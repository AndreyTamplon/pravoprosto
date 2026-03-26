package lessonruntime

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"pravoprost/backend/internal/evaluation"
)

type runtimeGraph struct {
	StartNodeID string
	Order       []string
	NodeMap     map[string]runtimeNode
}

type runtimeNode struct {
	ID          string
	Kind        string
	NextNodeID  string
	Text        string
	AssetURL    string
	Prompt      string
	Options     []runtimeOption
	Transitions map[string]string
	Rubric      map[string]any
}

type runtimeOption struct {
	ID         string
	Text       string
	Result     string
	Feedback   string
	NextNodeID string
}

func (s *Service) resolveRevision(ctx context.Context, studentID string, courseID string) (string, string, string, json.RawMessage, error) {
	if revisionID, title, description, content, err := s.activeRevisionForStudent(ctx, studentID, courseID); err == nil {
		return revisionID, title, description, content, nil
	}
	return s.resolvePublishedRevision(ctx, studentID, courseID)
}

func (s *Service) resolveRevisionTx(ctx context.Context, tx pgx.Tx, studentID string, courseID string) (string, string, string, json.RawMessage, error) {
	if revisionID, title, description, content, err := s.activeRevisionForStudentTx(ctx, tx, studentID, courseID); err == nil {
		return revisionID, title, description, content, nil
	}
	revisionID, title, content, err := s.resolvePublishedRevisionTx(ctx, tx, studentID, courseID)
	if err != nil {
		return "", "", "", nil, err
	}
	return revisionID, title, "", content, nil
}

func (s *Service) activeRevisionForStudent(ctx context.Context, studentID string, courseID string) (string, string, string, json.RawMessage, error) {
	var revisionID, title, description string
	var content json.RawMessage
	err := s.db.QueryRow(ctx, `
		select cr.id::text, cr.title, cr.description, cr.content_json::text
		from course_progress cp
		join course_revisions cr on cr.id = cp.course_revision_id
		where cp.student_id = $1 and cp.course_id = $2 and cp.status = 'in_progress'
	`, studentID, courseID).Scan(&revisionID, &title, &description, &content)
	if err == nil {
		if err := s.ensureCourseAccess(ctx, studentID, courseID); err != nil {
			return "", "", "", nil, err
		}
	}
	return revisionID, title, description, content, err
}

func (s *Service) activeRevisionForStudentTx(ctx context.Context, tx pgx.Tx, studentID string, courseID string) (string, string, string, json.RawMessage, error) {
	var revisionID, title, description string
	var content json.RawMessage
	err := tx.QueryRow(ctx, `
		select cr.id::text, cr.title, cr.description, cr.content_json::text
		from course_progress cp
		join course_revisions cr on cr.id = cp.course_revision_id
		where cp.student_id = $1 and cp.course_id = $2 and cp.status = 'in_progress'
		for update of cp
	`, studentID, courseID).Scan(&revisionID, &title, &description, &content)
	if err == nil {
		if err := s.ensureCourseAccessTx(ctx, tx, studentID, courseID); err != nil {
			return "", "", "", nil, err
		}
	}
	return revisionID, title, description, content, err
}

func (s *Service) resolvePublishedRevision(ctx context.Context, studentID string, courseID string) (string, string, string, json.RawMessage, error) {
	if err := s.ensureCourseAccess(ctx, studentID, courseID); err != nil {
		return "", "", "", nil, err
	}
	var revisionID, title, description string
	var content json.RawMessage
	err := s.db.QueryRow(ctx, `
		select id::text, title, description, content_json::text
		from course_revisions
		where course_id = $1 and is_current = true
	`, courseID).Scan(&revisionID, &title, &description, &content)
	return revisionID, title, description, content, err
}

func (s *Service) resolvePublishedRevisionTx(ctx context.Context, tx pgx.Tx, studentID string, courseID string) (string, string, json.RawMessage, error) {
	if err := s.ensureCourseAccessTx(ctx, tx, studentID, courseID); err != nil {
		return "", "", nil, err
	}
	var revisionID, title string
	var content json.RawMessage
	err := tx.QueryRow(ctx, `
		select id::text, title, content_json::text
		from course_revisions
		where course_id = $1 and is_current = true
		for update
	`, courseID).Scan(&revisionID, &title, &content)
	return revisionID, title, content, err
}

