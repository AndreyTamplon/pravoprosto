package tests

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"pravoprost/backend/internal/identity"
	"pravoprost/backend/internal/testkit/app"
	httpclient "pravoprost/backend/internal/testkit/http"
)

// ---------------------------------------------------------------------------
// Mock Yandex IDP
// ---------------------------------------------------------------------------

type tokenRequest struct {
	GrantType    string
	Code         string
	ClientID     string
	ClientSecret string
	RedirectURI  string
}

type mockYandexIDP struct {
	server           *httptest.Server
	mu               sync.Mutex
	tokenRequests    []tokenRequest
	userInfoRequests []string // access tokens used
}

func newMockYandexIDP(t *testing.T) *mockYandexIDP {
	t.Helper()
	m := &mockYandexIDP{}
	mux := http.NewServeMux()

	// POST /token -- Yandex token endpoint
	mux.HandleFunc("POST /token", func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		tr := tokenRequest{
			GrantType:    r.FormValue("grant_type"),
			Code:         r.FormValue("code"),
			ClientID:     r.FormValue("client_id"),
			ClientSecret: r.FormValue("client_secret"),
			RedirectURI:  r.FormValue("redirect_uri"),
		}
		m.mu.Lock()
		m.tokenRequests = append(m.tokenRequests, tr)
		m.mu.Unlock()

		code := tr.Code

		if code == "invalid" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"invalid_grant"}`))
			return
		}
		if code == "server-error" {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token":  "mock-token-" + code,
			"token_type":    "bearer",
			"expires_in":    3600,
			"refresh_token": "mock-refresh-" + code,
		})
	})

	// GET /info -- Yandex userinfo endpoint
	mux.HandleFunc("GET /info", func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "OAuth ") {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
			return
		}
		token := strings.TrimPrefix(auth, "OAuth ")

		m.mu.Lock()
		m.userInfoRequests = append(m.userInfoRequests, token)
		m.mu.Unlock()

		if strings.Contains(token, "invalid-token") {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"invalid_token"}`))
			return
		}

		w.Header().Set("Content-Type", "application/json")

		switch {
		case strings.Contains(token, "alice"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":            "yandex-001",
				"login":         "alice",
				"display_name":  "Alice Test",
				"real_name":     "Alice Testova",
				"first_name":    "Alice",
				"last_name":     "Testova",
				"default_email": "alice@yandex.ru",
				"emails":        []string{"alice@yandex.ru"},
				"sex":           "female",
				"psuid":         "psuid-alice-001",
			})
		case strings.Contains(token, "bob"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":            "yandex-002",
				"login":         "bob",
				"display_name":  "",
				"real_name":     "",
				"first_name":    "Bob",
				"last_name":     "Smith",
				"default_email": "bob@yandex.ru",
				"emails":        []string{"bob@yandex.ru"},
				"sex":           "male",
				"psuid":         "psuid-bob-002",
			})
		case strings.Contains(token, "no-email"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":            "yandex-003",
				"login":         "noemail",
				"display_name":  "NoEmail User",
				"real_name":     "NoEmail",
				"first_name":    "NoEmail",
				"last_name":     "User",
				"default_email": "",
				"emails":        []string{},
				"sex":           "",
				"psuid":         "psuid-noemail-003",
			})
		default:
			// Generic profile for any other token
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":            "yandex-generic",
				"login":         "generic",
				"display_name":  "Generic User",
				"default_email": "generic@yandex.ru",
				"psuid":         "psuid-generic",
			})
		}
	})

	m.server = httptest.NewServer(mux)
	t.Cleanup(m.server.Close)
	return m
}

func (m *mockYandexIDP) provider(clientID, clientSecret string) *identity.YandexProvider {
	return identity.NewYandexProvider(identity.YandexProviderConfig{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		AuthURL:      m.server.URL + "/authorize",
		TokenURL:     m.server.URL + "/token",
		UserInfoURL:  m.server.URL + "/info",
	})
}

// ---------------------------------------------------------------------------
// Test 1: YandexAuthCodeURL
// ---------------------------------------------------------------------------

