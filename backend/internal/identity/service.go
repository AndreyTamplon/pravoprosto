package identity

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	platformconfig "pravoprost/backend/internal/platform/config"
)

type Service struct {
	db        *pgxpool.Pool
	config    platformconfig.Config
	providers *ProviderRegistry
}

type SessionView struct {
	Authenticated bool       `json:"authenticated"`
	CSRFToken     string     `json:"csrf_token,omitempty"`
	User          *UserView  `json:"user"`
	Onboarding    Onboarding `json:"onboarding"`
}

type UserView struct {
	AccountID string `json:"account_id"`
	Role      string `json:"role"`
	Status    string `json:"status"`
}

type Onboarding struct {
	RoleSelectionRequired  bool `json:"role_selection_required"`
	TeacherProfileRequired bool `json:"teacher_profile_required"`
}

type AuthenticatedSession struct {
	SessionID   string
	AccountID   string
	Role        string
	Status      string
	CSRFSecret  string
	DisplayName string
}

type SSOCallbackInput struct {
	Provider string
	Query    url.Values
}

type CallbackResult struct {
	SessionCookie *http.Cookie
	RedirectURL   string
}

type StartResult struct {
	StateCookie *http.Cookie
	RedirectURL string
}

func NewService(db *pgxpool.Pool, cfg platformconfig.Config, providers *ProviderRegistry) *Service {
	return &Service{
		db:        db,
		config:    cfg,
		providers: providers,
	}
}

func (s *Service) SessionView(ctx context.Context, r *http.Request) (SessionView, error) {
	session, ok, blocked, err := s.AuthenticateRequest(ctx, r)
	if err != nil {
		return SessionView{}, err
	}
	if !ok || blocked {
		return SessionView{
			Authenticated: false,
			User:          nil,
			Onboarding: Onboarding{
				RoleSelectionRequired:  false,
				TeacherProfileRequired: false,
			},
		}, nil
	}

	return SessionView{
		Authenticated: true,
		CSRFToken:     session.CSRFSecret,
		User: &UserView{
			AccountID: session.AccountID,
			Role:      session.Role,
			Status:    session.Status,
		},
		Onboarding: Onboarding{
			RoleSelectionRequired:  session.Role == "unselected",
			TeacherProfileRequired: session.Role == "teacher" && !teacherProfileComplete(ctx, s.db, session.AccountID),
		},
	}, nil
}

func (s *Service) AuthenticateRequest(ctx context.Context, r *http.Request) (AuthenticatedSession, bool, bool, error) {
	cookie, err := r.Cookie(s.config.SessionCookieName)
	if err != nil {
		if err == http.ErrNoCookie {
			return AuthenticatedSession{}, false, false, nil
		}
		return AuthenticatedSession{}, false, false, err
	}

	tokenHash := hashToken(cookie.Value)
	query := `
		select s.id::text, a.id::text, a.role, a.status, s.csrf_secret,
		       coalesce(sp.display_name, pp.display_name, tp.display_name, ap.display_name, ''),
		       (s.revoked_at is null and s.expires_at > now()) as is_active
		from sessions s
		join accounts a on a.id = s.account_id
		left join student_profiles sp on sp.account_id = a.id
		left join parent_profiles pp on pp.account_id = a.id
		left join teacher_profiles tp on tp.account_id = a.id
		left join admin_profiles ap on ap.account_id = a.id
		where s.session_token_hash = $1
	`

	var session AuthenticatedSession
	var isActive bool
	err = s.db.QueryRow(ctx, query, tokenHash).Scan(
		&session.SessionID,
		&session.AccountID,
		&session.Role,
		&session.Status,
		&session.CSRFSecret,
		&session.DisplayName,
		&isActive,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return AuthenticatedSession{}, false, false, nil
		}
		return AuthenticatedSession{}, false, false, err
	}

	if session.Status == "blocked" {
		_, _ = s.db.Exec(ctx, `update sessions set revoked_at = now() where id = $1 and revoked_at is null`, session.SessionID)
		return AuthenticatedSession{}, false, true, nil
	}
	if !isActive {
		return AuthenticatedSession{}, false, false, nil
	}

	if _, err := s.db.Exec(ctx, `update sessions set last_seen_at = now() where id = $1`, session.SessionID); err != nil {
		log.Printf("identity: update last_seen_at for session %s: %v", session.SessionID, err)
	}
	return session, true, false, nil
}