func (s *Service) ensureCourseAccess(ctx context.Context, studentID string, courseID string) error {
	var ownerKind string
	if err := s.db.QueryRow(ctx, `select owner_kind from courses where id = $1 and deleted_at is null`, courseID).Scan(&ownerKind); err != nil {
		return err
	}
	if ownerKind == "platform" {
		return nil
	}
	var grantCount int
	if err := s.db.QueryRow(ctx, `
		select count(*)
		from course_access_grants
		where course_id = $1 and student_id = $2 and archived_at is null
	`, courseID, studentID).Scan(&grantCount); err != nil {
		return err
	}
	if grantCount == 0 {
		return ErrLockedTeacherAccess
	}
	return nil
}

func (s *Service) ensureCourseAccessTx(ctx context.Context, tx pgx.Tx, studentID string, courseID string) error {
	var ownerKind string
	if err := tx.QueryRow(ctx, `select owner_kind from courses where id = $1 and deleted_at is null`, courseID).Scan(&ownerKind); err != nil {
		return err
	}
	if ownerKind == "platform" {
		return nil
	}
	var grantCount int
	if err := tx.QueryRow(ctx, `
		select count(*)
		from course_access_grants
		where course_id = $1 and student_id = $2 and archived_at is null
	`, courseID, studentID).Scan(&grantCount); err != nil {
		return err
	}
	if grantCount == 0 {
		return ErrLockedTeacherAccess
	}
	return nil
}

func buildTreeModules(s *Service, content json.RawMessage, db txLike, ctx context.Context, studentID string, courseID string, revisionID string) ([]map[string]any, error) {
	payload := map[string]any{}
	if err := json.Unmarshal(content, &payload); err != nil {
		return nil, err
	}
	modules, _ := payload["modules"].([]any)
	result := make([]map[string]any, 0, len(modules))
	for _, rawModule := range modules {
		module, _ := rawModule.(map[string]any)
		moduleLessons := make([]map[string]any, 0)
		lessons, _ := module["lessons"].([]any)
		allPreviousCompleted := true
		for _, rawLesson := range lessons {
			lesson, _ := rawLesson.(map[string]any)
			lessonID := asStringAny(lesson["id"])
			var status string
			var progressPercent int
			err := db.QueryRow(ctx, `
				select coalesce(lp.status, 'not_started'),
				       case when lp.status = 'completed' then 100 when lp.status = 'in_progress' then 50 else 0 end
				from course_progress cp
				left join lesson_progress lp on lp.course_progress_id = cp.id and lp.lesson_id = $3
				where cp.student_id = $1 and cp.course_id = $2 and cp.course_revision_id = $4
				order by case when cp.status = 'in_progress' then 0 else 1 end, cp.started_at desc
				limit 1
			`, studentID, courseID, lessonID, revisionID).Scan(&status, &progressPercent)
			if err == pgx.ErrNoRows {
				status = "not_started"
				progressPercent = 0
			} else if err != nil {
				return nil, err
			}
			commercialState, offerView, orderView, err := s.resolveCommercialAccessState(ctx, db, studentID, courseID, lessonID)
			if err != nil {
				return nil, err
			}
			accessState := commercialState
			if status == "completed" {
				accessState = "completed"
			}
			if !allPreviousCompleted && status == "not_started" {
				accessState = "locked_prerequisite"
			}
			moduleLessons = append(moduleLessons, map[string]any{
				"lesson_id":        lessonID,
				"title":            asStringAny(lesson["title"]),
				"status":           status,
				"progress_percent": progressPercent,
				"access": map[string]any{
					"lesson_id":    lessonID,
					"access_state": accessState,
					"offer":        offerView,
					"order":        orderView,
					"support_hint": nil,
				},
			})
			if status != "completed" {
				allPreviousCompleted = false
			}
		}
		result = append(result, map[string]any{
			"module_id": asStringAny(module["id"]),
			"title":     asStringAny(module["title"]),
			"lessons":   moduleLessons,
		})
	}
	return result, nil
}

