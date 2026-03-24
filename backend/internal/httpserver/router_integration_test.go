package httpserver_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	testapp "pravoprost/backend/internal/testkit/app"
	httpclient "pravoprost/backend/internal/testkit/http"
)

type authedClient struct {
	client    *http.Client
	csrfToken string
	accountID string
}

func TestPreviewSessionEndpointsHonorACLAndRuntimeParity(t *testing.T) {
	app := testapp.New(t)
	ctx := context.Background()

	teacher := loginAs(t, app, "teacher-preview-owner")
	selectRole(t, app, teacher, "teacher")
	updateTeacherProfile(t, app, teacher, "Preview Owner", "Preview School")

	otherTeacher := loginAs(t, app, "teacher-preview-other")
	selectRole(t, app, otherTeacher, "teacher")
	updateTeacherProfile(t, app, otherTeacher, "Preview Other", "Other School")

	courseID := createTeacherCourse(t, app, teacher, "Preview Contract", "Contract verification")
	draft := getJSONMap(t, teacher.client, app.Server.URL+"/api/v1/teacher/courses/"+courseID+"/draft")
	draftVersion := int64(draft["draft_version"].(float64))

	updateTeacherDraft(t, app, teacher, courseID, map[string]any{
		"draft_version": draftVersion,
		"title":         "Preview Contract",
		"description":   "Contract verification",
		"content": map[string]any{
			"modules": []any{
				map[string]any{
					"id":    "mod-preview",
					"title": "Preview module",
					"lessons": []any{
						map[string]any{
							"id":    "lesson-preview",
							"title": "Preview lesson",
							"graph": map[string]any{
								"startNodeId": "story-1",
								"nodes": []any{
									map[string]any{
										"id":         "story-1",
										"kind":       "story",
										"text":       "Story step",
										"nextNodeId": "choice-1",
									},
									map[string]any{
										"id":     "choice-1",
										"kind":   "single_choice",
										"prompt": "Pick the right option",
										"options": []any{
											map[string]any{
												"id":         "choice-a",
												"text":       "Correct",
												"result":     "correct",
												"feedback":   "Correct choice",
												"nextNodeId": "free-1",
											},
											map[string]any{
												"id":         "choice-b",
												"text":       "Wrong",
												"result":     "incorrect",
												"feedback":   "Wrong choice",
												"nextNodeId": "free-1",
											},
										},
									},
									map[string]any{
										"id":     "free-1",
										"kind":   "free_text",
										"prompt": "Explain the rule",
										"rubric": map[string]any{
											"referenceAnswer": "Because it is safe",
											"criteria":        "Mention safety",
										},
										"transitions": []any{
											map[string]any{"onVerdict": "correct", "nextNodeId": "end-1"},
											map[string]any{"onVerdict": "partial", "nextNodeId": "end-1"},
											map[string]any{"onVerdict": "incorrect", "nextNodeId": "end-1"},
										},
									},
									map[string]any{
										"id":   "end-1",
										"kind": "end",
										"text": "Preview complete",
									},
								},
							},
						},
					},
				},
			},
		},
	})

	start := postJSON(t, teacher.client, app.Server.URL+"/api/v1/teacher/courses/"+courseID+"/preview", teacher.csrfToken, map[string]any{
		"lesson_id": "lesson-preview",
	})
	if start.StatusCode != http.StatusOK {
		t.Fatalf("start preview: status=%d body=%s", start.StatusCode, readBody(t, start))
	}
	var started map[string]any
	decodeJSON(t, start.Body, &started)
	previewSessionID := asString(t, started["preview_session_id"])
	if previewSessionID == "" {
		t.Fatalf("preview_session_id missing: %#v", started)
	}
	startStep := asMap(t, started["step"])
	if got := asString(t, startStep["node_kind"]); got != "story" {
		t.Fatalf("expected story start node, got %q", got)
	}

	getCurrent := getWithCSRF(t, teacher.client, app.Server.URL+"/api/v1/preview-sessions/"+previewSessionID, teacher.csrfToken)
	if getCurrent.StatusCode != http.StatusOK {
		t.Fatalf("get preview session: status=%d body=%s", getCurrent.StatusCode, readBody(t, getCurrent))
	}
	var current map[string]any
	decodeJSON(t, getCurrent.Body, &current)
	currentStep := asMap(t, current["step"])
	if got := asString(t, currentStep["node_id"]); got != "story-1" {
		t.Fatalf("expected story-1, got %q", got)
	}

	nextResp := postJSON(t, teacher.client, app.Server.URL+"/api/v1/preview-sessions/"+previewSessionID+"/next", teacher.csrfToken, map[string]any{
		"state_version":    1,
		"expected_node_id": "story-1",
	})
	if nextResp.StatusCode != http.StatusOK {
		t.Fatalf("preview next: status=%d body=%s", nextResp.StatusCode, readBody(t, nextResp))
	}
	var nextEnvelope map[string]any
	decodeJSON(t, nextResp.Body, &nextEnvelope)
	nextStep := asMap(t, nextEnvelope["step"])
	if got := asString(t, nextStep["node_kind"]); got != "single_choice" {
		t.Fatalf("expected single_choice after next, got %q", got)
	}
	if got := int64(nextStep["state_version"].(float64)); got != 2 {
		t.Fatalf("expected state_version=2 after next, got %d", got)
	}

	duplicateNext := postJSON(t, teacher.client, app.Server.URL+"/api/v1/preview-sessions/"+previewSessionID+"/next", teacher.csrfToken, map[string]any{
		"state_version":    1,
		"expected_node_id": "story-1",
	})
	if duplicateNext.StatusCode != http.StatusOK {
		t.Fatalf("duplicate preview next: status=%d body=%s", duplicateNext.StatusCode, readBody(t, duplicateNext))
	}
	var duplicateEnvelope map[string]any
	decodeJSON(t, duplicateNext.Body, &duplicateEnvelope)
	if got := asString(t, asMap(t, duplicateEnvelope["step"])["node_id"]); got != "choice-1" {
		t.Fatalf("expected duplicate next to return current advanced node, got %q", got)
	}

	otherAccess := getWithCSRF(t, otherTeacher.client, app.Server.URL+"/api/v1/preview-sessions/"+previewSessionID, otherTeacher.csrfToken)
	if otherAccess.StatusCode != http.StatusNotFound {
		t.Fatalf("expected other teacher to get 404, got status=%d body=%s", otherAccess.StatusCode, readBody(t, otherAccess))
	}

	choiceAnswer := postJSON(t, teacher.client, app.Server.URL+"/api/v1/preview-sessions/"+previewSessionID+"/answer", teacher.csrfToken, map[string]any{
		"state_version": 2,
		"node_id":       "choice-1",
		"answer": map[string]any{
			"option_id": "choice-a",
		},
	})
	if choiceAnswer.StatusCode != http.StatusOK {
		t.Fatalf("preview choice answer: status=%d body=%s", choiceAnswer.StatusCode, readBody(t, choiceAnswer))
	}
	var choiceOutcome map[string]any
	decodeJSON(t, choiceAnswer.Body, &choiceOutcome)
	if got := asString(t, choiceOutcome["verdict"]); got != "correct" {
		t.Fatalf("expected correct choice verdict, got %q", got)
	}
	if got := asString(t, asMap(t, choiceOutcome["next_step"])["node_kind"]); got != "free_text" {
		t.Fatalf("expected free_text next step, got %q", got)
	}

	freeTextAnswer := postJSON(t, teacher.client, app.Server.URL+"/api/v1/preview-sessions/"+previewSessionID+"/answer", teacher.csrfToken, map[string]any{
		"state_version": 3,
		"node_id":       "free-1",
		"answer": map[string]any{
			"text": "[llm:correct] because it is safe",
		},
	})
	if freeTextAnswer.StatusCode != http.StatusOK {
		t.Fatalf("preview free-text answer: status=%d body=%s", freeTextAnswer.StatusCode, readBody(t, freeTextAnswer))
	}
	var freeTextOutcome map[string]any
	decodeJSON(t, freeTextAnswer.Body, &freeTextOutcome)
	if got := asString(t, asMap(t, freeTextOutcome["next_step"])["node_kind"]); got != "end" {
		t.Fatalf("expected end next step, got %q", got)
	}

	finalState := getWithCSRF(t, teacher.client, app.Server.URL+"/api/v1/preview-sessions/"+previewSessionID, teacher.csrfToken)
	if finalState.StatusCode != http.StatusOK {
		t.Fatalf("get final preview state: status=%d body=%s", finalState.StatusCode, readBody(t, finalState))
	}
	var finalEnvelope map[string]any
	decodeJSON(t, finalState.Body, &finalEnvelope)
	if got := asString(t, asMap(t, finalEnvelope["step"])["node_kind"]); got != "end" {
		t.Fatalf("expected stored preview state to be end, got %q", got)
	}
	_ = ctx
}

