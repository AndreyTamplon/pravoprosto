package lessonruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"pravoprost/backend/internal/evaluation"
	platformconfig "pravoprost/backend/internal/platform/config"
)

type Service struct {
	db        *pgxpool.Pool
	config    platformconfig.Config
	logger    *slog.Logger
	evaluator evaluation.FreeTextEvaluator
}

func NewService(db *pgxpool.Pool, cfg platformconfig.Config, evaluator evaluation.FreeTextEvaluator, logger *slog.Logger) *Service {
	if evaluator == nil {
		evaluator = evaluation.NewOpenAICompatibleAdapter(cfg, logger)
	}
	return &Service{db: db, config: cfg, logger: logger, evaluator: evaluator}
}

type CatalogView struct {
	Sections []map[string]any `json:"sections"`
}

type CourseTreeView struct {
	CourseID         string           `json:"course_id"`
	CourseRevisionID string           `json:"course_revision_id"`
	Title            string           `json:"title"`
	Description      string           `json:"description"`
	Progress         map[string]any   `json:"progress,omitempty"`
	Modules          []map[string]any `json:"modules"`
}

type GameStateView struct {
	XPTotal           int64            `json:"xp_total"`
	Level             int              `json:"level"`
	HeartsCurrent     int              `json:"hearts_current"`
	HeartsMax         int              `json:"hearts_max"`
	HeartsRestoreAt   *string          `json:"hearts_restore_at"`
	CurrentStreakDays int              `json:"current_streak_days"`
	BestStreakDays    int              `json:"best_streak_days"`
	Badges            []map[string]any `json:"badges"`
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
	GameState      GameStateMini  `json:"game_state"`
}

type GameStateMini struct {
	XPTotal         int64   `json:"xp_total"`
	Level           int     `json:"level"`
	HeartsCurrent   int     `json:"hearts_current"`
	HeartsMax       int     `json:"hearts_max"`
	HeartsRestoreAt *string `json:"hearts_restore_at"`
}

type AnswerOutcome struct {
	Verdict          string         `json:"verdict"`
	FeedbackText     string         `json:"feedback_text"`
	XPDelta          int            `json:"xp_delta"`
	HeartsDelta      int            `json:"hearts_delta"`
	GameState        GameStateMini  `json:"game_state"`
	NextAction       string         `json:"next_action"`
	NextNodeID       *string        `json:"next_node_id"`
	LessonCompletion map[string]any `json:"lesson_completion"`
	NextStep         *StepView      `json:"next_step"`
}

type evaluationOutcome struct {
	Verdict          string
	Feedback         string
	NextNodeID       string
	EvaluatorType    string
	EvaluatorLatency *int
	EvaluatorTraceID *string
}

func DecodeNextRequest(r *http.Request) (int64, string, error) {
	var body struct {
		StateVersion   int64  `json:"state_version"`
		ExpectedNodeID string `json:"expected_node_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		return 0, "", err
	}
	return body.StateVersion, body.ExpectedNodeID, nil
}

func DecodeAnswerRequest(r *http.Request) (int64, string, map[string]any, error) {
	var body struct {
		StateVersion int64          `json:"state_version"`
		NodeID       string         `json:"node_id"`
		Answer       map[string]any `json:"answer"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		return 0, "", nil, err
	}
	return body.StateVersion, body.NodeID, body.Answer, nil
}

