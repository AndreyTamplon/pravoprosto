package tests

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"pravoprost/backend/internal/testkit/app"
	httpclient "pravoprost/backend/internal/testkit/http"
)

func TestPreview_PolicyParityAndNoMutation(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)

	content := map[string]any{
		"modules": []any{
			map[string]any{
				"id":    "module_1",
				"title": "Module",
				"lessons": []any{
					map[string]any{
						"id":    "lesson_1",
						"title": "Lesson",
						"graph": map[string]any{
							"startNodeId": "n1",
							"nodes": []any{
								map[string]any{"id": "n1", "kind": "story", "body": map[string]any{"text": "Start"}, "nextNodeId": "n2"},
								map[string]any{"id": "n2", "kind": "single_choice", "prompt": "Choose", "options": []any{
									map[string]any{"id": "a1", "text": "A", "result": "correct", "feedback": "ok", "nextNodeId": "n3"},
								}},
								map[string]any{
									"id":     "n3",
									"kind":   "free_text",
									"prompt": "Explain",
									"rubric": map[string]any{"referenceAnswer": "safe password"},
									"transitions": []any{
										map[string]any{"onVerdict": "correct", "nextNodeId": "n4"},
										map[string]any{"onVerdict": "partial", "nextNodeId": "n4"},
										map[string]any{"onVerdict": "incorrect", "nextNodeId": "n4"},
									},
								},
								map[string]any{"id": "n4", "kind": "end", "text": "Done"},
							},
						},
					},
				},
			},
		},
	}
	courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Preview Parity", content)

	startResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/courses/"+courseID+"/preview", map[string]any{"lesson_id": "lesson_1"}, adminCSRF)
	if startResp.StatusCode != http.StatusOK {
		t.Fatalf("admin preview start status: %d", startResp.StatusCode)
	}
	defer startResp.Body.Close()
	var preview struct {
		PreviewSessionID string `json:"preview_session_id"`
		Step             struct {
			StateVersion int64  `json:"state_version"`
			NodeID       string `json:"node_id"`
			NodeKind     string `json:"node_kind"`
		} `json:"step"`
	}
	if err := json.NewDecoder(startResp.Body).Decode(&preview); err != nil {
		t.Fatalf("decode preview start: %v", err)
	}
	if preview.Step.StateVersion == 0 || preview.Step.NodeKind != "story" {
		t.Fatalf("unexpected preview start payload: %+v", preview.Step)
	}

	studentClient := httpclient.New(t)
	studentCSRF, _ := loginAsRole(t, studentClient, testApp, "student-preview-deny", "student")
	parentClient := httpclient.New(t)
	parentCSRF, _ := loginAsRole(t, parentClient, testApp, "parent-preview-deny", "parent")
	teacherA := httpclient.New(t)
	teacherACSFR, _ := loginAsRole(t, teacherA, testApp, "teacher-preview-owner-a", "teacher")
	teacherB := httpclient.New(t)
	teacherBCSRF, _ := loginAsRole(t, teacherB, testApp, "teacher-preview-owner-b", "teacher")

	var beforeCourseProgress, beforeSessions, beforeGameStates int
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from course_progress`).Scan(&beforeCourseProgress); err != nil {
		t.Fatalf("count course_progress before preview: %v", err)
	}
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from lesson_sessions`).Scan(&beforeSessions); err != nil {
		t.Fatalf("count lesson_sessions before preview: %v", err)
	}
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from student_game_state`).Scan(&beforeGameStates); err != nil {
		t.Fatalf("count game state before preview: %v", err)
	}

	for _, tc := range []struct {
		name   string
		client *http.Client
		csrf   string
		status int
	}{
		{name: "student denied", client: studentClient, csrf: studentCSRF, status: http.StatusForbidden},
		{name: "parent denied", client: parentClient, csrf: parentCSRF, status: http.StatusForbidden},
		{name: "teacher denied", client: teacherA, csrf: teacherACSFR, status: http.StatusNotFound},
		{name: "other teacher denied", client: teacherB, csrf: teacherBCSRF, status: http.StatusNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp := performJSON(t, tc.client, http.MethodPost, testApp.Server.URL+"/api/v1/preview-sessions/"+preview.PreviewSessionID+"/next", map[string]any{"state_version": preview.Step.StateVersion}, tc.csrf)
			if resp.StatusCode != tc.status {
				t.Fatalf("preview next status = %d, want %d", resp.StatusCode, tc.status)
			}
		})
	}

	nextResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/preview-sessions/"+preview.PreviewSessionID+"/next", map[string]any{"state_version": preview.Step.StateVersion}, adminCSRF)
	if nextResp.StatusCode != http.StatusOK {
		t.Fatalf("preview next status: %d", nextResp.StatusCode)
	}
	defer nextResp.Body.Close()
	var question struct {
		Step struct {
			StateVersion int64  `json:"state_version"`
			NodeID       string `json:"node_id"`
			NodeKind     string `json:"node_kind"`
		} `json:"step"`
	}
	if err := json.NewDecoder(nextResp.Body).Decode(&question); err != nil {
		t.Fatalf("decode preview next: %v", err)
	}
	if question.Step.NodeKind != "single_choice" {
		t.Fatalf("unexpected preview node after next: %+v", question.Step)
	}

	answerResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/preview-sessions/"+preview.PreviewSessionID+"/answer", map[string]any{
		"state_version": question.Step.StateVersion,
		"node_id":       question.Step.NodeID,
		"answer":        map[string]any{"option_id": "a1"},
	}, adminCSRF)
	if answerResp.StatusCode != http.StatusOK {
		t.Fatalf("preview single_choice answer status: %d", answerResp.StatusCode)
	}
	defer answerResp.Body.Close()
	var previewAnswer struct {
		Verdict  string `json:"verdict"`
		NextStep *struct {
			StateVersion int64  `json:"state_version"`
			NodeID       string `json:"node_id"`
			NodeKind     string `json:"node_kind"`
		} `json:"next_step"`
	}
	if err := json.NewDecoder(answerResp.Body).Decode(&previewAnswer); err != nil {
		t.Fatalf("decode preview answer: %v", err)
	}
	if previewAnswer.Verdict != "correct" || previewAnswer.NextStep == nil || previewAnswer.NextStep.NodeKind != "free_text" {
		t.Fatalf("unexpected preview single_choice outcome: %+v", previewAnswer)
	}

	freeTextResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/preview-sessions/"+preview.PreviewSessionID+"/answer", map[string]any{
		"state_version": previewAnswer.NextStep.StateVersion,
		"node_id":       previewAnswer.NextStep.NodeID,
		"answer":        map[string]any{"text": "[llm:partial]"},
	}, adminCSRF)
	if freeTextResp.StatusCode != http.StatusOK {
		t.Fatalf("preview free_text status: %d", freeTextResp.StatusCode)
	}
	defer freeTextResp.Body.Close()
	var previewFreeText struct {
		Verdict  string `json:"verdict"`
		NextStep *struct {
			NodeKind string `json:"node_kind"`
		} `json:"next_step"`
	}
	if err := json.NewDecoder(freeTextResp.Body).Decode(&previewFreeText); err != nil {
		t.Fatalf("decode preview free_text: %v", err)
	}
	if previewFreeText.Verdict != "partial" || previewFreeText.NextStep == nil || previewFreeText.NextStep.NodeKind != "end" {
		t.Fatalf("unexpected preview free_text outcome: %+v", previewFreeText)
	}

	var afterCourseProgress, afterSessions, afterGameStates int
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from course_progress`).Scan(&afterCourseProgress); err != nil {
		t.Fatalf("count course_progress after preview: %v", err)
	}
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from lesson_sessions`).Scan(&afterSessions); err != nil {
		t.Fatalf("count lesson_sessions after preview: %v", err)
	}
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from student_game_state`).Scan(&afterGameStates); err != nil {
		t.Fatalf("count game state after preview: %v", err)
	}
	if beforeCourseProgress != afterCourseProgress || beforeSessions != afterSessions || beforeGameStates != afterGameStates {
		t.Fatalf("preview must not mutate learner state cp=%d/%d ls=%d/%d gs=%d/%d", beforeCourseProgress, afterCourseProgress, beforeSessions, afterSessions, beforeGameStates, afterGameStates)
	}

	runtimeStudent := httpclient.New(t)
	runtimeCSRF, _ := loginAsRole(t, runtimeStudent, testApp, "student-preview-parity", "student")
	startRuntime := performJSON(t, runtimeStudent, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/start", map[string]any{}, runtimeCSRF)
	if startRuntime.StatusCode != http.StatusOK {
		t.Fatalf("runtime start status: %d", startRuntime.StatusCode)
	}
	defer startRuntime.Body.Close()
	var runtimeStart struct {
		SessionID    string `json:"session_id"`
		StateVersion int64  `json:"state_version"`
		NodeID       string `json:"node_id"`
		NodeKind     string `json:"node_kind"`
	}
	if err := json.NewDecoder(startRuntime.Body).Decode(&runtimeStart); err != nil {
		t.Fatalf("decode runtime start: %v", err)
	}
	if runtimeStart.NodeKind != preview.Step.NodeKind {
		t.Fatalf("preview/runtime start mismatch %s vs %s", preview.Step.NodeKind, runtimeStart.NodeKind)
	}

	runtimeNext := performJSON(t, runtimeStudent, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+runtimeStart.SessionID+"/next", map[string]any{
		"state_version":    runtimeStart.StateVersion,
		"expected_node_id": runtimeStart.NodeID,
	}, runtimeCSRF)
	if runtimeNext.StatusCode != http.StatusOK {
		t.Fatalf("runtime next status: %d", runtimeNext.StatusCode)
	}
	defer runtimeNext.Body.Close()
	var runtimeQuestion struct {
		StateVersion int64  `json:"state_version"`
		NodeID       string `json:"node_id"`
		NodeKind     string `json:"node_kind"`
	}
	if err := json.NewDecoder(runtimeNext.Body).Decode(&runtimeQuestion); err != nil {
		t.Fatalf("decode runtime question: %v", err)
	}
	if runtimeQuestion.NodeKind != question.Step.NodeKind {
		t.Fatalf("preview/runtime question mismatch %s vs %s", question.Step.NodeKind, runtimeQuestion.NodeKind)
	}

	runtimeAnswer := performJSONWithIdempotency(t, runtimeStudent, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+runtimeStart.SessionID+"/answer", map[string]any{
		"state_version": runtimeQuestion.StateVersion,
		"node_id":       runtimeQuestion.NodeID,
		"answer":        map[string]any{"kind": "single_choice", "option_id": "a1"},
	}, runtimeCSRF, "preview-parity-1")
	if runtimeAnswer.StatusCode != http.StatusOK {
		t.Fatalf("runtime answer status: %d", runtimeAnswer.StatusCode)
	}
	defer runtimeAnswer.Body.Close()
	var runtimeChoice struct {
		Verdict  string `json:"verdict"`
		NextStep *struct {
			StateVersion int64  `json:"state_version"`
			NodeID       string `json:"node_id"`
			NodeKind     string `json:"node_kind"`
		} `json:"next_step"`
	}
	if err := json.NewDecoder(runtimeAnswer.Body).Decode(&runtimeChoice); err != nil {
		t.Fatalf("decode runtime answer: %v", err)
	}
	if runtimeChoice.Verdict != previewAnswer.Verdict || runtimeChoice.NextStep == nil || runtimeChoice.NextStep.NodeKind != previewAnswer.NextStep.NodeKind {
		t.Fatalf("preview/runtime single_choice mismatch preview=%+v runtime=%+v", previewAnswer, runtimeChoice)
	}

	runtimeFreeText := performJSONWithIdempotency(t, runtimeStudent, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+runtimeStart.SessionID+"/answer", map[string]any{
		"state_version": runtimeChoice.NextStep.StateVersion,
		"node_id":       runtimeChoice.NextStep.NodeID,
		"answer":        map[string]any{"kind": "free_text", "text": "[llm:partial]"},
	}, runtimeCSRF, "preview-parity-2")
	if runtimeFreeText.StatusCode != http.StatusOK {
		t.Fatalf("runtime free_text status: %d", runtimeFreeText.StatusCode)
	}
	defer runtimeFreeText.Body.Close()
	var runtimeFreeTextOutcome struct {
		Verdict    string `json:"verdict"`
		NextAction string `json:"next_action"`
	}
	if err := json.NewDecoder(runtimeFreeText.Body).Decode(&runtimeFreeTextOutcome); err != nil {
		t.Fatalf("decode runtime free_text: %v", err)
	}
	if runtimeFreeTextOutcome.Verdict != previewFreeText.Verdict || runtimeFreeTextOutcome.NextAction != "lesson_completed" {
		t.Fatalf("preview/runtime free_text mismatch preview=%+v runtime=%+v", previewFreeText, runtimeFreeTextOutcome)
	}
}

