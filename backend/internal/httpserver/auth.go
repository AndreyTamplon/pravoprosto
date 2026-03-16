package httpserver

import (
	"context"
	"crypto/subtle"
	"net/http"

	"pravoprost/backend/internal/identity"
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
		session, ok, blocked, err := deps.Identity.AuthenticateRequest(r.Context(), r)
		if err != nil {
			writeInternalError(w)
			return
		}
		if blocked {
			writeError(w, http.StatusForbidden, "account_blocked", "Account is blocked", nil)
			return
		}
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthorized", "Authentication required", nil)
			return
		}
		next(w, r.WithContext(withSession(r.Context(), session)))
	}
}

func requireRole(role string, deps Dependencies, next http.HandlerFunc) http.HandlerFunc {
	return requireAuth(func(w http.ResponseWriter, r *http.Request) {
		session, _ := sessionFromContext(r.Context())
		if session.Role != role {
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
			writeInternalError(w)
			return
		}
		if !ready {
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
		writeError(w, http.StatusForbidden, "forbidden", "Forbidden", nil)
	}, deps)
}

func requireCSRF(next http.HandlerFunc, deps Dependencies) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		session, ok := sessionFromContext(r.Context())
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthorized", "Authentication required", nil)
			return
		}
		if !secureEquals(r.Header.Get(deps.Config.CSRFHeaderName), session.CSRFSecret) {
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
