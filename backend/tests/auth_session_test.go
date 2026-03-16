package tests

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"testing"

	"pravoprost/backend/internal/testkit/app"
	httpclient "pravoprost/backend/internal/testkit/http"
)

func TestAuth_FirstLoginCreatesUnselectedAccountAndSession(t *testing.T) {
	testApp := app.New(t)
	client := httpclient.New(t)

	startResp, err := client.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/start")
	if err != nil {
		t.Fatalf("start sso: %v", err)
	}
	if startResp.StatusCode != http.StatusFound {
		t.Fatalf("unexpected start status: %d", startResp.StatusCode)
	}
	startLocation, _ := url.Parse(startResp.Header.Get("Location"))

	callbackResp, err := client.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/callback?state=" + startLocation.Query().Get("state") + "&code=student")
	if err != nil {
		t.Fatalf("callback: %v", err)
	}
	if callbackResp.StatusCode != http.StatusFound {
		t.Fatalf("unexpected callback status: %d", callbackResp.StatusCode)
	}

	sessionResp, err := client.Get(testApp.Server.URL + "/api/v1/session")
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	defer sessionResp.Body.Close()

	var body struct {
		Authenticated bool `json:"authenticated"`
		User          struct {
			AccountID string `json:"account_id"`
			Role      string `json:"role"`
		} `json:"user"`
		Onboarding struct {
			RoleSelectionRequired bool `json:"role_selection_required"`
		} `json:"onboarding"`
		CSRFToken string `json:"csrf_token"`
	}
	if err := json.NewDecoder(sessionResp.Body).Decode(&body); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if !body.Authenticated || body.User.Role != "unselected" || !body.Onboarding.RoleSelectionRequired || body.CSRFToken == "" {
		t.Fatalf("unexpected session body: %+v", body)
	}
}

func TestAuth_OnboardingRoleSelectionIdempotencyAndConflict(t *testing.T) {
	testApp := app.New(t)
	client := httpclient.New(t)
	csrf := loginViaDirectCallback(t, client, testApp)

	first := performJSON(t, client, http.MethodPost, testApp.Server.URL+"/api/v1/onboarding/role", map[string]string{"role": "student"}, csrf)
	if first.StatusCode != http.StatusOK {
		t.Fatalf("first onboarding status: %d", first.StatusCode)
	}

	second := performJSON(t, client, http.MethodPost, testApp.Server.URL+"/api/v1/onboarding/role", map[string]string{"role": "student"}, csrf)
	if second.StatusCode != http.StatusOK {
		t.Fatalf("repeat onboarding same role status: %d", second.StatusCode)
	}

	conflictResp := performJSON(t, client, http.MethodPost, testApp.Server.URL+"/api/v1/onboarding/role", map[string]string{"role": "parent"}, csrf)
	if conflictResp.StatusCode != http.StatusConflict {
		t.Fatalf("repeat onboarding different role status: %d", conflictResp.StatusCode)
	}

	adminResp := performJSON(t, client, http.MethodPost, testApp.Server.URL+"/api/v1/onboarding/role", map[string]string{"role": "admin"}, csrf)
	if adminResp.StatusCode != http.StatusForbidden {
		t.Fatalf("admin role selection status: %d", adminResp.StatusCode)
	}
}

func TestAuth_LogoutInvalidatesSession(t *testing.T) {
	testApp := app.New(t)
	client := httpclient.New(t)
	csrf := loginViaDirectCallback(t, client, testApp)
	_ = performJSON(t, client, http.MethodPost, testApp.Server.URL+"/api/v1/onboarding/role", map[string]string{"role": "student"}, csrf)

	req, err := http.NewRequest(http.MethodPost, testApp.Server.URL+"/api/v1/auth/logout", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set(testApp.Config.CSRFHeaderName, csrf)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("logout: %v", err)
	}
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("logout status: %d", resp.StatusCode)
	}

	sessionResp, err := client.Get(testApp.Server.URL + "/api/v1/session")
	if err != nil {
		t.Fatalf("session after logout: %v", err)
	}
	defer sessionResp.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(sessionResp.Body).Decode(&body); err != nil {
		t.Fatalf("decode session after logout: %v", err)
	}
	if body["authenticated"] != false {
		t.Fatalf("expected unauthenticated after logout, got %+v", body)
	}
}

