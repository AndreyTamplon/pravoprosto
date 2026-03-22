package guardianship

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	platformconfig "pravoprost/backend/internal/platform/config"
)

type Service struct {
	db     *pgxpool.Pool
	config platformconfig.Config
}

func NewService(db *pgxpool.Pool, cfg platformconfig.Config) *Service {
	return &Service{db: db, config: cfg}
}

type CreateInviteView struct {
	InviteID  string `json:"invite_id"`
	ClaimURL  string `json:"claim_url"`
	InviteURL string `json:"invite_url"`
	URLStatus string `json:"url_status"`
	CreatedAt string `json:"created_at"`
	ExpiresAt string `json:"expires_at"`
}

type InviteListItem struct {
	InviteID  string  `json:"invite_id"`
	Status    string  `json:"status"`
	InviteURL *string `json:"invite_url,omitempty"`
	ClaimURL  *string `json:"claim_url,omitempty"`
	URLStatus string  `json:"url_status"`
	CreatedAt string  `json:"created_at"`
	ExpiresAt string  `json:"expires_at"`
	UsedAt    *string `json:"used_at"`
}

type InviteListView struct {
	Items []InviteListItem `json:"items"`
}

type ClaimView struct {
	Parent struct {
		AccountID   string `json:"account_id"`
		DisplayName string `json:"display_name"`
	} `json:"parent"`
	LinkStatus string `json:"link_status"`
}

type ChildrenListView struct {
	Children []ChildSummaryView `json:"children"`
}

type ChildSummaryView struct {
	StudentID         string  `json:"student_id"`
	DisplayName       string  `json:"display_name"`
	AvatarURL         *string `json:"avatar_url"`
	XPTotal           int64   `json:"xp_total"`
	CurrentStreakDays int     `json:"current_streak_days"`
	CoursesInProgress int     `json:"courses_in_progress"`
	CoursesCompleted  int     `json:"courses_completed"`
	CompletedLessons  int     `json:"completed_lessons"`
	LastActivityAt    *string `json:"last_activity_at"`
}

type ChildProgressView struct {
	Student struct {
		StudentID   string  `json:"student_id"`
		DisplayName string  `json:"display_name"`
		AvatarURL   *string `json:"avatar_url"`
	} `json:"student"`
	Summary struct {
		XPTotal           int64 `json:"xp_total"`
		CurrentStreakDays int   `json:"current_streak_days"`
		TimeSpentMinutes  int   `json:"time_spent_minutes"`
		CorrectnessPct    int   `json:"correctness_percent"`
	} `json:"summary"`
	Courses []map[string]any `json:"courses"`
}

func (s *Service) CreateInvite(ctx context.Context, parentID string) (CreateInviteView, error) {
	rawToken, err := randomToken(24)
	if err != nil {
		return CreateInviteView{}, err
	}
	tokenEncrypted, err := encryptToken(rawToken, s.config.SigningSecret)
	if err != nil {
		return CreateInviteView{}, err
	}
	expiresAt := time.Now().Add(7 * 24 * time.Hour)
	var inviteID string
	var createdAt time.Time
	err = s.db.QueryRow(ctx, `
		insert into guardian_link_invites(created_by_parent_id, token_hash, token_encrypted, status, expires_at)
		values ($1, $2, $3, 'active', $4)
		returning id::text, created_at
	`, parentID, hashToken(rawToken), tokenEncrypted, expiresAt).Scan(&inviteID, &createdAt)
	if err != nil {
		return CreateInviteView{}, err
	}
	claimURL := strings.TrimRight(s.config.BaseURL, "/") + "/claim/guardian-link#token=" + rawToken
	return CreateInviteView{
		InviteID:  inviteID,
		ClaimURL:  claimURL,
		InviteURL: claimURL,
		URLStatus: "available",
		CreatedAt: createdAt.UTC().Format(time.RFC3339),
		ExpiresAt: expiresAt.UTC().Format(time.RFC3339),
	}, nil
}