func TestProfileUpdatePreservesAvatarWhenOmittedAndClearsOnExplicitNull(t *testing.T) {
	app := testapp.New(t)
	ctx := context.Background()

	student := loginAs(t, app, "student-avatar")
	selectRole(t, app, student, "student")

	assetID := uuid.NewString()
	if _, err := app.DB.Pool().Exec(ctx, `
		insert into assets(id, owner_account_id, storage_key, mime_type, size_bytes)
		values ($1, $2, $3, 'image/png', 123)
	`, assetID, student.accountID, "avatars/"+assetID+".png"); err != nil {
		t.Fatalf("insert asset: %v", err)
	}
	if _, err := app.DB.Pool().Exec(ctx, `
		update student_profiles
		set avatar_asset_id = $2
		where account_id = $1
	`, student.accountID, assetID); err != nil {
		t.Fatalf("set avatar asset: %v", err)
	}

	initialProfile := getJSONMap(t, student.client, app.Server.URL+"/api/v1/student/profile")
	if got := asString(t, initialProfile["avatar_url"]); !strings.HasSuffix(got, "/assets/"+assetID) {
		t.Fatalf("expected initial avatar_url to end with /assets/%s, got %q", assetID, got)
	}

	omitAvatar := putJSON(t, student.client, app.Server.URL+"/api/v1/student/profile", student.csrfToken, map[string]any{
		"display_name": "Avatar Preserved",
	})
	if omitAvatar.StatusCode != http.StatusOK {
		t.Fatalf("omit avatar update: status=%d body=%s", omitAvatar.StatusCode, readBody(t, omitAvatar))
	}
	var omitted map[string]any
	decodeJSON(t, omitAvatar.Body, &omitted)
	if got := asString(t, omitted["avatar_url"]); !strings.HasSuffix(got, "/assets/"+assetID) {
		t.Fatalf("expected avatar_url to stay unchanged when omitted, got %q", got)
	}

	clearAvatar := putJSON(t, student.client, app.Server.URL+"/api/v1/student/profile", student.csrfToken, map[string]any{
		"display_name":    "Avatar Cleared",
		"avatar_asset_id": nil,
	})
	if clearAvatar.StatusCode != http.StatusOK {
		t.Fatalf("clear avatar update: status=%d body=%s", clearAvatar.StatusCode, readBody(t, clearAvatar))
	}
	var cleared map[string]any
	decodeJSON(t, clearAvatar.Body, &cleared)
	if got := cleared["avatar_url"]; got != nil {
		t.Fatalf("expected avatar_url to be null after explicit clear, got %#v", got)
	}
}