func (s *Service) Catalog(ctx context.Context, studentID string) (CatalogView, error) {
	rows, err := s.db.Query(ctx, `
		select c.id::text, cr.title, cr.description, null::text as cover_url,
		       c.course_kind, c.owner_kind,
		       coalesce((
		           select floor((count(*) filter (where lp.status = 'completed')::decimal / nullif(count(*), 0)::decimal) * 100)::int
		           from course_progress cp
		           join lesson_progress lp on lp.course_progress_id = cp.id
		           where cp.student_id = $1 and cp.course_id = c.id and cp.status = 'in_progress'
		       ), 0) as progress_percent
		from courses c
		join course_revisions cr on cr.course_id = c.id and cr.is_current = true
		where c.owner_kind = 'platform' and c.deleted_at is null
		order by cr.published_at desc
	`, studentID)
	if err != nil {
		return CatalogView{}, err
	}
	defer rows.Close()

	platformItems := make([]map[string]any, 0)
	for rows.Next() {
		var courseID, title, description string
		var coverURL *string
		var courseKind, ownerKind string
		var progressPercent int
		if err := rows.Scan(&courseID, &title, &description, &coverURL, &courseKind, &ownerKind, &progressPercent); err != nil {
			return CatalogView{}, err
		}
		platformItems = append(platformItems, map[string]any{
			"course_id":        courseID,
			"title":            title,
			"description":      description,
			"cover_url":        coverURL,
			"course_kind":      courseKind,
			"owner_kind":       ownerKind,
			"source_section":   "platform_catalog",
			"progress_percent": progressPercent,
			"is_new":           false,
			"badges":           []string{},
		})
	}
	if rows.Err() != nil {
		return CatalogView{}, rows.Err()
	}

	teacherRows, err := s.db.Query(ctx, `
		select c.id::text, cr.title, cr.description, null::text as cover_url,
		       c.course_kind, c.owner_kind,
		       coalesce((
		           select floor((coalesce(completed_count, 0)::decimal / nullif(total_count, 0)::decimal) * 100)::int
		           from (
		               select cp.id,
		                      count(crl.lesson_id) as total_count,
		                      count(*) filter (where lp.status = 'completed') as completed_count
		               from course_progress cp
		               join course_revision_lessons crl on crl.course_revision_id = cp.course_revision_id
		               left join lesson_progress lp on lp.course_progress_id = cp.id and lp.lesson_id = crl.lesson_id
		               where cp.student_id = $1 and cp.course_id = c.id
		               group by cp.id
		               order by case when cp.status = 'in_progress' then 0 else 1 end, cp.started_at desc
		               limit 1
		           ) progress_row
		       ), 0) as progress_percent
		from course_access_grants g
		join courses c on c.id = g.course_id
		join course_revisions cr on cr.course_id = c.id and cr.is_current = true
		where g.student_id = $1 and g.archived_at is null and c.deleted_at is null
		order by g.granted_at desc
	`, studentID)
	if err != nil {
		return CatalogView{}, err
	}
	defer teacherRows.Close()

	teacherItems := make([]map[string]any, 0)
	for teacherRows.Next() {
		var courseID, title, description string
		var coverURL *string
		var courseKind, ownerKind string
		var progressPercent int
		if err := teacherRows.Scan(&courseID, &title, &description, &coverURL, &courseKind, &ownerKind, &progressPercent); err != nil {
			return CatalogView{}, err
		}
		teacherItems = append(teacherItems, map[string]any{
			"course_id":        courseID,
			"title":            title,
			"description":      description,
			"cover_url":        coverURL,
			"course_kind":      courseKind,
			"owner_kind":       ownerKind,
			"source_section":   "teacher_access",
			"progress_percent": progressPercent,
			"is_new":           false,
			"badges":           []string{},
		})
	}
	return CatalogView{
		Sections: []map[string]any{
			{"section": "platform_catalog", "title": "Курсы платформы", "items": platformItems},
			{"section": "teacher_access", "title": "Курсы по ссылке", "items": teacherItems},
		},
	}, teacherRows.Err()
}