func (s *Service) StartSSO(providerName string, returnTo string) (StartResult, error) {
	if err := validateReturnTo(returnTo, s.config.AllowedReturnToPrefix); err != nil {
		return StartResult{}, err
	}

	provider, ok := s.providers.Get(providerName)
	if !ok {
		return StartResult{}, ErrUnknownProvider
	}

	state, err := randomToken(24)
	if err != nil {
		return StartResult{}, err
	}

	payload, err := signState(statePayload{State: state, ReturnTo: returnTo, IssuedAtUN: time.Now().Unix()}, s.config.SigningSecret)
	if err != nil {
		return StartResult{}, err
	}

	callbackURL := strings.TrimRight(s.config.BaseURL, "/") + "/api/v1/auth/sso/" + providerName + "/callback"
	redirectURL := provider.AuthCodeURL(state, callbackURL)

	return StartResult{
		StateCookie: &http.Cookie{
			Name:     "pravoprost_oauth_state",
			Value:    payload,
			HttpOnly: true,
			Secure:   s.config.CookieSecure,
			Path:     "/",
			MaxAge:   300,
			SameSite: http.SameSiteLaxMode,
		},
		RedirectURL: redirectURL,
	}, nil
}

func (s *Service) Callback(ctx context.Context, input SSOCallbackInput, stateCookie *http.Cookie) (CallbackResult, error) {
	if stateCookie == nil {
		return CallbackResult{}, ErrInvalidState
	}
	payload, err := verifyState(stateCookie.Value, s.config.SigningSecret)
	if err != nil {
		return CallbackResult{}, ErrInvalidState
	}
	if payload.State == "" || input.Query.Get("state") != payload.State {
		return CallbackResult{}, ErrInvalidState
	}

	provider, ok := s.providers.Get(input.Provider)
	if !ok {
		return CallbackResult{}, ErrUnknownProvider
	}

	code := strings.TrimSpace(input.Query.Get("code"))
	if code == "" {
		return CallbackResult{}, ErrInvalidState
	}

	callbackURL := strings.TrimRight(s.config.BaseURL, "/") + "/api/v1/auth/sso/" + input.Provider + "/callback"
	resolved, err := provider.Exchange(ctx, code, callbackURL)
	if err != nil {
		return CallbackResult{}, err
	}

	accountID, role, err := s.upsertIdentity(ctx, input.Provider, resolved)
	if err != nil {
		return CallbackResult{}, err
	}

	rawToken, err := randomToken(32)
	if err != nil {
		return CallbackResult{}, err
	}
	csrfSecret, err := randomToken(24)
	if err != nil {
		return CallbackResult{}, err
	}
	var sessionID string
	err = s.db.QueryRow(ctx, `
		insert into sessions(account_id, session_token_hash, csrf_secret, expires_at)
		values ($1, $2, $3, $4)
		returning id::text
	`, accountID, hashToken(rawToken), csrfSecret, time.Now().Add(s.config.SessionTTL)).Scan(&sessionID)
	if err != nil {
		return CallbackResult{}, err
	}

	redirectURL := payload.ReturnTo
	if redirectURL == "" {
		if role == "unselected" {
			redirectURL = "/onboarding/role"
		} else {
			redirectURL = "/" + role
		}
	}

	return CallbackResult{
		SessionCookie: &http.Cookie{
			Name:     s.config.SessionCookieName,
			Value:    rawToken,
			Path:     "/",
			HttpOnly: true,
			Secure:   s.config.CookieSecure,
			SameSite: http.SameSiteLaxMode,
			Expires:  time.Now().Add(s.config.SessionTTL),
		},
		RedirectURL: redirectURL,
	}, nil
}