func TestParentInviteListDistinguishesAvailableAndLegacyURLs(t *testing.T) {
	app := testapp.New(t)
	ctx := context.Background()

	parent := loginAs(t, app, "parent-invites")
	selectRole(t, app, parent, "parent")

	createResp := postJSON(t, parent.client, app.Server.URL+"/api/v1/parent/children/link-invites", parent.csrfToken, map[string]any{})
	if createResp.StatusCode != http.StatusCreated {
		t.Fatalf("create invite: status=%d body=%s", createResp.StatusCode, readBody(t, createResp))
	}
	var created map[string]any
	decodeJSON(t, createResp.Body, &created)
	createdInviteID := asString(t, created["invite_id"])
	if createdInviteID == "" {
		t.Fatalf("missing invite_id in create response: %#v", created)
	}
	if asString(t, created["invite_url"]) == "" {
		t.Fatalf("expected create response invite_url, got %#v", created)
	}
	if asString(t, created["claim_url"]) == "" {
		t.Fatalf("expected create response claim_url for compatibility, got %#v", created)
	}
	if got := asString(t, created["url_status"]); got != "available" {
		t.Fatalf("expected create response url_status=available, got %q", got)
	}

	legacyInviteID := uuid.NewString()
	if _, err := app.DB.Pool().Exec(ctx, `
		insert into guardian_link_invites(id, created_by_parent_id, token_hash, token_encrypted, status, expires_at)
		values ($1, $2, $3, null, 'active', $4)
	`, legacyInviteID, parent.accountID, "legacy-token-hash", time.Now().Add(24*time.Hour)); err != nil {
		t.Fatalf("insert legacy invite: %v", err)
	}
	brokenInviteID := uuid.NewString()
	if _, err := app.DB.Pool().Exec(ctx, `
		insert into guardian_link_invites(id, created_by_parent_id, token_hash, token_encrypted, status, expires_at)
		values ($1, $2, $3, $4, 'active', $5)
	`, brokenInviteID, parent.accountID, "broken-token-hash", "corrupted-token", time.Now().Add(24*time.Hour)); err != nil {
		t.Fatalf("insert broken invite: %v", err)
	}

	listResp := getWithCSRF(t, parent.client, app.Server.URL+"/api/v1/parent/children/link-invites", parent.csrfToken)
	if listResp.StatusCode != http.StatusOK {
		t.Fatalf("list invites: status=%d body=%s", listResp.StatusCode, readBody(t, listResp))
	}
	var listed map[string]any
	decodeJSON(t, listResp.Body, &listed)
	items := listed["items"].([]any)
	byID := make(map[string]map[string]any, len(items))
	for _, rawItem := range items {
		item := rawItem.(map[string]any)
		byID[asString(t, item["invite_id"])] = item
	}

	createdItem, ok := byID[createdInviteID]
	if !ok {
		t.Fatalf("created invite not found in list: %#v", byID)
	}
	if got := asString(t, createdItem["url_status"]); got != "available" {
		t.Fatalf("expected listed created invite to be available, got %q", got)
	}
	if asString(t, createdItem["invite_url"]) == "" {
		t.Fatalf("expected listed created invite_url, got %#v", createdItem)
	}

	legacyItem, ok := byID[legacyInviteID]
	if !ok {
		t.Fatalf("legacy invite not found in list: %#v", byID)
	}
	if got := asString(t, legacyItem["url_status"]); got != "legacy_unavailable" {
		t.Fatalf("expected legacy invite url_status=legacy_unavailable, got %q", got)
	}
	if value, exists := legacyItem["invite_url"]; exists && value != nil && value != "" {
		t.Fatalf("expected legacy invite_url to be empty, got %#v", value)
	}

	brokenItem, ok := byID[brokenInviteID]
	if !ok {
		t.Fatalf("broken invite not found in list: %#v", byID)
	}
	if got := asString(t, brokenItem["url_status"]); got != "legacy_unavailable" {
		t.Fatalf("expected broken invite url_status=legacy_unavailable, got %q", got)
	}
	if value, exists := brokenItem["invite_url"]; exists && value != nil && value != "" {
		t.Fatalf("expected broken invite_url to be empty, got %#v", value)
	}
}

