package tests

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"pravoprost/backend/internal/testkit/app"
	httpclient "pravoprost/backend/internal/testkit/http"
)

func TestGuardianship_CreateClaimListAndRevokeInvite(t *testing.T) {
	testApp := app.New(t)
	parentClient := httpclient.New(t)
	parentCSRF, _ := loginAsRole(t, parentClient, testApp, "parent-one", "parent")

	createResp := performJSON(t, parentClient, http.MethodPost, testApp.Server.URL+"/api/v1/parent/children/link-invites", map[string]any{}, parentCSRF)
	if createResp.StatusCode != http.StatusCreated {
		t.Fatalf("create invite status: %d", createResp.StatusCode)
	}
	defer createResp.Body.Close()
	var invite struct {
		InviteID string `json:"invite_id"`
		ClaimURL string `json:"claim_url"`
	}
	if err := json.NewDecoder(createResp.Body).Decode(&invite); err != nil {
		t.Fatalf("decode invite: %v", err)
	}
	token := strings.TrimPrefix(strings.Split(invite.ClaimURL, "#")[1], "token=")

	studentClient := httpclient.New(t)
	studentCSRF, studentID := loginAsRole(t, studentClient, testApp, "student-one", "student")
	claimResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/guardian-links/claim", map[string]string{"token": token}, studentCSRF)
	if claimResp.StatusCode != http.StatusOK {
		t.Fatalf("claim invite status: %d", claimResp.StatusCode)
	}

	childrenResp, err := parentClient.Get(testApp.Server.URL + "/api/v1/parent/children")
	if err != nil {
		t.Fatalf("parent children: %v", err)
	}
	defer childrenResp.Body.Close()
	var children struct {
		Children []struct {
			StudentID string `json:"student_id"`
		} `json:"children"`
	}
	if err := json.NewDecoder(childrenResp.Body).Decode(&children); err != nil {
		t.Fatalf("decode children: %v", err)
	}
	if len(children.Children) != 1 || children.Children[0].StudentID != studentID {
		t.Fatalf("unexpected children payload: %+v", children)
	}

	progressResp, err := parentClient.Get(testApp.Server.URL + "/api/v1/parent/children/" + studentID + "/progress")
	if err != nil {
		t.Fatalf("child progress: %v", err)
	}
	if progressResp.StatusCode != http.StatusOK {
		t.Fatalf("child progress status: %d", progressResp.StatusCode)
	}

	anotherInviteResp := performJSON(t, parentClient, http.MethodPost, testApp.Server.URL+"/api/v1/parent/children/link-invites", map[string]any{}, parentCSRF)
	if anotherInviteResp.StatusCode != http.StatusCreated {
		t.Fatalf("second create invite: %d", anotherInviteResp.StatusCode)
	}
	defer anotherInviteResp.Body.Close()
	var secondInvite struct {
		InviteID string `json:"invite_id"`
		ClaimURL string `json:"claim_url"`
	}
	if err := json.NewDecoder(anotherInviteResp.Body).Decode(&secondInvite); err != nil {
		t.Fatalf("decode second invite: %v", err)
	}

	revokeResp := performJSON(t, parentClient, http.MethodPost, testApp.Server.URL+"/api/v1/parent/children/link-invites/"+secondInvite.InviteID+"/revoke", map[string]any{}, parentCSRF)
	if revokeResp.StatusCode != http.StatusOK {
		t.Fatalf("revoke invite status: %d", revokeResp.StatusCode)
	}

	revokedToken := strings.TrimPrefix(strings.Split(secondInvite.ClaimURL, "#")[1], "token=")
	revokedClaimResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/guardian-links/claim", map[string]string{"token": revokedToken}, studentCSRF)
	if revokedClaimResp.StatusCode != http.StatusConflict {
		t.Fatalf("claimed resolved invite status: %d", revokedClaimResp.StatusCode)
	}
}

