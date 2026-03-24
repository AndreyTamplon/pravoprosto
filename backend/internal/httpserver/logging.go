package httpserver

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	platformlogging "pravoprost/backend/internal/platform/logging"
)

type requestContextKey string

const (
	requestIDHeader                       = "X-Request-Id"
	requestIDContextKey requestContextKey = "request_id"
)

func requestIDFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	requestID, _ := ctx.Value(requestIDContextKey).(string)
	return requestID
}

func requestContextMiddleware(baseLogger *slog.Logger) func(http.Handler) http.Handler {
	logger := platformlogging.Named(baseLogger, "http_request")
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requestID := sanitizeRequestID(r.Header.Get(requestIDHeader))
			if requestID == "" {
				requestID = uuid.NewString()
			}
			w.Header().Set(requestIDHeader, requestID)

			ctx := context.WithValue(r.Context(), requestIDContextKey, requestID)
			ctx = platformlogging.WithContext(ctx, logger.With("request_id", requestID))
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func accessLogMiddleware(baseLogger *slog.Logger) func(http.Handler) http.Handler {
	logger := platformlogging.Named(baseLogger, "http_access")
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			startedAt := time.Now()
			recorder := &responseRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(recorder, r)

			routePattern := routePattern(r)
			requestLogger := platformlogging.FromContext(r.Context(), logger).With(
				"method", r.Method,
				"path", r.URL.Path,
				"route", routePattern,
				"status", recorder.status,
				"duration_ms", time.Since(startedAt).Milliseconds(),
				"response_bytes", recorder.bytesWritten,
				"remote_ip", clientIP(r),
				"user_agent", truncateValue(r.UserAgent(), 256),
			)

			if routePattern == "/health" && recorder.status == http.StatusOK {
				return
			}
			switch {
			case recorder.status >= http.StatusInternalServerError:
				requestLogger.Error("http request completed")
			case recorder.status == http.StatusTooManyRequests:
				requestLogger.Warn("http request completed")
			default:
				requestLogger.Info("http request completed")
			}
		})
	}
}

func recoveryMiddleware(baseLogger *slog.Logger) func(http.Handler) http.Handler {
	logger := platformlogging.Named(baseLogger, "http_recovery")
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if recovered := recover(); recovered != nil {
					platformlogging.FromContext(r.Context(), logger).Error(
						"panic recovered",
						"method", r.Method,
						"path", r.URL.Path,
						"route", routePattern(r),
						"panic", fmt.Sprint(recovered),
						"stack", string(debug.Stack()),
					)
					if recorder, ok := w.(*responseRecorder); !ok || !recorder.Written() {
						writeInternalError(w)
					}
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

type responseRecorder struct {
	http.ResponseWriter
	status       int
	bytesWritten int
	wroteHeader  bool
}

func (r *responseRecorder) WriteHeader(status int) {
	r.status = status
	r.wroteHeader = true
	r.ResponseWriter.WriteHeader(status)
}

func (r *responseRecorder) Write(body []byte) (int, error) {
	if !r.wroteHeader {
		r.WriteHeader(http.StatusOK)
	}
	written, err := r.ResponseWriter.Write(body)
	r.bytesWritten += written
	return written, err
}

func (r *responseRecorder) Written() bool {
	return r.wroteHeader
}

func routePattern(r *http.Request) string {
	routeCtx := chi.RouteContext(r.Context())
	if routeCtx == nil {
		return ""
	}
	pattern := strings.TrimSpace(routeCtx.RoutePattern())
	if pattern == "" {
		return "unmatched"
	}
	return pattern
}

func clientIP(r *http.Request) string {
	if forwarded := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); forwarded != "" {
		parts := strings.Split(forwarded, ",")
		if len(parts) > 0 {
			return strings.TrimSpace(parts[0])
		}
	}
	host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
	if err == nil {
		return host
	}
	return strings.TrimSpace(r.RemoteAddr)
}

func sanitizeRequestID(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 128 {
		return ""
	}
	for _, r := range value {
		if r < 33 || r > 126 {
			return ""
		}
	}
	return value
}

func truncateValue(value string, limit int) string {
	if limit <= 0 || len(value) <= limit {
		return value
	}
	return value[:limit]
}
