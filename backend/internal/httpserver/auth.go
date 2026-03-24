package httpserver

import (
	"context"
	"crypto/subtle"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"pravoprost/backend/internal/identity"
	platformlogging "pravoprost/backend/internal/platform/logging"
)

type contextKey string

const sessionContextKey contextKey = "session"

func withSession(ctx context.Context, session identity.AuthenticatedSession) context.Context {
	return context.WithValue(ctx, sessionContextKey, session)
}

func sessionFromContext(ctx context.Context) (identity.AuthenticatedSession, bool) {
	value, ok := ctx.Value(sessionContextKey).(identity.AuthenticatedSession)
	return value, ok
}

func requireAuth(next http.HandlerFunc, deps Dependencies) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		logger := requestLogger(r.Context(), deps.Logger)
		session, ok, blocked, err := deps.Identity.AuthenticateRequest(r.Context(), r)
		if err != nil {
			logger.Error("request authentication failed", "err", err)
			writeInternalError(w)
			return
		}
		if blocked {
			logger.Warn("blocked account attempted request")
			writeError(w, http.StatusForbidden, "account_blocked", "Account is blocked", nil)
			return
		}
		if !ok {
			logger.Info("authentication required")
			writeError(w, http.StatusUnauthorized, "unauthorized", "Authentication required", nil)
			return
		}
		ctx := withSession(r.Context(), session)
		ctx = platformlogging.WithContext(ctx, requestLogger(ctx, deps.Logger).With(
			"account_id", session.AccountID,
			"role", session.Role,
		))
		next(w, r.WithContext(ctx))
	}
}

func requireRole(role string, deps Dependencies, next http.HandlerFunc) http.HandlerFunc {
	return requireAuth(func(w http.ResponseWriter, r *http.Request) {
		session, _ := sessionFromContext(r.Context())
		if session.Role != role {
			requestLogger(r.Context(), deps.Logger).Warn("forbidden role access", "expected_role", role, "actual_role", session.Role)
			writeError(w, http.StatusForbidden, "forbidden", "Forbidden", nil)
			return
		}
		next(w, r)
	}, deps)
}

func requireTeacherReady(deps Dependencies, next http.HandlerFunc) http.HandlerFunc {
	return requireRole("teacher", deps, func(w http.ResponseWriter, r *http.Request) {
		session, _ := sessionFromContext(r.Context())
		ready, err := deps.Courses.TeacherProfileReady(r.Context(), session.AccountID)
		if err != nil {
			requestLogger(r.Context(), deps.Logger).Error("teacher readiness check failed", "err", err)
			writeInternalError(w)
			return
		}
		if !ready {
			requestLogger(r.Context(), deps.Logger).Info("teacher profile completion required")
			writeError(w, http.StatusConflict, "teacher_profile_required", "Teacher profile must be completed first", nil)
			return
		}
		next(w, r)
	})
}

func requireAnyRole(roles []string, deps Dependencies, next http.HandlerFunc) http.HandlerFunc {
	return requireAuth(func(w http.ResponseWriter, r *http.Request) {
		session, _ := sessionFromContext(r.Context())
		for _, role := range roles {
			if session.Role == role {
				next(w, r)
				return
			}
		}
		requestLogger(r.Context(), deps.Logger).Warn("forbidden role access", "allowed_roles", strings.Join(roles, ","), "actual_role", session.Role)
		writeError(w, http.StatusForbidden, "forbidden", "Forbidden", nil)
	}, deps)
}

func requireCSRF(next http.HandlerFunc, deps Dependencies) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		session, ok := sessionFromContext(r.Context())
		if !ok {
			requestLogger(r.Context(), deps.Logger).Info("csrf check failed without authenticated session")
			writeError(w, http.StatusUnauthorized, "unauthorized", "Authentication required", nil)
			return
		}
		if !secureEquals(r.Header.Get(deps.Config.CSRFHeaderName), session.CSRFSecret) {
			requestLogger(r.Context(), deps.Logger).Warn("invalid csrf token")
			writeError(w, http.StatusForbidden, "forbidden", "CSRF token missing or invalid", nil)
			return
		}
		next(w, r)
	}
}

func secureEquals(left string, right string) bool {
	if len(left) == 0 || len(right) == 0 {
		return false
	}
	if len(left) != len(right) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("X-XSS-Protection", "1; mode=block")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
		next.ServeHTTP(w, r)
	})
}

// rateLimitByIP returns middleware that limits requests per IP using an in-memory
// token bucket. tokens are replenished at a rate of limit per window.
func rateLimitByIP(limit int, window time.Duration) func(http.Handler) http.Handler {
	type bucket struct {
		tokens int
		last   time.Time
	}
	var mu sync.Mutex
	buckets := make(map[string]*bucket)

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := r.RemoteAddr
			if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
				ip = strings.TrimSpace(strings.Split(fwd, ",")[0])
			}

			mu.Lock()
			b, ok := buckets[ip]
			now := time.Now()
			if !ok {
				b = &bucket{tokens: limit, last: now}
				buckets[ip] = b
			}
			elapsed := now.Sub(b.last)
			if elapsed >= window {
				b.tokens = limit
				b.last = now
			} else {
				refill := int(elapsed * time.Duration(limit) / window)
				b.tokens += refill
				if b.tokens > limit {
					b.tokens = limit
				}
				b.last = now
			}
			if b.tokens <= 0 {
				mu.Unlock()
				requestLogger(r.Context(), nil).Warn("request rate limited")
				writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many requests", nil)
				return
			}
			b.tokens--
			mu.Unlock()

			next.ServeHTTP(w, r)
		})
	}
}

func requestLogger(ctx context.Context, fallback *slog.Logger) *slog.Logger {
	return platformlogging.FromContext(ctx, fallback)
}

func limitRequestBody(maxBytes int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if maxBytes > 0 {
				r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
			}
			next.ServeHTTP(w, r)
		})
	}
}