func (s *Service) Logout(ctx context.Context, sessionID string) error {
	_, err := s.db.Exec(ctx, `update sessions set revoked_at = now() where id = $1 and revoked_at is null`, sessionID)
	return err
}

func (s *Service) CompleteRoleSelection(ctx context.Context, accountID string, requestedRole string) (string, string, error) {
	if requestedRole == "admin" {
		return "", "", ErrForbiddenAdminRoleSelection
	}
	if requestedRole != "student" && requestedRole != "parent" && requestedRole != "teacher" {
		return "", "", ErrInvalidRoleSelection
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return "", "", err
	}
	defer tx.Rollback(ctx)

	var currentRole string
	err = tx.QueryRow(ctx, `select role from accounts where id = $1 for update`, accountID).Scan(&currentRole)
	if err != nil {
		return "", "", err
	}
	if currentRole != "unselected" {
		if currentRole == requestedRole {
			return accountID, currentRole, tx.Commit(ctx)
		}
		return "", "", ErrRoleAlreadySet
	}

	if _, err := tx.Exec(ctx, `update accounts set role = $1, updated_at = now() where id = $2`, requestedRole, accountID); err != nil {
		return "", "", err
	}

	displayName := defaultDisplayName(ctx, tx, accountID)

	switch requestedRole {
	case "student":
		if _, err := tx.Exec(ctx, `
			insert into student_profiles(account_id, display_name)
			values ($1, $2)
			on conflict (account_id) do nothing
		`, accountID, displayName); err != nil {
			return "", "", err
		}
		if _, err := tx.Exec(ctx, `
			insert into student_game_state(student_id, xp_total, level, hearts_current, hearts_max, hearts_updated_at)
			values ($1, 0, 1, $2, $2, now())
			on conflict (student_id) do nothing
		`, accountID, s.config.HeartsMax); err != nil {
			return "", "", err
		}
		if _, err := tx.Exec(ctx, `
			insert into student_streak_state(student_id, current_streak_days, best_streak_days, updated_at)
			values ($1, 0, 0, now())
			on conflict (student_id) do nothing
		`, accountID); err != nil {
			return "", "", err
		}
	case "parent":
		if _, err := tx.Exec(ctx, `
			insert into parent_profiles(account_id, display_name)
			values ($1, $2)
			on conflict (account_id) do nothing
		`, accountID, displayName); err != nil {
			return "", "", err
		}
	case "teacher":
		if _, err := tx.Exec(ctx, `
			insert into teacher_profiles(account_id, display_name)
			values ($1, $2)
			on conflict (account_id) do nothing
		`, accountID, displayName); err != nil {
			return "", "", err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return "", "", err
	}
	return accountID, requestedRole, nil
}

func (s *Service) BlockUser(ctx context.Context, userID string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `update accounts set status = 'blocked', updated_at = now() where id = $1`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `update sessions set revoked_at = now() where account_id = $1 and revoked_at is null`, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) UnblockUser(ctx context.Context, userID string) error {
	_, err := s.db.Exec(ctx, `update accounts set status = 'active', updated_at = now() where id = $1`, userID)
	return err
}

func (s *Service) ListUsers(ctx context.Context, role string) (map[string]any, error) {
	rows, err := s.db.Query(ctx, `
		select a.id::text,
		       a.role,
		       a.status,
		       coalesce(sp.display_name, pp.display_name, tp.display_name, ap.display_name, ''),
		       ei.email,
		       a.created_at::text,
		       coalesce(sgs.xp_total, 0),
		       (
		           select max(cp.last_activity_at)::text
		           from course_progress cp
		           where cp.student_id = a.id
		       )
		from accounts a
		left join lateral (
		    select email
		    from external_identities
		    where account_id = a.id and email is not null and trim(email) <> ''
		    order by created_at desc
		    limit 1
		) ei on true
		left join student_profiles sp on sp.account_id = a.id
		left join parent_profiles pp on pp.account_id = a.id
		left join teacher_profiles tp on tp.account_id = a.id
		left join admin_profiles ap on ap.account_id = a.id
		left join student_game_state sgs on sgs.student_id = a.id
		where ($1 = '' or a.role = $1)
		order by a.created_at desc
	`, role)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]map[string]any, 0)
	for rows.Next() {
		var accountID, roleValue, statusValue, displayName, createdAt string
		var email *string
		var xpTotal int64
		var lastActivityAt *string
		if err := rows.Scan(&accountID, &roleValue, &statusValue, &displayName, &email, &createdAt, &xpTotal, &lastActivityAt); err != nil {
			return nil, err
		}
		items = append(items, map[string]any{
			"account_id":       accountID,
			"role":             roleValue,
			"status":           statusValue,
			"display_name":     displayName,
			"email":            email,
			"created_at":       createdAt,
			"xp_total":         xpTotal,
			"last_activity_at": lastActivityAt,
		})
	}
	return map[string]any{"items": items, "next_cursor": nil}, rows.Err()
}

