package tests

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"pravoprost/backend/internal/testkit/app"
	httpclient "pravoprost/backend/internal/testkit/http"
)

// twoModuleCourse builds a platform course with a free module (3 lessons, sort 1-3) and a paid
// module (1 lesson, sort 4). Putting the paid lesson first in its own module avoids the
// prerequisite gate (locked_prerequisite would otherwise mask locked_paid in the tree).
func twoModuleCourse() map[string]any {
	lesson := func(id string) map[string]any {
		return map[string]any{
			"id":    id,
			"title": id,
			"graph": map[string]any{
				"startNodeId": "n1",
				"nodes":       []any{map[string]any{"id": "n1", "kind": "end", "text": "Done"}},
			},
		}
	}
	return map[string]any{
		"modules": []any{
			map[string]any{"id": "m1", "title": "Free module", "lessons": []any{lesson("l1"), lesson("l2"), lesson("l3")}},
			map[string]any{"id": "m2", "title": "Paid module", "lessons": []any{lesson("l4")}},
		},
	}
}

// fakeTBankServer returns an httptest server that mimics T-Bank /v2/Init and the env wiring.
func fakeTBankServer(t *testing.T, terminalKey, password, paymentID string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v2/Init" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		decoder := json.NewDecoder(r.Body)
		decoder.UseNumber()
		var payload map[string]any
		if err := decoder.Decode(&payload); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		expectedToken := signTBankTokenFromPayload(payload, password)
		if !strings.EqualFold(expectedToken, strings.TrimSpace(scalarToString(payload["Token"]))) {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		orderID := strings.TrimSpace(scalarToString(payload["OrderId"]))
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"Success": true, "ErrorCode": "0", "PaymentId": paymentID,
			"OrderId": orderID, "Status": "NEW", "PaymentURL": "https://pay.test/checkout/" + orderID,
		})
	}))
	t.Setenv("PRAVO_TBANK_TERMINAL_KEY", terminalKey)
	t.Setenv("PRAVO_TBANK_PASSWORD", password)
	t.Setenv("PRAVO_TBANK_API_BASE_URL", srv.URL)
	t.Setenv("PRAVO_TBANK_NOTIFICATION_PATH", "/api/payment/webhook")
	t.Setenv("PRAVO_TBANK_PENDING_TTL_MINUTES", "60")
	return srv
}

