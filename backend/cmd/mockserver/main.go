// Mock Yandex ID + LLM server for manual e2e testing.
// Implements real Yandex OAuth2 endpoints (authorize, token, userinfo)
// and OpenAI-compatible LLM in a single process on two ports.
//
// Usage:
//
//	go run ./cmd/mockserver
//
// Environment:
//
//	MOCK_SSO_ADDR  (default ":8091")
//	MOCK_LLM_ADDR  (default ":8090")
package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// Yandex ID mock (real OAuth2 protocol)
// ---------------------------------------------------------------------------

// userDB is a thread-safe registry of fake Yandex users.
// Each unique "code" in the OAuth callback maps to a user.
type userDB struct {
	mu    sync.RWMutex
	users map[string]yandexUser
}

type yandexUser struct {
	ID           string `json:"id"`
	Login        string `json:"login"`
	DisplayName  string `json:"display_name"`
	RealName     string `json:"real_name"`
	FirstName    string `json:"first_name"`
	LastName     string `json:"last_name"`
	DefaultEmail string `json:"default_email"`
	Sex          string `json:"sex"`
}

func newUserDB() *userDB {
	return &userDB{users: map[string]yandexUser{
		"admin": {
			ID: "admin-yandex-id", Login: "admin",
			DisplayName: "Admin", RealName: "Admin User",
			FirstName: "Admin", LastName: "User",
			DefaultEmail: "admin@yandex.ru", Sex: "male",
		},
		"teacher": {
			ID: "teacher-yandex-id", Login: "teacher",
			DisplayName: "Мария Ивановна", RealName: "Мария Иванова",
			FirstName: "Мария", LastName: "Иванова",
			DefaultEmail: "teacher@yandex.ru", Sex: "female",
		},
		"student": {
			ID: "student-yandex-id", Login: "student",
			DisplayName: "Алиса", RealName: "Алиса Петрова",
			FirstName: "Алиса", LastName: "Петрова",
			DefaultEmail: "student@yandex.ru", Sex: "female",
		},
		"parent": {
			ID: "parent-yandex-id", Login: "parent",
			DisplayName: "Елена", RealName: "Елена Петрова",
			FirstName: "Елена", LastName: "Петрова",
			DefaultEmail: "parent@yandex.ru", Sex: "female",
		},
		"student2": {
			ID: "student2-yandex-id", Login: "student2",
			DisplayName: "Борис", RealName: "Борис Сидоров",
			FirstName: "Борис", LastName: "Сидоров",
			DefaultEmail: "student2@yandex.ru", Sex: "male",
		},
	}}
}

func (db *userDB) resolve(code string) yandexUser {
	db.mu.RLock()
	if u, ok := db.users[code]; ok {
		db.mu.RUnlock()
		return u
	}
	db.mu.RUnlock()

	u := yandexUser{
		ID:           code + "-yandex-id",
		Login:        code,
		DisplayName:  code,
		RealName:     code,
		FirstName:    code,
		DefaultEmail: code + "@yandex.ru",
	}
	db.mu.Lock()
	db.users[code] = u
	db.mu.Unlock()
	return u
}

// tokenStore maps access_token → code so /info can look up the user.
type tokenStore struct {
	mu     sync.RWMutex
	tokens map[string]string // token → code
}

func newTokenStore() *tokenStore {
	return &tokenStore{tokens: make(map[string]string)}
}

func (s *tokenStore) issue(code string) string {
	token := fmt.Sprintf("mock-token-%s-%d", code, time.Now().UnixNano())
	s.mu.Lock()
	s.tokens[token] = code
	s.mu.Unlock()
	return token
}

func (s *tokenStore) resolve(token string) (string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	code, ok := s.tokens[token]
	return code, ok
}