func (s *Service) GameState(ctx context.Context, studentID string) (GameStateView, error) {
	state, err := s.ensureGameState(ctx, studentID)
	if err != nil {
		return GameStateView{}, err
	}
	rows, err := s.db.Query(ctx, `select badge_code, awarded_at::text from student_badges where student_id = $1 order by awarded_at desc`, studentID)
	if err != nil {
		return GameStateView{}, err
	}
	defer rows.Close()
	badges := make([]map[string]any, 0)
	for rows.Next() {
		var badgeCode, awardedAt string
		if err := rows.Scan(&badgeCode, &awardedAt); err != nil {
			return GameStateView{}, err
		}
		badges = append(badges, map[string]any{"badge_code": badgeCode, "awarded_at": awardedAt})
	}
	return GameStateView{
		XPTotal:           state.XPTotal,
		Level:             state.Level,
		HeartsCurrent:     state.HeartsCurrent,
		HeartsMax:         state.HeartsMax,
		HeartsRestoreAt:   state.HeartsRestoreAt,
		CurrentStreakDays: state.CurrentStreakDays,
		BestStreakDays:    state.BestStreakDays,
		Badges:            badges,
	}, rows.Err()
}

func (s *Service) CourseTree(ctx context.Context, studentID string, courseID string) (CourseTreeView, error) {
	revisionID, title, description, content, err := s.resolveRevision(ctx, studentID, courseID)
	if err != nil {
		return CourseTreeView{}, err
	}
	modules, err := buildTreeModules(s, content, s.db, ctx, studentID, courseID, revisionID)
	if err != nil {
		return CourseTreeView{}, err
	}
	progress, err := s.courseTreeProgress(ctx, studentID, courseID, revisionID)
	if err != nil {
		return CourseTreeView{}, err
	}
	return CourseTreeView{
		CourseID:         courseID,
		CourseRevisionID: revisionID,
		Title:            title,
		Description:      description,
		Progress:         progress,
		Modules:          modules,
	}, nil
}

func (s *Service) courseTreeProgress(ctx context.Context, studentID string, courseID string, revisionID string) (map[string]any, error) {
	var status string
	var completedLessons int
	var totalLessons int
	var lastActivityAt *string
	err := s.db.QueryRow(ctx, `
		select cp.status,
		       coalesce((
		           select count(*)
		           from lesson_progress lp
		           where lp.course_progress_id = cp.id and lp.status = 'completed'
		       ), 0),
		       (
		           select count(*)
		           from course_revision_lessons crl
		           where crl.course_revision_id = cp.course_revision_id
		       ),
		       cp.last_activity_at::text
		from course_progress cp
		where cp.student_id = $1 and cp.course_id = $2 and cp.course_revision_id = $3
		order by case when cp.status = 'in_progress' then 0 else 1 end, cp.started_at desc
		limit 1
	`, studentID, courseID, revisionID).Scan(&status, &completedLessons, &totalLessons, &lastActivityAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"status":            status,
		"completed_lessons": completedLessons,
		"total_lessons":     totalLessons,
		"last_activity_at":  lastActivityAt,
	}, nil
}

