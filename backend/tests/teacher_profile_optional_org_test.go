package tests

import (
	"encoding/json"
	"net/http"
	"testing"

	"pravoprost/backend/internal/testkit/app"
	httpclient "pravoprost/backend/internal/testkit/http"
)

// TestTeacherProfile_OrganizationOptional locks in the pilot blocker fix: a teacher who completes
// onboarding with only a display name (no organization) must be able to use the cabinet. The
// onboarding gate itself must still hold until a display name is provided.
func TestTeacherProfile_OrganizationOptional(t *testing.T) {
	testApp := app.New(t)
	teacherClient := httpclient.New(t)
	teacherCSRF, _ := loginAsRole(t, teacherClient, testApp, "teacher-optional-org", "teacher")

	// 1. Fresh teacher (empty display name) is still gated by the onboarding requirement.
	sessionResp, err := teacherClient.Get(testApp.Server.URL + "/api/v1/session")
	if err != nil {
		t.Fatalf("session: %v", err)
	}
	var session struct {
		Onboarding struct {
			TeacherProfileRequired bool `json:"teacher_profile_required"`
		} `json:"onboarding"`
	}
	if err := json.NewDecoder(sessionResp.Body).Decode(&session); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	sessionResp.Body.Close()
	if !session.Onboarding.TeacherProfileRequired {
		t.Fatalf("expected teacher_profile_required=true before onboarding")
	}

	gatedResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses", map[string]any{
		"title":       "Gated",
		"description": "Should be blocked before onboarding",
	}, teacherCSRF)
	gatedResp.Body.Close()
	if gatedResp.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409 before onboarding, got %d", gatedResp.StatusCode)
	}

	// 2. Complete onboarding with ONLY a display name — organization omitted entirely.
	profileResp := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/profile", map[string]any{
		"display_name":    "Иван Петрович",
		"avatar_asset_id": nil,
	}, teacherCSRF)
	profileResp.Body.Close()
	if profileResp.StatusCode != http.StatusOK {
		t.Fatalf("profile update (no org) status: %d", profileResp.StatusCode)
	}

	// 3. Profile is now considered complete — the gate no longer fires.
	sessionResp2, err := teacherClient.Get(testApp.Server.URL + "/api/v1/session")
	if err != nil {
		t.Fatalf("session after onboarding: %v", err)
	}
	var session2 struct {
		Onboarding struct {
			TeacherProfileRequired bool `json:"teacher_profile_required"`
		} `json:"onboarding"`
	}
	if err := json.NewDecoder(sessionResp2.Body).Decode(&session2); err != nil {
		t.Fatalf("decode session2: %v", err)
	}
	sessionResp2.Body.Close()
	if session2.Onboarding.TeacherProfileRequired {
		t.Fatalf("expected teacher_profile_required=false after onboarding without org")
	}

	// 4. A teacher-ready route now succeeds even though organization was never set.
	createResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses", map[string]any{
		"title":       "Курс без организации",
		"description": "Organization is optional",
	}, teacherCSRF)
	defer createResp.Body.Close()
	if createResp.StatusCode != http.StatusCreated {
		t.Fatalf("create course without org status: %d", createResp.StatusCode)
	}

	// 5. The stored profile reports a null organization.
	getResp, err := teacherClient.Get(testApp.Server.URL + "/api/v1/teacher/profile")
	if err != nil {
		t.Fatalf("get profile: %v", err)
	}
	defer getResp.Body.Close()
	var profile struct {
		DisplayName      string  `json:"display_name"`
		OrganizationName *string `json:"organization_name"`
	}
	if err := json.NewDecoder(getResp.Body).Decode(&profile); err != nil {
		t.Fatalf("decode profile: %v", err)
	}
	if profile.DisplayName != "Иван Петрович" {
		t.Fatalf("unexpected display name: %q", profile.DisplayName)
	}
	if profile.OrganizationName != nil && *profile.OrganizationName != "" {
		t.Fatalf("expected empty/null organization, got %q", *profile.OrganizationName)
	}
}