func (s *Service) ListInvites(ctx context.Context, parentID string) (InviteListView, error) {
	rows, err := s.db.Query(ctx, `
		select id::text, status, token_encrypted, created_at::text, expires_at::text, used_at::text
		from guardian_link_invites
		where created_by_parent_id = $1
		order by created_at desc
	`, parentID)
	if err != nil {
		return InviteListView{}, err
	}
	defer rows.Close()

	items := make([]InviteListItem, 0)
	for rows.Next() {
		var item InviteListItem
		var tokenEncrypted *string
		if err := rows.Scan(&item.InviteID, &item.Status, &tokenEncrypted, &item.CreatedAt, &item.ExpiresAt, &item.UsedAt); err != nil {
			return InviteListView{}, err
		}
		if tokenEncrypted != nil && strings.TrimSpace(*tokenEncrypted) != "" {
			rawToken, err := decryptToken(*tokenEncrypted, s.config.SigningSecret)
			if err != nil {
				item.URLStatus = "legacy_unavailable"
				items = append(items, item)
				continue
			}
			claimURL := strings.TrimRight(s.config.BaseURL, "/") + "/claim/guardian-link#token=" + rawToken
			item.InviteURL = &claimURL
			item.ClaimURL = &claimURL
			item.URLStatus = "available"
		} else {
			item.URLStatus = "legacy_unavailable"
		}
		items = append(items, item)
	}
	return InviteListView{Items: items}, rows.Err()
}

func (s *Service) RevokeInvite(ctx context.Context, parentID string, inviteID string) (map[string]string, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var status string
	err = tx.QueryRow(ctx, `
		select status
		from guardian_link_invites
		where id = $1 and created_by_parent_id = $2
		for update
	`, inviteID, parentID).Scan(&status)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrInviteNotFound
		}
		return nil, err
	}
	if status != "active" {
		return nil, ErrInviteAlreadyResolved
	}
	if _, err := tx.Exec(ctx, `
		update guardian_link_invites
		set status = 'revoked', revoked_at = now()
		where id = $1
	`, inviteID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return map[string]string{"invite_id": inviteID, "status": "revoked"}, nil
}

func (s *Service) ClaimInvite(ctx context.Context, studentID string, token string) (ClaimView, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return ClaimView{}, err
	}
	defer tx.Rollback(ctx)

	var inviteID string
	var parentID string
	var status string
	var expiresAt time.Time
	err = tx.QueryRow(ctx, `
		select id::text, created_by_parent_id::text, status, expires_at
		from guardian_link_invites
		where token_hash = $1
		for update
	`, hashToken(token)).Scan(&inviteID, &parentID, &status, &expiresAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			return ClaimView{}, ErrInviteNotFound
		}
		return ClaimView{}, err
	}

	if status == "claimed" {
		return ClaimView{}, ErrInviteAlreadyUsed
	}
	if status != "active" {
		return ClaimView{}, ErrInviteInvalidState
	}
	if time.Now().After(expiresAt) {
		return ClaimView{}, ErrInviteExpired
	}

	var existingCount int
	if err := tx.QueryRow(ctx, `
		select count(*)
		from guardian_links
		where parent_id = $1 and student_id = $2 and status = 'active'
	`, parentID, studentID).Scan(&existingCount); err != nil {
		return ClaimView{}, err
	}
	if existingCount > 0 {
		if _, err := tx.Exec(ctx, `
			update guardian_link_invites
			set status = 'claimed', claimed_by_student_id = $2, used_at = now()
			where id = $1
		`, inviteID, studentID); err != nil {
			return ClaimView{}, err
		}
		return s.finishClaim(ctx, tx, inviteID, parentID)
	}

	rows, err := tx.Query(ctx, `
		select parent_slot
		from guardian_links
		where student_id = $1 and status = 'active'
		for update
	`, studentID)
	if err != nil {
		return ClaimView{}, err
	}
	defer rows.Close()

	used := map[int]bool{}
	for rows.Next() {
		var slot int
		if err := rows.Scan(&slot); err != nil {
			return ClaimView{}, err
		}
		used[slot] = true
	}
	if rows.Err() != nil {
		return ClaimView{}, rows.Err()
	}
	if len(used) >= 2 {
		return ClaimView{}, ErrGuardianLimitReached
	}
	slot := 1
	if used[1] {
		slot = 2
	}

	if _, err := tx.Exec(ctx, `
		insert into guardian_links(parent_id, student_id, parent_slot, status, invite_id)
		values ($1, $2, $3, 'active', $4)
	`, parentID, studentID, slot, inviteID); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return ClaimView{}, ErrGuardianLimitReached
		}
		return ClaimView{}, err
	}
	if _, err := tx.Exec(ctx, `
		update guardian_link_invites
		set status = 'claimed', claimed_by_student_id = $2, used_at = now()
		where id = $1
	`, inviteID, studentID); err != nil {
		return ClaimView{}, err
	}
	return s.finishClaim(ctx, tx, inviteID, parentID)
}