func (s *Service) StartLesson(ctx context.Context, studentID string, courseID string, lessonID string) (StepView, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return StepView{}, err
	}
	defer tx.Rollback(ctx)

	revisionID, _, _, content, err := s.resolveRevisionTx(ctx, tx, studentID, courseID)
	if err != nil {
		return StepView{}, err
	}
	graph, err := graphForLesson(content, lessonID)
	if err != nil {
		return StepView{}, err
	}
	state, err := s.ensureGameStateTx(ctx, tx, studentID)
	if err != nil {
		return StepView{}, err
	}
	var sessionID string
	var currentNodeID string
	var stateVersion int64
	err = tx.QueryRow(ctx, `
		select ls.id::text, ls.current_node_id, ls.state_version
		from lesson_sessions ls
		join course_progress cp on cp.id = ls.course_progress_id
		where ls.student_id = $1 and cp.course_id = $2 and ls.lesson_id = $3 and ls.status = 'in_progress'
		for update of ls
	`, studentID, courseID, lessonID).Scan(&sessionID, &currentNodeID, &stateVersion)
	if err != nil && err != pgx.ErrNoRows {
		return StepView{}, err
	}
	if err == nil {
		if err := s.ensureLessonAccessTx(ctx, tx, studentID, courseID, lessonID); err != nil {
			return StepView{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return StepView{}, err
		}
		return renderStep(sessionID, courseID, lessonID, stateVersion, graph, currentNodeID, state), nil
	}

	if err := s.ensureLessonStartAllowedTx(ctx, tx, studentID, courseID, revisionID, lessonID); err != nil {
		return StepView{}, err
	}
	if err := s.ensureLessonAccessTx(ctx, tx, studentID, courseID, lessonID); err != nil {
		return StepView{}, err
	}

	courseProgressID, err := s.ensureCourseProgressTx(ctx, tx, studentID, courseID, revisionID, lessonID)
	if err != nil {
		return StepView{}, err
	}
	if err := s.ensureLessonProgressTx(ctx, tx, studentID, courseProgressID, revisionID, lessonID); err != nil {
		return StepView{}, err
	}
	currentNodeID = graph.StartNodeID
	stateVersion = 1
	if err := tx.QueryRow(ctx, `
		insert into lesson_sessions(student_id, course_progress_id, course_revision_id, lesson_id, status, current_node_id, state_version)
		values ($1, $2, $3, $4, 'in_progress', $5, 1)
		returning id::text
	`, studentID, courseProgressID, revisionID, lessonID, currentNodeID).Scan(&sessionID); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			if err := tx.QueryRow(ctx, `
				select ls.id::text, ls.current_node_id, ls.state_version
				from lesson_sessions ls
				join course_progress cp on cp.id = ls.course_progress_id
				where ls.student_id = $1 and cp.course_id = $2 and ls.lesson_id = $3 and ls.status = 'in_progress'
				for update of ls
			`, studentID, courseID, lessonID).Scan(&sessionID, &currentNodeID, &stateVersion); err != nil {
				return StepView{}, err
			}
		} else {
			return StepView{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return StepView{}, err
	}
	return renderStep(sessionID, courseID, lessonID, stateVersion, graph, currentNodeID, state), nil
}

func (s *Service) SessionByCourseLesson(ctx context.Context, studentID string, courseID string, lessonID string) (StepView, error) {
	var sessionID string
	err := s.db.QueryRow(ctx, `
		select ls.id::text
		from lesson_sessions ls
		join course_progress cp on cp.id = ls.course_progress_id
		where ls.student_id = $1 and cp.course_id = $2 and ls.lesson_id = $3 and ls.status = 'in_progress'
	`, studentID, courseID, lessonID).Scan(&sessionID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return StepView{}, ErrLessonSessionNotFound
		}
		return StepView{}, err
	}
	return s.SessionByID(ctx, studentID, sessionID)
}

func (s *Service) SessionByID(ctx context.Context, studentID string, sessionID string) (StepView, error) {
	var courseID, revisionID, lessonID, currentNodeID string
	var stateVersion int64
	var status string
	err := s.db.QueryRow(ctx, `
		select cp.course_id::text, ls.course_revision_id::text, ls.lesson_id, ls.current_node_id, ls.state_version, ls.status
		from lesson_sessions ls
		join course_progress cp on cp.id = ls.course_progress_id
		where ls.id = $1 and ls.student_id = $2
	`, sessionID, studentID).Scan(&courseID, &revisionID, &lessonID, &currentNodeID, &stateVersion, &status)
	if err != nil {
		if err == pgx.ErrNoRows {
			return StepView{}, ErrLessonSessionNotFound
		}
		return StepView{}, err
	}
	if status != "in_progress" {
		return StepView{}, ErrLessonSessionNotActive
	}
	if err := s.ensureCourseAccess(ctx, studentID, courseID); err != nil {
		return StepView{}, err
	}
	accessState, _, _, err := s.resolveCommercialAccessState(ctx, s.db, studentID, courseID, lessonID)
	if err != nil {
		return StepView{}, err
	}
	switch accessState {
	case "locked_paid":
		return StepView{}, ErrContentLockedPaid
	case "awaiting_payment_confirmation":
		return StepView{}, ErrContentAccessAwaitingConfirmation
	}
	graph, err := s.graphForRevisionLesson(ctx, revisionID, lessonID)
	if err != nil {
		return StepView{}, err
	}
	state, err := s.ensureGameState(ctx, studentID)
	if err != nil {
		return StepView{}, err
	}
	return renderStep(sessionID, courseID, lessonID, stateVersion, graph, currentNodeID, state), nil
}

