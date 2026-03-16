package tests

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"pravoprost/backend/internal/testkit/app"
	httpclient "pravoprost/backend/internal/testkit/http"
)

func TestStudentRuntime_FreeTextLLMContractMatrix(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)
	courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "LLM Contract Course", llmContractContent())

	t.Run("persists metadata on success", func(t *testing.T) {
		studentClient := httpclient.New(t)
		studentCSRF, studentID := loginAsRole(t, studentClient, testApp, "student-llm-success", "student")
		sessionID, questionStateVersion, questionNodeID := startFreeTextSession(t, studentClient, testApp, studentCSRF, courseID)

		answerResp := performJSONWithIdempotency(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+sessionID+"/answer", map[string]any{
			"state_version": questionStateVersion,
			"node_id":       questionNodeID,
			"answer":        map[string]any{"kind": "free_text", "text": "[llm:correct] safe password"},
		}, studentCSRF, "llm-success")
		if answerResp.StatusCode != http.StatusOK {
			t.Fatalf("success answer status: %d", answerResp.StatusCode)
		}
		defer answerResp.Body.Close()

		var answer struct {
			Verdict string `json:"verdict"`
		}
		if err := json.NewDecoder(answerResp.Body).Decode(&answer); err != nil {
			t.Fatalf("decode success answer: %v", err)
		}
		if answer.Verdict != "correct" {
			t.Fatalf("unexpected success verdict: %s", answer.Verdict)
		}

		var verdict, evaluatorType, evaluatorTraceID string
		var evaluatorLatency int
		if err := testApp.DB.Pool().QueryRow(context.Background(), `
			select verdict, evaluator_type, coalesce(evaluator_latency_ms, 0), coalesce(evaluator_trace_id, '')
			from step_attempts sa
			join lesson_sessions ls on ls.id = sa.lesson_session_id
			where ls.student_id = $1
			order by sa.created_at desc
			limit 1
		`, studentID).Scan(&verdict, &evaluatorType, &evaluatorLatency, &evaluatorTraceID); err != nil {
			t.Fatalf("query step attempt metadata: %v", err)
		}
		if verdict != "correct" || evaluatorType != "llm_free_text" || evaluatorTraceID != "fake-llm-request" {
			t.Fatalf("unexpected evaluator metadata: verdict=%s type=%s trace=%s", verdict, evaluatorType, evaluatorTraceID)
		}
		if evaluatorLatency < 0 {
			t.Fatalf("unexpected negative evaluator latency: %d", evaluatorLatency)
		}
	})

	t.Run("persists incorrect verdict on success", func(t *testing.T) {
		studentClient := httpclient.New(t)
		studentCSRF, studentID := loginAsRole(t, studentClient, testApp, "student-llm-incorrect", "student")
		sessionID, questionStateVersion, questionNodeID := startFreeTextSession(t, studentClient, testApp, studentCSRF, courseID)

		answerResp := performJSONWithIdempotency(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+sessionID+"/answer", map[string]any{
			"state_version": questionStateVersion,
			"node_id":       questionNodeID,
			"answer":        map[string]any{"kind": "free_text", "text": "[llm:incorrect] unsafe password"},
		}, studentCSRF, "llm-incorrect")
		if answerResp.StatusCode != http.StatusOK {
			t.Fatalf("incorrect answer status: %d", answerResp.StatusCode)
		}
		defer answerResp.Body.Close()

		var answer struct {
			Verdict  string `json:"verdict"`
			Feedback string `json:"feedback"`
		}
		if err := json.NewDecoder(answerResp.Body).Decode(&answer); err != nil {
			t.Fatalf("decode incorrect answer: %v", err)
		}
		if answer.Verdict != "incorrect" {
			t.Fatalf("unexpected incorrect verdict payload: %+v", answer)
		}

		var verdict, evaluatorTraceID string
		if err := testApp.DB.Pool().QueryRow(context.Background(), `
			select verdict, coalesce(evaluator_trace_id, '')
			from step_attempts sa
			join lesson_sessions ls on ls.id = sa.lesson_session_id
			where ls.student_id = $1
			order by sa.created_at desc
			limit 1
		`, studentID).Scan(&verdict, &evaluatorTraceID); err != nil {
			t.Fatalf("query incorrect step attempt: %v", err)
		}
		if verdict != "incorrect" || evaluatorTraceID != "fake-llm-request" {
			t.Fatalf("unexpected incorrect attempt metadata verdict=%s trace=%s", verdict, evaluatorTraceID)
		}
	})

	for _, tc := range []struct {
		name string
		text string
	}{
		{name: "malformed", text: "[llm:malformed]"},
		{name: "unknown_verdict", text: "[llm:unknown]"},
		{name: "provider_500", text: "[llm:500]"},
		{name: "timeout", text: "[llm:timeout]"},
		{name: "slow", text: "[llm:slow]"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			studentClient := httpclient.New(t)
			studentCSRF, studentID := loginAsRole(t, studentClient, testApp, "student-"+tc.name, "student")
			sessionID, questionStateVersion, questionNodeID := startFreeTextSession(t, studentClient, testApp, studentCSRF, courseID)

			errorResp := performJSONWithIdempotency(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+sessionID+"/answer", map[string]any{
				"state_version": questionStateVersion,
				"node_id":       questionNodeID,
				"answer":        map[string]any{"kind": "free_text", "text": tc.text},
			}, studentCSRF, "llm-"+tc.name)
			if errorResp.StatusCode != http.StatusServiceUnavailable {
				t.Fatalf("llm error status: %d", errorResp.StatusCode)
			}
			defer errorResp.Body.Close()

			var envelope struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}
			if err := json.NewDecoder(errorResp.Body).Decode(&envelope); err != nil {
				t.Fatalf("decode error envelope: %v", err)
			}
			if envelope.Error.Code != "llm_temporarily_unavailable" {
				t.Fatalf("unexpected error code: %s", envelope.Error.Code)
			}

			var attempts int
			if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from step_attempts where lesson_session_id = $1`, sessionID).Scan(&attempts); err != nil {
				t.Fatalf("count attempts: %v", err)
			}
			if attempts != 0 {
				t.Fatalf("llm failure must not create attempt, got %d", attempts)
			}

			var currentNodeID string
			var stateVersion int64
			if err := testApp.DB.Pool().QueryRow(context.Background(), `
				select current_node_id, state_version
				from lesson_sessions
				where id = $1
			`, sessionID).Scan(&currentNodeID, &stateVersion); err != nil {
				t.Fatalf("query lesson session after llm error: %v", err)
			}
			if currentNodeID != questionNodeID || stateVersion != questionStateVersion {
				t.Fatalf("llm failure must not advance session, got node=%s version=%d", currentNodeID, stateVersion)
			}

			var xpTotal int64
			var heartsCurrent int
			if err := testApp.DB.Pool().QueryRow(context.Background(), `
				select xp_total, hearts_current
				from student_game_state
				where student_id = $1
			`, studentID).Scan(&xpTotal, &heartsCurrent); err != nil {
				t.Fatalf("query game state after llm error: %v", err)
			}
			if xpTotal != 0 || heartsCurrent != 5 {
				t.Fatalf("llm failure must not mutate game state, got xp=%d hearts=%d", xpTotal, heartsCurrent)
			}
		})
	}
}

func TestPreview_FreeTextLLMFailureDoesNotAdvanceState(t *testing.T) {
	testApp := app.New(t)
	teacherClient := httpclient.New(t)
	teacherCSRF, _ := loginAsRole(t, teacherClient, testApp, "teacher-preview-llm", "teacher")
	_ = performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/profile", map[string]any{
		"display_name":      "Preview Teacher",
		"organization_name": "School",
		"avatar_asset_id":   nil,
	}, teacherCSRF)

	createResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses", map[string]any{
		"title":       "Preview LLM",
		"description": "Basics",
	}, teacherCSRF)
	if createResp.StatusCode != http.StatusCreated {
		t.Fatalf("create preview llm course status: %d", createResp.StatusCode)
	}
	defer createResp.Body.Close()
	var created struct {
		CourseID string `json:"course_id"`
	}
	if err := json.NewDecoder(createResp.Body).Decode(&created); err != nil {
		t.Fatalf("decode preview llm course: %v", err)
	}

	updateResp := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/draft", map[string]any{
		"draft_version":  1,
		"title":          "Preview LLM",
		"description":    "Basics",
		"cover_asset_id": nil,
		"content":        llmContractContent(),
	}, teacherCSRF)
	if updateResp.StatusCode != http.StatusOK {
		t.Fatalf("update preview llm draft status: %d", updateResp.StatusCode)
	}

	startResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/preview", map[string]any{"lesson_id": "lesson_1"}, teacherCSRF)
	if startResp.StatusCode != http.StatusOK {
		t.Fatalf("start preview llm status: %d", startResp.StatusCode)
	}
	defer startResp.Body.Close()
	var preview struct {
		PreviewSessionID string `json:"preview_session_id"`
		Step             struct {
			StateVersion int64  `json:"state_version"`
			NodeID       string `json:"node_id"`
		} `json:"step"`
	}
	if err := json.NewDecoder(startResp.Body).Decode(&preview); err != nil {
		t.Fatalf("decode preview start: %v", err)
	}

	nextResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/preview-sessions/"+preview.PreviewSessionID+"/next", map[string]any{"state_version": preview.Step.StateVersion}, teacherCSRF)
	if nextResp.StatusCode != http.StatusOK {
		t.Fatalf("preview next llm status: %d", nextResp.StatusCode)
	}
	defer nextResp.Body.Close()
	var next struct {
		Step struct {
			StateVersion int64  `json:"state_version"`
			NodeID       string `json:"node_id"`
		} `json:"step"`
	}
	if err := json.NewDecoder(nextResp.Body).Decode(&next); err != nil {
		t.Fatalf("decode preview next: %v", err)
	}

	errorResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/preview-sessions/"+preview.PreviewSessionID+"/answer", map[string]any{
		"state_version": next.Step.StateVersion,
		"node_id":       next.Step.NodeID,
		"answer":        map[string]any{"text": "[llm:malformed]"},
	}, teacherCSRF)
	if errorResp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("preview llm error status: %d", errorResp.StatusCode)
	}
	errorResp.Body.Close()

	retryResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/preview-sessions/"+preview.PreviewSessionID+"/answer", map[string]any{
		"state_version": next.Step.StateVersion,
		"node_id":       next.Step.NodeID,
		"answer":        map[string]any{"text": "[llm:correct] safe password"},
	}, teacherCSRF)
	if retryResp.StatusCode != http.StatusOK {
		t.Fatalf("preview llm retry status: %d", retryResp.StatusCode)
	}
}

func llmContractContent() map[string]any {
	return map[string]any{
		"modules": []any{
			map[string]any{
				"id":    "module_1",
				"title": "Module 1",
				"lessons": []any{
					map[string]any{
						"id":    "lesson_1",
						"title": "Lesson 1",
						"graph": map[string]any{
							"startNodeId": "n1",
							"nodes": []any{
								map[string]any{"id": "n1", "kind": "story", "body": map[string]any{"text": "Start"}, "nextNodeId": "n2"},
								map[string]any{
									"id":     "n2",
									"kind":   "free_text",
									"prompt": "Why should a password stay private?",
									"rubric": map[string]any{"referenceAnswer": "safe password"},
									"transitions": []any{
										map[string]any{"onVerdict": "correct", "nextNodeId": "n3"},
										map[string]any{"onVerdict": "partial", "nextNodeId": "n3"},
										map[string]any{"onVerdict": "incorrect", "nextNodeId": "n3"},
									},
								},
								map[string]any{"id": "n3", "kind": "end", "text": "Done"},
							},
						},
					},
				},
			},
		},
	}
}

func startFreeTextSession(t *testing.T, studentClient *http.Client, testApp *app.TestApp, studentCSRF string, courseID string) (string, int64, string) {
	t.Helper()
	startResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/start", map[string]any{}, studentCSRF)
	if startResp.StatusCode != http.StatusOK {
		t.Fatalf("start llm session status: %d", startResp.StatusCode)
	}
	defer startResp.Body.Close()
	var start struct {
		SessionID    string `json:"session_id"`
		StateVersion int64  `json:"state_version"`
		NodeID       string `json:"node_id"`
	}
	if err := json.NewDecoder(startResp.Body).Decode(&start); err != nil {
		t.Fatalf("decode llm start: %v", err)
	}

	nextResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/next", map[string]any{
		"state_version":    start.StateVersion,
		"expected_node_id": start.NodeID,
	}, studentCSRF)
	if nextResp.StatusCode != http.StatusOK {
		t.Fatalf("next llm question status: %d", nextResp.StatusCode)
	}
	defer nextResp.Body.Close()
	var question struct {
		StateVersion int64  `json:"state_version"`
		NodeID       string `json:"node_id"`
		NodeKind     string `json:"node_kind"`
	}
	if err := json.NewDecoder(nextResp.Body).Decode(&question); err != nil {
		t.Fatalf("decode llm question: %v", err)
	}
	if question.NodeKind != "free_text" {
		t.Fatalf("expected free_text node, got %s", question.NodeKind)
	}
	return start.SessionID, question.StateVersion, question.NodeID
}
