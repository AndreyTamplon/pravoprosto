package courses

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"pravoprost/backend/internal/evaluation"
)

type Service struct {
	db         *pgxpool.Pool
	logger     *slog.Logger
	mu         sync.RWMutex
	previews   map[string]*previewSession
	evaluator  evaluation.FreeTextEvaluator
	previewTTL time.Duration
	previewMax int
}

func NewService(db *pgxpool.Pool, evaluator evaluation.FreeTextEvaluator, logger *slog.Logger) *Service {
	return &Service{
		db:         db,
		logger:     logger,
		previews:   make(map[string]*previewSession),
		evaluator:  evaluator,
		previewTTL: 30 * time.Minute,
		previewMax: 1024,
	}
}

type CreateCourseInput struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	AgeMin      *int   `json:"age_min"`
	AgeMax      *int   `json:"age_max"`
}

type UpdateDraftInput struct {
	DraftVersion int64           `json:"draft_version"`
	Title        string          `json:"title"`
	Description  string          `json:"description"`
	AgeMin       *int            `json:"age_min"`
	AgeMax       *int            `json:"age_max"`
	CoverAssetID *string         `json:"cover_asset_id"`
	Content      json.RawMessage `json:"content"`
}

type ValidationError struct {
	Path    string `json:"path"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type ValidationView struct {
	IsValid bool              `json:"is_valid"`
	Errors  []ValidationError `json:"errors"`
}

type DraftValidationFailure struct {
	Validation ValidationView
}

func (e DraftValidationFailure) Error() string {
	return ErrDraftValidationFailed.Error()
}

func (e DraftValidationFailure) Unwrap() error {
	return ErrDraftValidationFailed
}

type CourseListView struct {
	Items []map[string]any `json:"items"`
}

type DraftView struct {
	CourseID                string          `json:"course_id"`
	DraftID                 string          `json:"draft_id"`
	DraftVersion            int64           `json:"draft_version"`
	WorkflowStatus          string          `json:"workflow_status"`
	Title                   string          `json:"title"`
	Description             string          `json:"description"`
	AgeMin                  *int            `json:"age_min"`
	AgeMax                  *int            `json:"age_max"`
	CoverAssetID            *string         `json:"cover_asset_id"`
	Content                 json.RawMessage `json:"content"`
	LastPublishedRevisionID *string         `json:"last_published_revision_id"`
	Validation              ValidationView  `json:"validation"`
}

type PreviewStartInput struct {
	LessonID   string `json:"lesson_id"`
	ReturnPath string `json:"return_path"`
}

type PreviewStepEnvelope struct {
	Preview          bool     `json:"preview"`
	PreviewSessionID string   `json:"preview_session_id,omitempty"`
	ReturnPath       string   `json:"return_path,omitempty"`
	Step             StepView `json:"step"`
}

type PreviewAnswerOutcome struct {
	Preview      bool      `json:"preview"`
	Verdict      string    `json:"verdict"`
	FeedbackText string    `json:"feedback_text"`
	NextStep     *StepView `json:"next_step"`
}

type StepView struct {
	SessionID      string         `json:"session_id"`
	CourseID       string         `json:"course_id"`
	LessonID       string         `json:"lesson_id"`
	StateVersion   int64          `json:"state_version"`
	NodeID         string         `json:"node_id"`
	NodeKind       string         `json:"node_kind"`
	Payload        map[string]any `json:"payload"`
	StepsCompleted int            `json:"steps_completed"`
	StepsTotal     int            `json:"steps_total"`
	ProgressRatio  float64        `json:"progress_ratio"`
	GameState      any            `json:"game_state"`
	Navigation     StepNavigation `json:"navigation"`
}

type StepNavigation struct {
	CanGoBack        bool    `json:"can_go_back"`
	BackKind         *string `json:"back_kind,omitempty"`
	BackTargetNodeID *string `json:"back_target_node_id,omitempty"`
}

type ReviewStatusView struct {
	Current *map[string]any  `json:"current"`
	History []map[string]any `json:"history"`
}

func DecodeCreateCourse(r *http.Request) (CreateCourseInput, error) {
	var input CreateCourseInput
	return input, json.NewDecoder(r.Body).Decode(&input)
}

func DecodeUpdateDraft(r *http.Request) (UpdateDraftInput, error) {
	var input UpdateDraftInput
	return input, json.NewDecoder(r.Body).Decode(&input)
}

func DecodePreviewStart(r *http.Request) (PreviewStartInput, error) {
	var input PreviewStartInput
	return input, json.NewDecoder(r.Body).Decode(&input)
}

func (s *Service) TeacherProfileReady(ctx context.Context, teacherID string) (bool, error) {
	var displayName string
	var organizationName *string
	if err := s.db.QueryRow(ctx, `
		select display_name, organization_name
		from teacher_profiles
		where account_id = $1
	`, teacherID).Scan(&displayName, &organizationName); err != nil {
		return false, err
	}
	return strings.TrimSpace(displayName) != "" && organizationName != nil && strings.TrimSpace(*organizationName) != "", nil
}

func (s *Service) CreateCourse(ctx context.Context, ownerRole string, ownerID string, input CreateCourseInput) (map[string]string, error) {
	ownerKind := "teacher"
	courseKind := "teacher_private"
	var ownerAccountID any = ownerID
	if ownerRole == "admin" {
		ownerKind = "platform"
		courseKind = "platform_catalog"
		ownerAccountID = nil
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var courseID string
	if err := tx.QueryRow(ctx, `
		insert into courses(owner_kind, owner_account_id, course_kind, status)
		values ($1, $2, $3, 'active')
		returning id::text
	`, ownerKind, ownerAccountID, courseKind).Scan(&courseID); err != nil {
		return nil, err
	}
	var draftID string
	if err := tx.QueryRow(ctx, `
		insert into course_drafts(course_id, workflow_status, draft_version, title, description, age_min, age_max, content_json)
		values ($1, 'editing', 1, $2, $3, $4, $5, '{"modules":[]}'::jsonb)
		returning id::text
	`, courseID, input.Title, input.Description, input.AgeMin, input.AgeMax).Scan(&draftID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return map[string]string{"course_id": courseID, "draft_id": draftID}, nil
}

func (s *Service) ListCourses(ctx context.Context, role string, accountID string) (CourseListView, error) {
	var (
		rows pgx.Rows
		err  error
	)
	if role == "teacher" {
		rows, err = s.db.Query(ctx, `
			select c.id::text,
			       d.title,
			       d.workflow_status,
			       (
			           select status from course_reviews r
			           where r.course_draft_id = d.id
			           order by r.submitted_at desc limit 1
			       ) as review_status,
			       (
			           select cr.id::text from course_revisions cr
			           where cr.course_id = c.id and cr.is_current = true
			           limit 1
			       ) as published_revision_id,
			       (
			           select count(*) from course_access_grants ag
			           where ag.course_id = c.id and ag.archived_at is null
			       ) as students_count,
			       d.updated_at::text
			from courses c
			join course_drafts d on d.course_id = c.id
			where c.owner_kind = 'teacher' and c.owner_account_id = $1 and c.deleted_at is null
			order by d.updated_at desc
		`, accountID)
	} else {
		rows, err = s.db.Query(ctx, `
			select c.id::text,
			       d.title,
			       c.owner_kind,
			       c.course_kind,
			       c.status,
			       (
			           select cr.id::text from course_revisions cr
			           where cr.course_id = c.id and cr.is_current = true
			           limit 1
			       ) as current_revision_id,
			       coalesce((
			           select count(*)
			           from jsonb_array_elements(coalesce(d.content_json->'modules', '[]'::jsonb)) mod,
			               jsonb_array_elements(coalesce(mod->'lessons', '[]'::jsonb)) lesson
			       ), 0) as lesson_count,
			       (
			           select count(*)
			           from course_access_grants ag
			           where ag.course_id = c.id and ag.archived_at is null
			       ) as student_count,
			       c.created_at::text
			from courses c
			join course_drafts d on d.course_id = c.id
			where c.deleted_at is null
			order by d.updated_at desc
		`)
	}
	if err != nil {
		return CourseListView{}, err
	}
	defer rows.Close()

	items := make([]map[string]any, 0)
	for rows.Next() {
		if role == "teacher" {
			var courseID, title, workflowStatus, updatedAt string
			var reviewStatus *string
			var publishedRevisionID *string
			var studentsCount int
			if err := rows.Scan(&courseID, &title, &workflowStatus, &reviewStatus, &publishedRevisionID, &studentsCount, &updatedAt); err != nil {
				return CourseListView{}, err
			}
			items = append(items, map[string]any{
				"course_id":             courseID,
				"title":                 title,
				"workflow_status":       workflowStatus,
				"review_status":         reviewStatus,
				"published_revision_id": publishedRevisionID,
				"students_count":        studentsCount,
				"updated_at":            updatedAt,
			})
		} else {
			var courseID, title, ownerKind, courseKind, status, createdAt string
			var currentRevisionID *string
			var lessonCount, studentCount int
			if err := rows.Scan(&courseID, &title, &ownerKind, &courseKind, &status, &currentRevisionID, &lessonCount, &studentCount, &createdAt); err != nil {
				return CourseListView{}, err
			}
			items = append(items, map[string]any{
				"course_id":           courseID,
				"title":               title,
				"course_kind":         courseKind,
				"owner_kind":          ownerKind,
				"status":              status,
				"current_revision_id": currentRevisionID,
				"lesson_count":        lessonCount,
				"student_count":       studentCount,
				"created_at":          createdAt,
			})
		}
	}
	return CourseListView{Items: items}, rows.Err()
}

func (s *Service) PromoCourses(ctx context.Context) (map[string]any, error) {
	rows, err := s.db.Query(ctx, `
		select c.id::text,
		       cr.title,
		       cr.description,
		       null::text as cover_url,
		       cr.age_min,
		       cr.age_max,
		       coalesce((
		           select count(*)
		           from course_revision_lessons crl
		           where crl.course_revision_id = cr.id
		       ), 0) as lesson_count
		from courses c
		join course_revisions cr on cr.course_id = c.id and cr.is_current = true
		where c.owner_kind = 'platform' and c.deleted_at is null
		order by cr.published_at desc
		limit 12
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]map[string]any, 0)
	for rows.Next() {
		var courseID, title, description string
		var coverURL *string
		var ageMin, ageMax *int
		var lessonCount int
		if err := rows.Scan(&courseID, &title, &description, &coverURL, &ageMin, &ageMax, &lessonCount); err != nil {
			return nil, err
		}
		items = append(items, map[string]any{
			"course_id":    courseID,
			"title":        title,
			"description":  description,
			"cover_url":    coverURL,
			"age_min":      ageMin,
			"age_max":      ageMax,
			"lesson_count": lessonCount,
			"badge":        "Популярный",
		})
	}
	return map[string]any{"items": items}, rows.Err()
}