func TestSSOProvider_YandexAuthCodeURL(t *testing.T) {
	mock := newMockYandexIDP(t)
	p := mock.provider("test-client-id", "test-client-secret")

	u := p.AuthCodeURL("test-state-123", "http://example.test/callback")
	parsed, err := url.Parse(u)
	if err != nil {
		t.Fatalf("parse auth code url: %v", err)
	}

	if !strings.HasPrefix(u, mock.server.URL+"/authorize") {
		t.Fatalf("auth URL should start with mock authorize endpoint, got: %s", u)
	}
	q := parsed.Query()
	if q.Get("client_id") != "test-client-id" {
		t.Fatalf("expected client_id=test-client-id, got %s", q.Get("client_id"))
	}
	if q.Get("state") != "test-state-123" {
		t.Fatalf("expected state=test-state-123, got %s", q.Get("state"))
	}
	if q.Get("redirect_uri") != "http://example.test/callback" {
		t.Fatalf("expected redirect_uri=http://example.test/callback, got %s", q.Get("redirect_uri"))
	}
	if q.Get("force_confirm") != "yes" {
		t.Fatalf("expected force_confirm=yes, got %s", q.Get("force_confirm"))
	}
	if q.Get("response_type") != "code" {
		t.Fatalf("expected response_type=code, got %s", q.Get("response_type"))
	}
}

// ---------------------------------------------------------------------------
// Test 2: YandexExchangeSuccess
// ---------------------------------------------------------------------------

func TestSSOProvider_YandexExchangeSuccess(t *testing.T) {
	mock := newMockYandexIDP(t)
	p := mock.provider("test-client-id", "test-client-secret")

	resolved, err := p.Exchange(context.Background(), "alice", "http://example.test/callback")
	if err != nil {
		t.Fatalf("exchange: %v", err)
	}

	if resolved.Subject != "yandex-001" {
		t.Fatalf("expected Subject=yandex-001, got %s", resolved.Subject)
	}
	if resolved.Email != "alice@yandex.ru" {
		t.Fatalf("expected Email=alice@yandex.ru, got %s", resolved.Email)
	}
	if !resolved.EmailVerified {
		t.Fatalf("expected EmailVerified=true")
	}
	if resolved.DisplayName != "Alice Test" {
		t.Fatalf("expected DisplayName='Alice Test', got %s", resolved.DisplayName)
	}

	// Verify RawProfile contains expected Yandex fields
	for _, field := range []string{"id", "login", "psuid", "display_name", "default_email"} {
		if _, ok := resolved.RawProfile[field]; !ok {
			t.Fatalf("RawProfile missing field %q", field)
		}
	}
	if resolved.RawProfile["id"] != "yandex-001" {
		t.Fatalf("RawProfile[id] expected yandex-001, got %v", resolved.RawProfile["id"])
	}
	if resolved.RawProfile["psuid"] != "psuid-alice-001" {
		t.Fatalf("RawProfile[psuid] expected psuid-alice-001, got %v", resolved.RawProfile["psuid"])
	}
}

// ---------------------------------------------------------------------------
// Test 3: YandexExchangeFallbackDisplayName
// ---------------------------------------------------------------------------

func TestSSOProvider_YandexExchangeFallbackDisplayName(t *testing.T) {
	mock := newMockYandexIDP(t)
	p := mock.provider("test-client-id", "test-client-secret")

	resolved, err := p.Exchange(context.Background(), "bob", "http://example.test/callback")
	if err != nil {
		t.Fatalf("exchange: %v", err)
	}

	if resolved.Subject != "yandex-002" {
		t.Fatalf("expected Subject=yandex-002, got %s", resolved.Subject)
	}
	// display_name is empty, should fall back to first_name + last_name
	if resolved.DisplayName != "Bob Smith" {
		t.Fatalf("expected DisplayName='Bob Smith' (fallback), got %q", resolved.DisplayName)
	}
	if resolved.Email != "bob@yandex.ru" {
		t.Fatalf("expected Email=bob@yandex.ru, got %s", resolved.Email)
	}
}

// ---------------------------------------------------------------------------
// Test 4: YandexExchangeNoEmail
// ---------------------------------------------------------------------------

func TestSSOProvider_YandexExchangeNoEmail(t *testing.T) {
	mock := newMockYandexIDP(t)
	p := mock.provider("test-client-id", "test-client-secret")

	resolved, err := p.Exchange(context.Background(), "no-email", "http://example.test/callback")
	if err != nil {
		t.Fatalf("exchange: %v", err)
	}

	if resolved.Subject != "yandex-003" {
		t.Fatalf("expected Subject=yandex-003, got %s", resolved.Subject)
	}
	if resolved.Email != "" {
		t.Fatalf("expected empty Email, got %s", resolved.Email)
	}
	if resolved.DisplayName != "NoEmail User" {
		t.Fatalf("expected DisplayName='NoEmail User', got %q", resolved.DisplayName)
	}
}