func createPlatformOffer(t *testing.T, adminClient *http.Client, testApp *app.TestApp, adminCSRF string, priceMinor int64) string {
	t.Helper()
	resp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/offers", map[string]any{
		"target_type":        "platform",
		"title":              "Полный доступ",
		"description":        "Доступ ко всем урокам",
		"price_amount_minor": priceMinor,
		"price_currency":     "RUB",
	}, adminCSRF)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("create platform offer status: %d (%s)", resp.StatusCode, string(body))
	}
	var created struct {
		OfferID string `json:"offer_id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		t.Fatalf("decode platform offer: %v", err)
	}
	return created.OfferID
}

func setOfferStatus(t *testing.T, adminClient *http.Client, testApp *app.TestApp, adminCSRF, offerID, status string, priceMinor int64) *http.Response {
	t.Helper()
	return performJSON(t, adminClient, http.MethodPut, testApp.Server.URL+"/api/v1/admin/commerce/offers/"+offerID, map[string]any{
		"title":              "Полный доступ",
		"description":        "Доступ ко всем урокам",
		"price_amount_minor": priceMinor,
		"price_currency":     "RUB",
		"status":             status,
	}, adminCSRF)
}

func setFreeLessonCount(t *testing.T, adminClient *http.Client, testApp *app.TestApp, adminCSRF, courseID string, count int) {
	t.Helper()
	resp := performJSON(t, adminClient, http.MethodPut, testApp.Server.URL+"/api/v1/admin/commerce/courses/"+courseID+"/free-access", map[string]any{
		"free_lesson_count": count,
	}, adminCSRF)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("set free_lesson_count=%d status: %d (%s)", count, resp.StatusCode, string(body))
	}
}

func lessonAccessState(tree studentTreeView, lessonID string) string {
	for _, m := range tree.Modules {
		for _, l := range m.Lessons {
			if l.LessonID == lessonID {
				return l.Access.AccessState
			}
		}
	}
	return ""
}

// TestFreeAccess_FreeTierStudentCheckoutGlobalUnlockAndRevoke is the P0 end-to-end:
// free first module → paywall on module 2 → student self-checkout → webhook → ALL courses
// unlocked → revoke re-locks paid lessons while free ones stay open.
func TestFreeAccess_FreeTierStudentCheckoutGlobalUnlockAndRevoke(t *testing.T) {
	const terminalKey, password, paymentID = "ft-terminal", "ft-password", "900001"
	fakeTBank := fakeTBankServer(t, terminalKey, password, paymentID)
	defer fakeTBank.Close()

	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)
	studentClient := httpclient.New(t)
	studentCSRF, studentID := loginAsRole(t, studentClient, testApp, "ft-student", "student")
	_ = studentCSRF

	courseA, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Course A", twoModuleCourse())
	courseB, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Course B", twoModuleCourse())
	setFreeLessonCount(t, adminClient, testApp, adminCSRF, courseA, 3)
	setFreeLessonCount(t, adminClient, testApp, adminCSRF, courseB, 3)

	// Kill switch: no active offer yet → everything is free (current prod behaviour preserved).
	treeA := fetchStudentTree(t, studentClient, testApp, courseA)
	if got := lessonAccessState(treeA, "l4"); got != "free" {
		t.Fatalf("no-offer l4 expected free, got %s", got)
	}

	offerID := createPlatformOffer(t, adminClient, testApp, adminCSRF, 9900)
	if resp := setOfferStatus(t, adminClient, testApp, adminCSRF, offerID, "active", 9900); resp.StatusCode != http.StatusOK {
		t.Fatalf("activate platform offer status: %d", resp.StatusCode)
	}

	// Paywall on: the free module's entry lesson is free, lesson 4 (first of the paid module) is
	// locked behind the platform offer. (l2/l3 show locked_prerequisite — free but sequential —
	// because prerequisite ordering overrides commercial state in the tree; that is orthogonal
	// to the paywall and unchanged by this feature.)
	treeA = fetchStudentTree(t, studentClient, testApp, courseA)
	if got := lessonAccessState(treeA, "l1"); got != "free" {
		t.Fatalf("free-tier l1 expected free, got %s", got)
	}
	if got := lessonAccessState(treeA, "l4"); got != "locked_paid" {
		t.Fatalf("l4 expected locked_paid, got %s", got)
	}
	treeB := fetchStudentTree(t, studentClient, testApp, courseB)
	if got := lessonAccessState(treeB, "l4"); got != "locked_paid" {
		t.Fatalf("courseB l4 expected locked_paid, got %s", got)
	}

	// Free lesson opens; paid lesson is blocked.
	if resp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseA+"/lessons/l1/start", map[string]any{}, studentCSRF); resp.StatusCode != http.StatusOK {
		t.Fatalf("start free l1 status: %d", resp.StatusCode)
	}
	if resp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseA+"/lessons/l4/start", map[string]any{}, studentCSRF); resp.StatusCode != http.StatusConflict {
		t.Fatalf("start paid l4 expected 409, got %d", resp.StatusCode)
	}

	// Student self-checkout the platform product.
	checkoutResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/offers/"+offerID+"/checkout", map[string]any{}, studentCSRF)
	defer checkoutResp.Body.Close()
	if checkoutResp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(checkoutResp.Body)
		t.Fatalf("student checkout status: %d (%s)", checkoutResp.StatusCode, string(body))
	}
	var checkout struct {
		OrderID     string `json:"order_id"`
		AccessState string `json:"access_state"`
		PaymentURL  string `json:"payment_url"`
	}
	if err := json.NewDecoder(checkoutResp.Body).Decode(&checkout); err != nil {
		t.Fatalf("decode student checkout: %v", err)
	}
	if checkout.OrderID == "" || checkout.PaymentURL == "" || checkout.AccessState != "awaiting_payment_confirmation" {
		t.Fatalf("unexpected student checkout payload: %+v", checkout)
	}

	treeA = fetchStudentTree(t, studentClient, testApp, courseA)
	if got := lessonAccessState(treeA, "l4"); got != "awaiting_payment_confirmation" {
		t.Fatalf("l4 after checkout expected awaiting, got %s", got)
	}

	// T-Bank confirms payment.
	notification := map[string]any{
		"TerminalKey": terminalKey, "OrderId": checkout.OrderID, "PaymentId": paymentID,
		"Status": "CONFIRMED", "Success": true, "Amount": 9900,
	}
	notification["Token"] = signTBankTokenFromPayload(notification, password)
	webhookResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/payment/webhook", notification, "")
	defer webhookResp.Body.Close()
	if webhookResp.StatusCode != http.StatusOK {
		t.Fatalf("webhook status: %d", webhookResp.StatusCode)
	}

	// Idempotency: a duplicate CONFIRMED webhook must not create a second entitlement.
	dupWebhookResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/payment/webhook", notification, "")
	defer dupWebhookResp.Body.Close()
	if dupWebhookResp.StatusCode != http.StatusOK {
		t.Fatalf("duplicate webhook status: %d", dupWebhookResp.StatusCode)
	}

	// Global unlock: paid lessons of BOTH courses are now granted; free lessons stay free.
	treeA = fetchStudentTree(t, studentClient, testApp, courseA)
	if got := lessonAccessState(treeA, "l4"); got != "granted" {
		t.Fatalf("courseA l4 after pay expected granted, got %s", got)
	}
	treeB = fetchStudentTree(t, studentClient, testApp, courseB)
	if got := lessonAccessState(treeB, "l4"); got != "granted" {
		t.Fatalf("courseB l4 after pay expected granted (global unlock), got %s", got)
	}
	if resp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseB+"/lessons/l4/start", map[string]any{}, studentCSRF); resp.StatusCode != http.StatusOK {
		t.Fatalf("start courseB l4 after pay status: %d", resp.StatusCode)
	}

	// Exactly one active platform entitlement with NULL course, order fulfilled.
	var entCount int
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from entitlements where student_id=$1 and status='active' and target_type='platform' and target_course_id is null`, studentID).Scan(&entCount); err != nil {
		t.Fatalf("count platform entitlement: %v", err)
	}
	if entCount != 1 {
		t.Fatalf("expected 1 active platform entitlement, got %d", entCount)
	}

	// Double-charge guard: paying again is rejected before any T-Bank call.
	if resp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/offers/"+offerID+"/checkout", map[string]any{}, studentCSRF); resp.StatusCode != http.StatusConflict {
		t.Fatalf("second checkout expected 409 entitlement_already_active, got %d", resp.StatusCode)
	}

	// Revoke platform entitlement → paid lesson re-locks, free lesson stays free.
	var entID string
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select id::text from entitlements where student_id=$1 and status='active' and target_type='platform'`, studentID).Scan(&entID); err != nil {
		t.Fatalf("lookup platform entitlement id: %v", err)
	}
	if resp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/entitlements/"+entID+"/revoke", map[string]any{}, adminCSRF); resp.StatusCode != http.StatusOK {
		t.Fatalf("revoke platform entitlement status: %d", resp.StatusCode)
	}
	treeA = fetchStudentTree(t, studentClient, testApp, courseA)
	if got := lessonAccessState(treeA, "l4"); got != "locked_paid" {
		t.Fatalf("l4 after revoke expected locked_paid, got %s", got)
	}
	if got := lessonAccessState(treeA, "l1"); got != "free" {
		t.Fatalf("l1 after revoke expected free, got %s", got)
	}
}

// TestFreeAccess_ConfigGuardsAndStudentScope covers the config edges and the security guards.
func TestFreeAccess_ConfigGuardsAndStudentScope(t *testing.T) {
	const terminalKey, password, paymentID = "cfg-terminal", "cfg-password", "900002"
	fakeTBank := fakeTBankServer(t, terminalKey, password, paymentID)
	defer fakeTBank.Close()

	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)
	studentClient := httpclient.New(t)
	studentCSRF, studentID := loginAsRole(t, studentClient, testApp, "cfg-student", "student")
	_ = studentCSRF

	courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Cfg Course", twoModuleCourse())
	offerID := createPlatformOffer(t, adminClient, testApp, adminCSRF, 9900)
	if resp := setOfferStatus(t, adminClient, testApp, adminCSRF, offerID, "active", 9900); resp.StatusCode != http.StatusOK {
		t.Fatalf("activate platform offer status: %d", resp.StatusCode)
	}

	// free_lesson_count defaults to 0 → free tier OFF → even lesson 1 is locked when the offer is active.
	tree := fetchStudentTree(t, studentClient, testApp, courseID)
	if got := lessonAccessState(tree, "l1"); got != "locked_paid" {
		t.Fatalf("free_count=0 l1 expected locked_paid, got %s", got)
	}

	// free_lesson_count=3 → first module free, l4 locked.
	setFreeLessonCount(t, adminClient, testApp, adminCSRF, courseID, 3)
	tree = fetchStudentTree(t, studentClient, testApp, courseID)
	if got := lessonAccessState(tree, "l1"); got != "free" {
		t.Fatalf("free_count=3 l1 expected free, got %s", got)
	}
	if got := lessonAccessState(tree, "l4"); got != "locked_paid" {
		t.Fatalf("free_count=3 l4 expected locked_paid, got %s", got)
	}

	// free_lesson_count >= total → entire course free.
	setFreeLessonCount(t, adminClient, testApp, adminCSRF, courseID, 99)
	tree = fetchStudentTree(t, studentClient, testApp, courseID)
	if got := lessonAccessState(tree, "l4"); got != "free" {
		t.Fatalf("free_count=99 l4 expected free, got %s", got)
	}
	// Negative count is rejected.
	if resp := performJSON(t, adminClient, http.MethodPut, testApp.Server.URL+"/api/v1/admin/commerce/courses/"+courseID+"/free-access", map[string]any{"free_lesson_count": -1}, adminCSRF); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("negative free_count expected 400, got %d", resp.StatusCode)
	}
	setFreeLessonCount(t, adminClient, testApp, adminCSRF, courseID, 3)

	// Student cannot self-checkout a legacy per-lesson offer.
	lessonOfferResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/offers", map[string]any{
		"target_type": "lesson", "target_course_id": courseID, "target_lesson_id": "l4",
		"title": "Legacy lesson", "description": "x", "price_amount_minor": 5000, "price_currency": "RUB",
	}, adminCSRF)
	defer lessonOfferResp.Body.Close()
	var lessonOffer struct {
		OfferID string `json:"offer_id"`
	}
	_ = json.NewDecoder(lessonOfferResp.Body).Decode(&lessonOffer)
	if resp := setOfferStatus(t, adminClient, testApp, adminCSRF, lessonOffer.OfferID, "active", 5000); resp.StatusCode != http.StatusOK {
		t.Fatalf("activate lesson offer status: %d", resp.StatusCode)
	}
	if resp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/offers/"+lessonOffer.OfferID+"/checkout", map[string]any{}, studentCSRF); resp.StatusCode != http.StatusConflict {
		t.Fatalf("student checkout of lesson offer expected 409, got %d", resp.StatusCode)
	}

	// Only one active platform offer allowed.
	secondOffer := createPlatformOffer(t, adminClient, testApp, adminCSRF, 14900)
	if resp := setOfferStatus(t, adminClient, testApp, adminCSRF, secondOffer, "active", 14900); resp.StatusCode != http.StatusConflict {
		t.Fatalf("activating 2nd platform offer expected 409 active_offer_conflict, got %d", resp.StatusCode)
	}

	// Double-charge guard via complimentary platform grant: a granted student cannot checkout.
	grantResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/entitlements/grants", map[string]any{
		"student_id": studentID, "target_type": "platform",
	}, adminCSRF)
	defer grantResp.Body.Close()
	if grantResp.StatusCode != http.StatusCreated && grantResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(grantResp.Body)
		t.Fatalf("platform complimentary grant status: %d (%s)", grantResp.StatusCode, string(body))
	}
	if resp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/offers/"+offerID+"/checkout", map[string]any{}, studentCSRF); resp.StatusCode != http.StatusConflict {
		t.Fatalf("checkout with active platform entitlement expected 409, got %d", resp.StatusCode)
	}
	// And the granted student sees the paid lesson as granted.
	tree = fetchStudentTree(t, studentClient, testApp, courseID)
	if got := lessonAccessState(tree, "l4"); got != "granted" {
		t.Fatalf("granted student l4 expected granted, got %s", got)
	}
}

// TestFreeAccess_StudentCheckoutRequiresEmailForReceipt covers the prod bug: with T-Bank
// fiscalization on (receipt required) and a student that has no email, self-checkout must ask for
// an email (422 email_required) instead of letting T-Bank reject the Init; once supplied, the
// receipt is built and the email is persisted to the account.
func TestFreeAccess_StudentCheckoutRequiresEmailForReceipt(t *testing.T) {
	const terminalKey, password, paymentID = "rcpt-terminal", "rcpt-password", "900003"
	fakeTBank := fakeTBankServer(t, terminalKey, password, paymentID)
	defer fakeTBank.Close()
	t.Setenv("PRAVO_TBANK_RECEIPT_ENABLED", "true")
	t.Setenv("PRAVO_TBANK_RECEIPT_TAXATION", "osn")

	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)
	studentClient := httpclient.New(t)
	studentCSRF, studentID := loginAsRole(t, studentClient, testApp, "rcpt-student", "student")

	// Simulate a student that logged in without granting the email scope.
	if _, err := testApp.DB.Pool().Exec(context.Background(), `update external_identities set email='' where account_id=$1`, studentID); err != nil {
		t.Fatalf("clear student email: %v", err)
	}

	courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Receipt Course", twoModuleCourse())
	setFreeLessonCount(t, adminClient, testApp, adminCSRF, courseID, 2)
	offerID := createPlatformOffer(t, adminClient, testApp, adminCSRF, 9900)
	if resp := setOfferStatus(t, adminClient, testApp, adminCSRF, offerID, "active", 9900); resp.StatusCode != http.StatusOK {
		t.Fatalf("activate platform offer: %d", resp.StatusCode)
	}

	// No email → blocked with email_required (T-Bank not called).
	noEmail := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/offers/"+offerID+"/checkout", map[string]any{}, studentCSRF)
	defer noEmail.Body.Close()
	if noEmail.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("checkout without email expected 422, got %d", noEmail.StatusCode)
	}

	// Invalid email → 400.
	badEmail := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/offers/"+offerID+"/checkout", map[string]any{"email": "nope"}, studentCSRF)
	defer badEmail.Body.Close()
	if badEmail.StatusCode != http.StatusBadRequest {
		t.Fatalf("checkout with invalid email expected 400, got %d", badEmail.StatusCode)
	}

	// Valid email → checkout proceeds, receipt carries the email, and the email is persisted.
	withEmail := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/offers/"+offerID+"/checkout", map[string]any{"email": "kid@example.com"}, studentCSRF)
	defer withEmail.Body.Close()
	if withEmail.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(withEmail.Body)
		t.Fatalf("checkout with email expected 201, got %d (%s)", withEmail.StatusCode, string(body))
	}
	var initReq string
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select init_request_json::text from tbank_payment_sessions tps join commercial_orders o on o.id=tps.order_id where o.student_id=$1 order by tps.created_at desc limit 1`, studentID).Scan(&initReq); err != nil {
		t.Fatalf("query init request: %v", err)
	}
	if !strings.Contains(initReq, "kid@example.com") {
		t.Fatalf("init request should contain receipt email, got: %s", initReq)
	}
	var stored string
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select coalesce(email,'') from external_identities where account_id=$1`, studentID).Scan(&stored); err != nil {
		t.Fatalf("query stored email: %v", err)
	}
	if stored != "kid@example.com" {
		t.Fatalf("expected persisted email kid@example.com, got %q", stored)
	}
}