func (s *Service) Next(ctx context.Context, studentID string, sessionID string, stateVersion int64, expectedNodeID string) (StepView, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return StepView{}, err
	}
	defer tx.Rollback(ctx)
	var courseID, revisionID, lessonID, currentNodeID, courseProgressID string
	var currentVersion int64
	var status string
	if err := tx.QueryRow(ctx, `
		select cp.course_id::text, ls.course_revision_id::text, ls.lesson_id, ls.current_node_id, ls.state_version, ls.status, cp.id::text
		from lesson_sessions ls
		join course_progress cp on cp.id = ls.course_progress_id
		where ls.id = $1 and ls.student_id = $2
		for update
	`, sessionID, studentID).Scan(&courseID, &revisionID, &lessonID, &currentNodeID, &currentVersion, &status, &courseProgressID); err != nil {
		if err == pgx.ErrNoRows {
			return StepView{}, ErrLessonSessionNotFound
		}
		return StepView{}, err
	}
	if status != "in_progress" {
		return StepView{}, ErrLessonSessionNotActive
	}
	if err := s.ensureCourseAccessTx(ctx, tx, studentID, courseID); err != nil {
		return StepView{}, err
	}
	if err := s.ensureLessonAccessTx(ctx, tx, studentID, courseID, lessonID); err != nil {
		return StepView{}, err
	}
	graph, err := s.graphForRevisionLessonTx(ctx, tx, revisionID, lessonID)
	if err != nil {
		return StepView{}, err
	}
	if currentVersion != stateVersion || currentNodeID != expectedNodeID {
		priorNode := graph.NodeMap[expectedNodeID]
		if currentVersion == stateVersion+1 && priorNode.Kind == "story" && priorNode.NextNodeID != "" && currentNodeID == priorNode.NextNodeID {
			currentNode := graph.NodeMap[currentNodeID]
			if currentNode.Kind == "end" {
				completion, err := s.completeLessonTx(ctx, tx, studentID, sessionID, courseProgressID, lessonID, 0, graph, currentNode.Text)
				if err != nil {
					return StepView{}, err
				}
				_ = completion
			}
			state, err := s.ensureGameStateTx(ctx, tx, studentID)
			if err != nil {
				return StepView{}, err
			}
			if err := tx.Commit(ctx); err != nil {
				return StepView{}, err
			}
			return renderStep(sessionID, courseID, lessonID, currentVersion, graph, currentNodeID, state), nil
		}
		return StepView{}, ErrLessonSessionStateConflict
	}
	node := graph.NodeMap[currentNodeID]
	if node.Kind != "story" || node.NextNodeID == "" {
		return StepView{}, ErrLessonSessionStateConflict
	}
	nextNode := graph.NodeMap[node.NextNodeID]
	newVersion := currentVersion + 1
	state, err := s.ensureGameStateTx(ctx, tx, studentID)
	if err != nil {
		return StepView{}, err
	}
	if nextNode.Kind == "end" {
		if _, err := tx.Exec(ctx, `update lesson_sessions set current_node_id = $2, state_version = $3, last_activity_at = now() where id = $1`, sessionID, nextNode.ID, newVersion); err != nil {
			return StepView{}, err
		}
		completion, err := s.completeLessonTx(ctx, tx, studentID, sessionID, courseProgressID, lessonID, 0, graph, nextNode.Text)
		if err != nil {
			return StepView{}, err
		}
		_ = completion
		if err := tx.Commit(ctx); err != nil {
			return StepView{}, err
		}
		return renderStep(sessionID, courseID, lessonID, newVersion, graph, nextNode.ID, state), nil
	}
	if _, err := tx.Exec(ctx, `update lesson_sessions set current_node_id = $2, state_version = $3, last_activity_at = now() where id = $1`, sessionID, node.NextNodeID, newVersion); err != nil {
		return StepView{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return StepView{}, err
	}
	return renderStep(sessionID, courseID, lessonID, newVersion, graph, nextNode.ID, state), nil
}