// ---------------------------------------------------------------------------
// Test 5: YandexExchangeInvalidCode
// ---------------------------------------------------------------------------

func TestSSOProvider_YandexExchangeInvalidCode(t *testing.T) {
	mock := newMockYandexIDP(t)
	p := mock.provider("test-client-id", "test-client-secret")

	_, err := p.Exchange(context.Background(), "invalid", "http://example.test/callback")
	if err == nil {
		t.Fatal("expected error for invalid code, got nil")
	}
}

// ---------------------------------------------------------------------------
// Test 6: YandexExchangeServerError
// ---------------------------------------------------------------------------

func TestSSOProvider_YandexExchangeServerError(t *testing.T) {
	mock := newMockYandexIDP(t)
	p := mock.provider("test-client-id", "test-client-secret")

	_, err := p.Exchange(context.Background(), "server-error", "http://example.test/callback")
	if err == nil {
		t.Fatal("expected error for server error, got nil")
	}
}

// ---------------------------------------------------------------------------
// Test 7: YandexExchangeInvalidToken
// ---------------------------------------------------------------------------

func TestSSOProvider_YandexExchangeInvalidToken(t *testing.T) {
	mock := newMockYandexIDP(t)
	p := mock.provider("test-client-id", "test-client-secret")

	_, err := p.Exchange(context.Background(), "invalid-token", "http://example.test/callback")
	if err == nil {
		t.Fatal("expected error for invalid token, got nil")
	}
	if !strings.Contains(err.Error(), "401") {
		t.Fatalf("expected error containing 401, got: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Test 8: RegistryLookup
// ---------------------------------------------------------------------------

func TestSSOProvider_RegistryLookup(t *testing.T) {
	mock := newMockYandexIDP(t)
	p := mock.provider("test-client-id", "test-client-secret")

	registry := identity.NewProviderRegistry()
	registry.Register(p)

	got, ok := registry.Get("yandex")
	if !ok {
		t.Fatal("expected to find yandex provider in registry")
	}
	if got.Name() != "yandex" {
		t.Fatalf("expected provider name 'yandex', got %s", got.Name())
	}

	_, ok = registry.Get("google")
	if ok {
		t.Fatal("expected google provider to not exist in registry")
	}
}

// ---------------------------------------------------------------------------
// Test 9: FullFlowThroughBackend
// ---------------------------------------------------------------------------

func TestSSOProvider_FullFlowThroughBackend(t *testing.T) {
	mock := newMockYandexIDP(t)
	registry := identity.NewProviderRegistry()
	registry.Register(mock.provider("test-client-id", "test-client-secret"))
	testApp := app.NewWithRegistry(t, registry)
	client := httpclient.New(t)

	// Step 1: StartSSO -- GET /api/v1/auth/sso/yandex/start
	startResp, err := client.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/start")
	if err != nil {
		t.Fatalf("start sso: %v", err)
	}
	if startResp.StatusCode != http.StatusFound {
		t.Fatalf("expected 302, got %d", startResp.StatusCode)
	}

	// Step 2: Extract state from redirect URL
	redirectURL, err := url.Parse(startResp.Header.Get("Location"))
	if err != nil {
		t.Fatalf("parse redirect url: %v", err)
	}
	state := redirectURL.Query().Get("state")
	if state == "" {
		t.Fatal("state parameter missing from redirect URL")
	}
	// Verify the redirect goes to our mock IDP
	if !strings.HasPrefix(redirectURL.String(), mock.server.URL) {
		t.Fatalf("redirect should go to mock IDP, got: %s", redirectURL.String())
	}

	// Step 3: Callback with code (simulating the IDP redirect back)
	callbackResp, err := client.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/callback?state=" + state + "&code=alice")
	if err != nil {
		t.Fatalf("callback: %v", err)
	}
	if callbackResp.StatusCode != http.StatusFound {
		t.Fatalf("expected callback 302, got %d", callbackResp.StatusCode)
	}

	// Step 4: Verify session created
	sessionResp, err := client.Get(testApp.Server.URL + "/api/v1/session")
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	defer sessionResp.Body.Close()
	var session struct {
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
	if err := json.NewDecoder(sessionResp.Body).Decode(&session); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if !session.Authenticated {
		t.Fatal("session should be authenticated")
	}
	if session.User.Role != "unselected" {
		t.Fatalf("expected role=unselected, got %s", session.User.Role)
	}
	if !session.Onboarding.RoleSelectionRequired {
		t.Fatal("expected role_selection_required=true")
	}
	if session.CSRFToken == "" {
		t.Fatal("expected csrf_token to be non-empty")
	}

	// Step 5: Verify external_identities row has correct provider_subject
	var providerSubject, email string
	var emailVerified bool
	err = testApp.DB.Pool().QueryRow(context.Background(), `
		select provider_subject, email, email_verified
		from external_identities
		where account_id = $1 and provider = 'yandex'
	`, session.User.AccountID).Scan(&providerSubject, &email, &emailVerified)
	if err != nil {
		t.Fatalf("query external_identities: %v", err)
	}
	if providerSubject != "yandex-001" {
		t.Fatalf("expected provider_subject=yandex-001, got %s", providerSubject)
	}
	if email != "alice@yandex.ru" {
		t.Fatalf("expected email=alice@yandex.ru, got %s", email)
	}
	if !emailVerified {
		t.Fatal("expected email_verified=true")
	}
}

// ---------------------------------------------------------------------------
// Test 10: FullFlowNewUserOnboarding
// ---------------------------------------------------------------------------

func TestSSOProvider_FullFlowNewUserOnboarding(t *testing.T) {
	mock := newMockYandexIDP(t)
	registry := identity.NewProviderRegistry()
	registry.Register(mock.provider("test-client-id", "test-client-secret"))
	testApp := app.NewWithRegistry(t, registry)
	client := httpclient.New(t)

	// Login with alice
	csrf, accountID := ssoLogin(t, client, testApp, "alice")

	// Complete role selection as student
	resp := performJSON(t, client, http.MethodPost, testApp.Server.URL+"/api/v1/onboarding/role", map[string]string{"role": "student"}, csrf)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("role selection status: %d", resp.StatusCode)
	}

	// Verify display_name in student_profiles
	// defaultDisplayName reads raw_profile_json ->> 'name' first (which is empty for Yandex),
	// then falls back to email prefix. For alice@yandex.ru that's "alice".
	// But actually, let's check -- the raw JSON may include "display_name" as a key.
	// defaultDisplayName reads raw_profile_json ->> 'name', and Yandex raw JSON has no 'name' key.
	// So it falls back to email prefix: "alice".
	var displayName string
	err := testApp.DB.Pool().QueryRow(context.Background(), `
		select display_name from student_profiles where account_id = $1
	`, accountID).Scan(&displayName)
	if err != nil {
		t.Fatalf("query student_profiles: %v", err)
	}
	if displayName != "alice" {
		t.Fatalf("expected display_name='alice' (email prefix fallback), got %q", displayName)
	}

	// Verify role is now student
	sessResp, err := client.Get(testApp.Server.URL + "/api/v1/session")
	if err != nil {
		t.Fatalf("get session after onboarding: %v", err)
	}
	defer sessResp.Body.Close()
	var sess struct {
		User struct {
			Role string `json:"role"`
		} `json:"user"`
	}
	if err := json.NewDecoder(sessResp.Body).Decode(&sess); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if sess.User.Role != "student" {
		t.Fatalf("expected role=student, got %s", sess.User.Role)
	}
}

// ---------------------------------------------------------------------------
// Test 11: FullFlowExistingUser
// ---------------------------------------------------------------------------

func TestSSOProvider_FullFlowExistingUser(t *testing.T) {
	mock := newMockYandexIDP(t)
	registry := identity.NewProviderRegistry()
	registry.Register(mock.provider("test-client-id", "test-client-secret"))
	testApp := app.NewWithRegistry(t, registry)

	// First login
	client1 := httpclient.New(t)
	_, accountID1 := ssoLogin(t, client1, testApp, "alice")

	// Second login with same Yandex user
	client2 := httpclient.New(t)
	_, accountID2 := ssoLogin(t, client2, testApp, "alice")

	// Same account
	if accountID1 != accountID2 {
		t.Fatalf("expected same account for repeated login, got %s and %s", accountID1, accountID2)
	}

	// No duplicate in external_identities
	var count int
	err := testApp.DB.Pool().QueryRow(context.Background(), `
		select count(*) from external_identities
		where provider = 'yandex' and provider_subject = 'yandex-001'
	`).Scan(&count)
	if err != nil {
		t.Fatalf("count external_identities: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected exactly 1 external_identity row, got %d", count)
	}
}

// ---------------------------------------------------------------------------
// Test 12: UnknownProviderReturnsError
// ---------------------------------------------------------------------------

func TestSSOProvider_UnknownProviderReturnsError(t *testing.T) {
	mock := newMockYandexIDP(t)
	registry := identity.NewProviderRegistry()
	registry.Register(mock.provider("test-client-id", "test-client-secret"))
	testApp := app.NewWithRegistry(t, registry)
	client := httpclient.New(t)

	// Try to start SSO with google (only yandex is registered)
	resp, err := client.Get(testApp.Server.URL + "/api/v1/auth/sso/google/start")
	if err != nil {
		t.Fatalf("start google sso: %v", err)
	}
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for unknown provider, got %d", resp.StatusCode)
	}
	defer resp.Body.Close()
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if body.Error.Code != "unknown_provider" {
		t.Fatalf("expected error code 'unknown_provider', got %q", body.Error.Code)
	}
}

// ---------------------------------------------------------------------------
// Test 13: LegacyProviderStillWorks
// ---------------------------------------------------------------------------

func TestSSOProvider_LegacyProviderStillWorks(t *testing.T) {
	// Use the standard New() which creates a fakeSSO with the legacy exchange endpoint
	testApp := app.New(t)
	client := httpclient.New(t)

	// Start SSO
	startResp, err := client.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/start")
	if err != nil {
		t.Fatalf("start sso: %v", err)
	}
	if startResp.StatusCode != http.StatusFound {
		t.Fatalf("expected 302 from start, got %d", startResp.StatusCode)
	}
	startLocation, _ := url.Parse(startResp.Header.Get("Location"))
	state := startLocation.Query().Get("state")

	// Callback with code
	callbackResp, err := client.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/callback?state=" + state + "&code=student")
	if err != nil {
		t.Fatalf("callback: %v", err)
	}
	if callbackResp.StatusCode != http.StatusFound {
		t.Fatalf("expected 302 from callback, got %d", callbackResp.StatusCode)
	}

	// Verify session
	sessionResp, err := client.Get(testApp.Server.URL + "/api/v1/session")
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	defer sessionResp.Body.Close()
	var sess struct {
		Authenticated bool `json:"authenticated"`
		User          struct {
			AccountID string `json:"account_id"`
			Role      string `json:"role"`
		} `json:"user"`
	}
	if err := json.NewDecoder(sessionResp.Body).Decode(&sess); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if !sess.Authenticated {
		t.Fatal("expected authenticated session via legacy provider")
	}
	if sess.User.AccountID == "" {
		t.Fatal("expected non-empty account_id")
	}
	if sess.User.Role != "unselected" {
		t.Fatalf("expected role=unselected, got %s", sess.User.Role)
	}

	// Verify external_identities has the correct provider_subject from legacy SSO
	var providerSubject string
	err = testApp.DB.Pool().QueryRow(context.Background(), `
		select provider_subject from external_identities
		where account_id = $1 and provider = 'yandex'
	`, sess.User.AccountID).Scan(&providerSubject)
	if err != nil {
		t.Fatalf("query external_identities: %v", err)
	}
	// Legacy fakeSSO returns subject="subj-login" for code="student"
	if providerSubject != "subj-login" {
		t.Fatalf("expected provider_subject='subj-login', got %q", providerSubject)
	}
}

// ---------------------------------------------------------------------------
// Helper: ssoLogin performs the full SSO login flow and returns csrf + accountID
// ---------------------------------------------------------------------------

func ssoLogin(t *testing.T, client *http.Client, testApp *app.TestApp, code string) (string, string) {
	t.Helper()

	startResp, err := client.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/start")
	if err != nil {
		t.Fatalf("start sso login: %v", err)
	}
	if startResp.StatusCode != http.StatusFound {
		t.Fatalf("expected 302 from start, got %d", startResp.StatusCode)
	}
	redirectURL, _ := url.Parse(startResp.Header.Get("Location"))
	state := redirectURL.Query().Get("state")
	if state == "" {
		t.Fatal("state missing from redirect")
	}

	callbackResp, err := client.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/callback?state=" + state + "&code=" + code)
	if err != nil {
		t.Fatalf("sso callback: %v", err)
	}
	if callbackResp.StatusCode != http.StatusFound {
		t.Fatalf("expected 302 from callback, got %d", callbackResp.StatusCode)
	}

	sessResp, err := client.Get(testApp.Server.URL + "/api/v1/session")
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	defer sessResp.Body.Close()
	var body struct {
		CSRFToken string `json:"csrf_token"`
		User      struct {
			AccountID string `json:"account_id"`
		} `json:"user"`
	}
	if err := json.NewDecoder(sessResp.Body).Decode(&body); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if body.User.AccountID == "" {
		t.Fatal("expected non-empty account_id")
	}
	return body.CSRFToken, body.User.AccountID
}