func TestAuth_InvalidStateAndReturnToRejection(t *testing.T) {
	testApp := app.New(t)
	client := httpclient.New(t)

	callbackResp, err := client.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/callback?state=wrong&code=student")
	if err != nil {
		t.Fatalf("callback invalid state: %v", err)
	}
	if callbackResp.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid state status: %d", callbackResp.StatusCode)
	}

	resp, err := client.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/start?return_to=https://evil.example")
	if err != nil {
		t.Fatalf("start invalid return_to: %v", err)
	}
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("invalid return_to status: %d", resp.StatusCode)
	}
}

func TestAuth_ReturnToSurvivesSSOCallback(t *testing.T) {
	testApp := app.New(t)
	client := httpclient.New(t)

	startResp, err := client.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/start?return_to=/claim/course-link?token=abc123")
	if err != nil {
		t.Fatalf("start sso with return_to: %v", err)
	}
	if startResp.StatusCode != http.StatusFound {
		t.Fatalf("unexpected start status: %d", startResp.StatusCode)
	}
	startLocation, _ := url.Parse(startResp.Header.Get("Location"))

	callbackResp, err := client.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/callback?state=" + startLocation.Query().Get("state") + "&code=student")
	if err != nil {
		t.Fatalf("callback with return_to: %v", err)
	}
	if callbackResp.StatusCode != http.StatusFound {
		t.Fatalf("unexpected callback status: %d", callbackResp.StatusCode)
	}
	if callbackResp.Header.Get("Location") != "/claim/course-link?token=abc123" {
		t.Fatalf("unexpected callback redirect location: %s", callbackResp.Header.Get("Location"))
	}
}

func TestAuth_ParallelFirstLoginCallbacksAreIdempotent(t *testing.T) {
	testApp := app.New(t)
	clientA := httpclient.New(t)
	clientB := httpclient.New(t)

	startA, err := clientA.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/start")
	if err != nil {
		t.Fatalf("start sso client A: %v", err)
	}
	startALocation, _ := url.Parse(startA.Header.Get("Location"))
	startB, err := clientB.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/start")
	if err != nil {
		t.Fatalf("start sso client B: %v", err)
	}
	startBLocation, _ := url.Parse(startB.Header.Get("Location"))

	statuses := runParallelStatuses(t, func() int {
		resp, err := clientA.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/callback?state=" + startALocation.Query().Get("state") + "&code=parallel-first-login")
		if err != nil {
			t.Fatalf("callback client A: %v", err)
		}
		return resp.StatusCode
	}, func() int {
		resp, err := clientB.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/callback?state=" + startBLocation.Query().Get("state") + "&code=parallel-first-login")
		if err != nil {
			t.Fatalf("callback client B: %v", err)
		}
		return resp.StatusCode
	})
	if countStatus(statuses, http.StatusFound) != 2 {
		t.Fatalf("parallel first-login callback statuses: %+v", statuses)
	}

	sessionA, err := clientA.Get(testApp.Server.URL + "/api/v1/session")
	if err != nil {
		t.Fatalf("session client A: %v", err)
	}
	defer sessionA.Body.Close()
	sessionB, err := clientB.Get(testApp.Server.URL + "/api/v1/session")
	if err != nil {
		t.Fatalf("session client B: %v", err)
	}
	defer sessionB.Body.Close()

	var bodyA struct {
		Authenticated bool `json:"authenticated"`
		User          struct {
			AccountID string `json:"account_id"`
		} `json:"user"`
	}
	var bodyB struct {
		Authenticated bool `json:"authenticated"`
		User          struct {
			AccountID string `json:"account_id"`
		} `json:"user"`
	}
	if err := json.NewDecoder(sessionA.Body).Decode(&bodyA); err != nil {
		t.Fatalf("decode session A: %v", err)
	}
	if err := json.NewDecoder(sessionB.Body).Decode(&bodyB); err != nil {
		t.Fatalf("decode session B: %v", err)
	}
	if !bodyA.Authenticated || !bodyB.Authenticated || bodyA.User.AccountID == "" || bodyA.User.AccountID != bodyB.User.AccountID {
		t.Fatalf("unexpected parallel first-login sessions A=%+v B=%+v", bodyA, bodyB)
	}
}

