package tests

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"pravoprost/backend/internal/testkit/app"
	httpclient "pravoprost/backend/internal/testkit/http"
)

func abandonTestCourseContent() map[string]any {
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
								map[string]any{"id": "n1", "kind": "story", "body": map[string]any{"text": "First"}, "nextNodeId": "n2"},
								map[string]any{"id": "n2", "kind": "story", "body": map[string]any{"text": "Second"}, "nextNodeId": "n3"},
								map[string]any{"id": "n3", "kind": "end", "text": "Done"},
							},
						},
					},
				},
			},
		},
	}
}

func TestStudentRuntime_AbandonSession_RestartsFromFirstNode(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)

	courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Abandon Course A", abandonTestCourseContent())

	studentClient := httpclient.New(t)
	studentCSRF, _ := loginAsRole(t, studentClient, testApp, "student-abandon-restart", "student")

	startResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/start", map[string]any{}, studentCSRF)
	if startResp.StatusCode != http.StatusOK {
		t.Fatalf("start status: %d", startResp.StatusCode)
	}
	var start struct {
		SessionID    string `json:"session_id"`
		StateVersion int64  `json:"state_version"`
		NodeID       string `json:"node_id"`
	}
	if err := json.NewDecoder(startResp.Body).Decode(&start); err != nil {
		t.Fatalf("decode start: %v", err)
	}
	startResp.Body.Close()

	if start.NodeID != "n1" {
		t.Fatalf("expected start at n1, got %s", start.NodeID)
	}

	nextResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/next", map[string]any{
		"state_version":    start.StateVersion,
		"expected_node_id": start.NodeID,
	}, studentCSRF)
	if nextResp.StatusCode != http.StatusOK {
		t.Fatalf("next status: %d", nextResp.StatusCode)
	}
	var afterNext struct {
		NodeID string `json:"node_id"`
	}
	if err := json.NewDecoder(nextResp.Body).Decode(&afterNext); err != nil {
		t.Fatalf("decode next: %v", err)
	}
	nextResp.Body.Close()
	if afterNext.NodeID != "n2" {
		t.Fatalf("expected progress to n2, got %s", afterNext.NodeID)
	}

	abandonResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/abandon", map[string]any{}, studentCSRF)
	if abandonResp.StatusCode != http.StatusOK {
		t.Fatalf("abandon status: %d", abandonResp.StatusCode)
	}
	abandonResp.Body.Close()

	// D-4/D-5/D-6 invariants: lesson_progress must NOT change after abandon (replay_count, attempts_count, status untouched),
	// terminated session keeps current_node_id frozen.
	var (
		lpStatus         string
		lpAttempts       int
		lpReplayCount    int
		lsStatus         string
		lsTerminationRsn *string
		lsCurrentNode    *string
	)
	ctx := context.Background()
	if err := testApp.DB.Pool().QueryRow(ctx, `
		select status, attempts_count, replay_count
		from lesson_progress
		where lesson_id = $1 and student_id = (select id from accounts where role = 'student' order by created_at desc limit 1)
	`, "lesson_1").Scan(&lpStatus, &lpAttempts, &lpReplayCount); err != nil {
		t.Fatalf("query lesson_progress after abandon: %v", err)
	}
	if lpReplayCount != 0 {
		t.Fatalf("D-2: replay_count must be 0 after abandon (no completed→retry), got %d", lpReplayCount)
	}
	if lpStatus == "completed" {
		t.Fatalf("D-4: lesson_progress.status flipped to completed unexpectedly")
	}
	if err := testApp.DB.Pool().QueryRow(ctx, `
		select status, termination_reason, current_node_id
		from lesson_sessions where id = $1
	`, start.SessionID).Scan(&lsStatus, &lsTerminationRsn, &lsCurrentNode); err != nil {
		t.Fatalf("query lesson_sessions after abandon: %v", err)
	}
	if lsStatus != "terminated" {
		t.Fatalf("expected status=terminated, got %s", lsStatus)
	}
	if lsTerminationRsn == nil || *lsTerminationRsn != "user_abandoned" {
		t.Fatalf("expected termination_reason=user_abandoned, got %v", lsTerminationRsn)
	}
	if lsCurrentNode == nil || *lsCurrentNode != "n2" {
		t.Fatalf("D-6: terminated session must keep frozen current_node_id=n2, got %v", lsCurrentNode)
	}

	restartResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/start", map[string]any{}, studentCSRF)
	if restartResp.StatusCode != http.StatusOK {
		t.Fatalf("restart status: %d", restartResp.StatusCode)
	}
	var restart struct {
		SessionID string `json:"session_id"`
		NodeID    string `json:"node_id"`
	}
	if err := json.NewDecoder(restartResp.Body).Decode(&restart); err != nil {
		t.Fatalf("decode restart: %v", err)
	}
	restartResp.Body.Close()

	if restart.NodeID != "n1" {
		t.Fatalf("after abandon-restart expected n1, got %s", restart.NodeID)
	}
	if restart.SessionID == start.SessionID {
		t.Fatalf("expected new session id after abandon, got same %s", restart.SessionID)
	}
}