func (s *Service) GetDraft(ctx context.Context, role string, actorID string, courseID string) (DraftView, error) {
	if err := s.ensureCourseAccess(ctx, role, actorID, courseID); err != nil {
		return DraftView{}, err
	}
	var view DraftView
	if err := s.db.QueryRow(ctx, `
		select d.course_id::text,
		       d.id::text,
		       d.draft_version,
		       d.workflow_status,
		       d.title,
		       d.description,
		       d.age_min,
		       d.age_max,
		       d.cover_asset_id::text,
		       d.content_json::text,
		       d.last_published_revision_id::text
		from course_drafts d
		where d.course_id = $1
	`, courseID).Scan(
		&view.CourseID,
		&view.DraftID,
		&view.DraftVersion,
		&view.WorkflowStatus,
		&view.Title,
		&view.Description,
		&view.AgeMin,
		&view.AgeMax,
		&view.CoverAssetID,
		&view.Content,
		&view.LastPublishedRevisionID,
	); err != nil {
		return DraftView{}, err
	}
	validation, err := s.ValidateDraft(ctx, draftAssetOwner(role, actorID), view.CoverAssetID, view.Content)
	if err != nil {
		return DraftView{}, err
	}
	view.Validation = validation
	return view, nil
}

func (s *Service) UpdateDraft(ctx context.Context, role string, actorID string, courseID string, input UpdateDraftInput) (map[string]any, error) {
	if err := s.ensureCourseAccess(ctx, role, actorID, courseID); err != nil {
		return nil, err
	}
	validation, err := s.ValidateDraft(ctx, draftAssetOwner(role, actorID), input.CoverAssetID, input.Content)
	if err != nil {
		return nil, err
	}
	if !validation.IsValid {
		return map[string]any{"validation": validation}, ErrDraftValidationFailed
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var currentVersion int64
	if err := tx.QueryRow(ctx, `select draft_version from course_drafts where course_id = $1 for update`, courseID).Scan(&currentVersion); err != nil {
		return nil, err
	}
	if currentVersion != input.DraftVersion {
		return nil, ErrDraftVersionConflict
	}
	if _, err := tx.Exec(ctx, `
		update course_drafts
		set draft_version = draft_version + 1,
		    title = $2,
		    description = $3,
		    age_min = $4,
		    age_max = $5,
		    cover_asset_id = $6,
		    content_json = $7,
		    workflow_status = 'editing',
		    updated_at = now()
		where course_id = $1
	`, courseID, input.Title, input.Description, input.AgeMin, input.AgeMax, input.CoverAssetID, input.Content); err != nil {
		return nil, err
	}
	var draftID string
	var updatedVersion int64
	if err := tx.QueryRow(ctx, `select id::text, draft_version from course_drafts where course_id = $1`, courseID).Scan(&draftID, &updatedVersion); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return map[string]any{
		"draft_id":        draftID,
		"draft_version":   updatedVersion,
		"workflow_status": "editing",
		"validation":      validation,
	}, nil
}

func (s *Service) ArchiveCourse(ctx context.Context, teacherID string, courseID string) (map[string]string, error) {
	if err := s.ensureCourseAccess(ctx, "teacher", teacherID, courseID); err != nil {
		return nil, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
		update courses
		set deleted_at = now()
		where id = $1 and owner_kind = 'teacher' and owner_account_id = $2 and deleted_at is null
	`, courseID, teacherID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		update course_drafts
		set workflow_status = 'archived', updated_at = now()
		where course_id = $1
	`, courseID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return map[string]string{"course_id": courseID, "status": "archived"}, nil
}

func (s *Service) AdminArchiveCourse(ctx context.Context, courseID string) (map[string]string, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `
		update courses
		set deleted_at = now(), status = 'archived'
		where id = $1 and deleted_at is null
	`, courseID)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrCourseNotFound
	}
	if _, err := tx.Exec(ctx, `
		update course_drafts
		set workflow_status = 'archived', updated_at = now()
		where course_id = $1
	`, courseID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		update commercial_offers
		set status = 'archived', archived_at = now(), updated_at = now()
		where target_course_id = $1 and status <> 'archived'
	`, courseID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return map[string]string{"course_id": courseID, "status": "archived"}, nil
}

func (s *Service) ensureCourseAccess(ctx context.Context, role string, actorID string, courseID string) error {
	var count int
	var err error
	if role == "teacher" {
		err = s.db.QueryRow(ctx, `
			select count(*)
			from courses
			where id = $1 and owner_kind = 'teacher' and owner_account_id = $2 and deleted_at is null
		`, courseID, actorID).Scan(&count)
	} else {
		err = s.db.QueryRow(ctx, `
			select count(*)
			from courses
			where id = $1 and owner_kind = 'platform' and deleted_at is null
		`, courseID).Scan(&count)
	}
	if err != nil {
		return err
	}
	if count == 0 {
		return ErrCourseNotFound
	}
	return nil
}

func (s *Service) ValidateDraft(ctx context.Context, assetOwnerID *string, coverAssetID *string, contentRaw json.RawMessage) (ValidationView, error) {
	errors := make([]ValidationError, 0)
	if coverAssetID != nil && strings.TrimSpace(*coverAssetID) != "" {
		assetError, err := s.validateAssetReference(ctx, assetOwnerID, "cover_asset_id", *coverAssetID)
		if err != nil {
			return ValidationView{}, err
		}
		if assetError != nil {
			errors = append(errors, *assetError)
		}
	}

	var contentAny any
	if len(contentRaw) == 0 {
		contentAny = map[string]any{"modules": []any{}}
	} else if err := json.Unmarshal(contentRaw, &contentAny); err != nil {
		errors = append(errors, ValidationError{
			Path:    "content",
			Code:    "invalid_content",
			Message: "Content must be a valid JSON object",
		})
		return ValidationView{IsValid: false, Errors: errors}, nil
	}

	content, ok := contentAny.(map[string]any)
	if !ok {
		errors = append(errors, ValidationError{
			Path:    "content",
			Code:    "invalid_content",
			Message: "Content must be a JSON object",
		})
		return ValidationView{IsValid: false, Errors: errors}, nil
	}
	errors = append(errors, validateContent(content)...)
	for _, ref := range collectAssetReferences(content, "") {
		assetError, err := s.validateAssetReference(ctx, assetOwnerID, ref.Path, ref.AssetID)
		if err != nil {
			return ValidationView{}, err
		}
		if assetError != nil {
			errors = append(errors, *assetError)
		}
	}
	return ValidationView{IsValid: len(errors) == 0, Errors: errors}, nil
}

func (s *Service) validateAssetReference(ctx context.Context, assetOwnerID *string, path string, rawAssetID string) (*ValidationError, error) {
	assetID := strings.TrimSpace(rawAssetID)
	if assetID == "" {
		return nil, nil
	}
	if _, err := uuid.Parse(assetID); err != nil {
		return &ValidationError{
			Path:    path,
			Code:    "invalid_asset_id",
			Message: "Asset id must be a valid UUID",
		}, nil
	}

	var ownerAccountID *string
	err := s.db.QueryRow(ctx, `
		select owner_account_id::text
		from assets
		where id = $1 and deleted_at is null
	`, assetID).Scan(&ownerAccountID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return &ValidationError{
				Path:    path,
				Code:    "missing_asset",
				Message: "Referenced asset does not exist",
			}, nil
		}
		return nil, err
	}

	if assetOwnerID != nil && strings.TrimSpace(*assetOwnerID) != "" && (ownerAccountID == nil || *ownerAccountID != *assetOwnerID) {
		return &ValidationError{
			Path:    path,
			Code:    "asset_not_owned",
			Message: "Asset must belong to the draft owner",
		}, nil
	}

	return nil, nil
}

func draftAssetOwner(role string, actorID string) *string {
	if role != "teacher" || strings.TrimSpace(actorID) == "" {
		return nil
	}
	return &actorID
}

func (s *Service) StartPreview(ctx context.Context, role string, actorID string, courseID string, lessonID string, returnPath string) (PreviewStepEnvelope, error) {
	draft, err := s.GetDraft(ctx, role, actorID, courseID)
	if err != nil {
		return PreviewStepEnvelope{}, err
	}
	return s.startPreviewFromDraft(role, actorID, draft, lessonID, returnPath)
}

func (s *Service) ModerationDraft(ctx context.Context, reviewID string) (DraftView, error) {
	draft, _, err := s.loadModerationDraft(ctx, reviewID)
	if err != nil {
		return DraftView{}, err
	}
	return draft, nil
}

func (s *Service) StartModerationPreview(ctx context.Context, adminID string, reviewID string, lessonID string, returnPath string) (PreviewStepEnvelope, error) {
	draft, _, err := s.loadModerationDraft(ctx, reviewID)
	if err != nil {
		return PreviewStepEnvelope{}, err
	}
	return s.startPreviewFromDraft("admin", adminID, draft, lessonID, returnPath)
}

func (s *Service) startPreviewFromDraft(role string, actorID string, draft DraftView, lessonID string, returnPath string) (PreviewStepEnvelope, error) {
	if !draft.Validation.IsValid {
		return PreviewStepEnvelope{}, DraftValidationFailure{Validation: draft.Validation}
	}
	lesson, err := findLesson(draft.Content, lessonID)
	if err != nil {
		return PreviewStepEnvelope{}, err
	}
	graph := lesson.Graph
	startNode := graph.NodeMap[graph.StartNodeID]
	sessionID := uuid.NewString()
	s.mu.Lock()
	s.evictPreviewsLocked(time.Now())
	session := &previewSession{
		ID:         sessionID,
		OwnerRole:  role,
		OwnerID:    actorID,
		CourseID:   draft.CourseID,
		LessonID:   lessonID,
		ReturnPath: returnPath,
		Graph:      graph,
		History: []previewPathEntry{
			{NodeID: graph.StartNodeID, NodeKind: startNode.Kind, Active: true},
		},
		CurrentID:    graph.StartNodeID,
		StateVersion: 1,
		LastTouched:  time.Now(),
	}
	s.previews[sessionID] = session
	s.mu.Unlock()
	_ = startNode
	return buildPreviewEnvelope(session), nil
}

func (s *Service) loadModerationDraft(ctx context.Context, reviewID string) (DraftView, *string, error) {
	var draft DraftView
	var ownerKind string
	var ownerAccountID *string
	if err := s.db.QueryRow(ctx, `
		select c.owner_kind,
		       c.owner_account_id::text,
		       d.course_id::text,
		       d.id::text,
		       d.draft_version,
		       d.workflow_status,
		       d.title,
		       d.description,
		       d.age_min,
		       d.age_max,
		       d.cover_asset_id::text,
		       d.content_json::text,
		       d.last_published_revision_id::text
		from course_reviews r
		join course_drafts d on d.id = r.course_draft_id
		join courses c on c.id = d.course_id
		where r.id = $1 and r.status = 'pending'
	`, reviewID).Scan(
		&ownerKind,
		&ownerAccountID,
		&draft.CourseID,
		&draft.DraftID,
		&draft.DraftVersion,
		&draft.WorkflowStatus,
		&draft.Title,
		&draft.Description,
		&draft.AgeMin,
		&draft.AgeMax,
		&draft.CoverAssetID,
		&draft.Content,
		&draft.LastPublishedRevisionID,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return DraftView{}, nil, ErrReviewNotFound
		}
		return DraftView{}, nil, err
	}

	var assetOwnerID *string
	if ownerKind == "teacher" {
		assetOwnerID = ownerAccountID
	}
	validation, err := s.ValidateDraft(ctx, assetOwnerID, draft.CoverAssetID, draft.Content)
	if err != nil {
		return DraftView{}, nil, err
	}
	draft.Validation = validation
	return draft, assetOwnerID, nil
}

func (s *Service) PreviewSession(_ context.Context, role string, actorID string, previewSessionID string) (PreviewStepEnvelope, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, err := s.loadPreviewLocked(previewSessionID, role, actorID, time.Now())
	if err != nil {
		return PreviewStepEnvelope{}, err
	}
	return buildPreviewEnvelope(session), nil
}

func (s *Service) PreviewNext(_ context.Context, role string, actorID string, previewSessionID string, stateVersion int64, expectedNodeID string) (PreviewStepEnvelope, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, err := s.loadPreviewLocked(previewSessionID, role, actorID, time.Now())
	if err != nil {
		return PreviewStepEnvelope{}, err
	}
	if session.StateVersion != stateVersion || session.CurrentID != expectedNodeID {
		priorNode := session.Graph.NodeMap[expectedNodeID]
		if session.StateVersion == stateVersion+1 && priorNode.Kind == "story" && priorNode.NextNodeID != "" && session.CurrentID == priorNode.NextNodeID {
			return buildPreviewEnvelope(session), nil
		}
		return PreviewStepEnvelope{}, ErrPreviewStateConflict
	}
	node := session.Graph.NodeMap[session.CurrentID]
	if node.Kind != "story" || node.NextNodeID == "" {
		return PreviewStepEnvelope{}, ErrInvalidPreviewAction
	}
	session.StateVersion++
	session.CurrentID = node.NextNodeID
	appendPreviewHistory(session, session.Graph.NodeMap[session.CurrentID], "")
	session.LastTouched = time.Now()
	return buildPreviewEnvelope(session), nil
}

func (s *Service) PreviewAnswer(ctx context.Context, role string, actorID string, previewSessionID string, stateVersion int64, nodeID string, answer map[string]any) (PreviewAnswerOutcome, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, err := s.loadPreviewLocked(previewSessionID, role, actorID, time.Now())
	if err != nil {
		return PreviewAnswerOutcome{}, err
	}
	if session.StateVersion != stateVersion {
		return PreviewAnswerOutcome{}, ErrPreviewStateConflict
	}
	if session.CurrentID != nodeID {
		return PreviewAnswerOutcome{}, ErrPreviewStateConflict
	}
	node := session.Graph.NodeMap[session.CurrentID]
	switch node.Kind {
	case "single_choice":
		optionID, _ := answer["option_id"].(string)
		for _, option := range node.Options {
			if option.ID == optionID {
				session.StateVersion++
				session.CurrentID = option.NextNodeID
				appendPreviewHistory(session, session.Graph.NodeMap[session.CurrentID], "")
				session.LastTouched = time.Now()
				nextNode := session.Graph.NodeMap[session.CurrentID]
				step := buildStepView(session.ID, session.CourseID, session.LessonID, session.StateVersion, session.Graph, session.CurrentID, nextNode)
				step.Navigation = previewNavigation(session)
				return PreviewAnswerOutcome{
					Preview:      true,
					Verdict:      option.Result,
					FeedbackText: option.Feedback,
					NextStep:     ptrStep(step),
				}, nil
			}
		}
		return PreviewAnswerOutcome{}, ErrInvalidPreviewAction
	case "free_text":
		text, _ := answer["text"].(string)
		result, err := s.evaluator.Evaluate(ctx, evaluation.FreeTextEvaluationInput{
			Prompt:            node.Prompt,
			ReferenceAnswer:   asString(node.Rubric["referenceAnswer"]),
			CriteriaCorrect:   firstNonEmpty(asString(mapNestedValue(node.Rubric, "criteriaByVerdict", "correct")), asString(node.Rubric["criteria"])),
			CriteriaPartial:   firstNonEmpty(asString(mapNestedValue(node.Rubric, "criteriaByVerdict", "partial")), asString(node.Rubric["criteria"])),
			CriteriaIncorrect: firstNonEmpty(asString(mapNestedValue(node.Rubric, "criteriaByVerdict", "incorrect")), asString(node.Rubric["criteria"])),
			StudentAnswer:     text,
		})
		if err != nil {
			if errors.Is(err, evaluation.ErrTemporarilyUnavailable) {
				return PreviewAnswerOutcome{}, ErrPreviewEvaluationUnavailable
			}
			return PreviewAnswerOutcome{}, err
		}
		nextNodeID := node.Transitions[result.Verdict]
		if nextNodeID == "" {
			return PreviewAnswerOutcome{}, ErrInvalidPreviewAction
		}
		session.StateVersion++
		session.CurrentID = nextNodeID
		appendPreviewHistory(session, session.Graph.NodeMap[session.CurrentID], "")
		session.LastTouched = time.Now()
		nextNode := session.Graph.NodeMap[session.CurrentID]
		step := buildStepView(session.ID, session.CourseID, session.LessonID, session.StateVersion, session.Graph, session.CurrentID, nextNode)
		step.Navigation = previewNavigation(session)
		return PreviewAnswerOutcome{
			Preview:      true,
			Verdict:      result.Verdict,
			FeedbackText: previewFreeTextFeedback(node.Rubric, result.Verdict, result.Feedback),
			NextStep:     ptrStep(step),
		}, nil
	default:
		return PreviewAnswerOutcome{}, ErrInvalidPreviewAction
	}
}

func (s *Service) PreviewDecision(_ context.Context, role string, actorID string, previewSessionID string, stateVersion int64, nodeID string, optionID string) (PreviewStepEnvelope, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, err := s.loadPreviewLocked(previewSessionID, role, actorID, time.Now())
	if err != nil {
		return PreviewStepEnvelope{}, err
	}
	if session.StateVersion != stateVersion || session.CurrentID != nodeID {
		return PreviewStepEnvelope{}, ErrPreviewStateConflict
	}
	node := session.Graph.NodeMap[session.CurrentID]
	if node.Kind != "decision" {
		return PreviewStepEnvelope{}, ErrInvalidPreviewAction
	}
	for _, option := range node.Options {
		if option.ID != optionID {
			continue
		}
		session.StateVersion++
		session.CurrentID = option.NextNodeID
		appendPreviewHistory(session, session.Graph.NodeMap[session.CurrentID], optionID)
		session.LastTouched = time.Now()
		return buildPreviewEnvelope(session), nil
	}
	return PreviewStepEnvelope{}, ErrInvalidPreviewAction
}

func (s *Service) PreviewBack(_ context.Context, role string, actorID string, previewSessionID string, stateVersion int64) (PreviewStepEnvelope, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, err := s.loadPreviewLocked(previewSessionID, role, actorID, time.Now())
	if err != nil {
		return PreviewStepEnvelope{}, err
	}
	if session.StateVersion != stateVersion {
		return PreviewStepEnvelope{}, ErrPreviewStateConflict
	}
	currentIndex := latestActivePreviewHistoryIndex(session)
	if currentIndex <= 0 {
		return PreviewStepEnvelope{}, ErrInvalidPreviewAction
	}
	targetIndex := -1
	for index := currentIndex - 1; index >= 0; index-- {
		if session.History[index].Active && session.History[index].NodeKind == "decision" {
			targetIndex = index
			break
		}
	}
	if targetIndex < 0 {
		return PreviewStepEnvelope{}, ErrInvalidPreviewAction
	}
	for index := targetIndex + 1; index < len(session.History); index++ {
		session.History[index].Active = false
	}
	session.StateVersion++
	session.CurrentID = session.History[targetIndex].NodeID
	session.LastTouched = time.Now()
	return buildPreviewEnvelope(session), nil
}

func previewFreeTextFeedback(rubric map[string]any, verdict string, fallback string) string {
	feedbackByVerdict, _ := rubric["feedbackByVerdict"].(map[string]any)
	if feedback := strings.TrimSpace(asString(feedbackByVerdict[verdict])); feedback != "" {
		return feedback
	}
	return fallback
}

func mapNestedValue(root map[string]any, key string, nested string) any {
	raw, ok := root[key].(map[string]any)
	if !ok {
		return nil
	}
	return raw[nested]
}

func (s *Service) SubmitReview(ctx context.Context, teacherID string, courseID string) (map[string]any, error) {
	draft, err := s.GetDraft(ctx, "teacher", teacherID, courseID)
	if err != nil {
		return nil, err
	}
	if !draft.Validation.IsValid {
		return nil, DraftValidationFailure{Validation: draft.Validation}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var existing int
	if err := tx.QueryRow(ctx, `select count(*) from course_reviews where course_draft_id = $1 and status = 'pending'`, draft.DraftID).Scan(&existing); err != nil {
		return nil, err
	}
	if existing > 0 {
		return nil, ErrModerationReviewAlreadyPending
	}
	var reviewID string
	if err := tx.QueryRow(ctx, `
		insert into course_reviews(course_draft_id, submitted_by_account_id, submitted_draft_version, status)
		values ($1, $2, $3, 'pending')
		returning id::text
	`, draft.DraftID, teacherID, draft.DraftVersion).Scan(&reviewID); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, ErrModerationReviewAlreadyPending
		}
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		update course_drafts
		set workflow_status = 'in_review', last_submitted_at = now(), updated_at = now()
		where id = $1
	`, draft.DraftID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return map[string]any{"review_id": reviewID, "status": "pending"}, nil
}

func (s *Service) ReviewStatus(ctx context.Context, teacherID string, courseID string) (ReviewStatusView, error) {
	draft, err := s.GetDraft(ctx, "teacher", teacherID, courseID)
	if err != nil {
		return ReviewStatusView{}, err
	}
	rows, err := s.db.Query(ctx, `
		select id::text, status, submitted_at::text, review_comment
		from course_reviews
		where course_draft_id = $1
		order by submitted_at desc
	`, draft.DraftID)
	if err != nil {
		return ReviewStatusView{}, err
	}
	defer rows.Close()
	history := make([]map[string]any, 0)
	for rows.Next() {
		var reviewID, status, submittedAt string
		var comment *string
		if err := rows.Scan(&reviewID, &status, &submittedAt, &comment); err != nil {
			return ReviewStatusView{}, err
		}
		history = append(history, map[string]any{
			"review_id":      reviewID,
			"status":         status,
			"submitted_at":   submittedAt,
			"review_comment": comment,
		})
	}
	var current *map[string]any
	if len(history) > 0 {
		current = &history[0]
	}
	return ReviewStatusView{Current: current, History: history}, rows.Err()
}

func (s *Service) ModerationQueue(ctx context.Context) (CourseListView, error) {
	rows, err := s.db.Query(ctx, `
		select r.id::text, c.id::text, d.id::text, d.title, tp.account_id::text, tp.display_name, r.submitted_at::text
		from course_reviews r
		join course_drafts d on d.id = r.course_draft_id
		join courses c on c.id = d.course_id
		join teacher_profiles tp on tp.account_id = c.owner_account_id
		where r.status = 'pending'
		order by r.submitted_at asc
	`)
	if err != nil {
		return CourseListView{}, err
	}
	defer rows.Close()
	items := make([]map[string]any, 0)
	for rows.Next() {
		var reviewID, courseID, draftID, title, teacherID, teacherName, submittedAt string
		if err := rows.Scan(&reviewID, &courseID, &draftID, &title, &teacherID, &teacherName, &submittedAt); err != nil {
			return CourseListView{}, err
		}
		items = append(items, map[string]any{
			"review_id": reviewID,
			"course_id": courseID,
			"draft_id":  draftID,
			"title":     title,
			"teacher": map[string]any{
				"account_id":   teacherID,
				"display_name": teacherName,
			},
			"submitted_at": submittedAt,
		})
	}
	return CourseListView{Items: items}, rows.Err()
}

func (s *Service) PublishCourse(ctx context.Context, courseID string, publishedBy string) (map[string]any, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var ownerKind string
	if err := tx.QueryRow(ctx, `select owner_kind from courses where id = $1 and deleted_at is null for update`, courseID).Scan(&ownerKind); err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrCourseNotFound
		}
		return nil, err
	}
	if ownerKind != "platform" {
		return nil, ErrCourseNotPlatformOwned
	}
	result, err := s.publishCourseTx(ctx, tx, courseID, publishedBy)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Service) ApproveReview(ctx context.Context, reviewID string, adminID string, comment *string) (map[string]any, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var courseID, draftID, status string
	if err := tx.QueryRow(ctx, `
		select d.course_id::text, r.course_draft_id::text, r.status
		from course_reviews r
		join course_drafts d on d.id = r.course_draft_id
		where r.id = $1
		for update
	`, reviewID).Scan(&courseID, &draftID, &status); err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrReviewNotFound
		}
		return nil, err
	}
	if status != "pending" {
		return nil, ErrReviewAlreadyResolved
	}
	result, err := s.publishCourseTx(ctx, tx, courseID, adminID)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		update course_reviews
		set status = 'approved', reviewer_id = $2, review_comment = $3, resolved_at = now()
		where id = $1
	`, reviewID, adminID, comment); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return map[string]any{
		"review_id":             reviewID,
		"status":                "approved",
		"published_revision_id": result["course_revision_id"],
	}, nil
}

func (s *Service) RejectReview(ctx context.Context, reviewID string, adminID string, comment *string) (map[string]any, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var draftID, status string
	if err := tx.QueryRow(ctx, `
		select course_draft_id::text, status
		from course_reviews
		where id = $1
		for update
	`, reviewID).Scan(&draftID, &status); err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrReviewNotFound
		}
		return nil, err
	}
	if status != "pending" {
		return nil, ErrReviewAlreadyResolved
	}
	if _, err := tx.Exec(ctx, `
		update course_reviews
		set status = 'rejected', reviewer_id = $2, review_comment = $3, resolved_at = now()
		where id = $1
	`, reviewID, adminID, comment); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		update course_drafts
		set workflow_status = 'changes_requested', last_rejected_at = now(), updated_at = now()
		where id = $1
	`, draftID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return map[string]any{"review_id": reviewID, "status": "rejected"}, nil
}

