package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"

	"pravoprost/backend/internal/httpserver"
	"pravoprost/backend/internal/identity"
	"pravoprost/backend/internal/platform/config"
	platformdb "pravoprost/backend/internal/platform/db"
	platformlogging "pravoprost/backend/internal/platform/logging"
)

type TestApp struct {
	Config   config.Config
	DB       *platformdb.DB
	Server   *httptest.Server
	Postgres testcontainers.Container
	FakeSSO  *httptest.Server
	FakeLLM  *httptest.Server
}

func New(t *testing.T) *TestApp {
	t.Helper()
	ctx := context.Background()

	pg, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        "postgres:16-alpine",
			ExposedPorts: []string{"5432/tcp"},
			Env: map[string]string{
				"POSTGRES_DB":       "pravoprost",
				"POSTGRES_USER":     "postgres",
				"POSTGRES_PASSWORD": "postgres",
			},
			WaitingFor: wait.ForLog("database system is ready to accept connections"),
		},
		Started: true,
	})
	if err != nil {
		t.Fatalf("start postgres container: %v", err)
	}

	host, err := pg.Host(ctx)
	if err != nil {
		_ = pg.Terminate(ctx)
		t.Fatalf("postgres host: %v", err)
	}
	port, err := pg.MappedPort(ctx, "5432/tcp")
	if err != nil {
		_ = pg.Terminate(ctx)
		t.Fatalf("postgres port: %v", err)
	}

	cfg := config.Load()
	cfg.DatabaseURL = "postgres://postgres:postgres@" + host + ":" + port.Port() + "/pravoprost?sslmode=disable"
	cfg.BaseURL = "http://example.test"
	cfg.SigningSecret = "test-secret"
	cfg.CookieSecure = false
	cfg.LLMTimeout = 100 * time.Millisecond

	fakeSSO := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/yandex/exchange" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		code := r.URL.Query().Get("code")
		payload := map[string]any{
			"subject":  code,
			"email":    code + "@example.test",
			"verified": true,
			"name":     code,
			"raw": map[string]any{
				"subject": code,
			},
		}
		switch code {
		case "student":
			payload["subject"] = "subj-login"
			payload["email"] = "test@example.com"
			payload["name"] = "Ira"
		case "admin":
			payload["subject"] = "admin-subj"
			payload["email"] = "admin@example.com"
			payload["name"] = "Admin"
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(payload)
	}))
	cfg.SSOBaseURL = fakeSSO.URL

	fakeLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var body struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		userContent := ""
		if len(body.Messages) > 0 {
			userContent = body.Messages[len(body.Messages)-1].Content
		}
		answerContent := userContent
		if parts := strings.SplitN(userContent, "\nANSWER:", 2); len(parts) == 2 {
			answerContent = parts[1]
		}
		lower := strings.ToLower(answerContent)
		mode := "auto"
		switch {
		case strings.Contains(lower, "[llm:correct]"):
			mode = "correct"
		case strings.Contains(lower, "[llm:partial]"):
			mode = "partial"
		case strings.Contains(lower, "[llm:incorrect]"):
			mode = "incorrect"
		case strings.Contains(lower, "[llm:malformed]"):
			mode = "malformed"
		case strings.Contains(lower, "[llm:unknown]"):
			mode = "unknown"
		case strings.Contains(lower, "[llm:500]"):
			mode = "500"
		case strings.Contains(lower, "[llm:timeout]"):
			mode = "timeout"
		case strings.Contains(lower, "[llm:slow]"):
			mode = "slow"
		}

		if mode == "500" {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"provider_failure"}`))
			return
		}
		if mode == "timeout" || mode == "slow" {
			time.Sleep(250 * time.Millisecond)
		}

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Request-Id", "fake-llm-request")
		content := `{"verdict":"partial","feedback":"Часть ответа верна"}`
		switch mode {
		case "correct":
			content = `{"verdict":"correct","feedback":"Ответ корректный"}`
		case "partial":
			content = `{"verdict":"partial","feedback":"Часть ответа верна"}`
		case "incorrect":
			content = `{"verdict":"incorrect","feedback":"Ответ неверный"}`
		case "malformed":
			content = `{"verdict":`
		case "unknown":
			content = `{"verdict":"mystery","feedback":"??"}`
		default:
			switch {
			case strings.Contains(lower, "safe"), strings.Contains(lower, "нельзя"):
				content = `{"verdict":"correct","feedback":"Ответ корректный"}`
			case strings.Contains(lower, "some idea"), strings.Contains(lower, "idea"):
				content = `{"verdict":"partial","feedback":"Часть ответа верна"}`
			default:
				content = `{"verdict":"partial","feedback":"Часть ответа верна"}`
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id":    "chatcmpl_fake",
			"model": "fake-llm",
			"choices": []map[string]any{
				{
					"message": map[string]any{
						"content": content,
					},
				},
			},
		})
	}))
	cfg.LLMBaseURL = fakeLLM.URL

	var db *platformdb.DB
	for attempt := 0; attempt < 20; attempt++ {
		db, err = platformdb.Open(ctx, cfg.DatabaseURL)
		if err == nil {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if err != nil {
		fakeSSO.Close()
		fakeLLM.Close()
		_ = pg.Terminate(ctx)
		t.Fatalf("open db: %v", err)
	}
	if err := db.ApplyMigrations(ctx); err != nil {
		_ = db.Close(ctx)
		fakeSSO.Close()
		fakeLLM.Close()
		_ = pg.Terminate(ctx)
		t.Fatalf("apply migrations: %v", err)
	}

	logger := platformlogging.NewDiscardLogger()
	server := httptest.NewServer(httpserver.NewRouter(httpserver.Dependencies{
		Config: cfg,
		DB:     db,
		Logger: logger,
	}))

	t.Cleanup(func() {
		server.Close()
		fakeSSO.Close()
		fakeLLM.Close()
		_ = db.Close(ctx)
		_ = pg.Terminate(ctx)
	})

	return &TestApp{
		Config:   cfg,
		DB:       db,
		Server:   server,
		Postgres: pg,
		FakeSSO:  fakeSSO,
		FakeLLM:  fakeLLM,
	}
}

// NewWithRegistry creates a TestApp using a custom ProviderRegistry instead
// of the default LegacyExternalProvider. The fakeSSO and fakeLLM are still
// created for other tests that might need them.
func NewWithRegistry(t *testing.T, registry *identity.ProviderRegistry) *TestApp {
	t.Helper()
	ctx := context.Background()

	pg, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        "postgres:16-alpine",
			ExposedPorts: []string{"5432/tcp"},
			Env: map[string]string{
				"POSTGRES_DB":       "pravoprost",
				"POSTGRES_USER":     "postgres",
				"POSTGRES_PASSWORD": "postgres",
			},
			WaitingFor: wait.ForLog("database system is ready to accept connections"),
		},
		Started: true,
	})
	if err != nil {
		t.Fatalf("start postgres container: %v", err)
	}

	host, err := pg.Host(ctx)
	if err != nil {
		_ = pg.Terminate(ctx)
		t.Fatalf("postgres host: %v", err)
	}
	port, err := pg.MappedPort(ctx, "5432/tcp")
	if err != nil {
		_ = pg.Terminate(ctx)
		t.Fatalf("postgres port: %v", err)
	}

	cfg := config.Load()
	cfg.DatabaseURL = "postgres://postgres:postgres@" + host + ":" + port.Port() + "/pravoprost?sslmode=disable"
	cfg.BaseURL = "http://example.test"
	cfg.SigningSecret = "test-secret"
	cfg.CookieSecure = false
	cfg.LLMTimeout = 100 * time.Millisecond
	cfg.SSOBaseURL = "" // Disable legacy provider; use custom registry

	fakeLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "chatcmpl_fake", "model": "fake-llm",
			"choices": []map[string]any{{"message": map[string]any{"content": `{"verdict":"partial","feedback":"ok"}`}}},
		})
	}))
	cfg.LLMBaseURL = fakeLLM.URL

	var db *platformdb.DB
	for attempt := 0; attempt < 20; attempt++ {
		db, err = platformdb.Open(ctx, cfg.DatabaseURL)
		if err == nil {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if err != nil {
		fakeLLM.Close()
		_ = pg.Terminate(ctx)
		t.Fatalf("open db: %v", err)
	}
	if err := db.ApplyMigrations(ctx); err != nil {
		_ = db.Close(ctx)
		fakeLLM.Close()
		_ = pg.Terminate(ctx)
		t.Fatalf("apply migrations: %v", err)
	}

	logger := platformlogging.NewDiscardLogger()
	identitySvc := identity.NewService(db.Pool(), cfg, registry, logger)
	server := httptest.NewServer(httpserver.NewRouter(httpserver.Dependencies{
		Config:   cfg,
		DB:       db,
		Logger:   logger,
		Identity: identitySvc,
	}))

	t.Cleanup(func() {
		server.Close()
		fakeLLM.Close()
		_ = db.Close(ctx)
		_ = pg.Terminate(ctx)
	})

	return &TestApp{
		Config:   cfg,
		DB:       db,
		Server:   server,
		Postgres: pg,
		FakeLLM:  fakeLLM,
	}
}