func TestAuth_ReturnToSurvivesSSOAndBlockRevokesAllActiveSessions(t *testing.T) {
	testApp := app.New(t)
	clientA := httpclient.New(t)
	clientB := httpclient.New(t)

	startResp, err := clientA.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/start?return_to=/claim/course-link?token=invite-123")
	if err != nil {
		t.Fatalf("start sso with return_to: %v", err)
	}
	if startResp.StatusCode != http.StatusFound {
		t.Fatalf("start sso with return_to status: %d", startResp.StatusCode)
	}
	startLocation, _ := url.Parse(startResp.Header.Get("Location"))
	callbackResp, err := clientA.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/callback?state=" + startLocation.Query().Get("state") + "&code=student-multi-session")
	if err != nil {
		t.Fatalf("callback with return_to: %v", err)
	}
	if callbackResp.StatusCode != http.StatusFound {
		t.Fatalf("callback with return_to status: %d", callbackResp.StatusCode)
	}
	if callbackResp.Header.Get("Location") != "/claim/course-link?token=invite-123" {
		t.Fatalf("unexpected callback redirect location: %s", callbackResp.Header.Get("Location"))
	}

	csrfB, accountID := loginAsRole(t, clientB, testApp, "student-multi-session", "student")
	if csrfB == "" || accountID == "" {
		t.Fatalf("expected second session for same account")
	}

	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)
	blockResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/users/"+accountID+"/block", map[string]string{"reason": "test"}, adminCSRF)
	if blockResp.StatusCode != http.StatusOK {
		t.Fatalf("block user with multiple sessions status: %d", blockResp.StatusCode)
	}

	for _, tc := range []struct {
		name   string
		client *http.Client
	}{
		{name: "first session revoked", client: clientA},
		{name: "second session revoked", client: clientB},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp, err := tc.client.Get(testApp.Server.URL + "/api/v1/session")
			if err != nil {
				t.Fatalf("session request after block: %v", err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("session status after block = %d", resp.StatusCode)
			}
			var body struct {
				Authenticated bool `json:"authenticated"`
			}
			if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
				t.Fatalf("decode session after block: %v", err)
			}
			if body.Authenticated {
				t.Fatalf("blocked session must become unauthenticated")
			}
		})
	}

	var revokedSessions int
	if err := testApp.DB.Pool().QueryRow(context.Background(), `
		select count(*)
		from sessions
		where account_id = $1 and revoked_at is not null
	`, accountID).Scan(&revokedSessions); err != nil {
		t.Fatalf("count revoked sessions: %v", err)
	}
	if revokedSessions < 2 {
		t.Fatalf("expected all active sessions to be revoked, got %d", revokedSessions)
	}
}

func TestAuth_BlockedUserCannotReuseSessionAndTeacherNeedsProfile(t *testing.T) {
	testApp := app.New(t)
	client := httpclient.New(t)
	csrf := loginViaDirectCallback(t, client, testApp)
	roleResp := performJSON(t, client, http.MethodPost, testApp.Server.URL+"/api/v1/onboarding/role", map[string]string{"role": "teacher"}, csrf)
	if roleResp.StatusCode != http.StatusOK {
		t.Fatalf("teacher onboarding: %d", roleResp.StatusCode)
	}

	sessionResp, err := client.Get(testApp.Server.URL + "/api/v1/session")
	if err != nil {
		t.Fatalf("teacher session: %v", err)
	}
	defer sessionResp.Body.Close()
	var sessionBody struct {
		User struct {
			AccountID string `json:"account_id"`
		} `json:"user"`
		Onboarding struct {
			TeacherProfileRequired bool `json:"teacher_profile_required"`
		} `json:"onboarding"`
	}
	if err := json.NewDecoder(sessionResp.Body).Decode(&sessionBody); err != nil {
		t.Fatalf("decode teacher session: %v", err)
	}
	if !sessionBody.Onboarding.TeacherProfileRequired {
		t.Fatalf("teacher profile should be required")
	}

	if _, err := testApp.DB.Pool().Exec(context.Background(), `
		insert into accounts(id, role, status) values ('00000000-0000-0000-0000-000000000999', 'admin', 'active')
		on conflict do nothing;
		insert into admin_profiles(account_id, display_name) values ('00000000-0000-0000-0000-000000000999', 'Admin') on conflict do nothing;
	`); err != nil {
		t.Fatalf("seed admin: %v", err)
	}

	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)
	blockResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/users/"+sessionBody.User.AccountID+"/block", map[string]string{"reason": "test"}, adminCSRF)
	if blockResp.StatusCode != http.StatusOK {
		t.Fatalf("block user status: %d", blockResp.StatusCode)
	}

	teacherProfileResp, err := client.Get(testApp.Server.URL + "/api/v1/teacher/profile")
	if err != nil {
		t.Fatalf("teacher profile after block: %v", err)
	}
	if teacherProfileResp.StatusCode != http.StatusForbidden {
		t.Fatalf("blocked teacher access status: %d", teacherProfileResp.StatusCode)
	}
}