func ssoHandler(db *userDB, tokens *tokenStore) http.Handler {
	mux := http.NewServeMux()

	// GET /authorize — Yandex OAuth2 authorization endpoint.
	// Real Yandex shows login UI; mock shows user picker and redirects to callback.
	mux.HandleFunc("/authorize", func(w http.ResponseWriter, r *http.Request) {
		state := r.URL.Query().Get("state")
		redirectURI := r.URL.Query().Get("redirect_uri")
		slog.Info("mock sso authorize requested", "has_state", state != "", "has_redirect_uri", redirectURI != "")

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, `<!DOCTYPE html>
<html><head><title>Mock Yandex ID</title>
<style>
body { font-family: sans-serif; max-width: 500px; margin: 40px auto; background: #FFFBEB; }
a { display: block; padding: 12px 16px; margin: 8px 0; background: #FC3F1D; color: #fff;
    text-decoration: none; border-radius: 8px; text-align: center; font-size: 18px; }
a:hover { background: #E0360F; }
h1 { color: #1E293B; }
input { width: 100%%; padding: 10px; font-size: 16px; margin: 4px 0; box-sizing: border-box; }
button { padding: 12px 16px; background: #F97316; color: #fff; border: none; border-radius: 8px;
         font-size: 16px; cursor: pointer; width: 100%%; margin-top: 8px; }
.logo { text-align: center; font-size: 2em; margin-bottom: 8px; }
</style></head>
<body>
<div class="logo">🔑</div>
<h1>Mock Yandex ID</h1>
<p>Выберите пользователя:</p>
<a href="%s">🛡️ Admin</a>
<a href="%s">📚 Teacher (Мария Ивановна)</a>
<a href="%s">🎒 Student (Алиса)</a>
<a href="%s">👩 Parent (Елена)</a>
<a href="%s">🎒 Student 2 (Борис)</a>
<hr>
<p>Или введите произвольный код:</p>
<form action="%s" method="GET">
  <input type="hidden" name="state" value="%s">
  <input type="text" name="code" placeholder="custom-user-code">
  <button type="submit">Войти</button>
</form>
</body></html>`,
			buildCallback(redirectURI, state, "admin"),
			buildCallback(redirectURI, state, "teacher"),
			buildCallback(redirectURI, state, "student"),
			buildCallback(redirectURI, state, "parent"),
			buildCallback(redirectURI, state, "student2"),
			redirectURI,
			state,
		)
	})

	// POST /token — Yandex OAuth2 token endpoint.
	// Receives authorization code, returns access_token.
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if err := r.ParseForm(); err != nil {
			http.Error(w, `{"error":"bad_request"}`, http.StatusBadRequest)
			return
		}

		code := r.FormValue("code")
		grantType := r.FormValue("grant_type")

		slog.Info("mock sso token exchange", "grant_type", grantType, "has_code", code != "")

		if code == "" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"invalid_grant","error_description":"code is empty"}`))
			return
		}

		accessToken := tokens.issue(code)

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token":  accessToken,
			"token_type":    "bearer",
			"expires_in":    3600,
			"refresh_token": "mock-refresh-" + code,
		})
	})

	// GET /info — Yandex userinfo endpoint.
	// Backend calls this with "Authorization: OAuth <token>".
	mux.HandleFunc("/info", func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		token := strings.TrimPrefix(authHeader, "OAuth ")
		if token == "" || token == authHeader {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"invalid_token"}`))
			return
		}

		code, ok := tokens.resolve(token)
		if !ok {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"invalid_token"}`))
			return
		}

		u := db.resolve(code)
		slog.Info("mock sso userinfo served", "login", u.Login, "user_id", u.ID)

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id":            u.ID,
			"login":         u.Login,
			"display_name":  u.DisplayName,
			"real_name":     u.RealName,
			"first_name":    u.FirstName,
			"last_name":     u.LastName,
			"default_email": u.DefaultEmail,
			"emails":        []string{u.DefaultEmail},
			"sex":           u.Sex,
			"psuid":         "mock-psuid-" + u.ID,
		})
	})

	// Health
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok","service":"mock-yandex-id"}`))
	})

	return mux
}

func buildCallback(redirectURI, state, code string) string {
	u, _ := url.Parse(redirectURI)
	q := u.Query()
	q.Set("state", state)
	q.Set("code", code)
	u.RawQuery = q.Encode()
	return u.String()
}

// ---------------------------------------------------------------------------
// LLM mock (OpenAI-compatible)
// ---------------------------------------------------------------------------

func llmHandler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var body struct {
			Model    string `json:"model"`
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
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

		slog.Info("mock llm request", "model", body.Model, "mode", mode, "answer_len", len(answerContent))

		if mode == "500" {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"provider_failure"}`))
			return
		}
		if mode == "timeout" {
			time.Sleep(30 * time.Second)
			return
		}
		if mode == "slow" {
			time.Sleep(3 * time.Second)
		}

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
			case strings.Contains(lower, "safe"), strings.Contains(lower, "нельзя"),
				strings.Contains(lower, "правильн"), strings.Contains(lower, "верн"):
				content = `{"verdict":"correct","feedback":"Ответ корректный"}`
			case strings.Contains(lower, "не знаю"), strings.Contains(lower, "может"):
				content = `{"verdict":"partial","feedback":"Часть ответа верна"}`
			case strings.Contains(lower, "можно"), strings.Contains(lower, "ничего страшн"):
				content = `{"verdict":"incorrect","feedback":"Это небезопасно"}`
			}
		}

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Request-Id", fmt.Sprintf("mock-llm-%d", time.Now().UnixMilli()))
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id":    "chatcmpl_mock",
			"model": body.Model,
			"choices": []map[string]any{
				{
					"message": map[string]any{
						"content": content,
					},
				},
			},
		})
	})

	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok","service":"mock-llm"}`))
	})

	return mux
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

func main() {
	ssoAddr := envOr("MOCK_SSO_ADDR", ":8091")
	llmAddr := envOr("MOCK_LLM_ADDR", ":8090")
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))

	db := newUserDB()
	tokens := newTokenStore()

	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		slog.Info("mock yandex id listening", "addr", ssoAddr)
		if err := http.ListenAndServe(ssoAddr, ssoHandler(db, tokens)); err != nil {
			slog.Error("mock sso server failed", "err", err)
			os.Exit(1)
		}
	}()

	go func() {
		defer wg.Done()
		slog.Info("mock llm listening", "addr", llmAddr)
		if err := http.ListenAndServe(llmAddr, llmHandler()); err != nil {
			slog.Error("mock llm server failed", "err", err)
			os.Exit(1)
		}
	}()

	slog.Info("mock servers started", "sso_url", "http://localhost"+ssoAddr, "llm_url", "http://localhost"+llmAddr)
	slog.Info("mock users available", "users", "admin,teacher,student,parent,student2")
	slog.Info("mock llm control codes available", "codes", "[llm:correct],[llm:partial],[llm:incorrect],[llm:500],[llm:timeout],[llm:malformed]")

	wg.Wait()
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
