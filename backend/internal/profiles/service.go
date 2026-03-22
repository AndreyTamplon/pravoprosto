package profiles

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	db *pgxpool.Pool
}

func NewService(db *pgxpool.Pool) *Service {
	return &Service{db: db}
}

type BadgeView struct {
	BadgeCode string `json:"badge_code"`
	AwardedAt string `json:"awarded_at"`
}

type ActiveCourseView struct {
	CourseID        string `json:"course_id"`
	Title           string `json:"title"`
	ProgressPercent int    `json:"progress_percent"`
}

type StudentProfileView struct {
	AccountID         string             `json:"account_id"`
	DisplayName       string             `json:"display_name"`
	AvatarURL         *string            `json:"avatar_url"`
	XPTotal           int64              `json:"xp_total"`
	Level             int                `json:"level"`
	CurrentStreakDays int                `json:"current_streak_days"`
	BestStreakDays    int                `json:"best_streak_days"`
	CompletedLessons  int                `json:"completed_lessons"`
	ActiveCourses     []ActiveCourseView `json:"active_courses"`
	Badges            []BadgeView        `json:"badges"`
}

type BasicProfileView struct {
	AccountID        string  `json:"account_id"`
	DisplayName      string  `json:"display_name"`
	AvatarURL        *string `json:"avatar_url"`
	OrganizationName *string `json:"organization_name,omitempty"`
}

type UpdateProfileInput struct {
	DisplayName      string  `json:"display_name"`
	AvatarAssetID    *string `json:"avatar_asset_id"`
	AvatarProvided   bool    `json:"-"`
	OrganizationName *string `json:"organization_name,omitempty"`
}

func DecodeUpdateProfile(r *http.Request) (UpdateProfileInput, error) {
	var raw map[string]json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
		return UpdateProfileInput{}, err
	}

	var input UpdateProfileInput
	if value, ok := raw["display_name"]; ok {
		if err := json.Unmarshal(value, &input.DisplayName); err != nil {
			return UpdateProfileInput{}, err
		}
	}
	if value, ok := raw["organization_name"]; ok {
		orgName, err := decodeOptionalString(value)
		if err != nil {
			return UpdateProfileInput{}, err
		}
		input.OrganizationName = orgName
	}
	if value, ok := raw["avatar_asset_id"]; ok {
		avatarAssetID, err := decodeOptionalString(value)
		if err != nil {
			return UpdateProfileInput{}, err
		}
		input.AvatarAssetID = avatarAssetID
		input.AvatarProvided = true
	}
	return input, nil
}