func (s *Service) resolveCommercialAccessState(ctx context.Context, db txLike, studentID string, courseID string, lessonID string) (string, map[string]any, map[string]any, error) {
	var entitlementID string
	err := db.QueryRow(ctx, `
		select id::text
		from entitlements
		where student_id = $1 and status = 'active' and target_course_id = $2
		  and (target_type = 'course' or (target_type = 'lesson' and target_lesson_id = $3))
		order by case when target_type = 'lesson' then 0 else 1 end
		limit 1
	`, studentID, courseID, lessonID).Scan(&entitlementID)
	if err == nil {
		return "granted", nil, nil, nil
	}
	if err != pgx.ErrNoRows {
		return "", nil, nil, err
	}

	var orderID, orderTargetType string
	pendingTTL := s.config.TBankPendingTTL
	if pendingTTL <= 0 {
		pendingTTL = 60 * time.Minute
	}
	pendingCutoff := time.Now().UTC().Add(-pendingTTL)
	err = db.QueryRow(ctx, `
		select id::text, target_type
		from commercial_orders
		where student_id = $1 and status = 'awaiting_confirmation' and target_course_id = $2
		  and (target_type = 'course' or (target_type = 'lesson' and target_lesson_id = $3))
		  and created_at >= $4
		order by case when target_type = 'lesson' then 0 else 1 end
		limit 1
	`, studentID, courseID, lessonID, pendingCutoff).Scan(&orderID, &orderTargetType)
	if err == nil {
		return "awaiting_payment_confirmation", nil, map[string]any{
			"order_id":    orderID,
			"target_type": orderTargetType,
			"status":      "awaiting_confirmation",
		}, nil
	}
	if err != pgx.ErrNoRows {
		return "", nil, nil, err
	}

	var offerID, offerTargetType, title, priceCurrency string
	var hasOpenRequest bool
	var priceAmountMinor int64
	err = db.QueryRow(ctx, `
		select o.id::text, o.target_type, o.title, o.price_amount_minor, o.price_currency,
		       exists(
		           select 1
		           from purchase_requests pr
		           where pr.offer_id = o.id and pr.student_id = $3 and pr.status = 'open'
		       ) as has_open_request
		from commercial_offers o
		where o.status = 'active' and o.target_course_id = $1
		  and (o.target_type = 'course' or (o.target_type = 'lesson' and o.target_lesson_id = $2))
		order by case when o.target_type = 'lesson' then 0 else 1 end
		limit 1
	`, courseID, lessonID, studentID).Scan(&offerID, &offerTargetType, &title, &priceAmountMinor, &priceCurrency, &hasOpenRequest)
	if err == nil {
		return "locked_paid", map[string]any{
			"offer_id":           offerID,
			"target_type":        offerTargetType,
			"title":              title,
			"price_amount_minor": priceAmountMinor,
			"price_currency":     priceCurrency,
			"has_open_request":   hasOpenRequest,
		}, nil, nil
	}
	if err != pgx.ErrNoRows {
		return "", nil, nil, err
	}
	return "free", nil, nil, nil
}

func (s *Service) ensureLessonAccessTx(ctx context.Context, tx pgx.Tx, studentID string, courseID string, lessonID string) error {
	accessState, _, _, err := s.resolveCommercialAccessState(ctx, tx, studentID, courseID, lessonID)
	if err != nil {
		return err
	}
	switch accessState {
	case "locked_paid":
		return ErrContentLockedPaid
	case "awaiting_payment_confirmation":
		return ErrContentAccessAwaitingConfirmation
	default:
		return nil
	}
}