func TestRuntime_NegativeValidationAndHeartRecovery(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)
	courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Negative Runtime", map[string]any{
		"modules": []any{
			map[string]any{
				"id": "module_1",
				"lessons": []any{
					map[string]any{
						"id":    "lesson_1",
						"title": "Lesson",
						"graph": map[string]any{
							"startNodeId": "n1",
							"nodes": []any{
								map[string]any{"id": "n1", "kind": "story", "body": map[string]any{"text": "Start"}, "nextNodeId": "n2"},
								map[string]any{"id": "n2", "kind": "single_choice", "prompt": "Q", "options": []any{
									map[string]any{"id": "a1", "text": "A", "result": "correct", "feedback": "ok", "nextNodeId": "n3"},
								}},
								map[string]any{"id": "n3", "kind": "end", "text": "Done"},
							},
						},
					},
				},
			},
		},
	})
	studentClient := httpclient.New(t)
	studentCSRF, studentID := loginAsRole(t, studentClient, testApp, "student-negative-runtime", "student")

	startResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/start", map[string]any{}, studentCSRF)
	if startResp.StatusCode != http.StatusOK {
		t.Fatalf("runtime negative start status: %d", startResp.StatusCode)
	}
	defer startResp.Body.Close()
	var start struct {
		SessionID    string `json:"session_id"`
		StateVersion int64  `json:"state_version"`
		NodeID       string `json:"node_id"`
	}
	if err := json.NewDecoder(startResp.Body).Decode(&start); err != nil {
		t.Fatalf("decode runtime negative start: %v", err)
	}

	answerOnStory := performJSONWithIdempotency(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/answer", map[string]any{
		"state_version": start.StateVersion,
		"node_id":       start.NodeID,
		"answer":        map[string]any{"kind": "single_choice", "option_id": "a1"},
	}, studentCSRF, "answer-on-story")
	if answerOnStory.StatusCode != http.StatusConflict {
		t.Fatalf("answer on story status: %d", answerOnStory.StatusCode)
	}

	nextResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/next", map[string]any{
		"state_version":    start.StateVersion,
		"expected_node_id": start.NodeID,
	}, studentCSRF)
	if nextResp.StatusCode != http.StatusOK {
		t.Fatalf("runtime negative next status: %d", nextResp.StatusCode)
	}
	defer nextResp.Body.Close()
	var question struct {
		StateVersion int64  `json:"state_version"`
		NodeID       string `json:"node_id"`
	}
	if err := json.NewDecoder(nextResp.Body).Decode(&question); err != nil {
		t.Fatalf("decode runtime negative question: %v", err)
	}

	wrongNode := performJSONWithIdempotency(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/answer", map[string]any{
		"state_version": question.StateVersion,
		"node_id":       "wrong-node",
		"answer":        map[string]any{"kind": "single_choice", "option_id": "a1"},
	}, studentCSRF, "wrong-node")
	if wrongNode.StatusCode != http.StatusConflict {
		t.Fatalf("wrong node answer status: %d", wrongNode.StatusCode)
	}

	if _, err := testApp.DB.Pool().Exec(context.Background(), `
		update student_game_state
		set hearts_current = 3,
		    hearts_updated_at = now() - interval '90 minutes',
		    updated_at = now()
		where student_id = $1
	`, studentID); err != nil {
		t.Fatalf("prepare heart recovery: %v", err)
	}
	gameStateResp, err := studentClient.Get(testApp.Server.URL + "/api/v1/student/game-state")
	if err != nil {
		t.Fatalf("game state fetch: %v", err)
	}
	defer gameStateResp.Body.Close()
	var gameState struct {
		HeartsCurrent int `json:"hearts_current"`
		HeartsMax     int `json:"hearts_max"`
	}
	if err := json.NewDecoder(gameStateResp.Body).Decode(&gameState); err != nil {
		t.Fatalf("decode recovered game state: %v", err)
	}
	if gameState.HeartsCurrent != gameState.HeartsMax {
		t.Fatalf("expected recovered hearts to max, got %+v", gameState)
	}
}