func TestAuth_BlockRevokesAllActiveSessions(t *testing.T) {
	testApp := app.New(t)
	clientA := httpclient.New(t)
	clientB := httpclient.New(t)

	csrfA, accountID := loginWithoutOnboarding(t, clientA, testApp, "student-block-all")
	csrfB, sameAccountID := loginWithoutOnboarding(t, clientB, testApp, "student-block-all")
	if accountID != sameAccountID {
		t.Fatalf("expected same account for parallel sessions, got %s and %s", accountID, sameAccountID)
	}

	roleResp := performJSON(t, clientA, http.MethodPost, testApp.Server.URL+"/api/v1/onboarding/role", map[string]string{"role": "student"}, csrfA)
	if roleResp.StatusCode != http.StatusOK {
		t.Fatalf("student onboarding for multi-session block status: %d", roleResp.StatusCode)
	}

	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)
	blockResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/users/"+accountID+"/block", map[string]string{"reason": "multi-session"}, adminCSRF)
	if blockResp.StatusCode != http.StatusOK {
		t.Fatalf("block user multi-session status: %d", blockResp.StatusCode)
	}

	for _, tc := range []struct {
		name   string
		client *http.Client
	}{
		{name: "client A", client: clientA},
		{name: "client B", client: clientB},
	} {
		t.Run(tc.name, func(t *testing.T) {
			profileResp, err := tc.client.Get(testApp.Server.URL + "/api/v1/student/profile")
			if err != nil {
				t.Fatalf("student profile after block: %v", err)
			}
			if profileResp.StatusCode != http.StatusForbidden {
				t.Fatalf("blocked session status: %d", profileResp.StatusCode)
			}

			sessionResp, err := tc.client.Get(testApp.Server.URL + "/api/v1/session")
			if err != nil {
				t.Fatalf("session view after block: %v", err)
			}
			defer sessionResp.Body.Close()
			var sessionBody struct {
				Authenticated bool `json:"authenticated"`
			}
			if err := json.NewDecoder(sessionResp.Body).Decode(&sessionBody); err != nil {
				t.Fatalf("decode session after block: %v", err)
			}
			if sessionBody.Authenticated {
				t.Fatalf("blocked session must no longer authenticate")
			}
		})
	}

	var activeSessions, revokedSessions int
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from sessions where account_id = $1 and revoked_at is null`, accountID).Scan(&activeSessions); err != nil {
		t.Fatalf("count active sessions after block: %v", err)
	}
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from sessions where account_id = $1 and revoked_at is not null`, accountID).Scan(&revokedSessions); err != nil {
		t.Fatalf("count revoked sessions after block: %v", err)
	}
	if activeSessions != 0 || revokedSessions < 2 {
		t.Fatalf("unexpected session revocation state active=%d revoked=%d", activeSessions, revokedSessions)
	}

	_ = csrfB
}

func TestAuth_AdminCannotBlockSelf(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)

	sessionResp, err := adminClient.Get(testApp.Server.URL + "/api/v1/session")
	if err != nil {
		t.Fatalf("admin session fetch: %v", err)
	}
	defer sessionResp.Body.Close()
	var sessionBody struct {
		User struct {
			AccountID string `json:"account_id"`
		} `json:"user"`
	}
	if err := json.NewDecoder(sessionResp.Body).Decode(&sessionBody); err != nil {
		t.Fatalf("decode admin session: %v", err)
	}

	blockResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/users/"+sessionBody.User.AccountID+"/block", map[string]string{"reason": "self"}, adminCSRF)
	if blockResp.StatusCode != http.StatusConflict {
		t.Fatalf("admin self-block status: %d", blockResp.StatusCode)
	}
}