func (s *Service) publishCourseTx(ctx context.Context, tx pgx.Tx, courseID string, publishedBy string) (map[string]any, error) {
	var draft DraftView
	var ownerKind string
	var ownerAccountID *string
	if err := tx.QueryRow(ctx, `
		select c.owner_kind,
		       c.owner_account_id::text,
		       d.course_id::text,
		       d.id::text,
		       d.draft_version,
		       d.workflow_status,
		       d.title,
		       d.description,
		       d.age_min,
		       d.age_max,
		       d.cover_asset_id::text,
		       d.content_json::text,
		       d.last_published_revision_id::text
		from course_drafts d
		join courses c on c.id = d.course_id
		where d.course_id = $1
		for update
	`, courseID).Scan(
		&ownerKind,
		&ownerAccountID,
		&draft.CourseID,
		&draft.DraftID,
		&draft.DraftVersion,
		&draft.WorkflowStatus,
		&draft.Title,
		&draft.Description,
		&draft.AgeMin,
		&draft.AgeMax,
		&draft.CoverAssetID,
		&draft.Content,
		&draft.LastPublishedRevisionID,
	); err != nil {
		return nil, err
	}
	var assetOwnerID *string
	if ownerKind == "teacher" {
		assetOwnerID = ownerAccountID
	}
	validation, err := s.ValidateDraft(ctx, assetOwnerID, draft.CoverAssetID, draft.Content)
	if err != nil {
		return nil, err
	}
	if !validation.IsValid {
		return nil, ErrCourseNotPublishable
	}
	var versionNo int
	if err := tx.QueryRow(ctx, `select coalesce(max(version_no), 0) + 1 from course_revisions where course_id = $1`, courseID).Scan(&versionNo); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `update course_revisions set is_current = false, disabled_at = now() where course_id = $1 and is_current = true`, courseID); err != nil {
		return nil, err
	}
	var revisionID string
	if err := tx.QueryRow(ctx, `
		insert into course_revisions(course_id, version_no, title, description, age_min, age_max, cover_asset_id, content_json, published_by_account_id, is_current)
		values ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
		returning id::text
	`, courseID, versionNo, draft.Title, draft.Description, draft.AgeMin, draft.AgeMax, draft.CoverAssetID, draft.Content, publishedBy).Scan(&revisionID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `delete from course_revision_lessons where course_revision_id = $1`, revisionID); err != nil {
		return nil, err
	}
	lessons, err := flattenLessons(courseID, revisionID, draft.Content)
	if err != nil {
		return nil, err
	}
	for _, lesson := range lessons {
		if _, err := tx.Exec(ctx, `
			insert into course_revision_lessons(course_revision_id, course_id, module_id, lesson_id, title, sort_order)
			values ($1, $2, $3, $4, $5, $6)
		`, revisionID, courseID, lesson.ModuleID, lesson.LessonID, lesson.Title, lesson.SortOrder); err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(ctx, `
		update course_drafts
		set workflow_status = 'editing', last_published_revision_id = $2, updated_at = now()
		where course_id = $1
	`, courseID, revisionID); err != nil {
		return nil, err
	}
	return map[string]any{
		"course_id":          courseID,
		"course_revision_id": revisionID,
		"version_no":         versionNo,
		"published_at":       time.Now().UTC().Format(time.RFC3339),
	}, nil
}