func (s *Service) UserDetail(ctx context.Context, userID string) (map[string]any, error) {
	var role, displayName string
	var xpTotal int64
	var completedCourses, completedLessons int
	var lastActivityAt *string
	if err := s.db.QueryRow(ctx, `
		select a.role,
		       coalesce(sp.display_name, pp.display_name, tp.display_name, ap.display_name, ''),
		       coalesce(sgs.xp_total, 0),
		       coalesce((select count(*) from course_progress cp where cp.student_id = a.id and cp.status = 'completed'), 0),
		       coalesce((select count(*) from lesson_progress lp where lp.student_id = a.id and lp.status = 'completed'), 0),
		       (select max(cp.last_activity_at)::text from course_progress cp where cp.student_id = a.id)
		from accounts a
		left join student_profiles sp on sp.account_id = a.id
		left join parent_profiles pp on pp.account_id = a.id
		left join teacher_profiles tp on tp.account_id = a.id
		left join admin_profiles ap on ap.account_id = a.id
		left join student_game_state sgs on sgs.student_id = a.id
		where a.id = $1
	`, userID).Scan(&role, &displayName, &xpTotal, &completedCourses, &completedLessons, &lastActivityAt); err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrUserNotFound
		}
		return nil, err
	}
	return map[string]any{
		"user": map[string]any{
			"account_id":   userID,
			"role":         role,
			"display_name": displayName,
		},
		"stats": map[string]any{
			"xp_total":          xpTotal,
			"completed_courses": completedCourses,
			"completed_lessons": completedLessons,
			"last_activity_at":  lastActivityAt,
		},
	}, nil
}

func (s *Service) upsertIdentity(ctx context.Context, provider string, identity ResolvedIdentity) (string, string, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return "", "", err
	}
	defer tx.Rollback(ctx)

	var accountID string
	var role string
	var status string
	err = tx.QueryRow(ctx, `
		select a.id::text, a.role, a.status
		from external_identities ei
		join accounts a on a.id = ei.account_id
		where ei.provider = $1 and ei.provider_subject = $2
	`, provider, identity.Subject).Scan(&accountID, &role, &status)
	if err != nil && err != pgx.ErrNoRows {
		return "", "", err
	}

	if err == pgx.ErrNoRows {
		newID := uuid.NewString()
		accountID = newID
		role = "unselected"
		if _, err := tx.Exec(ctx, `
			insert into accounts(id, role, status)
			values ($1, 'unselected', 'active')
		`, newID); err != nil {
			return "", "", err
		}
		insertedNewIdentity := false
		insertErr := tx.QueryRow(ctx, `
			insert into external_identities(account_id, provider, provider_subject, email, email_verified, raw_profile_json)
			values ($1, $2, $3, $4, $5, $6)
			on conflict (provider, provider_subject) do nothing
			returning account_id::text
		`, newID, provider, identity.Subject, identity.Email, identity.EmailVerified, identity.RawProfile).Scan(&accountID)
		if insertErr == pgx.ErrNoRows {
			if _, err := tx.Exec(ctx, `delete from accounts where id = $1`, newID); err != nil {
				return "", "", err
			}
			if err := tx.QueryRow(ctx, `
				select a.id::text, a.role, a.status
				from external_identities ei
				join accounts a on a.id = ei.account_id
				where ei.provider = $1 and ei.provider_subject = $2
			`, provider, identity.Subject).Scan(&accountID, &role, &status); err != nil {
				return "", "", err
			}
		} else if insertErr != nil {
			return "", "", insertErr
		} else {
			insertedNewIdentity = true
		}
		if insertedNewIdentity {
			status = "active"
		}
	}

	if status == "blocked" {
		return "", "", ErrAccountBlocked
	}

	if err := tx.Commit(ctx); err != nil {
		return "", "", err
	}
	return accountID, role, nil
}