func (s *Service) Answer(ctx context.Context, studentID string, sessionID string, stateVersion int64, nodeID string, answer map[string]any, idempotencyKey string) (AnswerOutcome, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return AnswerOutcome{}, err
	}
	defer tx.Rollback(ctx)

	var courseID, revisionID, lessonID, currentNodeID, status string
	var currentVersion int64
	var courseProgressID string
	if err := tx.QueryRow(ctx, `
		select cp.course_id::text, ls.course_revision_id::text, ls.lesson_id, ls.current_node_id, ls.state_version, ls.status, ls.course_progress_id::text
		from lesson_sessions ls
		join course_progress cp on cp.id = ls.course_progress_id
		where ls.id = $1 and ls.student_id = $2
		for update
	`, sessionID, studentID).Scan(&courseID, &revisionID, &lessonID, &currentNodeID, &currentVersion, &status, &courseProgressID); err != nil {
		if err == pgx.ErrNoRows {
			return AnswerOutcome{}, ErrLessonSessionNotFound
		}
		return AnswerOutcome{}, err
	}
	if status != "in_progress" {
		return AnswerOutcome{}, ErrLessonSessionNotActive
	}
	if err := s.ensureCourseAccessTx(ctx, tx, studentID, courseID); err != nil {
		return AnswerOutcome{}, err
	}
	if err := s.ensureLessonAccessTx(ctx, tx, studentID, courseID, lessonID); err != nil {
		return AnswerOutcome{}, err
	}
	if currentVersion != stateVersion || currentNodeID != nodeID {
		return AnswerOutcome{}, ErrLessonSessionStateConflict
	}

	var duplicate int
	if err := tx.QueryRow(ctx, `select count(*) from step_attempts where lesson_session_id = $1 and client_idempotency_key = $2`, sessionID, idempotencyKey).Scan(&duplicate); err != nil {
		return AnswerOutcome{}, err
	}
	if duplicate > 0 {
		return AnswerOutcome{}, ErrDuplicateAnswerSubmission
	}

	state, err := s.ensureGameStateTx(ctx, tx, studentID)
	if err != nil {
		return AnswerOutcome{}, err
	}
	if state.HeartsCurrent <= 0 {
		return AnswerOutcome{}, ErrOutOfHearts
	}
	graph, err := s.graphForRevisionLessonTx(ctx, tx, revisionID, lessonID)
	if err != nil {
		return AnswerOutcome{}, err
	}
	node := graph.NodeMap[nodeID]
	if node.Kind != "single_choice" && node.Kind != "free_text" {
		return AnswerOutcome{}, ErrAnswerOnNonQuestionNode
	}
	evaluationResult, err := s.evaluateNode(ctx, node, answer)
	if err != nil {
		return AnswerOutcome{}, err
	}
	answerPayload, err := json.Marshal(answer)
	if err != nil {
		return AnswerOutcome{}, err
	}
	var heartsDelta int
	var xpDelta int
	if evaluationResult.Verdict == "incorrect" {
		heartsDelta = -1
	}
	if evaluationResult.Verdict == "correct" {
		xpDelta = 10
	} else if evaluationResult.Verdict == "partial" {
		xpDelta = 5
	}
	if err := s.applyGameMutationTx(ctx, tx, studentID, xpDelta, heartsDelta); err != nil {
		return AnswerOutcome{}, err
	}
	var attemptNo int
	if err := tx.QueryRow(ctx, `select coalesce(max(attempt_no), 0) + 1 from step_attempts where lesson_session_id = $1`, sessionID).Scan(&attemptNo); err != nil {
		return AnswerOutcome{}, err
	}
	attemptID := uuid.NewString()
	if _, err := tx.Exec(ctx, `
		insert into step_attempts(
			id, lesson_session_id, node_id, attempt_no, client_idempotency_key, answer_json,
			verdict, feedback_text, next_node_id, evaluator_type, evaluator_latency_ms, evaluator_trace_id
		)
		values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
	`, attemptID, sessionID, nodeID, attemptNo, idempotencyKey, answerPayload, evaluationResult.Verdict, evaluationResult.Feedback, evaluationResult.NextNodeID, evaluationResult.EvaluatorType, evaluationResult.EvaluatorLatency, evaluationResult.EvaluatorTraceID); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return AnswerOutcome{}, ErrDuplicateAnswerSubmission
		}
		return AnswerOutcome{}, err
	}
	if _, err := tx.Exec(ctx, `
		update course_progress
		set correct_answers = correct_answers + $2,
		    partial_answers = partial_answers + $3,
		    incorrect_answers = incorrect_answers + $4,
		    last_lesson_id = $5,
		    last_activity_at = now()
		where id = $1
	`, courseProgressID, boolToInt(evaluationResult.Verdict == "correct"), boolToInt(evaluationResult.Verdict == "partial"), boolToInt(evaluationResult.Verdict == "incorrect"), lessonID); err != nil {
		return AnswerOutcome{}, err
	}
	if _, err := tx.Exec(ctx, `
		update lesson_progress
		set status = 'in_progress',
		    attempts_count = attempts_count + 1,
		    best_verdict = case
		        when best_verdict = 'correct' then 'correct'
		        when best_verdict = 'partial' and $3 = 'incorrect' then 'partial'
		        when best_verdict = 'partial' and $3 = 'correct' then 'correct'
		        when best_verdict = 'incorrect' and ($3 = 'partial' or $3 = 'correct') then $3
		        when best_verdict is null then $3
		        else best_verdict
		    end,
		    started_at = coalesce(started_at, now()),
		    last_activity_at = now()
		where course_progress_id = $1 and lesson_id = $2
	`, courseProgressID, lessonID, evaluationResult.Verdict); err != nil {
		return AnswerOutcome{}, err
	}
	if _, err := tx.Exec(ctx, `
		insert into game_events(student_id, source_type, source_id, event_type, xp_delta, hearts_delta, streak_delta)
		values ($1, 'step_attempt', $2, 'evaluated', $3, $4, 0)
	`, studentID, attemptID, xpDelta, heartsDelta); err != nil {
		return AnswerOutcome{}, err
	}

	state, err = s.ensureGameStateTx(ctx, tx, studentID)
	if err != nil {
		return AnswerOutcome{}, err
	}
	nextNode := graph.NodeMap[evaluationResult.NextNodeID]
	if nextNode.Kind == "end" {
		completion, err := s.completeLessonTx(ctx, tx, studentID, sessionID, courseProgressID, lessonID, xpDelta, graph, nextNode.Text)
		if err != nil {
			return AnswerOutcome{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return AnswerOutcome{}, err
		}
		return AnswerOutcome{
			Verdict:          evaluationResult.Verdict,
			FeedbackText:     evaluationResult.Feedback,
			XPDelta:          xpDelta,
			HeartsDelta:      heartsDelta,
			GameState:        state.toMini(),
			NextAction:       "lesson_completed",
			NextNodeID:       nil,
			LessonCompletion: completion,
			NextStep:         nil,
		}, nil
	}

	newVersion := currentVersion + 1
	if _, err := tx.Exec(ctx, `update lesson_sessions set current_node_id = $2, state_version = $3, last_activity_at = now() where id = $1`, sessionID, evaluationResult.NextNodeID, newVersion); err != nil {
		return AnswerOutcome{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AnswerOutcome{}, err
	}
	step := renderStep(sessionID, courseID, lessonID, newVersion, graph, evaluationResult.NextNodeID, state)
	return AnswerOutcome{
		Verdict:          evaluationResult.Verdict,
		FeedbackText:     evaluationResult.Feedback,
		XPDelta:          xpDelta,
		HeartsDelta:      heartsDelta,
		GameState:        state.toMini(),
		NextAction:       "show_next_node",
		NextNodeID:       &evaluationResult.NextNodeID,
		LessonCompletion: nil,
		NextStep:         &step,
	}, nil
}

func (s *Service) Retry(ctx context.Context, studentID string, courseID string, lessonID string) (StepView, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return StepView{}, err
	}
	defer tx.Rollback(ctx)
	state, err := s.ensureGameStateTx(ctx, tx, studentID)
	if err != nil {
		return StepView{}, err
	}
	courseProgressID, revisionID, err := s.activeOrLatestCourseProgressTx(ctx, tx, studentID, courseID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return StepView{}, ErrLessonRetryNotAllowed
		}
		return StepView{}, err
	}
	if err := s.ensureLessonRetryAllowedTx(ctx, tx, studentID, courseID, courseProgressID, revisionID, lessonID); err != nil {
		return StepView{}, err
	}
	graph, err := s.graphForRevisionLessonTx(ctx, tx, revisionID, lessonID)
	if err != nil {
		return StepView{}, err
	}
	if _, err := tx.Exec(ctx, `
		update lesson_progress
		set replay_count = replay_count + 1, status = 'in_progress', last_activity_at = now()
		where course_progress_id = $1 and lesson_id = $2
	`, courseProgressID, lessonID); err != nil {
		return StepView{}, err
	}
	var sessionID string
	if err := tx.QueryRow(ctx, `
		insert into lesson_sessions(student_id, course_progress_id, course_revision_id, lesson_id, status, current_node_id, state_version)
		values ($1, $2, $3, $4, 'in_progress', $5, 1)
		returning id::text
	`, studentID, courseProgressID, revisionID, lessonID, graph.StartNodeID).Scan(&sessionID); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return StepView{}, ErrLessonRetryNotAllowed
		}
		return StepView{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return StepView{}, err
	}
	return renderStep(sessionID, courseID, lessonID, 1, graph, graph.StartNodeID, state), nil
}