func (s *Service) loadPreviewLocked(previewSessionID string, role string, actorID string, now time.Time) (*previewSession, error) {
	session, ok := s.previews[previewSessionID]
	if !ok {
		return nil, ErrPreviewSessionNotFound
	}
	if s.previewTTL > 0 && now.Sub(session.LastTouched) > s.previewTTL {
		delete(s.previews, previewSessionID)
		return nil, ErrPreviewSessionNotFound
	}
	if session.OwnerRole != role || session.OwnerID != actorID {
		return nil, ErrPreviewSessionNotFound
	}
	return session, nil
}

func (s *Service) evictPreviewsLocked(now time.Time) {
	if s.previewTTL > 0 {
		for id, session := range s.previews {
			if now.Sub(session.LastTouched) > s.previewTTL {
				delete(s.previews, id)
			}
		}
	}
	if s.previewMax <= 0 || len(s.previews) < s.previewMax {
		return
	}
	var oldestID string
	var oldestTouch time.Time
	first := true
	for id, session := range s.previews {
		if first || session.LastTouched.Before(oldestTouch) {
			oldestID = id
			oldestTouch = session.LastTouched
			first = false
		}
	}
	if oldestID != "" {
		delete(s.previews, oldestID)
	}
}

var (
	ErrDraftVersionConflict           = fmt.Errorf("draft_version_conflict")
	ErrDraftValidationFailed          = fmt.Errorf("draft_validation_failed")
	ErrCourseNotFound                 = fmt.Errorf("course_not_found")
	ErrPreviewSessionNotFound         = fmt.Errorf("preview_session_not_found")
	ErrPreviewStateConflict           = fmt.Errorf("preview_session_state_conflict")
	ErrInvalidPreviewAction           = fmt.Errorf("invalid_preview_action")
	ErrPreviewEvaluationUnavailable   = fmt.Errorf("preview_evaluation_unavailable")
	ErrModerationReviewAlreadyPending = fmt.Errorf("moderation_review_already_pending")
	ErrReviewNotFound                 = fmt.Errorf("review_not_found")
	ErrReviewAlreadyResolved          = fmt.Errorf("review_already_resolved")
	ErrCourseNotPlatformOwned         = fmt.Errorf("course_not_platform_owned")
	ErrCourseNotPublishable           = fmt.Errorf("course_not_publishable")
)
