package httpserver

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"runtime"
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
	maxLoggedPathLength                   = 256
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
				"path", truncateValue(r.URL.Path, maxLoggedPathLength),
				"route", routePattern,
				"status", recorder.status,
				"duration_ms", time.Since(startedAt).Milliseconds(),
				"response_bytes", recorder.bytesWritten,
				"client_ip_hash", hashIdentifier(clientIP(r)),
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
					// Intentionally recover and return a JSON 500 so API clients receive
					// a stable error envelope instead of a dropped connection.
					platformlogging.FromContext(r.Context(), logger).Error(
						"panic recovered",
						"method", r.Method,
						"path", r.URL.Path,
						"route", routePattern(r),
						"panic", truncateValue(platformlogging.SanitizeText(fmt.Sprint(recovered)), 256),
						"stack_frames", stackFrames(4, 16),
					)
					if !responseWritten(w) {
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
	if r.wroteHeader {
		return
	}
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

func (r *responseRecorder) Flush() {
	flusher, ok := r.ResponseWriter.(http.Flusher)
	if !ok {
		return
	}
	if !r.wroteHeader {
		r.WriteHeader(http.StatusOK)
	}
	flusher.Flush()
}

func (r *responseRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := r.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("response writer does not support hijacking")
	}
	return hijacker.Hijack()
}

func (r *responseRecorder) Push(target string, opts *http.PushOptions) error {
	pusher, ok := r.ResponseWriter.(http.Pusher)
	if !ok {
		return http.ErrNotSupported
	}
	return pusher.Push(target, opts)
}

func (r *responseRecorder) ReadFrom(src io.Reader) (int64, error) {
	readerFrom, ok := r.ResponseWriter.(io.ReaderFrom)
	if !ok {
		return io.Copy(responseRecorderWriter{recorder: r}, src)
	}
	if !r.wroteHeader {
		r.WriteHeader(http.StatusOK)
	}
	written, err := readerFrom.ReadFrom(src)
	r.addBytesWritten64(written)
	return written, err
}

func (r *responseRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

type responseRecorderWriter struct {
	recorder *responseRecorder
}

func (w responseRecorderWriter) Write(body []byte) (int, error) {
	return w.recorder.Write(body)
}

func (r *responseRecorder) addBytesWritten64(written int64) {
	if written <= 0 {
		return
	}
	maxInt := int64(^uint(0) >> 1)
	if int64(r.bytesWritten) >= maxInt-written {
		r.bytesWritten = int(maxInt)
		return
	}
	r.bytesWritten += int(written)
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

func hashIdentifier(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(trimmed))
	return hex.EncodeToString(sum[:8])
}

func stackFrames(skip int, limit int) []string {
	if limit <= 0 {
		return nil
	}
	pcs := make([]uintptr, limit)
	count := runtime.Callers(skip, pcs)
	frames := runtime.CallersFrames(pcs[:count])
	result := make([]string, 0, count)
	for len(result) < limit {
		frame, more := frames.Next()
		result = append(result, fmt.Sprintf("%s:%d %s", frame.File, frame.Line, frame.Function))
		if !more {
			break
		}
	}
	return result
}

func responseWritten(w http.ResponseWriter) bool {
	for current := w; current != nil; {
		if recorder, ok := current.(interface{ Written() bool }); ok && recorder.Written() {
			return true
		}
		unwrapper, ok := current.(interface{ Unwrap() http.ResponseWriter })
		if !ok {
			return false
		}
		current = unwrapper.Unwrap()
	}
	return false
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