func TestStudentRuntime_AbandonSession_IsIdempotent(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)

	courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Abandon Course B", abandonTestCourseContent())

	studentClient := httpclient.New(t)
	studentCSRF, _ := loginAsRole(t, studentClient, testApp, "student-abandon-idem", "student")

	startResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/start", map[string]any{}, studentCSRF)
	if startResp.StatusCode != http.StatusOK {
		t.Fatalf("start status: %d", startResp.StatusCode)
	}
	var start struct {
		SessionID string `json:"session_id"`
	}
	if err := json.NewDecoder(startResp.Body).Decode(&start); err != nil {
		t.Fatalf("decode start: %v", err)
	}
	startResp.Body.Close()

	for i := range 3 {
		abandonResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/abandon", map[string]any{}, studentCSRF)
		if abandonResp.StatusCode != http.StatusOK {
			t.Fatalf("abandon attempt %d status: %d, want 200", i, abandonResp.StatusCode)
		}
		abandonResp.Body.Close()
	}
}

func TestStudentRuntime_AbandonSession_OnCompletedSessionIsNoOp(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)

	courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Abandon Course Completed", map[string]any{
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
								map[string]any{"id": "n1", "kind": "story", "body": map[string]any{"text": "Only step"}, "nextNodeId": "n2"},
								map[string]any{"id": "n2", "kind": "end", "text": "Done"},
							},
						},
					},
				},
			},
		},
	})

	studentClient := httpclient.New(t)
	studentCSRF, _ := loginAsRole(t, studentClient, testApp, "student-abandon-completed", "student")

	startResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/start", map[string]any{}, studentCSRF)
	if startResp.StatusCode != http.StatusOK {
		t.Fatalf("start status: %d", startResp.StatusCode)
	}
	var start struct {
		SessionID    string `json:"session_id"`
		StateVersion int64  `json:"state_version"`
		NodeID       string `json:"node_id"`
	}
	if err := json.NewDecoder(startResp.Body).Decode(&start); err != nil {
		t.Fatalf("decode start: %v", err)
	}
	startResp.Body.Close()

	nextResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/next", map[string]any{
		"state_version":    start.StateVersion,
		"expected_node_id": start.NodeID,
	}, studentCSRF)
	if nextResp.StatusCode != http.StatusOK {
		t.Fatalf("next-to-end status: %d", nextResp.StatusCode)
	}
	nextResp.Body.Close()

	var afterCompletion string
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select status from lesson_sessions where id = $1`, start.SessionID).Scan(&afterCompletion); err != nil {
		t.Fatalf("query post-completion: %v", err)
	}
	if afterCompletion != "completed" {
		t.Fatalf("expected status=completed after end-node, got %s", afterCompletion)
	}

	abandonResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/abandon", map[string]any{}, studentCSRF)
	if abandonResp.StatusCode != http.StatusOK {
		t.Fatalf("abandon on completed status: %d, want 200 (no-op)", abandonResp.StatusCode)
	}
	abandonResp.Body.Close()

	var afterAbandon string
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select status from lesson_sessions where id = $1`, start.SessionID).Scan(&afterAbandon); err != nil {
		t.Fatalf("query post-abandon: %v", err)
	}
	if afterAbandon != "completed" {
		t.Fatalf("abandon must not flip completed→terminated, got %s", afterAbandon)
	}
}

func TestStudentRuntime_AbandonSession_NotFoundForUnknownID(t *testing.T) {
	testApp := app.New(t)
	studentClient := httpclient.New(t)
	studentCSRF, _ := loginAsRole(t, studentClient, testApp, "student-abandon-nf", "student")

	abandonResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/00000000-0000-0000-0000-000000000000/abandon", map[string]any{}, studentCSRF)
	if abandonResp.StatusCode != http.StatusNotFound {
		t.Fatalf("abandon unknown session status: %d, want 404", abandonResp.StatusCode)
	}
	abandonResp.Body.Close()
}

func TestStudentRuntime_AbandonSession_ForeignSessionReturns404(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)

	courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Abandon Course C", abandonTestCourseContent())

	studentAClient := httpclient.New(t)
	studentACSRF, _ := loginAsRole(t, studentAClient, testApp, "student-abandon-owner", "student")

	startResp := performJSON(t, studentAClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/start", map[string]any{}, studentACSRF)
	if startResp.StatusCode != http.StatusOK {
		t.Fatalf("start (owner) status: %d", startResp.StatusCode)
	}
	var start struct {
		SessionID string `json:"session_id"`
	}
	if err := json.NewDecoder(startResp.Body).Decode(&start); err != nil {
		t.Fatalf("decode start: %v", err)
	}
	startResp.Body.Close()

	studentBClient := httpclient.New(t)
	studentBCSRF, _ := loginAsRole(t, studentBClient, testApp, "student-abandon-intruder", "student")

	abandonResp := performJSON(t, studentBClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/abandon", map[string]any{}, studentBCSRF)
	if abandonResp.StatusCode != http.StatusNotFound {
		t.Fatalf("foreign abandon status: %d, want 404", abandonResp.StatusCode)
	}
	abandonResp.Body.Close()

	resumeResp := performJSON(t, studentAClient, http.MethodGet, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/session", nil, "")
	if resumeResp.StatusCode != http.StatusOK {
		t.Fatalf("owner session still resumable status: %d", resumeResp.StatusCode)
	}
	resumeResp.Body.Close()

	// Authoritative SQL guard: owner's session row must still be in_progress, not terminated.
	var ownerSessionStatus string
	if err := testApp.DB.Pool().QueryRow(context.Background(), `
		select status from lesson_sessions where id = $1
	`, start.SessionID).Scan(&ownerSessionStatus); err != nil {
		t.Fatalf("query owner session row: %v", err)
	}
	if ownerSessionStatus != "in_progress" {
		t.Fatalf("foreign abandon corrupted owner session: status=%s, want in_progress", ownerSessionStatus)
	}
}