func loginAs(t *testing.T, app *testapp.TestApp, code string) authedClient {
	t.Helper()

	client := httpclient.New(t)
	startURL := app.Server.URL + "/api/v1/auth/sso/yandex/start?return_to=" + url.QueryEscape("/")
	startResp, err := client.Get(startURL)
	if err != nil {
		t.Fatalf("start sso: %v", err)
	}
	if startResp.StatusCode != http.StatusFound {
		t.Fatalf("start sso status=%d body=%s", startResp.StatusCode, readBody(t, startResp))
	}
	authorizeURL := startResp.Header.Get("Location")
	if authorizeURL == "" {
		t.Fatal("missing start sso redirect location")
	}
	parsedAuthorize, err := url.Parse(authorizeURL)
	if err != nil {
		t.Fatalf("parse authorize url: %v", err)
	}
	state := parsedAuthorize.Query().Get("state")
	redirectURI := parsedAuthorize.Query().Get("redirect_uri")
	if state == "" || redirectURI == "" {
		t.Fatalf("authorize URL missing state or redirect_uri: %s", authorizeURL)
	}
	redirectTarget, err := url.Parse(redirectURI)
	if err != nil {
		t.Fatalf("parse redirect_uri: %v", err)
	}
	serverURL, err := url.Parse(app.Server.URL)
	if err != nil {
		t.Fatalf("parse app server url: %v", err)
	}
	redirectTarget.Scheme = serverURL.Scheme
	redirectTarget.Host = serverURL.Host

	callbackURL := redirectTarget.String() + "?state=" + url.QueryEscape(state) + "&code=" + url.QueryEscape(code)
	callbackResp, err := client.Get(callbackURL)
	if err != nil {
		t.Fatalf("sso callback: %v", err)
	}
	if callbackResp.StatusCode != http.StatusFound {
		t.Fatalf("sso callback status=%d body=%s", callbackResp.StatusCode, readBody(t, callbackResp))
	}

	sessionResp, err := client.Get(app.Server.URL + "/api/v1/session")
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if sessionResp.StatusCode != http.StatusOK {
		t.Fatalf("session status=%d body=%s", sessionResp.StatusCode, readBody(t, sessionResp))
	}
	var session struct {
		CSRFToken string `json:"csrf_token"`
		User      *struct {
			AccountID string `json:"account_id"`
		} `json:"user"`
	}
	decodeJSON(t, sessionResp.Body, &session)
	if session.CSRFToken == "" || session.User == nil || session.User.AccountID == "" {
		t.Fatalf("invalid session payload: %#v", session)
	}
	return authedClient{
		client:    client,
		csrfToken: session.CSRFToken,
		accountID: session.User.AccountID,
	}
}