func (s *Service) ensureLessonStartAllowedTx(ctx context.Context, tx pgx.Tx, studentID string, courseID string, revisionID string, lessonID string) error {
	var moduleID string
	var sortOrder int
	if err := tx.QueryRow(ctx, `
		select module_id, sort_order
		from course_revision_lessons
		where course_revision_id = $1 and lesson_id = $2
	`, revisionID, lessonID).Scan(&moduleID, &sortOrder); err != nil {
		return err
	}

	rows, err := tx.Query(ctx, `
		select lesson_id
		from course_revision_lessons
		where course_revision_id = $1 and module_id = $2 and sort_order < $3
		order by sort_order asc
	`, revisionID, moduleID, sortOrder)
	if err != nil {
		return err
	}
	defer rows.Close()

	previousLessonIDs := make([]string, 0)
	for rows.Next() {
		var previousLessonID string
		if err := rows.Scan(&previousLessonID); err != nil {
			return err
		}
		previousLessonIDs = append(previousLessonIDs, previousLessonID)
	}
	if rows.Err() != nil {
		return rows.Err()
	}
	if len(previousLessonIDs) == 0 {
		return nil
	}

	var courseProgressID string
	err = tx.QueryRow(ctx, `
		select id::text
		from course_progress
		where student_id = $1 and course_id = $2 and course_revision_id = $3
		order by case when status = 'in_progress' then 0 else 1 end, started_at desc
		limit 1
	`, studentID, courseID, revisionID).Scan(&courseProgressID)
	if err == pgx.ErrNoRows {
		return ErrLockedPrerequisite
	}
	if err != nil {
		return err
	}

	for _, previousLessonID := range previousLessonIDs {
		var status string
		err := tx.QueryRow(ctx, `
			select status
			from lesson_progress
			where course_progress_id = $1 and lesson_id = $2
		`, courseProgressID, previousLessonID).Scan(&status)
		if err == pgx.ErrNoRows || status != "completed" {
			return ErrLockedPrerequisite
		}
		if err != nil {
			return err
		}
	}
	return nil
}

type txLike interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func graphForLesson(content json.RawMessage, lessonID string) (runtimeGraph, error) {
	payload := map[string]any{}
	if err := json.Unmarshal(content, &payload); err != nil {
		return runtimeGraph{}, err
	}
	modules, _ := payload["modules"].([]any)
	for _, rawModule := range modules {
		module, _ := rawModule.(map[string]any)
		lessons, _ := module["lessons"].([]any)
		for _, rawLesson := range lessons {
			lesson, _ := rawLesson.(map[string]any)
			if asStringAny(lesson["id"]) == lessonID {
				return parseGraph(lesson["graph"]), nil
			}
		}
	}
	return runtimeGraph{}, ErrLessonSessionNotFound
}

func parseGraph(raw any) runtimeGraph {
	graphMap, _ := raw.(map[string]any)
	nodes, _ := graphMap["nodes"].([]any)
	graph := runtimeGraph{
		StartNodeID: asStringAny(graphMap["startNodeId"]),
		Order:       make([]string, 0, len(nodes)),
		NodeMap:     make(map[string]runtimeNode, len(nodes)),
	}
	for _, rawNode := range nodes {
		nodeMap, _ := rawNode.(map[string]any)
		node := runtimeNode{
			ID:          asStringAny(nodeMap["id"]),
			Kind:        asStringAny(nodeMap["kind"]),
			NextNodeID:  asStringAny(nodeMap["nextNodeId"]),
			Text:        asStringAny(nodeMap["text"]),
			AssetURL:    asStringAny(nodeMap["asset_url"]),
			Prompt:      asStringAny(nodeMap["prompt"]),
			Transitions: map[string]string{},
		}
		if body, ok := nodeMap["body"].(map[string]any); ok {
			if node.Text == "" {
				node.Text = asStringAny(body["text"])
			}
			if node.AssetURL == "" {
				node.AssetURL = asStringAny(body["assetUrl"])
			}
			if node.AssetURL == "" {
				node.AssetURL = asStringAny(body["asset_url"])
			}
		}
		if options, ok := nodeMap["options"].([]any); ok {
			for _, rawOption := range options {
				optionMap, _ := rawOption.(map[string]any)
				node.Options = append(node.Options, runtimeOption{
					ID:         asStringAny(optionMap["id"]),
					Text:       asStringAny(optionMap["text"]),
					Result:     asStringAny(optionMap["result"]),
					Feedback:   asStringAny(optionMap["feedback"]),
					NextNodeID: asStringAny(optionMap["nextNodeId"]),
				})
			}
		}
		if transitions, ok := nodeMap["transitions"].([]any); ok {
			for _, rawTransition := range transitions {
				transitionMap, _ := rawTransition.(map[string]any)
				node.Transitions[asStringAny(transitionMap["onVerdict"])] = asStringAny(transitionMap["nextNodeId"])
			}
		}
		if rubric, ok := nodeMap["rubric"].(map[string]any); ok {
			node.Rubric = rubric
		}
		graph.Order = append(graph.Order, node.ID)
		graph.NodeMap[node.ID] = node
	}
	return graph
}

