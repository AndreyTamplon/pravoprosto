package logging

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"

	platformconfig "pravoprost/backend/internal/platform/config"
)

type contextKey string

const loggerContextKey contextKey = "logger"

func NewLogger(cfg platformconfig.Config) *slog.Logger {
	level := parseLevel(cfg.LogLevel)
	options := &slog.HandlerOptions{
		AddSource: cfg.LogAddSource,
		Level:     level,
		ReplaceAttr: func(groups []string, attr slog.Attr) slog.Attr {
			if attr.Key == slog.TimeKey && len(groups) == 0 {
				attr.Value = slog.StringValue(attr.Value.Time().UTC().Format("2006-01-02T15:04:05Z07:00"))
			}
			if shouldRedact(attr.Key) {
				attr.Value = slog.StringValue("[redacted]")
			}
			return attr
		},
	}

	handler := newHandler(os.Stdout, cfg.LogFormat, options)
	logger := slog.New(handler)
	if strings.TrimSpace(cfg.AppName) != "" {
		logger = logger.With("app", cfg.AppName)
	}
	return logger
}

func NewDiscardLogger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(io.Discard, nil))
}

func Named(logger *slog.Logger, component string) *slog.Logger {
	base := logger
	if base == nil {
		base = slog.Default()
	}
	component = strings.TrimSpace(component)
	if component == "" {
		return base
	}
	return base.With("component", component)
}

func WithContext(ctx context.Context, logger *slog.Logger) context.Context {
	if logger == nil {
		return ctx
	}
	return context.WithValue(ctx, loggerContextKey, logger)
}

func FromContext(ctx context.Context, fallback *slog.Logger) *slog.Logger {
	if ctx != nil {
		if logger, ok := ctx.Value(loggerContextKey).(*slog.Logger); ok && logger != nil {
			return logger
		}
	}
	if fallback != nil {
		return fallback
	}
	return slog.Default()
}

func RedactedValue() slog.Value {
	return slog.StringValue("[redacted]")
}

func newHandler(writer io.Writer, format string, options *slog.HandlerOptions) slog.Handler {
	switch resolveFormat(format) {
	case "text":
		return slog.NewTextHandler(writer, options)
	default:
		return slog.NewJSONHandler(writer, options)
	}
}

func resolveFormat(format string) string {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "json":
		return "json"
	case "text":
		return "text"
	}

	info, err := os.Stdout.Stat()
	if err == nil && (info.Mode()&os.ModeCharDevice) != 0 {
		return "text"
	}
	return "json"
}

func parseLevel(level string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

func shouldRedact(key string) bool {
	normalized := strings.ToLower(strings.TrimSpace(key))
	switch normalized {
	case "api_key",
		"authorization",
		"client_secret",
		"code",
		"cookie",
		"csrf_secret",
		"csrf_token",
		"database_url",
		"password",
		"set-cookie",
		"signing_secret",
		"state",
		"token":
		return true
	}
	return strings.HasSuffix(normalized, "_secret") ||
		strings.HasSuffix(normalized, "_token") ||
		strings.HasSuffix(normalized, "_cookie") ||
		strings.HasSuffix(normalized, "_password") ||
		strings.HasSuffix(normalized, "_api_key")
}