func (s *Service) GetStudent(ctx context.Context, accountID string) (StudentProfileView, error) {
	var view StudentProfileView
	var avatarPath *string
	err := s.db.QueryRow(ctx, `
		select sp.account_id::text,
		       sp.display_name,
		       case when a.id is null then null else '/assets/' || a.id::text end as avatar_url,
		       coalesce(sgs.xp_total, 0),
		       coalesce(sgs.level, 1),
		       coalesce(sss.current_streak_days, 0),
		       coalesce(sss.best_streak_days, 0),
		       coalesce((select count(*) from lesson_progress lp
		                where lp.student_id = sp.account_id and lp.status = 'completed'), 0)
		from student_profiles sp
		left join assets a on a.id = sp.avatar_asset_id and a.deleted_at is null
		left join student_game_state sgs on sgs.student_id = sp.account_id
		left join student_streak_state sss on sss.student_id = sp.account_id
		where sp.account_id = $1
	`, accountID).Scan(
		&view.AccountID,
		&view.DisplayName,
		&avatarPath,
		&view.XPTotal,
		&view.Level,
		&view.CurrentStreakDays,
		&view.BestStreakDays,
		&view.CompletedLessons,
	)
	if err != nil {
		return StudentProfileView{}, err
	}
	view.AvatarURL = avatarPath
	view.ActiveCourses = make([]ActiveCourseView, 0)
	view.Badges = make([]BadgeView, 0)

	rows, err := s.db.Query(ctx, `
		select cp.course_id::text, cr.title,
		       case
		           when total_lessons.total_count = 0 then 0
		           else floor((completed_lessons.completed_count::decimal / total_lessons.total_count::decimal) * 100)::int
		       end as progress_percent
		from course_progress cp
		join course_revisions cr on cr.id = cp.course_revision_id
		left join lateral (
		    select count(*) as completed_count from lesson_progress lp
		    where lp.course_progress_id = cp.id and lp.status = 'completed'
		) completed_lessons on true
		left join lateral (
		    select count(*) as total_count from course_revision_lessons crl
		    where crl.course_revision_id = cp.course_revision_id
		) total_lessons on true
		where cp.student_id = $1 and cp.status = 'in_progress'
		order by cp.last_activity_at desc
	`, accountID)
	if err != nil {
		return StudentProfileView{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var course ActiveCourseView
		if err := rows.Scan(&course.CourseID, &course.Title, &course.ProgressPercent); err != nil {
			return StudentProfileView{}, err
		}
		view.ActiveCourses = append(view.ActiveCourses, course)
	}
	if rows.Err() != nil {
		return StudentProfileView{}, rows.Err()
	}

	badgeRows, err := s.db.Query(ctx, `
		select badge_code, awarded_at::text
		from student_badges
		where student_id = $1
		order by awarded_at desc
	`, accountID)
	if err != nil {
		return StudentProfileView{}, err
	}
	defer badgeRows.Close()
	for badgeRows.Next() {
		var badge BadgeView
		if err := badgeRows.Scan(&badge.BadgeCode, &badge.AwardedAt); err != nil {
			return StudentProfileView{}, err
		}
		view.Badges = append(view.Badges, badge)
	}
	return view, badgeRows.Err()
}

func (s *Service) GetBasic(ctx context.Context, role string, accountID string) (BasicProfileView, error) {
	query, err := basicProfileQuery(role)
	if err != nil {
		return BasicProfileView{}, err
	}

	view := BasicProfileView{}
	var avatarPath *string
	err = s.db.QueryRow(ctx, query, accountID).Scan(
		&view.AccountID,
		&view.DisplayName,
		&avatarPath,
		&view.OrganizationName,
	)
	if err != nil {
		return BasicProfileView{}, err
	}
	view.AvatarURL = avatarPath
	return view, nil
}

func (s *Service) UpdateStudent(ctx context.Context, accountID string, input UpdateProfileInput) (StudentProfileView, error) {
	if err := s.ensureAssetOwnership(ctx, accountID, input.AvatarAssetID); err != nil {
		return StudentProfileView{}, err
	}
	_, err := s.db.Exec(ctx, `
		update student_profiles
		set display_name = $2,
		    avatar_asset_id = case when $3 then $4 else avatar_asset_id end,
		    updated_at = now()
		where account_id = $1
	`, accountID, input.DisplayName, input.AvatarProvided, nullableUUID(input.AvatarAssetID))
	if err != nil {
		return StudentProfileView{}, err
	}
	return s.GetStudent(ctx, accountID)
}

func (s *Service) UpdateBasic(ctx context.Context, role string, accountID string, input UpdateProfileInput) (BasicProfileView, error) {
	if err := s.ensureAssetOwnership(ctx, accountID, input.AvatarAssetID); err != nil {
		return BasicProfileView{}, err
	}
	query, err := basicProfileUpdateQuery(role)
	if err != nil {
		return BasicProfileView{}, err
	}
	args := []any{accountID, input.DisplayName, input.AvatarProvided, nullableUUID(input.AvatarAssetID)}
	if role == "teacher" {
		args = []any{accountID, input.DisplayName, input.OrganizationName, input.AvatarProvided, nullableUUID(input.AvatarAssetID)}
	}
	if _, err := s.db.Exec(ctx, query, args...); err != nil {
		return BasicProfileView{}, err
	}
	return s.GetBasic(ctx, role, accountID)
}

func (s *Service) ensureAssetOwnership(ctx context.Context, accountID string, assetID *string) error {
	if assetID == nil || strings.TrimSpace(*assetID) == "" {
		return nil
	}
	if _, err := uuid.Parse(*assetID); err != nil {
		return ErrAssetNotOwned
	}
	var count int
	if err := s.db.QueryRow(ctx, `
		select count(*) from assets
		where id = $1 and owner_account_id = $2 and deleted_at is null
	`, *assetID, accountID).Scan(&count); err != nil {
		return err
	}
	if count == 0 {
		return ErrAssetNotOwned
	}
	return nil
}

func basicProfileQuery(role string) (string, error) {
	switch role {
	case "student":
		return `
			select p.account_id::text, p.display_name,
			       case when a.id is null then null else '/assets/' || a.id::text end as avatar_url,
			       null::text
			from student_profiles p
			left join assets a on a.id = p.avatar_asset_id and a.deleted_at is null
			where p.account_id = $1
		`, nil
	case "parent":
		return `
			select p.account_id::text, p.display_name,
			       case when a.id is null then null else '/assets/' || a.id::text end as avatar_url,
			       null::text
			from parent_profiles p
			left join assets a on a.id = p.avatar_asset_id and a.deleted_at is null
			where p.account_id = $1
		`, nil
	case "teacher":
		return `
			select p.account_id::text, p.display_name,
			       case when a.id is null then null else '/assets/' || a.id::text end as avatar_url,
			       p.organization_name
			from teacher_profiles p
			left join assets a on a.id = p.avatar_asset_id and a.deleted_at is null
			where p.account_id = $1
		`, nil
	case "admin":
		return `
			select p.account_id::text, p.display_name,
			       case when a.id is null then null else '/assets/' || a.id::text end as avatar_url,
			       null::text
			from admin_profiles p
			left join assets a on a.id = p.avatar_asset_id and a.deleted_at is null
			where p.account_id = $1
		`, nil
	default:
		return "", fmt.Errorf("invalid_profile_role")
	}
}

func basicProfileUpdateQuery(role string) (string, error) {
	switch role {
	case "student":
		return `update student_profiles set display_name = $2, avatar_asset_id = case when $3 then $4 else avatar_asset_id end, updated_at = now() where account_id = $1`, nil
	case "parent":
		return `update parent_profiles set display_name = $2, avatar_asset_id = case when $3 then $4 else avatar_asset_id end, updated_at = now() where account_id = $1`, nil
	case "teacher":
		return `update teacher_profiles set display_name = $2, organization_name = $3, avatar_asset_id = case when $4 then $5 else avatar_asset_id end, updated_at = now() where account_id = $1`, nil
	case "admin":
		return `update admin_profiles set display_name = $2, avatar_asset_id = case when $3 then $4 else avatar_asset_id end, updated_at = now() where account_id = $1`, nil
	default:
		return "", fmt.Errorf("invalid_profile_role")
	}
}

func decodeOptionalString(value json.RawMessage) (*string, error) {
	if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
		return nil, nil
	}
	var out string
	if err := json.Unmarshal(value, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func nullableUUID(value *string) any {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil
	}
	return *value
}

var ErrAssetNotOwned = fmt.Errorf("asset_not_owned")