func teacherProfileComplete(ctx context.Context, db *pgxpool.Pool, accountID string) bool {
	var displayName string
	var organizationName *string
	err := db.QueryRow(ctx, `
		select display_name, organization_name
		from teacher_profiles
		where account_id = $1
	`, accountID).Scan(&displayName, &organizationName)
	if err != nil {
		return false
	}
	return strings.TrimSpace(displayName) != "" && organizationName != nil && strings.TrimSpace(*organizationName) != ""
}

func defaultDisplayName(ctx context.Context, tx pgx.Tx, accountID string) string {
	var email string
	var rawName string
	if err := tx.QueryRow(ctx, `
		select coalesce(email, ''), coalesce(raw_profile_json ->> 'name', '')
		from external_identities
		where account_id = $1
		order by created_at asc
		limit 1
	`, accountID).Scan(&email, &rawName); err == nil {
		if strings.TrimSpace(rawName) != "" {
			return rawName
		}
		if email != "" && strings.Contains(email, "@") {
			return strings.Split(email, "@")[0]
		}
	}
	return "User"
}

type statePayload struct {
	State      string `json:"state"`
	ReturnTo   string `json:"return_to"`
	IssuedAtUN int64  `json:"issued_at_unix"`
}

func signState(payload statePayload, secret string) (string, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	bodyEnc := base64.RawURLEncoding.EncodeToString(body)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(bodyEnc))
	signature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return bodyEnc + "." + signature, nil
}

func verifyState(value string, secret string) (statePayload, error) {
	parts := strings.Split(value, ".")
	if len(parts) != 2 {
		return statePayload{}, ErrInvalidState
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(parts[0]))
	expected := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(parts[1])) {
		return statePayload{}, ErrInvalidState
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return statePayload{}, ErrInvalidState
	}
	var payload statePayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return statePayload{}, ErrInvalidState
	}
	if payload.IssuedAtUN == 0 || time.Now().Unix()-payload.IssuedAtUN > 300 {
		return statePayload{}, ErrInvalidState
	}
	return payload, nil
}

func validateReturnTo(returnTo string, allowed []string) error {
	if strings.TrimSpace(returnTo) == "" {
		return nil
	}
	if strings.HasPrefix(returnTo, "//") {
		return ErrInvalidReturnTo
	}
	if strings.HasPrefix(returnTo, "http://") || strings.HasPrefix(returnTo, "https://") {
		return ErrInvalidReturnTo
	}
	for _, prefix := range allowed {
		if strings.HasPrefix(returnTo, prefix) {
			return nil
		}
	}
	return ErrInvalidReturnTo
}

func randomToken(size int) (string, error) {
	buf := make([]byte, size)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func hashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

var (
	ErrInvalidState                = fmt.Errorf("invalid_sso_state")
	ErrInvalidReturnTo             = fmt.Errorf("invalid_return_to")
	ErrUnknownProvider             = fmt.Errorf("unknown_provider")
	ErrAccountBlocked              = fmt.Errorf("account_blocked")
	ErrUserNotFound                = fmt.Errorf("user_not_found")
	ErrForbiddenAdminRoleSelection = fmt.Errorf("forbidden_admin_role_selection")
	ErrInvalidRoleSelection        = fmt.Errorf("invalid_role_selection")
	ErrRoleAlreadySet              = fmt.Errorf("role_already_set")
)