func renderStep(sessionID string, courseID string, lessonID string, stateVersion int64, graph runtimeGraph, nodeID string, state gameState) StepView {
	node := graph.NodeMap[nodeID]
	payload := map[string]any{}
	switch node.Kind {
	case "story", "end":
		payload["text"] = node.Text
		if node.AssetURL != "" {
			payload["asset_url"] = node.AssetURL
			payload["illustration_url"] = node.AssetURL
		}
	case "single_choice":
		payload["prompt"] = node.Prompt
		options := make([]map[string]any, 0, len(node.Options))
		for _, option := range node.Options {
			options = append(options, map[string]any{"id": option.ID, "text": option.Text})
		}
		payload["options"] = options
	case "decision":
		payload["prompt"] = node.Prompt
		options := make([]map[string]any, 0, len(node.Options))
		for _, option := range node.Options {
			options = append(options, map[string]any{"id": option.ID, "text": option.Text})
		}
		payload["options"] = options
	case "free_text":
		payload["prompt"] = node.Prompt
	}
	completed := 0
	for i, id := range graph.Order {
		if id == nodeID {
			completed = i
			if node.Kind == "end" {
				completed = i + 1
			}
			break
		}
	}
	progress := 0.0
	if len(graph.Order) > 0 {
		progress = float64(completed) / float64(len(graph.Order))
	}
	return StepView{
		SessionID:      sessionID,
		CourseID:       courseID,
		LessonID:       lessonID,
		StateVersion:   stateVersion,
		NodeID:         nodeID,
		NodeKind:       node.Kind,
		Payload:        payload,
		StepsCompleted: completed,
		StepsTotal:     len(graph.Order),
		ProgressRatio:  progress,
		GameState:      state.toMini(),
		Navigation:     StepNavigation{},
	}
}

func (s *Service) graphForRevisionLesson(ctx context.Context, revisionID string, lessonID string) (runtimeGraph, error) {
	var content json.RawMessage
	if err := s.db.QueryRow(ctx, `select content_json::text from course_revisions where id = $1`, revisionID).Scan(&content); err != nil {
		return runtimeGraph{}, err
	}
	return graphForLesson(content, lessonID)
}

func (s *Service) graphForRevisionLessonTx(ctx context.Context, tx pgx.Tx, revisionID string, lessonID string) (runtimeGraph, error) {
	var content json.RawMessage
	if err := tx.QueryRow(ctx, `select content_json::text from course_revisions where id = $1`, revisionID).Scan(&content); err != nil {
		return runtimeGraph{}, err
	}
	return graphForLesson(content, lessonID)
}