func TestProfiles_QueriesAndUploadsMatrix(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)
	studentClient := httpclient.New(t)
	studentCSRF, _ := loginAsRole(t, studentClient, testApp, "student-profile-matrix", "student")
	parentClient := httpclient.New(t)
	parentCSRF, _ := loginAsRole(t, parentClient, testApp, "parent-profile-matrix", "parent")
	teacherClient := httpclient.New(t)
	teacherCSRF, _ := loginAsRole(t, teacherClient, testApp, "teacher-profile-matrix", "teacher")

	for _, tc := range []struct {
		name   string
		client *http.Client
		csrf   string
		method string
		url    string
		body   map[string]any
		status int
	}{
		{name: "student get", client: studentClient, method: http.MethodGet, url: testApp.Server.URL + "/api/v1/student/profile", status: http.StatusOK},
		{name: "student put", client: studentClient, csrf: studentCSRF, method: http.MethodPut, url: testApp.Server.URL + "/api/v1/student/profile", body: map[string]any{"display_name": "Student", "avatar_asset_id": nil}, status: http.StatusOK},
		{name: "parent get", client: parentClient, method: http.MethodGet, url: testApp.Server.URL + "/api/v1/parent/profile", status: http.StatusOK},
		{name: "parent put", client: parentClient, csrf: parentCSRF, method: http.MethodPut, url: testApp.Server.URL + "/api/v1/parent/profile", body: map[string]any{"display_name": "Parent", "avatar_asset_id": nil}, status: http.StatusOK},
		{name: "teacher get", client: teacherClient, method: http.MethodGet, url: testApp.Server.URL + "/api/v1/teacher/profile", status: http.StatusOK},
		{name: "teacher put", client: teacherClient, csrf: teacherCSRF, method: http.MethodPut, url: testApp.Server.URL + "/api/v1/teacher/profile", body: map[string]any{"display_name": "Teacher", "organization_name": "School", "avatar_asset_id": nil}, status: http.StatusOK},
		{name: "admin get", client: adminClient, method: http.MethodGet, url: testApp.Server.URL + "/api/v1/admin/profile", status: http.StatusOK},
		{name: "admin put", client: adminClient, csrf: adminCSRF, method: http.MethodPut, url: testApp.Server.URL + "/api/v1/admin/profile", body: map[string]any{"display_name": "Admin", "avatar_asset_id": nil}, status: http.StatusOK},
		{name: "cross role denied", client: studentClient, method: http.MethodGet, url: testApp.Server.URL + "/api/v1/teacher/profile", status: http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var resp *http.Response
			if tc.method == http.MethodGet {
				var err error
				resp, err = tc.client.Get(tc.url)
				if err != nil {
					t.Fatalf("GET request failed: %v", err)
				}
			} else {
				resp = performJSON(t, tc.client, tc.method, tc.url, tc.body, tc.csrf)
			}
			defer resp.Body.Close()
			if resp.StatusCode != tc.status {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tc.status)
			}
		})
	}

	for _, tc := range []struct {
		name   string
		client *http.Client
		csrf   string
	}{
		{name: "student avatar upload", client: studentClient, csrf: studentCSRF},
		{name: "teacher course illustration upload", client: teacherClient, csrf: teacherCSRF},
		{name: "admin course illustration upload", client: adminClient, csrf: adminCSRF},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp := performJSON(t, tc.client, http.MethodPost, testApp.Server.URL+"/api/v1/assets/upload-requests", map[string]any{
				"file_name":  "image.png",
				"mime_type":  "image/png",
				"size_bytes": 1024,
			}, tc.csrf)
			if resp.StatusCode != http.StatusCreated {
				t.Fatalf("upload request status: %d", resp.StatusCode)
			}
		})
	}
}

