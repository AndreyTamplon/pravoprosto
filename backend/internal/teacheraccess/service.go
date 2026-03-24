package teacheraccess

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	platformconfig "pravoprost/backend/internal/platform/config"
	platformlogging "pravoprost/backend/internal/platform/logging"
)

type Service struct {
	db     *pgxpool.Pool
	config platformconfig.Config
	logger *slog.Logger
}

func NewService(db *pgxpool.Pool, cfg platformconfig.Config, logger *slog.Logger) *Service {
	return &Service{db: db, config: cfg, logger: logger}
}

type CreateLinkInput struct {
	ExpiresAt *time.Time
}

type CreateLinkView struct {
	LinkID    string  `json:"link_id"`
	ClaimURL  *string `json:"claim_url,omitempty"`
	InviteURL *string `json:"invite_url,omitempty"`
	URLStatus string  `json:"url_status"`
	Status    string  `json:"status"`
	CreatedAt string  `json:"created_at"`
	ExpiresAt *string `json:"expires_at"`
}

type LinkListView struct {
	Items []CreateLinkView `json:"items"`
}

type ClaimResult struct {
	CourseID string `json:"course_id"`
	Granted  bool   `json:"granted"`
}

type StudentsView struct {
	CourseID string           `json:"course_id"`
	Title    string           `json:"title"`
	Students []map[string]any `json:"students"`
}

type StudentDetailView struct {
	Student map[string]any   `json:"student"`
	Summary map[string]any   `json:"summary"`
	Lessons []map[string]any `json:"lessons"`
}

