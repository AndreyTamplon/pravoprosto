package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	AppName               string
	HTTPAddr              string
	BaseURL               string
	DatabaseURL           string
	SigningSecret         string
	SessionCookieName     string
	CookieSecure          bool
	SessionTTL            time.Duration
	CSRFHeaderName        string
	AllowedReturnToPrefix []string
	LLMBaseURL            string
	LLMAPIKey             string
	LLMModel              string
	LLMTimeout            time.Duration
	SSOBaseURL            string
	YandexClientID        string
	YandexClientSecret    string
	YandexAuthURL         string
	YandexTokenURL        string
	YandexUserInfoURL     string
	HeartsMax             int
	HeartsRestorePeriod   time.Duration
	MaxRequestBodyBytes   int64
}

func Load() Config {
	return Config{
		AppName:               getEnv("PRAVO_APP_NAME", "PravoProst Backend"),
		HTTPAddr:              getEnv("PRAVO_HTTP_ADDR", ":8080"),
		BaseURL:               getEnv("PRAVO_BASE_URL", "http://localhost:8080"),
		DatabaseURL:           getEnv("PRAVO_DATABASE_URL", "postgres://postgres:postgres@localhost:5432/pravoprost?sslmode=disable"),
		SigningSecret:         getEnv("PRAVO_SIGNING_SECRET", "dev-signing-secret"),
		SessionCookieName:     getEnv("PRAVO_SESSION_COOKIE_NAME", "pravoprost_session"),
		CookieSecure:          getEnvBool("PRAVO_COOKIE_SECURE", true),
		SessionTTL:            time.Duration(getEnvInt("PRAVO_SESSION_TTL_SECONDS", 14*24*60*60)) * time.Second,
		CSRFHeaderName:        getEnv("PRAVO_CSRF_HEADER_NAME", "X-CSRF-Token"),
		AllowedReturnToPrefix: getEnvSlice("PRAVO_ALLOWED_RETURN_TO", []string{"/", "/claim/course-link", "/claim/guardian-link"}),
		LLMBaseURL:            getEnv("PRAVO_LLM_BASE_URL", "http://localhost:8090"),
		LLMAPIKey:             getEnv("PRAVO_LLM_API_KEY", "test-key"),
		LLMModel:              getEnv("PRAVO_LLM_MODEL", "mock-gpt"),
		LLMTimeout:            time.Duration(getEnvInt("PRAVO_LLM_TIMEOUT_SECONDS", 5)) * time.Second,
		SSOBaseURL:            getEnv("PRAVO_SSO_BASE_URL", "http://localhost:8091"),
		YandexClientID:        getEnv("PRAVO_YANDEX_CLIENT_ID", ""),
		YandexClientSecret:    getEnv("PRAVO_YANDEX_CLIENT_SECRET", ""),
		YandexAuthURL:         getEnv("PRAVO_YANDEX_AUTH_URL", ""),
		YandexTokenURL:        getEnv("PRAVO_YANDEX_TOKEN_URL", ""),
		YandexUserInfoURL:     getEnv("PRAVO_YANDEX_USERINFO_URL", ""),
		HeartsMax:             getEnvInt("PRAVO_HEARTS_MAX", 5),
		HeartsRestorePeriod:   time.Duration(getEnvInt("PRAVO_HEARTS_RESTORE_MINUTES", 30)) * time.Minute,
		MaxRequestBodyBytes:   int64(getEnvInt("PRAVO_MAX_REQUEST_BODY_BYTES", 1<<20)),
	}
}

func (c Config) ValidateRuntime() error {
	if strings.TrimSpace(c.SigningSecret) == "" || c.SigningSecret == "dev-signing-secret" {
		return fmt.Errorf("invalid runtime config: PRAVO_SIGNING_SECRET must be set to a non-default value")
	}
	if strings.TrimSpace(c.LLMAPIKey) == "" || c.LLMAPIKey == "test-key" {
		return fmt.Errorf("invalid runtime config: PRAVO_LLM_API_KEY must be set to a non-default value")
	}
	if c.MaxRequestBodyBytes <= 0 {
		return fmt.Errorf("invalid runtime config: PRAVO_MAX_REQUEST_BODY_BYTES must be positive")
	}
	return nil
}

func getEnv(key string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func getEnvInt(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func getEnvSlice(key string, fallback []string) []string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			result = append(result, trimmed)
		}
	}
	if len(result) == 0 {
		return fallback
	}
	return result
}

func getEnvBool(key string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	switch strings.ToLower(value) {
	case "1", "true", "yes", "y":
		return true
	case "0", "false", "no", "n":
		return false
	default:
		return fallback
	}
}