func TestQueryContracts_ParentTeacherPromoModeration(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)

	platformCourseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Promo Visible", map[string]any{
		"modules": []any{map[string]any{"id": "module_1", "lessons": []any{map[string]any{"id": "lesson_1", "title": "Lesson", "graph": map[string]any{"startNodeId": "n1", "nodes": []any{map[string]any{"id": "n1", "kind": "single_choice", "prompt": "Q", "options": []any{map[string]any{"id": "a1", "text": "A", "result": "correct", "feedback": "ok", "nextNodeId": "n2"}}}, map[string]any{"id": "n2", "kind": "end", "text": "Done"}}}}}}},
	})
	unpublishedResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/courses", map[string]any{
		"title":       "Unpublished Platform",
		"description": "No publish",
	}, adminCSRF)
	if unpublishedResp.StatusCode != http.StatusCreated {
		t.Fatalf("create unpublished platform course status: %d", unpublishedResp.StatusCode)
	}

	teacher1 := httpclient.New(t)
	teacher1CSRF, _ := loginAsRole(t, teacher1, testApp, "teacher-query-a", "teacher")
	_ = performJSON(t, teacher1, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/profile", map[string]any{"display_name": "Teacher A", "organization_name": "Org", "avatar_asset_id": nil}, teacher1CSRF)
	teacher1Create := performJSON(t, teacher1, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses", map[string]any{"title": "Private A", "description": "Desc"}, teacher1CSRF)
	defer teacher1Create.Body.Close()
	var teacher1Course struct {
		CourseID string `json:"course_id"`
	}
	_ = json.NewDecoder(teacher1Create.Body).Decode(&teacher1Course)
	updateTeacherCourseDraft(t, teacher1, testApp, teacher1CSRF, teacher1Course.CourseID, 1, map[string]any{
		"modules": []any{map[string]any{"id": "module_1", "lessons": []any{map[string]any{"id": "lesson_1", "title": "Lesson", "graph": map[string]any{"startNodeId": "n1", "nodes": []any{map[string]any{"id": "n1", "kind": "single_choice", "prompt": "Q", "options": []any{map[string]any{"id": "a1", "text": "A", "result": "correct", "feedback": "ok", "nextNodeId": "n2"}}}, map[string]any{"id": "n2", "kind": "end"}}}}}}},
	})
	adminApproveTeacherCourse(t, adminClient, testApp, adminCSRF, teacher1, teacher1CSRF, teacher1Course.CourseID)

	teacher2 := httpclient.New(t)
	teacher2CSRF, _ := loginAsRole(t, teacher2, testApp, "teacher-query-b", "teacher")
	_ = performJSON(t, teacher2, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/profile", map[string]any{"display_name": "Teacher B", "organization_name": "Org", "avatar_asset_id": nil}, teacher2CSRF)

	studentClient := httpclient.New(t)
	studentCSRF, studentID := loginAsRole(t, studentClient, testApp, "student-query", "student")
	parentClient := httpclient.New(t)
	parentCSRF, _ := loginAsRole(t, parentClient, testApp, "parent-query", "parent")
	guardianToken := createGuardianInvite(t, parentClient, testApp, parentCSRF)
	if status := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/guardian-links/claim", map[string]string{"token": guardianToken}, studentCSRF).StatusCode; status != http.StatusOK {
		t.Fatalf("guardian claim for query contracts status: %d", status)
	}

	grantResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/courses/"+teacher1Course.CourseID+"/access-grants", map[string]any{"student_id": studentID}, adminCSRF)
	if grantResp.StatusCode != http.StatusCreated && grantResp.StatusCode != http.StatusOK {
		t.Fatalf("admin teacher access grant for query contracts status: %d", grantResp.StatusCode)
	}

	startResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+platformCourseID+"/lessons/lesson_1/start", map[string]any{}, studentCSRF)
	if startResp.StatusCode != http.StatusOK {
		t.Fatalf("start platform lesson for query contracts status: %d", startResp.StatusCode)
	}
	defer startResp.Body.Close()
	var started struct {
		SessionID    string `json:"session_id"`
		StateVersion int64  `json:"state_version"`
		NodeID       string `json:"node_id"`
		NodeKind     string `json:"node_kind"`
	}
	_ = json.NewDecoder(startResp.Body).Decode(&started)
	if started.NodeKind != "single_choice" {
		t.Fatalf("unexpected start node kind for query contracts: %s", started.NodeKind)
	}
	answerResp := performJSONWithIdempotency(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+started.SessionID+"/answer", map[string]any{
		"state_version": started.StateVersion,
		"node_id":       started.NodeID,
		"answer":        map[string]any{"kind": "single_choice", "option_id": "a1"},
	}, studentCSRF, "query-contract-answer")
	if answerResp.StatusCode != http.StatusOK {
		t.Fatalf("complete platform lesson for query contracts status: %d", answerResp.StatusCode)
	}

	promoResp, err := studentClient.Get(testApp.Server.URL + "/api/v1/public/promo-courses")
	if err != nil {
		t.Fatalf("promo query request: %v", err)
	}
	defer promoResp.Body.Close()
	var promo struct {
		Items []struct {
			CourseID string `json:"course_id"`
		} `json:"items"`
	}
	_ = json.NewDecoder(promoResp.Body).Decode(&promo)
	foundPlatform := false
	foundTeacher := false
	for _, item := range promo.Items {
		if item.CourseID == platformCourseID {
			foundPlatform = true
		}
		if item.CourseID == teacher1Course.CourseID {
			foundTeacher = true
		}
	}
	if !foundPlatform || foundTeacher {
		t.Fatalf("unexpected promo query results: %+v", promo.Items)
	}

	catalogResp, err := studentClient.Get(testApp.Server.URL + "/api/v1/student/catalog")
	if err != nil {
		t.Fatalf("catalog query request: %v", err)
	}
	defer catalogResp.Body.Close()
	var catalog struct {
		Sections []struct {
			Section string `json:"section"`
			Items   []struct {
				CourseID string `json:"course_id"`
			} `json:"items"`
		} `json:"sections"`
	}
	_ = json.NewDecoder(catalogResp.Body).Decode(&catalog)
	if len(catalog.Sections) != 2 || catalog.Sections[0].Section != "platform_catalog" || catalog.Sections[1].Section != "teacher_access" {
		t.Fatalf("unexpected catalog sections order: %+v", catalog.Sections)
	}

	treeResp, err := studentClient.Get(testApp.Server.URL + "/api/v1/student/courses/" + teacher1Course.CourseID)
	if err != nil {
		t.Fatalf("teacher course tree request: %v", err)
	}
	defer treeResp.Body.Close()
	var tree struct {
		Modules []struct {
			Lessons []struct {
				Access struct {
					LessonID    string `json:"lesson_id"`
					AccessState string `json:"access_state"`
				} `json:"access"`
			} `json:"lessons"`
		} `json:"modules"`
	}
	_ = json.NewDecoder(treeResp.Body).Decode(&tree)
	if len(tree.Modules) == 0 || len(tree.Modules[0].Lessons) == 0 || tree.Modules[0].Lessons[0].Access.LessonID != "lesson_1" {
		t.Fatalf("teacher tree access metadata missing: %+v", tree)
	}

	parentProgressResp, err := parentClient.Get(testApp.Server.URL + "/api/v1/parent/children/" + studentID + "/progress")
	if err != nil {
		t.Fatalf("parent progress request: %v", err)
	}
	defer parentProgressResp.Body.Close()
	var childProgress struct {
		Summary struct {
			XPTotal        int64 `json:"xp_total"`
			CorrectnessPct int   `json:"correctness_percent"`
		} `json:"summary"`
		Courses []struct {
			CourseID        string `json:"course_id"`
			ProgressPercent int    `json:"progress_percent"`
		} `json:"courses"`
	}
	_ = json.NewDecoder(parentProgressResp.Body).Decode(&childProgress)
	if childProgress.Summary.XPTotal == 0 || childProgress.Summary.CorrectnessPct == 0 || len(childProgress.Courses) == 0 {
		t.Fatalf("parent summary query missing aggregates: %+v", childProgress)
	}

	studentsResp, err := teacher1.Get(testApp.Server.URL + "/api/v1/teacher/courses/" + teacher1Course.CourseID + "/students")
	if err != nil {
		t.Fatalf("teacher students request: %v", err)
	}
	defer studentsResp.Body.Close()
	var students struct {
		Students []struct {
			StudentID       string `json:"student_id"`
			DisplayName     string `json:"display_name"`
			ProgressPercent int    `json:"progress_percent"`
			XPTotal         int64  `json:"xp_total"`
		} `json:"students"`
	}
	_ = json.NewDecoder(studentsResp.Body).Decode(&students)
	if len(students.Students) != 1 || students.Students[0].StudentID != studentID || students.Students[0].DisplayName == "" {
		t.Fatalf("teacher students query unexpected payload: %+v", students)
	}
	otherTeacherResp, err := teacher2.Get(testApp.Server.URL + "/api/v1/teacher/courses/" + teacher1Course.CourseID + "/students")
	if err != nil {
		t.Fatalf("other teacher students request: %v", err)
	}
	if otherTeacherResp.StatusCode != http.StatusConflict {
		t.Fatalf("other teacher should not see foreign analytics, got %d", otherTeacherResp.StatusCode)
	}

	reviewResp := performJSON(t, teacher1, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses/"+teacher1Course.CourseID+"/submit-review", map[string]any{}, teacher1CSRF)
	if reviewResp.StatusCode != http.StatusOK && reviewResp.StatusCode != http.StatusConflict {
		t.Fatalf("submit review for moderation query status: %d", reviewResp.StatusCode)
	}
	queueResp, err := adminClient.Get(testApp.Server.URL + "/api/v1/admin/moderation/queue")
	if err != nil {
		t.Fatalf("moderation queue request: %v", err)
	}
	defer queueResp.Body.Close()
	var queue struct {
		Items []struct {
			CourseID string `json:"course_id"`
		} `json:"items"`
	}
	_ = json.NewDecoder(queueResp.Body).Decode(&queue)
	for _, item := range queue.Items {
		if item.CourseID == teacher1Course.CourseID {
			return
		}
	}
	t.Fatalf("pending moderation course missing from queue")
}

func TestCommerce_EdgeCaseMatrix(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)
	studentClient := httpclient.New(t)
	studentCSRF, studentID := loginAsRole(t, studentClient, testApp, "student-commerce-edge", "student")

	courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Commerce Edge", map[string]any{
		"modules": []any{map[string]any{"id": "module_1", "lessons": []any{map[string]any{"id": "lesson_1", "title": "Lesson", "graph": map[string]any{"startNodeId": "n1", "nodes": []any{map[string]any{"id": "n1", "kind": "end", "text": "Done"}}}}}}},
	})
	createOfferResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/offers", map[string]any{
		"target_type":        "lesson",
		"target_course_id":   courseID,
		"target_lesson_id":   "lesson_1",
		"title":              "Edge Offer",
		"description":        "Desc",
		"price_amount_minor": 49000,
		"price_currency":     "RUB",
	}, adminCSRF)
	if createOfferResp.StatusCode != http.StatusCreated {
		t.Fatalf("create commerce edge offer status: %d", createOfferResp.StatusCode)
	}
	defer createOfferResp.Body.Close()
	var offer struct {
		OfferID string `json:"offer_id"`
	}
	_ = json.NewDecoder(createOfferResp.Body).Decode(&offer)
	activateResp := performJSON(t, adminClient, http.MethodPut, testApp.Server.URL+"/api/v1/admin/commerce/offers/"+offer.OfferID, map[string]any{
		"title":              "Edge Offer",
		"description":        "Desc",
		"price_amount_minor": 49000,
		"price_currency":     "RUB",
		"status":             "active",
	}, adminCSRF)
	if activateResp.StatusCode != http.StatusOK {
		t.Fatalf("activate commerce edge offer status: %d", activateResp.StatusCode)
	}

	archiveOfferResp := performJSON(t, adminClient, http.MethodPut, testApp.Server.URL+"/api/v1/admin/commerce/offers/"+offer.OfferID, map[string]any{
		"title":              "Edge Offer",
		"description":        "Desc",
		"price_amount_minor": 49000,
		"price_currency":     "RUB",
		"status":             "archived",
	}, adminCSRF)
	if archiveOfferResp.StatusCode != http.StatusOK {
		t.Fatalf("archive commerce edge offer status: %d", archiveOfferResp.StatusCode)
	}
	archivedPurchaseResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/offers/"+offer.OfferID+"/purchase-requests", map[string]any{}, studentCSRF)
	if archivedPurchaseResp.StatusCode != http.StatusConflict {
		t.Fatalf("purchase request for archived offer status: %d", archivedPurchaseResp.StatusCode)
	}
	archivedOrderResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/orders/manual", map[string]any{
		"student_id": studentID,
		"offer_id":   offer.OfferID,
	}, adminCSRF)
	if archivedOrderResp.StatusCode != http.StatusConflict {
		t.Fatalf("manual order for archived offer status: %d", archivedOrderResp.StatusCode)
	}

	reactivateResp := performJSON(t, adminClient, http.MethodPut, testApp.Server.URL+"/api/v1/admin/commerce/offers/"+offer.OfferID, map[string]any{
		"title":              "Edge Offer",
		"description":        "Desc",
		"price_amount_minor": 49000,
		"price_currency":     "RUB",
		"status":             "active",
	}, adminCSRF)
	if reactivateResp.StatusCode != http.StatusOK {
		t.Fatalf("reactivate commerce edge offer status: %d", reactivateResp.StatusCode)
	}
	purchaseResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/offers/"+offer.OfferID+"/purchase-requests", map[string]any{}, studentCSRF)
	if purchaseResp.StatusCode != http.StatusCreated {
		t.Fatalf("purchase request edge status: %d", purchaseResp.StatusCode)
	}
	defer purchaseResp.Body.Close()
	var purchase struct {
		PurchaseRequestID string `json:"purchase_request_id"`
	}
	_ = json.NewDecoder(purchaseResp.Body).Decode(&purchase)

	declineResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/purchase-requests/"+purchase.PurchaseRequestID+"/decline", map[string]any{}, adminCSRF)
	if declineResp.StatusCode != http.StatusOK {
		t.Fatalf("decline purchase request status: %d", declineResp.StatusCode)
	}
	repeatDecline := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/purchase-requests/"+purchase.PurchaseRequestID+"/decline", map[string]any{}, adminCSRF)
	if repeatDecline.StatusCode != http.StatusConflict {
		t.Fatalf("repeat decline status: %d", repeatDecline.StatusCode)
	}

	purchaseResp = performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/offers/"+offer.OfferID+"/purchase-requests", map[string]any{}, studentCSRF)
	defer purchaseResp.Body.Close()
	_ = json.NewDecoder(purchaseResp.Body).Decode(&purchase)
	orderResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/orders/manual", map[string]any{
		"student_id":          studentID,
		"offer_id":            offer.OfferID,
		"purchase_request_id": purchase.PurchaseRequestID,
	}, adminCSRF)
	if orderResp.StatusCode != http.StatusCreated {
		t.Fatalf("create edge manual order status: %d", orderResp.StatusCode)
	}
	defer orderResp.Body.Close()
	var order struct {
		OrderID string `json:"order_id"`
	}
	_ = json.NewDecoder(orderResp.Body).Decode(&order)

	missingExternal := performJSONWithIdempotency(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/orders/"+order.OrderID+"/payments/manual-confirm", map[string]any{
		"amount_minor": 49000, "currency": "RUB", "paid_at": "2026-03-15T10:15:00Z",
	}, adminCSRF, "missing-ext")
	if missingExternal.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing external_reference status: %d", missingExternal.StatusCode)
	}

	overrideConfirm := performJSONWithIdempotency(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/orders/"+order.OrderID+"/payments/manual-confirm", map[string]any{
		"external_reference": "edge-override",
		"amount_minor":       50000,
		"currency":           "RUB",
		"paid_at":            "2026-03-15T10:15:00Z",
		"override":           map[string]any{"reason": "cash rounding"},
	}, adminCSRF, "override-pay")
	if overrideConfirm.StatusCode != http.StatusOK {
		t.Fatalf("override confirm status: %d", overrideConfirm.StatusCode)
	}
	var overrideReason string
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select coalesce(override_reason, '') from payment_records where order_id = $1`, order.OrderID).Scan(&overrideReason); err != nil {
		t.Fatalf("query override reason: %v", err)
	}
	if overrideReason != "cash rounding" {
		t.Fatalf("unexpected override reason: %s", overrideReason)
	}

	offerArchiveAfterOrder := performJSON(t, adminClient, http.MethodPut, testApp.Server.URL+"/api/v1/admin/commerce/offers/"+offer.OfferID, map[string]any{
		"title":              "Edge Offer",
		"description":        "Desc",
		"price_amount_minor": 49000,
		"price_currency":     "RUB",
		"status":             "archived",
	}, adminCSRF)
	if offerArchiveAfterOrder.StatusCode != http.StatusOK {
		t.Fatalf("archive offer after fulfilled order status: %d", offerArchiveAfterOrder.StatusCode)
	}
	secondConfirm := performJSONWithIdempotency(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/orders/"+order.OrderID+"/payments/manual-confirm", map[string]any{
		"external_reference": "edge-override-2",
		"amount_minor":       49000,
		"currency":           "RUB",
		"paid_at":            "2026-03-15T11:15:00Z",
	}, adminCSRF, "second-confirm")
	if secondConfirm.StatusCode != http.StatusConflict {
		t.Fatalf("second confirm after fulfilled status: %d", secondConfirm.StatusCode)
	}

	duplicateGrant := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/entitlements/grants", map[string]any{
		"student_id":       studentID,
		"target_type":      "lesson",
		"target_course_id": courseID,
		"target_lesson_id": "lesson_1",
	}, adminCSRF)
	if duplicateGrant.StatusCode != http.StatusConflict {
		t.Fatalf("complimentary grant after fulfilled target status: %d", duplicateGrant.StatusCode)
	}

	var lessonEntitlements int
	if err := testApp.DB.Pool().QueryRow(context.Background(), `
		select count(*) from entitlements
		where student_id = $1 and target_course_id = $2 and target_lesson_id = 'lesson_1' and status = 'active'
	`, studentID, courseID).Scan(&lessonEntitlements); err != nil {
		t.Fatalf("count active lesson entitlements: %v", err)
	}
	if lessonEntitlements != 1 {
		t.Fatalf("expected exactly one active lesson entitlement, got %d", lessonEntitlements)
	}

	courseOfferResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/offers", map[string]any{
		"target_type":        "course",
		"target_course_id":   courseID,
		"target_lesson_id":   "",
		"title":              "Whole course",
		"description":        "Course",
		"price_amount_minor": 99000,
		"price_currency":     "RUB",
	}, adminCSRF)
	if courseOfferResp.StatusCode != http.StatusCreated {
		t.Fatalf("create course offer status: %d", courseOfferResp.StatusCode)
	}
	defer courseOfferResp.Body.Close()
	var courseOffer struct {
		OfferID string `json:"offer_id"`
	}
	_ = json.NewDecoder(courseOfferResp.Body).Decode(&courseOffer)
	if status := performJSON(t, adminClient, http.MethodPut, testApp.Server.URL+"/api/v1/admin/commerce/offers/"+courseOffer.OfferID, map[string]any{
		"title":              "Whole course",
		"description":        "Course",
		"price_amount_minor": 99000,
		"price_currency":     "RUB",
		"status":             "active",
	}, adminCSRF).StatusCode; status != http.StatusOK {
		t.Fatalf("activate course offer status: %d", status)
	}
	courseGrant := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/entitlements/grants", map[string]any{
		"student_id":       studentID,
		"target_type":      "course",
		"target_course_id": courseID,
		"target_lesson_id": "",
	}, adminCSRF)
	if courseGrant.StatusCode != http.StatusCreated {
		t.Fatalf("course complimentary grant status: %d", courseGrant.StatusCode)
	}
	duplicateCourseGrant := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/entitlements/grants", map[string]any{
		"student_id":       studentID,
		"target_type":      "course",
		"target_course_id": courseID,
		"target_lesson_id": "",
	}, adminCSRF)
	if duplicateCourseGrant.StatusCode != http.StatusConflict {
		t.Fatalf("duplicate course complimentary grant status: %d", duplicateCourseGrant.StatusCode)
	}
	var courseEntitlements int
	if err := testApp.DB.Pool().QueryRow(context.Background(), `
		select count(*) from entitlements
		where student_id = $1 and target_course_id = $2 and target_type = 'course' and status = 'active'
	`, studentID, courseID).Scan(&courseEntitlements); err != nil {
		t.Fatalf("count active course entitlements: %v", err)
	}
	if courseEntitlements != 1 {
		t.Fatalf("expected exactly one active course entitlement, got %d", courseEntitlements)
	}
}

func updateTeacherCourseDraft(t *testing.T, teacherClient *http.Client, testApp *app.TestApp, teacherCSRF string, courseID string, draftVersion int64, content map[string]any) {
	t.Helper()
	resp := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/courses/"+courseID+"/draft", map[string]any{
		"draft_version":  draftVersion,
		"title":          "Course",
		"description":    "Desc",
		"cover_asset_id": nil,
		"content":        content,
	}, teacherCSRF)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("teacher draft update status: %d", resp.StatusCode)
	}
}