func (s *Service) evaluateNode(ctx context.Context, node runtimeNode, answer map[string]any) (evaluationOutcome, error) {
	switch node.Kind {
	case "single_choice":
		optionID := asStringAny(answer["option_id"])
		for _, option := range node.Options {
			if option.ID == optionID {
				return evaluationOutcome{
					Verdict:       option.Result,
					Feedback:      option.Feedback,
					NextNodeID:    option.NextNodeID,
					EvaluatorType: "single_choice",
				}, nil
			}
		}
	case "free_text":
		result, err := s.evaluator.Evaluate(ctx, evaluation.FreeTextEvaluationInput{
			Prompt:            node.Prompt,
			ReferenceAnswer:   asStringAny(node.Rubric["referenceAnswer"]),
			CriteriaCorrect:   firstNonEmptyStringAny(nestedMapValue(node.Rubric, "criteriaByVerdict", "correct"), node.Rubric["criteria"]),
			CriteriaPartial:   firstNonEmptyStringAny(nestedMapValue(node.Rubric, "criteriaByVerdict", "partial"), node.Rubric["criteria"]),
			CriteriaIncorrect: firstNonEmptyStringAny(nestedMapValue(node.Rubric, "criteriaByVerdict", "incorrect"), node.Rubric["criteria"]),
			StudentAnswer:     asStringAny(answer["text"]),
		})
		if err != nil {
			if errors.Is(err, evaluation.ErrTemporarilyUnavailable) {
				return evaluationOutcome{}, ErrLLMTemporarilyUnavailable
			}
			return evaluationOutcome{}, err
		}
		nextNodeID := node.Transitions[result.Verdict]
		if nextNodeID == "" {
			return evaluationOutcome{}, ErrLessonSessionStateConflict
		}
		latency := result.LatencyMS
		traceID := strings.TrimSpace(result.TraceID)
		var tracePtr *string
		if traceID != "" {
			tracePtr = &traceID
		}
		return evaluationOutcome{
			Verdict:          result.Verdict,
			Feedback:         freeTextFeedback(node.Rubric, result.Verdict, result.Feedback),
			NextNodeID:       nextNodeID,
			EvaluatorType:    "llm_free_text",
			EvaluatorLatency: &latency,
			EvaluatorTraceID: tracePtr,
		}, nil
	}
	return evaluationOutcome{}, ErrLessonSessionStateConflict
}

func nestedMapValue(root map[string]any, key string, nested string) any {
	if root == nil {
		return nil
	}
	raw, ok := root[key].(map[string]any)
	if !ok {
		return nil
	}
	return raw[nested]
}

func freeTextFeedback(rubric map[string]any, verdict string, fallback string) string {
	feedbackByVerdict, _ := rubric["feedbackByVerdict"].(map[string]any)
	if feedback := strings.TrimSpace(asStringAny(feedbackByVerdict[verdict])); feedback != "" {
		return feedback
	}
	return fallback
}

func firstNonEmptyStringAny(values ...any) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(asStringAny(value)); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func (s *Service) ensureCourseProgressTx(ctx context.Context, tx pgx.Tx, studentID string, courseID string, revisionID string, lessonID string) (string, error) {
	var courseProgressID string
	err := tx.QueryRow(ctx, `
		select id::text from course_progress
		where student_id = $1 and course_id = $2 and status = 'in_progress'
		for update
	`, studentID, courseID).Scan(&courseProgressID)
	if err == pgx.ErrNoRows {
		err = tx.QueryRow(ctx, `
			insert into course_progress(student_id, course_id, course_revision_id, status, last_lesson_id)
			values ($1, $2, $3, 'in_progress', $4)
			returning id::text
		`, studentID, courseID, revisionID, lessonID).Scan(&courseProgressID)
		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				err = tx.QueryRow(ctx, `
					select id::text from course_progress
					where student_id = $1 and course_id = $2 and status = 'in_progress'
					for update
				`, studentID, courseID).Scan(&courseProgressID)
			}
		}
	}
	return courseProgressID, err
}

func (s *Service) ensureLessonProgressTx(ctx context.Context, tx pgx.Tx, studentID string, courseProgressID string, revisionID string, lessonID string) error {
	_, err := tx.Exec(ctx, `
		insert into lesson_progress(student_id, course_progress_id, course_revision_id, lesson_id, status)
		values ($1, $2, $3, $4, 'not_started')
		on conflict (course_progress_id, lesson_id) do nothing
	`, studentID, courseProgressID, revisionID, lessonID)
	return err
}

func (s *Service) ensureGameState(ctx context.Context, studentID string) (gameState, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return gameState{}, err
	}
	defer tx.Rollback(ctx)
	state, err := s.ensureGameStateTx(ctx, tx, studentID)
	if err != nil {
		return gameState{}, err
	}
	return state, tx.Commit(ctx)
}