func selectRole(t *testing.T, app *testapp.TestApp, actor authedClient, role string) {
	t.Helper()
	resp := postJSON(t, actor.client, app.Server.URL+"/api/v1/onboarding/role", actor.csrfToken, map[string]any{
		"role": role,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("select role %s: status=%d body=%s", role, resp.StatusCode, readBody(t, resp))
	}
}

func updateTeacherProfile(t *testing.T, app *testapp.TestApp, actor authedClient, displayName string, orgName string) {
	t.Helper()
	resp := putJSON(t, actor.client, app.Server.URL+"/api/v1/teacher/profile", actor.csrfToken, map[string]any{
		"display_name":      displayName,
		"organization_name": orgName,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("update teacher profile: status=%d body=%s", resp.StatusCode, readBody(t, resp))
	}
}

func createTeacherCourse(t *testing.T, app *testapp.TestApp, actor authedClient, title string, description string) string {
	t.Helper()
	resp := postJSON(t, actor.client, app.Server.URL+"/api/v1/teacher/courses", actor.csrfToken, map[string]any{
		"title":       title,
		"description": description,
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create teacher course: status=%d body=%s", resp.StatusCode, readBody(t, resp))
	}
	var body map[string]any
	decodeJSON(t, resp.Body, &body)
	return asString(t, body["course_id"])
}

func updateTeacherDraft(t *testing.T, app *testapp.TestApp, actor authedClient, courseID string, body map[string]any) {
	t.Helper()
	resp := putJSON(t, actor.client, app.Server.URL+"/api/v1/teacher/courses/"+courseID+"/draft", actor.csrfToken, body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("update teacher draft: status=%d body=%s", resp.StatusCode, readBody(t, resp))
	}
}

func getWithCSRF(t *testing.T, client *http.Client, requestURL string, csrfToken string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, requestURL, nil)
	if err != nil {
		t.Fatalf("new GET request: %v", err)
	}
	if csrfToken != "" {
		req.Header.Set("X-CSRF-Token", csrfToken)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", requestURL, err)
	}
	return resp
}

func postJSON(t *testing.T, client *http.Client, requestURL string, csrfToken string, body any) *http.Response {
	t.Helper()
	return doJSON(t, client, http.MethodPost, requestURL, csrfToken, body)
}

func putJSON(t *testing.T, client *http.Client, requestURL string, csrfToken string, body any) *http.Response {
	t.Helper()
	return doJSON(t, client, http.MethodPut, requestURL, csrfToken, body)
}

func doJSON(t *testing.T, client *http.Client, method string, requestURL string, csrfToken string, body any) *http.Response {
	t.Helper()
	rawBody, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal %s body: %v", method, err)
	}
	req, err := http.NewRequest(method, requestURL, bytes.NewReader(rawBody))
	if err != nil {
		t.Fatalf("new %s request: %v", method, err)
	}
	req.Header.Set("Content-Type", "application/json")
	if csrfToken != "" {
		req.Header.Set("X-CSRF-Token", csrfToken)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, requestURL, err)
	}
	return resp
}

func getJSONMap(t *testing.T, client *http.Client, requestURL string) map[string]any {
	t.Helper()
	resp, err := client.Get(requestURL)
	if err != nil {
		t.Fatalf("GET %s: %v", requestURL, err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s: status=%d body=%s", requestURL, resp.StatusCode, readBody(t, resp))
	}
	var body map[string]any
	decodeJSON(t, resp.Body, &body)
	return body
}

func decodeJSON(t *testing.T, body io.ReadCloser, target any) {
	t.Helper()
	defer body.Close()
	if err := json.NewDecoder(body).Decode(target); err != nil {
		t.Fatalf("decode json: %v", err)
	}
}

func readBody(t *testing.T, resp *http.Response) string {
	t.Helper()
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Sprintf("<read error: %v>", err)
	}
	return string(data)
}

func asString(t *testing.T, value any) string {
	t.Helper()
	switch typed := value.(type) {
	case string:
		return typed
	case nil:
		return ""
	default:
		t.Fatalf("expected string, got %T (%#v)", value, value)
		return ""
	}
}

func asMap(t *testing.T, value any) map[string]any {
	t.Helper()
	typed, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("expected map[string]any, got %T (%#v)", value, value)
	}
	return typed
}