func TestGuardianship_InviteReuseExpiryAndTwoParentLimit(t *testing.T) {
	testApp := app.New(t)

	parent1Client := httpclient.New(t)
	parent1CSRF, _ := loginAsRole(t, parent1Client, testApp, "parent-a", "parent")
	parent2Client := httpclient.New(t)
	parent2CSRF, _ := loginAsRole(t, parent2Client, testApp, "parent-b", "parent")
	parent3Client := httpclient.New(t)
	parent3CSRF, _ := loginAsRole(t, parent3Client, testApp, "parent-c", "parent")
	studentClient := httpclient.New(t)
	studentCSRF, studentID := loginAsRole(t, studentClient, testApp, "student-guardian", "student")

	token1 := createGuardianInvite(t, parent1Client, testApp, parent1CSRF)
	token2 := createGuardianInvite(t, parent2Client, testApp, parent2CSRF)
	token3 := createGuardianInvite(t, parent3Client, testApp, parent3CSRF)

	if status := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/guardian-links/claim", map[string]string{"token": token1}, studentCSRF).StatusCode; status != http.StatusOK {
		t.Fatalf("first claim status: %d", status)
	}
	reuseResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/guardian-links/claim", map[string]string{"token": token1}, studentCSRF)
	if reuseResp.StatusCode != http.StatusConflict {
		t.Fatalf("reused token status: %d", reuseResp.StatusCode)
	}
	if status := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/guardian-links/claim", map[string]string{"token": token2}, studentCSRF).StatusCode; status != http.StatusOK {
		t.Fatalf("second parent claim status: %d", status)
	}

	_, err := testApp.DB.Pool().Exec(context.Background(), `
		update guardian_link_invites
		set expires_at = now() - interval '1 day'
		where token_hash = encode(digest($1, 'sha256'), 'hex')
	`, token3)
	if err != nil {
		t.Fatalf("expire invite: %v", err)
	}
	expiredResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/guardian-links/claim", map[string]string{"token": token3}, studentCSRF)
	if expiredResp.StatusCode != http.StatusConflict {
		t.Fatalf("expired invite status: %d", expiredResp.StatusCode)
	}

	token4 := createGuardianInvite(t, parent3Client, testApp, parent3CSRF)
	limitResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/guardian-links/claim", map[string]string{"token": token4}, studentCSRF)
	if limitResp.StatusCode != http.StatusConflict {
		t.Fatalf("third parent claim status: %d", limitResp.StatusCode)
	}

	unrelatedProgress, err := parent3Client.Get(testApp.Server.URL + "/api/v1/parent/children/" + studentID + "/progress")
	if err != nil {
		t.Fatalf("unrelated parent progress: %v", err)
	}
	if unrelatedProgress.StatusCode != http.StatusForbidden {
		t.Fatalf("unrelated parent progress status: %d", unrelatedProgress.StatusCode)
	}
}

func createGuardianInvite(t *testing.T, client *http.Client, testApp *app.TestApp, csrf string) string {
	t.Helper()
	resp := performJSON(t, client, http.MethodPost, testApp.Server.URL+"/api/v1/parent/children/link-invites", map[string]any{}, csrf)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create invite status: %d", resp.StatusCode)
	}
	defer resp.Body.Close()
	var payload struct {
		ClaimURL string `json:"claim_url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode invite payload: %v", err)
	}
	return strings.TrimPrefix(strings.Split(payload.ClaimURL, "#")[1], "token=")
}

func loginAsRole(t *testing.T, client *http.Client, testApp *app.TestApp, code string, role string) (string, string) {
	t.Helper()
	startResp, err := client.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/start")
	if err != nil {
		t.Fatalf("start login: %v", err)
	}
	state := strings.Split(strings.Split(startResp.Header.Get("Location"), "state=")[1], "&")[0]
	callbackResp, err := client.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/callback?state=" + state + "&code=" + code)
	if err != nil {
		t.Fatalf("callback login: %v", err)
	}
	if callbackResp.StatusCode != http.StatusFound {
		t.Fatalf("callback status: %d", callbackResp.StatusCode)
	}
	sessionResp, err := client.Get(testApp.Server.URL + "/api/v1/session")
	if err != nil {
		t.Fatalf("session login: %v", err)
	}
	defer sessionResp.Body.Close()
	var sessionBody struct {
		CSRFToken string `json:"csrf_token"`
		User      struct {
			AccountID string `json:"account_id"`
		} `json:"user"`
	}
	if err := json.NewDecoder(sessionResp.Body).Decode(&sessionBody); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	resp := performJSON(t, client, http.MethodPost, testApp.Server.URL+"/api/v1/onboarding/role", map[string]string{"role": role}, sessionBody.CSRFToken)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("onboarding role %s status: %d", role, resp.StatusCode)
	}
	return sessionBody.CSRFToken, sessionBody.User.AccountID
}