func (s *Service) ensureGameStateTx(ctx context.Context, tx pgx.Tx, studentID string) (gameState, error) {
	if _, err := tx.Exec(ctx, `
		insert into student_game_state(student_id, hearts_current, hearts_max, hearts_updated_at)
		values ($1, $2, $2, now())
		on conflict (student_id) do nothing
	`, studentID, s.config.HeartsMax); err != nil {
		return gameState{}, err
	}
	if _, err := tx.Exec(ctx, `
		insert into student_streak_state(student_id, current_streak_days, best_streak_days, updated_at)
		values ($1, 0, 0, now())
		on conflict (student_id) do nothing
	`, studentID); err != nil {
		return gameState{}, err
	}
	var state gameState
	var updatedAt time.Time
	if err := tx.QueryRow(ctx, `
		select sgs.xp_total, sgs.level, sgs.hearts_current, sgs.hearts_max, sgs.hearts_updated_at,
		       sss.current_streak_days, sss.best_streak_days
		from student_game_state sgs
		join student_streak_state sss on sss.student_id = sgs.student_id
		where sgs.student_id = $1
		for update of sgs, sss
	`, studentID).Scan(&state.XPTotal, &state.Level, &state.HeartsCurrent, &state.HeartsMax, &updatedAt, &state.CurrentStreakDays, &state.BestStreakDays); err != nil {
		return gameState{}, err
	}
	recovered := int(time.Since(updatedAt) / s.config.HeartsRestorePeriod)
	if recovered > 0 && state.HeartsCurrent < state.HeartsMax {
		state.HeartsCurrent += recovered
		if state.HeartsCurrent > state.HeartsMax {
			state.HeartsCurrent = state.HeartsMax
		}
		if _, err := tx.Exec(ctx, `update student_game_state set hearts_current = $2, hearts_updated_at = now(), updated_at = now() where student_id = $1`, studentID, state.HeartsCurrent); err != nil {
			return gameState{}, err
		}
		updatedAt = time.Now()
	}
	if state.HeartsCurrent < state.HeartsMax {
		restoreAt := updatedAt.Add(s.config.HeartsRestorePeriod).UTC().Format(time.RFC3339)
		state.HeartsRestoreAt = &restoreAt
	}
	return state, nil
}

func (s *Service) applyGameMutationTx(ctx context.Context, tx pgx.Tx, studentID string, xpDelta int, heartsDelta int) error {
	state, err := s.ensureGameStateTx(ctx, tx, studentID)
	if err != nil {
		return err
	}
	newXP := state.XPTotal + int64(xpDelta)
	newHearts := state.HeartsCurrent + heartsDelta
	if newHearts < 0 {
		newHearts = 0
	}
	level := calcLevel(newXP)
	if _, err := tx.Exec(ctx, `
		update student_game_state
		set xp_total = $2, level = $3, hearts_current = $4, hearts_updated_at = now(), updated_at = now()
		where student_id = $1
	`, studentID, newXP, level, newHearts); err != nil {
		return err
	}
	return nil
}