func (s *Service) finishClaim(ctx context.Context, tx pgx.Tx, inviteID string, parentID string) (ClaimView, error) {
	var view ClaimView
	view.LinkStatus = "active"
	err := tx.QueryRow(ctx, `
		select p.account_id::text, p.display_name
		from parent_profiles p
		where p.account_id = $1
	`, parentID).Scan(&view.Parent.AccountID, &view.Parent.DisplayName)
	if err != nil {
		return ClaimView{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ClaimView{}, err
	}
	return view, nil
}

func (s *Service) ListChildren(ctx context.Context, parentID string) (ChildrenListView, error) {
	rows, err := s.db.Query(ctx, `
		select sp.account_id::text,
		       sp.display_name,
		       case when a.id is null then null else '/assets/' || a.id::text end as avatar_url,
		       coalesce(sgs.xp_total, 0),
		       coalesce(sss.current_streak_days, 0),
		       coalesce((select count(*) from course_progress cp where cp.student_id = sp.account_id and cp.status = 'in_progress'), 0),
		       coalesce((select count(*) from course_progress cp where cp.student_id = sp.account_id and cp.status = 'completed'), 0),
		       coalesce((select count(*) from lesson_progress lp where lp.student_id = sp.account_id and lp.status = 'completed'), 0),
		       (
		           select max(cp.last_activity_at)::text
		           from course_progress cp
		           where cp.student_id = sp.account_id
		       )
		from guardian_links gl
		join student_profiles sp on sp.account_id = gl.student_id
		left join assets a on a.id = sp.avatar_asset_id and a.deleted_at is null
		left join student_game_state sgs on sgs.student_id = sp.account_id
		left join student_streak_state sss on sss.student_id = sp.account_id
		where gl.parent_id = $1 and gl.status = 'active'
		order by sp.display_name asc
	`, parentID)
	if err != nil {
		return ChildrenListView{}, err
	}
	defer rows.Close()

	items := make([]ChildSummaryView, 0)
	for rows.Next() {
		var item ChildSummaryView
		if err := rows.Scan(
			&item.StudentID,
			&item.DisplayName,
			&item.AvatarURL,
			&item.XPTotal,
			&item.CurrentStreakDays,
			&item.CoursesInProgress,
			&item.CoursesCompleted,
			&item.CompletedLessons,
			&item.LastActivityAt,
		); err != nil {
			return ChildrenListView{}, err
		}
		items = append(items, item)
	}
	return ChildrenListView{Children: items}, rows.Err()
}

func (s *Service) ChildProgress(ctx context.Context, parentID string, studentID string) (ChildProgressView, error) {
	var linked bool
	if err := s.db.QueryRow(ctx, `
		select exists(
			select 1 from guardian_links
			where parent_id = $1 and student_id = $2 and status = 'active'
		)
	`, parentID, studentID).Scan(&linked); err != nil {
		return ChildProgressView{}, err
	}
	if !linked {
		return ChildProgressView{}, ErrChildNotVisible
	}

	var view ChildProgressView
	err := s.db.QueryRow(ctx, `
		select sp.account_id::text,
		       sp.display_name,
		       case when a.id is null then null else '/assets/' || a.id::text end as avatar_url,
		       coalesce(sgs.xp_total, 0),
		       coalesce(sss.current_streak_days, 0),
		       coalesce((
		           select round(
		               100.0 * sum(cp.correct_answers + cp.partial_answers)::numeric /
		               nullif(sum(cp.correct_answers + cp.partial_answers + cp.incorrect_answers), 0)
		           )::int
		           from course_progress cp
		           where cp.student_id = sp.account_id
		       ), 0)
		from student_profiles sp
		left join assets a on a.id = sp.avatar_asset_id and a.deleted_at is null
		left join student_game_state sgs on sgs.student_id = sp.account_id
		left join student_streak_state sss on sss.student_id = sp.account_id
		where sp.account_id = $1
	`, studentID).Scan(
		&view.Student.StudentID,
		&view.Student.DisplayName,
		&view.Student.AvatarURL,
		&view.Summary.XPTotal,
		&view.Summary.CurrentStreakDays,
		&view.Summary.CorrectnessPct,
	)
	if err != nil {
		return ChildProgressView{}, err
	}
	view.Summary.TimeSpentMinutes = 0
	view.Courses = make([]map[string]any, 0)

	rows, err := s.db.Query(ctx, `
		select cp.course_id::text,
		       cr.title,
		       cp.status,
		       completed.completed_count,
		       totals.total_count,
		       cp.correct_answers,
		       cp.partial_answers,
		       cp.incorrect_answers,
		       cp.last_activity_at::text,
		       case
		           when totals.total_count = 0 then 0
		           else floor((completed.completed_count::decimal / totals.total_count::decimal) * 100)::int
		       end as progress_percent
		from course_progress cp
		join course_revisions cr on cr.id = cp.course_revision_id
		left join lateral (
		    select count(*) as completed_count
		    from lesson_progress lp
		    where lp.course_progress_id = cp.id and lp.status = 'completed'
		) completed on true
		left join lateral (
		    select count(*) as total_count
		    from course_revision_lessons crl
		    where crl.course_revision_id = cp.course_revision_id
		) totals on true
		where cp.student_id = $1
		order by cp.started_at
	`, studentID)
	if err != nil {
		return ChildProgressView{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var courseID, title, status, lastActivityAt string
		var completedLessons, totalLessons, correctAnswers, partialAnswers, incorrectAnswers, percent int
		if err := rows.Scan(&courseID, &title, &status, &completedLessons, &totalLessons, &correctAnswers, &partialAnswers, &incorrectAnswers, &lastActivityAt, &percent); err != nil {
			return ChildProgressView{}, err
		}
		view.Courses = append(view.Courses, map[string]any{
			"course_id":         courseID,
			"title":             title,
			"status":            status,
			"completed_lessons": completedLessons,
			"total_lessons":     totalLessons,
			"correct_answers":   correctAnswers,
			"partial_answers":   partialAnswers,
			"incorrect_answers": incorrectAnswers,
			"last_activity_at":  lastActivityAt,
			"progress_percent":  percent,
			"lessons":           []any{},
		})
	}
	return view, rows.Err()
}

func DecodeClaimRequest(r *http.Request) (string, error) {
	var payload struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		return "", err
	}
	return payload.Token, nil
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

func encryptToken(raw string, secret string) (string, error) {
	key := sha256.Sum256([]byte(secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	cipherText := gcm.Seal(nil, nonce, []byte(raw), nil)
	return base64.RawURLEncoding.EncodeToString(append(nonce, cipherText...)), nil
}

func decryptToken(value string, secret string) (string, error) {
	key := sha256.Sum256([]byte(secret))
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(raw) < gcm.NonceSize() {
		return "", fmt.Errorf("invalid_encrypted_token")
	}
	nonce := raw[:gcm.NonceSize()]
	cipherText := raw[gcm.NonceSize():]
	plain, err := gcm.Open(nil, nonce, cipherText, nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

var (
	ErrInviteNotFound        = fmt.Errorf("invite_not_found")
	ErrInviteAlreadyUsed     = fmt.Errorf("invite_already_used")
	ErrInviteExpired         = fmt.Errorf("invite_expired")
	ErrInviteInvalidState    = fmt.Errorf("invite_invalid_state")
	ErrGuardianLimitReached  = fmt.Errorf("guardian_limit_reached")
	ErrInviteAlreadyResolved = fmt.Errorf("invite_already_resolved")
	ErrChildNotVisible       = fmt.Errorf("child_not_visible")
)