func TestAuth_BlockedUserCannotMintNewSessionViaSSO(t *testing.T) {
	testApp := app.New(t)

	blockedClient := httpclient.New(t)
	csrf := loginViaDirectCallback(t, blockedClient, testApp)
	roleResp := performJSON(t, blockedClient, http.MethodPost, testApp.Server.URL+"/api/v1/onboarding/role", map[string]string{"role": "student"}, csrf)
	if roleResp.StatusCode != http.StatusConflict && roleResp.StatusCode != http.StatusOK {
		t.Fatalf("student onboarding status: %d", roleResp.StatusCode)
	}

	sessionResp, err := blockedClient.Get(testApp.Server.URL + "/api/v1/session")
	if err != nil {
		t.Fatalf("blocked user session fetch: %v", err)
	}
	defer sessionResp.Body.Close()
	var sessionBody struct {
		User struct {
			AccountID string `json:"account_id"`
		} `json:"user"`
	}
	if err := json.NewDecoder(sessionResp.Body).Decode(&sessionBody); err != nil {
		t.Fatalf("decode blocked user session: %v", err)
	}

	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)
	blockResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/users/"+sessionBody.User.AccountID+"/block", map[string]string{"reason": "test"}, adminCSRF)
	if blockResp.StatusCode != http.StatusOK {
		t.Fatalf("block user status: %d", blockResp.StatusCode)
	}

	freshClient := httpclient.New(t)
	startResp, err := freshClient.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/start")
	if err != nil {
		t.Fatalf("start blocked user sso: %v", err)
	}
	startLocation, _ := url.Parse(startResp.Header.Get("Location"))
	callbackResp, err := freshClient.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/callback?state=" + startLocation.Query().Get("state") + "&code=student")
	if err != nil {
		t.Fatalf("blocked user callback: %v", err)
	}
	if callbackResp.StatusCode != http.StatusForbidden {
		t.Fatalf("blocked user callback status: %d", callbackResp.StatusCode)
	}
}

func TestAuth_ReturnToSurvivesCallbackAndBlockRevokesAllSessions(t *testing.T) {
	testApp := app.New(t)

	returnToClient := httpclient.New(t)
	startResp, err := returnToClient.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/start?return_to=%2Fclaim%2Fcourse-link%3Ftoken%3Dabc123")
	if err != nil {
		t.Fatalf("start sso with return_to: %v", err)
	}
	if startResp.StatusCode != http.StatusFound {
		t.Fatalf("start sso with return_to status: %d", startResp.StatusCode)
	}
	startLocation, _ := url.Parse(startResp.Header.Get("Location"))
	callbackResp, err := returnToClient.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/callback?state=" + startLocation.Query().Get("state") + "&code=student-return-to")
	if err != nil {
		t.Fatalf("callback with return_to: %v", err)
	}
	if callbackResp.StatusCode != http.StatusFound {
		t.Fatalf("callback with return_to status: %d", callbackResp.StatusCode)
	}
	if callbackResp.Header.Get("Location") != "/claim/course-link?token=abc123" {
		t.Fatalf("unexpected callback redirect location: %s", callbackResp.Header.Get("Location"))
	}

	clientA := httpclient.New(t)
	csrfA, accountID := loginWithoutOnboardingAuth(t, clientA, testApp, "student-multi-session")
	roleA := performJSON(t, clientA, http.MethodPost, testApp.Server.URL+"/api/v1/onboarding/role", map[string]string{"role": "student"}, csrfA)
	if roleA.StatusCode != http.StatusOK {
		t.Fatalf("first session onboarding status: %d", roleA.StatusCode)
	}

	clientB := httpclient.New(t)
	csrfB, sameAccountID := loginWithoutOnboardingAuth(t, clientB, testApp, "student-multi-session")
	if sameAccountID != accountID {
		t.Fatalf("expected same account across sessions, got %s and %s", accountID, sameAccountID)
	}
	roleB := performJSON(t, clientB, http.MethodPost, testApp.Server.URL+"/api/v1/onboarding/role", map[string]string{"role": "student"}, csrfB)
	if roleB.StatusCode != http.StatusOK && roleB.StatusCode != http.StatusConflict {
		t.Fatalf("second session onboarding status: %d", roleB.StatusCode)
	}

	var activeSessions int
	if err := testApp.DB.Pool().QueryRow(context.Background(), `
		select count(*) from sessions where account_id = $1 and revoked_at is null
	`, accountID).Scan(&activeSessions); err != nil {
		t.Fatalf("count active sessions before block: %v", err)
	}
	if activeSessions < 2 {
		t.Fatalf("expected at least two active sessions before block, got %d", activeSessions)
	}

	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)
	blockResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/users/"+accountID+"/block", map[string]string{"reason": "multi-session-test"}, adminCSRF)
	if blockResp.StatusCode != http.StatusOK {
		t.Fatalf("block multi-session user status: %d", blockResp.StatusCode)
	}

	var revokedSessions int
	if err := testApp.DB.Pool().QueryRow(context.Background(), `
		select count(*) from sessions where account_id = $1 and revoked_at is not null
	`, accountID).Scan(&revokedSessions); err != nil {
		t.Fatalf("count revoked sessions after block: %v", err)
	}
	if revokedSessions != activeSessions {
		t.Fatalf("expected all sessions revoked, active=%d revoked=%d", activeSessions, revokedSessions)
	}

	for _, tc := range []struct {
		name   string
		client *http.Client
	}{
		{name: "first session blocked", client: clientA},
		{name: "second session blocked", client: clientB},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp, err := tc.client.Get(testApp.Server.URL + "/api/v1/student/profile")
			if err != nil {
				t.Fatalf("blocked student profile request: %v", err)
			}
			if resp.StatusCode != http.StatusForbidden {
				t.Fatalf("blocked student profile status: %d", resp.StatusCode)
			}
		})
	}
}