func (s *Service) completeLessonTx(ctx context.Context, tx pgx.Tx, studentID string, sessionID string, courseProgressID string, lessonID string, xpDelta int, graph runtimeGraph, endText string) (map[string]any, error) {
	if _, err := tx.Exec(ctx, `update lesson_sessions set status = 'completed', completed_at = now(), last_activity_at = now() where id = $1`, sessionID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `update lesson_progress set status = 'completed', completed_at = now(), last_activity_at = now() where course_progress_id = $1 and lesson_id = $2`, courseProgressID, lessonID); err != nil {
		return nil, err
	}
	var completedCount, totalCount int
	if err := tx.QueryRow(ctx, `
		select
			coalesce((
				select count(*)
				from lesson_progress lp
				where lp.course_progress_id = $1 and lp.status = 'completed'
			), 0),
			(
				select count(*)
				from course_revision_lessons crl
				join course_progress cp on cp.course_revision_id = crl.course_revision_id
				where cp.id = $1
			)
	`, courseProgressID).Scan(&completedCount, &totalCount); err != nil {
		return nil, err
	}
	if completedCount == totalCount && totalCount > 0 {
		if _, err := tx.Exec(ctx, `update course_progress set status = 'completed', completed_at = now(), last_activity_at = now() where id = $1`, courseProgressID); err != nil {
			return nil, err
		}
	}
	var streakCurrent, streakBest int
	if err := tx.QueryRow(ctx, `
		update student_streak_state
		set current_streak_days = case
		        when last_activity_date is null then 1
		        when last_activity_date = current_date then current_streak_days
		        when last_activity_date = current_date - interval '1 day' then current_streak_days + 1
		        else 1
		    end,
		    best_streak_days = greatest(best_streak_days, case
		        when last_activity_date is null then 1
		        when last_activity_date = current_date then current_streak_days
		        when last_activity_date = current_date - interval '1 day' then current_streak_days + 1
		        else 1
		    end),
		    last_activity_date = current_date,
		    updated_at = now()
		where student_id = $1
		returning current_streak_days, best_streak_days
	`, studentID).Scan(&streakCurrent, &streakBest); err != nil {
		return nil, err
	}
	var badgeCount int
	if err := tx.QueryRow(ctx, `select count(*) from student_badges where student_id = $1 and badge_code = 'first_lesson'`, studentID).Scan(&badgeCount); err != nil {
		return nil, err
	}
	if badgeCount == 0 {
		if _, err := tx.Exec(ctx, `
			insert into student_badges(student_id, badge_code, source_type, source_id)
			values ($1, 'first_lesson', 'lesson_session', $2)
		`, studentID, sessionID); err != nil {
			return nil, err
		}
	}
	completion := map[string]any{
		"lesson_id":           lessonID,
		"accuracy_percent":    100,
		"time_spent_seconds":  len(graph.Order) * 10,
		"lesson_xp_earned":    xpDelta,
		"current_streak_days": streakCurrent,
		"next_lesson_id":      nil,
	}
	if strings.TrimSpace(endText) != "" {
		completion["end_text"] = endText
	}
	return completion, nil
}

func (s *Service) activeOrLatestCourseProgressTx(ctx context.Context, tx pgx.Tx, studentID string, courseID string) (string, string, error) {
	var progressID, revisionID string
	err := tx.QueryRow(ctx, `
		select id::text, course_revision_id::text
		from course_progress
		where student_id = $1 and course_id = $2
		order by case when status = 'in_progress' then 0 else 1 end, started_at desc
		limit 1
		for update
	`, studentID, courseID).Scan(&progressID, &revisionID)
	return progressID, revisionID, err
}

func (s *Service) ensureLessonRetryAllowedTx(ctx context.Context, tx pgx.Tx, studentID string, courseID string, courseProgressID string, revisionID string, lessonID string) error {
	if err := s.ensureCourseAccessTx(ctx, tx, studentID, courseID); err != nil {
		return err
	}
	if err := s.ensureLessonAccessTx(ctx, tx, studentID, courseID, lessonID); err != nil {
		return err
	}
	if err := s.ensureLessonStartAllowedTx(ctx, tx, studentID, courseID, revisionID, lessonID); err != nil {
		if err == ErrLockedPrerequisite {
			return ErrLessonRetryNotAllowed
		}
		return err
	}
	var status string
	err := tx.QueryRow(ctx, `
		select status
		from lesson_progress
		where course_progress_id = $1 and lesson_id = $2
	`, courseProgressID, lessonID).Scan(&status)
	if err == pgx.ErrNoRows || status != "completed" {
		return ErrLessonRetryNotAllowed
	}
	if err != nil {
		return err
	}
	return nil
}

func asStringAny(value any) string {
	str, _ := value.(string)
	return str
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func calcLevel(xp int64) int {
	switch {
	case xp >= 500:
		return 5
	case xp >= 300:
		return 4
	case xp >= 150:
		return 3
	case xp >= 50:
		return 2
	default:
		return 1
	}
}