func DecodeCreateLink(r *http.Request) (CreateLinkInput, error) {
	var body struct {
		ExpiresAt *string `json:"expires_at"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		return CreateLinkInput{}, err
	}
	var expiresAt *time.Time
	if body.ExpiresAt != nil && strings.TrimSpace(*body.ExpiresAt) != "" {
		parsed, err := time.Parse(time.RFC3339, *body.ExpiresAt)
		if err != nil {
			return CreateLinkInput{}, err
		}
		expiresAt = &parsed
	}
	return CreateLinkInput{ExpiresAt: expiresAt}, nil
}

func DecodeClaim(r *http.Request) (string, error) {
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		return "", err
	}
	return strings.TrimSpace(body.Token), nil
}

func (s *Service) CreateLink(ctx context.Context, teacherID string, courseID string, input CreateLinkInput) (CreateLinkView, error) {
	published, err := s.ensureTeacherPrivateCourse(ctx, teacherID, courseID)
	if err != nil {
		return CreateLinkView{}, err
	}
	if !published {
		return CreateLinkView{}, ErrCourseNotPublished
	}

	token, err := randomToken(24)
	if err != nil {
		return CreateLinkView{}, err
	}
	var linkID string
	tokenEncrypted, err := encryptToken(token, s.config.SigningSecret)
	if err != nil {
		return CreateLinkView{}, err
	}
	createdAt := time.Now().UTC()
	if err := s.db.QueryRow(ctx, `
		insert into course_access_links(course_id, token_hash, token_encrypted, status, expires_at, created_by_account_id)
		values ($1, $2, $3, 'active', $4, $5)
		returning id::text
	`, courseID, hashToken(token), tokenEncrypted, input.ExpiresAt, teacherID).Scan(&linkID); err != nil {
		return CreateLinkView{}, err
	}
	var expiresAt *string
	if input.ExpiresAt != nil {
		formatted := input.ExpiresAt.UTC().Format(time.RFC3339)
		expiresAt = &formatted
	}
	claimURL := strings.TrimRight(s.config.BaseURL, "/") + "/claim/course-link#token=" + token
	return CreateLinkView{
		LinkID:    linkID,
		ClaimURL:  &claimURL,
		InviteURL: &claimURL,
		URLStatus: "available",
		Status:    "active",
		CreatedAt: createdAt.Format(time.RFC3339),
		ExpiresAt: expiresAt,
	}, nil
}

func (s *Service) ListLinks(ctx context.Context, teacherID string, courseID string) (LinkListView, error) {
	if _, err := s.ensureTeacherPrivateCourse(ctx, teacherID, courseID); err != nil {
		return LinkListView{}, err
	}
	rows, err := s.db.Query(ctx, `
		select id::text, token_encrypted, status, created_at::text, expires_at::text
		from course_access_links
		where course_id = $1 and created_by_account_id = $2
		order by created_at desc
	`, courseID, teacherID)
	if err != nil {
		return LinkListView{}, err
	}
	defer rows.Close()

	items := make([]CreateLinkView, 0)
	for rows.Next() {
		var linkID, status, createdAt string
		var tokenEncrypted *string
		var expiresAt *string
		if err := rows.Scan(&linkID, &tokenEncrypted, &status, &createdAt, &expiresAt); err != nil {
			return LinkListView{}, err
		}
		var claimURL *string
		urlStatus := "legacy_unavailable"
		if tokenEncrypted != nil && strings.TrimSpace(*tokenEncrypted) != "" {
			token, err := decryptToken(*tokenEncrypted, s.config.SigningSecret)
			if err == nil {
				url := strings.TrimRight(s.config.BaseURL, "/") + "/claim/course-link#token=" + token
				claimURL = &url
				urlStatus = "available"
			} else {
				platformlogging.FromContext(ctx, s.logger).Warn("failed to decrypt teacher access token", "link_id", linkID, "err", err)
			}
		}
		if status == "active" && expiresAt != nil {
			if parsed, err := time.Parse(time.RFC3339, *expiresAt); err == nil && time.Now().After(parsed) {
				status = "expired"
			}
		}
		items = append(items, CreateLinkView{
			LinkID:    linkID,
			ClaimURL:  claimURL,
			InviteURL: claimURL,
			URLStatus: urlStatus,
			Status:    status,
			CreatedAt: createdAt,
			ExpiresAt: expiresAt,
		})
	}
	return LinkListView{Items: items}, rows.Err()
}

func (s *Service) RevokeLink(ctx context.Context, teacherID string, linkID string) (map[string]string, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var status string
	if err := tx.QueryRow(ctx, `
		select l.status
		from course_access_links l
		join courses c on c.id = l.course_id
		where l.id = $1 and c.owner_kind = 'teacher' and c.owner_account_id = $2 and c.deleted_at is null
		for update
	`, linkID, teacherID).Scan(&status); err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrLinkNotFound
		}
		return nil, err
	}
	if status != "active" {
		return nil, ErrLinkAlreadyResolved
	}
	if _, err := tx.Exec(ctx, `update course_access_links set status = 'revoked', revoked_at = now() where id = $1`, linkID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return map[string]string{"link_id": linkID, "status": "revoked"}, nil
}

func (s *Service) ClaimLink(ctx context.Context, studentID string, token string) (ClaimResult, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return ClaimResult{}, err
	}
	defer tx.Rollback(ctx)

	var linkID, courseID, status, createdBy string
	var expiresAt *time.Time
	var published bool
	err = tx.QueryRow(ctx, `
		select l.id::text,
		       l.course_id::text,
		       l.status,
		       l.expires_at,
		       l.created_by_account_id::text,
		       exists(select 1 from course_revisions cr where cr.course_id = l.course_id and cr.is_current = true)
		from course_access_links l
		join courses c on c.id = l.course_id
		where l.token_hash = $1 and c.owner_kind = 'teacher' and c.deleted_at is null
		for update
	`, hashToken(token)).Scan(&linkID, &courseID, &status, &expiresAt, &createdBy, &published)
	if err != nil {
		if err == pgx.ErrNoRows {
			return ClaimResult{}, ErrLinkNotFound
		}
		return ClaimResult{}, err
	}
	if status == "revoked" {
		return ClaimResult{}, ErrLinkRevoked
	}
	if status == "expired" {
		return ClaimResult{}, ErrLinkExpired
	}
	if expiresAt != nil && time.Now().After(*expiresAt) {
		if _, err := tx.Exec(ctx, `update course_access_links set status = 'expired' where id = $1 and status = 'active'`, linkID); err != nil {
			return ClaimResult{}, err
		}
		return ClaimResult{}, ErrLinkExpired
	}
	if !published {
		return ClaimResult{}, ErrCourseNotPublished
	}

	var grantID string
	err = tx.QueryRow(ctx, `
		insert into course_access_grants(course_id, student_id, source, granted_by_account_id, first_claimed_via_link_id)
		values ($1, $2, 'teacher_link', $3, $4)
		on conflict do nothing
		returning id::text
	`, courseID, studentID, createdBy, linkID).Scan(&grantID)
	if err != nil && err != pgx.ErrNoRows {
		return ClaimResult{}, err
	}
	if err == pgx.ErrNoRows {
		if err := tx.QueryRow(ctx, `
			select id::text
			from course_access_grants
			where course_id = $1 and student_id = $2 and archived_at is null
		`, courseID, studentID).Scan(&grantID); err != nil {
			return ClaimResult{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return ClaimResult{}, err
	}
	return ClaimResult{CourseID: courseID, Granted: grantID != ""}, nil
}

func (s *Service) ListStudents(ctx context.Context, teacherID string, courseID string) (StudentsView, error) {
	if _, err := s.ensureTeacherPrivateCourse(ctx, teacherID, courseID); err != nil {
		return StudentsView{}, err
	}
	var title string
	if err := s.db.QueryRow(ctx, `
		select coalesce(cr.title, d.title)
		from courses c
		join course_drafts d on d.course_id = c.id
		left join course_revisions cr on cr.course_id = c.id and cr.is_current = true
		where c.id = $1
	`, courseID).Scan(&title); err != nil {
		return StudentsView{}, err
	}
	rows, err := s.db.Query(ctx, `
		select sp.account_id::text,
		       sp.display_name,
		       coalesce((
		           select floor((count(*) filter (where lp.status = 'completed')::decimal / nullif(count(crl.lesson_id), 0)::decimal) * 100)::int
		           from course_progress cp
		           join course_revision_lessons crl on crl.course_revision_id = cp.course_revision_id
		           left join lesson_progress lp on lp.course_progress_id = cp.id and lp.lesson_id = crl.lesson_id
		           where cp.student_id = sp.account_id and cp.course_id = c.id
		           group by cp.id
		           order by case when cp.status = 'in_progress' then 0 else 1 end, cp.started_at desc
		           limit 1
		       ), 0),
		       coalesce(sgs.xp_total, 0),
		       coalesce((
		           select floor((cp.correct_answers::decimal / nullif(cp.correct_answers + cp.partial_answers + cp.incorrect_answers, 0)::decimal) * 100)::int
		           from course_progress cp
		           where cp.student_id = sp.account_id and cp.course_id = c.id
		           order by case when cp.status = 'in_progress' then 0 else 1 end, cp.started_at desc
		           limit 1
		       ), 0),
		       (
		           select cp.last_activity_at::text
		           from course_progress cp
		           where cp.student_id = sp.account_id and cp.course_id = c.id
		           order by case when cp.status = 'in_progress' then 0 else 1 end, cp.started_at desc
		           limit 1
		       )
		from course_access_grants g
		join courses c on c.id = g.course_id
		join student_profiles sp on sp.account_id = g.student_id
		left join student_game_state sgs on sgs.student_id = sp.account_id
		where g.course_id = $1 and g.archived_at is null
		order by sp.display_name asc
	`, courseID)
	if err != nil {
		return StudentsView{}, err
	}
	defer rows.Close()

	students := make([]map[string]any, 0)
	for rows.Next() {
		var studentID, displayName string
		var progressPercent, xpTotal, correctnessPercent int
		var lastActivityAt *string
		if err := rows.Scan(&studentID, &displayName, &progressPercent, &xpTotal, &correctnessPercent, &lastActivityAt); err != nil {
			return StudentsView{}, err
		}
		students = append(students, map[string]any{
			"student_id":          studentID,
			"display_name":        displayName,
			"progress_percent":    progressPercent,
			"xp_total":            xpTotal,
			"correctness_percent": correctnessPercent,
			"last_activity_at":    lastActivityAt,
		})
	}
	return StudentsView{CourseID: courseID, Title: title, Students: students}, rows.Err()
}

func (s *Service) StudentDetail(ctx context.Context, teacherID string, courseID string, studentID string) (StudentDetailView, error) {
	if _, err := s.ensureTeacherPrivateCourse(ctx, teacherID, courseID); err != nil {
		return StudentDetailView{}, err
	}
	var visible int
	if err := s.db.QueryRow(ctx, `
		select count(*)
		from course_access_grants
		where course_id = $1 and student_id = $2 and archived_at is null
	`, courseID, studentID).Scan(&visible); err != nil {
		return StudentDetailView{}, err
	}
	if visible == 0 {
		return StudentDetailView{}, ErrStudentNotVisible
	}

	view := StudentDetailView{
		Student: map[string]any{},
		Summary: map[string]any{},
		Lessons: []map[string]any{},
	}
	var displayName string
	if err := s.db.QueryRow(ctx, `
		select display_name
		from student_profiles
		where account_id = $1
	`, studentID).Scan(&displayName); err != nil {
		return StudentDetailView{}, err
	}
	view.Student["student_id"] = studentID
	view.Student["display_name"] = displayName

	var progressPercent, xpTotal, correctnessPercent int
	if err := s.db.QueryRow(ctx, `
		select
		    coalesce((
		        select floor((count(*) filter (where lp.status = 'completed')::decimal / nullif(count(crl.lesson_id), 0)::decimal) * 100)::int
		        from course_progress cp
		        join course_revision_lessons crl on crl.course_revision_id = cp.course_revision_id
		        left join lesson_progress lp on lp.course_progress_id = cp.id and lp.lesson_id = crl.lesson_id
		        where cp.student_id = $1 and cp.course_id = $2
		        group by cp.id
		        order by case when cp.status = 'in_progress' then 0 else 1 end, cp.started_at desc
		        limit 1
		    ), 0),
		    coalesce((select xp_total from student_game_state where student_id = $1), 0),
		    coalesce((
		        select floor((cp.correct_answers::decimal / nullif(cp.correct_answers + cp.partial_answers + cp.incorrect_answers, 0)::decimal) * 100)::int
		        from course_progress cp
		        where cp.student_id = $1 and cp.course_id = $2
		        order by case when cp.status = 'in_progress' then 0 else 1 end, cp.started_at desc
		        limit 1
		    ), 0)
	`, studentID, courseID).Scan(&progressPercent, &xpTotal, &correctnessPercent); err != nil {
		return StudentDetailView{}, err
	}
	view.Summary["progress_percent"] = progressPercent
	view.Summary["xp_total"] = xpTotal
	view.Summary["correctness_percent"] = correctnessPercent

	rows, err := s.db.Query(ctx, `
		select crl.lesson_id, crl.title, coalesce(lp.status, 'not_started'), lp.best_verdict, coalesce(lp.attempts_count, 0)
		from (
		    select cp.id, cp.course_revision_id
		    from course_progress cp
		    where cp.student_id = $1 and cp.course_id = $2
		    order by case when cp.status = 'in_progress' then 0 else 1 end, cp.started_at desc
		    limit 1
		) latest
		join course_revision_lessons crl on crl.course_revision_id = latest.course_revision_id
		left join lesson_progress lp on lp.course_progress_id = latest.id and lp.lesson_id = crl.lesson_id
		order by crl.sort_order asc
	`, studentID, courseID)
	if err != nil {
		return StudentDetailView{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var lessonID, title, status string
		var bestVerdict *string
		var attemptsCount int
		if err := rows.Scan(&lessonID, &title, &status, &bestVerdict, &attemptsCount); err != nil {
			return StudentDetailView{}, err
		}
		view.Lessons = append(view.Lessons, map[string]any{
			"lesson_id":      lessonID,
			"title":          title,
			"status":         status,
			"best_verdict":   bestVerdict,
			"attempts_count": attemptsCount,
		})
	}
	return view, rows.Err()
}

func (s *Service) AdminGrant(ctx context.Context, adminID string, courseID string, studentID string) (map[string]string, error) {
	if _, err := uuid.Parse(strings.TrimSpace(studentID)); err != nil {
		return nil, ErrInvalidStudentID
	}
	var role string
	if err := s.db.QueryRow(ctx, `select role from accounts where id = $1`, studentID).Scan(&role); err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrInvalidStudentID
		}
		return nil, err
	}
	if role != "student" {
		return nil, ErrStudentRoleRequired
	}
	published, err := s.ensureCourseGrantable(ctx, courseID)
	if err != nil {
		return nil, err
	}
	if !published {
		return nil, ErrCourseNotPublished
	}
	var grantID string
	err = s.db.QueryRow(ctx, `
		insert into course_access_grants(course_id, student_id, source, granted_by_account_id)
		values ($1, $2, 'admin_grant', $3)
		on conflict do nothing
		returning id::text
	`, courseID, studentID, adminID).Scan(&grantID)
	if err != nil && err != pgx.ErrNoRows {
		return nil, err
	}
	if err == pgx.ErrNoRows {
		if err := s.db.QueryRow(ctx, `
			select id::text
			from course_access_grants
			where course_id = $1 and student_id = $2 and archived_at is null
		`, courseID, studentID).Scan(&grantID); err != nil {
			return nil, err
		}
	}
	return map[string]string{"grant_id": grantID, "course_id": courseID, "student_id": studentID}, nil
}

func (s *Service) ensureTeacherPrivateCourse(ctx context.Context, teacherID string, courseID string) (bool, error) {
	var ownerKind, ownerID, courseKind string
	var published bool
	if err := s.db.QueryRow(ctx, `
		select owner_kind, owner_account_id::text, course_kind,
		       exists(select 1 from course_revisions cr where cr.course_id = c.id and cr.is_current = true)
		from courses c
		where c.id = $1 and c.deleted_at is null
	`, courseID).Scan(&ownerKind, &ownerID, &courseKind, &published); err != nil {
		if err == pgx.ErrNoRows {
			return false, ErrCourseNotFound
		}
		return false, err
	}
	if ownerKind != "teacher" || ownerID != teacherID || courseKind != "teacher_private" {
		return false, ErrCourseNotTeacherPrivate
	}
	return published, nil
}

func (s *Service) ensureCourseGrantable(ctx context.Context, courseID string) (bool, error) {
	var ownerKind, courseKind string
	var published bool
	if err := s.db.QueryRow(ctx, `
		select owner_kind, course_kind,
		       exists(select 1 from course_revisions cr where cr.course_id = c.id and cr.is_current = true)
		from courses c
		where c.id = $1 and c.deleted_at is null
	`, courseID).Scan(&ownerKind, &courseKind, &published); err != nil {
		if err == pgx.ErrNoRows {
			return false, ErrCourseNotFound
		}
		return false, err
	}
	if ownerKind != "teacher" || courseKind != "teacher_private" {
		return false, ErrPlatformContentMustUseEntitlement
	}
	return published, nil
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
	ciphertext := gcm.Seal(nil, nonce, []byte(raw), nil)
	payload := append(nonce, ciphertext...)
	return base64.RawURLEncoding.EncodeToString(payload), nil
}

func decryptToken(value string, secret string) (string, error) {
	payload, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return "", err
	}
	key := sha256.Sum256([]byte(secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(payload) < gcm.NonceSize() {
		return "", fmt.Errorf("invalid_encrypted_token")
	}
	nonce := payload[:gcm.NonceSize()]
	ciphertext := payload[gcm.NonceSize():]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

var (
	ErrCourseNotFound                    = fmt.Errorf("course_not_found")
	ErrCourseNotPublished                = fmt.Errorf("course_not_published")
	ErrCourseNotTeacherPrivate           = fmt.Errorf("course_not_teacher_private")
	ErrLinkNotFound                      = fmt.Errorf("course_link_not_found")
	ErrLinkRevoked                       = fmt.Errorf("course_link_revoked")
	ErrLinkExpired                       = fmt.Errorf("course_link_expired")
	ErrLinkAlreadyResolved               = fmt.Errorf("course_link_already_resolved")
	ErrInvalidStudentID                  = fmt.Errorf("invalid_student_id")
	ErrStudentRoleRequired               = fmt.Errorf("student_role_required")
	ErrStudentNotVisible                 = fmt.Errorf("student_not_visible")
	ErrPlatformContentMustUseEntitlement = fmt.Errorf("platform_content_must_use_entitlement")
)