func loginWithoutOnboardingAuth(t *testing.T, client *http.Client, testApp *app.TestApp, code string) (string, string) {
	t.Helper()
	startResp, err := client.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/start")
	if err != nil {
		t.Fatalf("start login without onboarding: %v", err)
	}
	startLocation, _ := url.Parse(startResp.Header.Get("Location"))
	callbackResp, err := client.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/callback?state=" + startLocation.Query().Get("state") + "&code=" + code)
	if err != nil {
		t.Fatalf("callback login without onboarding: %v", err)
	}
	if callbackResp.StatusCode != http.StatusFound {
		t.Fatalf("callback login without onboarding status: %d", callbackResp.StatusCode)
	}
	resp, err := client.Get(testApp.Server.URL + "/api/v1/session")
	if err != nil {
		t.Fatalf("session request without onboarding: %v", err)
	}
	defer resp.Body.Close()
	var body struct {
		CSRFToken string `json:"csrf_token"`
		User      struct {
			AccountID string `json:"account_id"`
		} `json:"user"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode session without onboarding: %v", err)
	}
	return body.CSRFToken, body.User.AccountID
}

func loginViaDirectCallback(t *testing.T, client *http.Client, testApp *app.TestApp) string {
	t.Helper()
	startResp, err := client.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/start?return_to=/claim/course-link")
	if err != nil {
		t.Fatalf("start sso: %v", err)
	}
	startLocation, _ := url.Parse(startResp.Header.Get("Location"))
	state := startLocation.Query().Get("state")
	callbackResp, err := client.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/callback?state=" + state + "&code=student")
	if err != nil {
		t.Fatalf("callback sso: %v", err)
	}
	if callbackResp.StatusCode != http.StatusFound {
		t.Fatalf("callback status: %d", callbackResp.StatusCode)
	}
	resp, err := client.Get(testApp.Server.URL + "/api/v1/session")
	if err != nil {
		t.Fatalf("session request: %v", err)
	}
	defer resp.Body.Close()
	var body struct {
		CSRFToken string `json:"csrf_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode session body: %v", err)
	}
	return body.CSRFToken
}

func loginExistingAdmin(t *testing.T, client *http.Client, testApp *app.TestApp) string {
	t.Helper()
	startResp, err := client.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/start")
	if err != nil {
		t.Fatalf("start admin sso: %v", err)
	}
	startLocation, _ := url.Parse(startResp.Header.Get("Location"))
	state := startLocation.Query().Get("state")
	callbackResp, err := client.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/callback?state=" + state + "&code=admin")
	if err != nil {
		t.Fatalf("admin callback: %v", err)
	}
	if callbackResp.StatusCode != http.StatusFound {
		t.Fatalf("admin callback status: %d", callbackResp.StatusCode)
	}
	if _, err := testApp.DB.Pool().Exec(context.Background(), `
		update accounts set role = 'admin', status = 'active' where id = (
		    select account_id from external_identities where provider = 'yandex' and provider_subject = 'admin-subj'
		);
		insert into admin_profiles(account_id, display_name)
		select account_id, 'Admin' from external_identities
		where provider = 'yandex' and provider_subject = 'admin-subj'
		on conflict (account_id) do nothing;
	`); err != nil {
		t.Fatalf("promote admin: %v", err)
	}
	resp, err := client.Get(testApp.Server.URL + "/api/v1/session")
	if err != nil {
		t.Fatalf("admin session request: %v", err)
	}
	defer resp.Body.Close()
	var body struct {
		CSRFToken string `json:"csrf_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode admin session: %v", err)
	}
	return body.CSRFToken
}

func performJSON(t *testing.T, client *http.Client, method string, url string, payload any, csrf string) *http.Response {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	req, err := http.NewRequest(method, url, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if csrf != "" {
		req.Header.Set("X-CSRF-Token", csrf)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	return resp
}