type gameState struct {
	XPTotal           int64
	Level             int
	HeartsCurrent     int
	HeartsMax         int
	HeartsRestoreAt   *string
	CurrentStreakDays int
	BestStreakDays    int
}

func (g gameState) toMini() GameStateMini {
	return GameStateMini{
		XPTotal:         g.XPTotal,
		Level:           g.Level,
		HeartsCurrent:   g.HeartsCurrent,
		HeartsMax:       g.HeartsMax,
		HeartsRestoreAt: g.HeartsRestoreAt,
	}
}

var (
	ErrLessonSessionNotFound             = fmt.Errorf("lesson_session_not_found")
	ErrLessonSessionNotActive            = fmt.Errorf("lesson_session_not_active")
	ErrLessonSessionStateConflict        = fmt.Errorf("lesson_session_state_conflict")
	ErrAnswerOnNonQuestionNode           = fmt.Errorf("answer_on_non_question_node")
	ErrLessonRetryNotAllowed             = fmt.Errorf("lesson_retry_not_allowed")
	ErrDuplicateAnswerSubmission         = fmt.Errorf("duplicate_answer_submission")
	ErrContentLockedPaid                 = fmt.Errorf("content_locked_paid")
	ErrContentAccessAwaitingConfirmation = fmt.Errorf("content_access_awaiting_confirmation")
	ErrLockedTeacherAccess               = fmt.Errorf("locked_teacher_access")
	ErrLockedPrerequisite                = fmt.Errorf("locked_prerequisite")
	ErrOutOfHearts                       = fmt.Errorf("out_of_hearts")
	ErrLLMTemporarilyUnavailable         = fmt.Errorf("llm_temporarily_unavailable")
)
