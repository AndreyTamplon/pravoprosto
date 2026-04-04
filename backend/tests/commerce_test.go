package tests

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"pravoprost/backend/internal/testkit/app"
	httpclient "pravoprost/backend/internal/testkit/http"
)

func TestCommerce_PaidLessonPurchaseOrderConfirmAndRevoke(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)
	studentClient := httpclient.New(t)
	studentCSRF, studentID := loginAsRole(t, studentClient, testApp, "student-commerce-paid", "student")

	courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Paid Lesson Course", map[string]any{
		"modules": []any{
			map[string]any{
				"id": "module_1",
				"lessons": []any{
					map[string]any{
						"id":    "lesson_1",
						"title": "Paid lesson",
						"graph": map[string]any{
							"startNodeId": "n0",
							"nodes": []any{
								map[string]any{"id": "n0", "kind": "story", "body": map[string]any{"text": "Start"}, "nextNodeId": "n1"},
								map[string]any{"id": "n1", "kind": "single_choice", "prompt": "Q", "options": []any{map[string]any{"id": "a1", "text": "A", "result": "correct", "feedback": "ok", "nextNodeId": "n2"}}},
								map[string]any{"id": "n2", "kind": "end"},
							},
						},
					},
				},
			},
		},
	})

	createOfferResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/offers", map[string]any{
		"target_type":        "lesson",
		"target_course_id":   courseID,
		"target_lesson_id":   "lesson_1",
		"title":              "Lesson 1 paid",
		"description":        "Premium",
		"price_amount_minor": 49000,
		"price_currency":     "RUB",
	}, adminCSRF)
	if createOfferResp.StatusCode != http.StatusCreated {
		t.Fatalf("create offer status: %d", createOfferResp.StatusCode)
	}
	defer createOfferResp.Body.Close()
	var createdOffer struct {
		OfferID string `json:"offer_id"`
	}
	if err := json.NewDecoder(createOfferResp.Body).Decode(&createdOffer); err != nil {
		t.Fatalf("decode created offer: %v", err)
	}

	activateOfferResp := performJSON(t, adminClient, http.MethodPut, testApp.Server.URL+"/api/v1/admin/commerce/offers/"+createdOffer.OfferID, map[string]any{
		"title":              "Lesson 1 paid",
		"description":        "Premium",
		"price_amount_minor": 49000,
		"price_currency":     "RUB",
		"status":             "active",
	}, adminCSRF)
	if activateOfferResp.StatusCode != http.StatusOK {
		t.Fatalf("activate offer status: %d", activateOfferResp.StatusCode)
	}

	tree := fetchStudentTree(t, studentClient, testApp, courseID)
	if tree.Modules[0].Lessons[0].Access.AccessState != "locked_paid" {
		t.Fatalf("expected locked_paid before purchase, got %s", tree.Modules[0].Lessons[0].Access.AccessState)
	}

	lockedStartResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/start", map[string]any{}, studentCSRF)
	if lockedStartResp.StatusCode != http.StatusConflict {
		t.Fatalf("locked paid start status: %d", lockedStartResp.StatusCode)
	}

	purchaseResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/offers/"+createdOffer.OfferID+"/purchase-requests", map[string]any{}, studentCSRF)
	if purchaseResp.StatusCode != http.StatusCreated {
		t.Fatalf("purchase request status: %d", purchaseResp.StatusCode)
	}
	defer purchaseResp.Body.Close()
	var purchase struct {
		PurchaseRequestID string `json:"purchase_request_id"`
	}
	if err := json.NewDecoder(purchaseResp.Body).Decode(&purchase); err != nil {
		t.Fatalf("decode purchase request: %v", err)
	}

	duplicatePurchaseResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/offers/"+createdOffer.OfferID+"/purchase-requests", map[string]any{}, studentCSRF)
	if duplicatePurchaseResp.StatusCode != http.StatusConflict {
		t.Fatalf("duplicate purchase request status: %d", duplicatePurchaseResp.StatusCode)
	}

	orderResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/orders/manual", map[string]any{
		"student_id":          studentID,
		"offer_id":            createdOffer.OfferID,
		"purchase_request_id": purchase.PurchaseRequestID,
	}, adminCSRF)
	if orderResp.StatusCode != http.StatusCreated {
		t.Fatalf("manual order status: %d", orderResp.StatusCode)
	}
	defer orderResp.Body.Close()
	var order struct {
		OrderID string `json:"order_id"`
	}
	if err := json.NewDecoder(orderResp.Body).Decode(&order); err != nil {
		t.Fatalf("decode manual order: %v", err)
	}

	tree = fetchStudentTree(t, studentClient, testApp, courseID)
	if tree.Modules[0].Lessons[0].Access.AccessState != "awaiting_payment_confirmation" {
		t.Fatalf("expected awaiting_payment_confirmation after order, got %s", tree.Modules[0].Lessons[0].Access.AccessState)
	}

	awaitingStartResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/start", map[string]any{}, studentCSRF)
	if awaitingStartResp.StatusCode != http.StatusConflict {
		t.Fatalf("awaiting payment start status: %d", awaitingStartResp.StatusCode)
	}

	missingIdemReq, err := http.NewRequest(http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/orders/"+order.OrderID+"/payments/manual-confirm", strings.NewReader(`{"external_reference":"cash-1","amount_minor":49000,"currency":"RUB","paid_at":"2026-03-14T10:15:00Z"}`))
	if err != nil {
		t.Fatalf("new confirm request: %v", err)
	}
	missingIdemReq.Header.Set("Content-Type", "application/json")
	missingIdemReq.Header.Set(testApp.Config.CSRFHeaderName, adminCSRF)
	missingIdemResp, err := adminClient.Do(missingIdemReq)
	if err != nil {
		t.Fatalf("manual confirm request: %v", err)
	}
	if missingIdemResp.StatusCode != http.StatusBadRequest {
		t.Fatalf("manual confirm without idempotency status: %d", missingIdemResp.StatusCode)
	}

	mismatchResp := performJSONWithIdempotency(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/orders/"+order.OrderID+"/payments/manual-confirm", map[string]any{
		"external_reference": "cash-2026-03-14-001",
		"amount_minor":       50000,
		"currency":           "RUB",
		"paid_at":            "2026-03-14T10:15:00Z",
	}, adminCSRF, "pay-1")
	if mismatchResp.StatusCode != http.StatusConflict {
		t.Fatalf("mismatch confirm status: %d", mismatchResp.StatusCode)
	}

	confirmResp := performJSONWithIdempotency(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/orders/"+order.OrderID+"/payments/manual-confirm", map[string]any{
		"external_reference": "cash-2026-03-14-001",
		"amount_minor":       49000,
		"currency":           "RUB",
		"paid_at":            "2026-03-14T10:15:00Z",
	}, adminCSRF, "pay-2")
	if confirmResp.StatusCode != http.StatusOK {
		t.Fatalf("valid confirm status: %d", confirmResp.StatusCode)
	}
	defer confirmResp.Body.Close()
	var confirmed struct {
		PaymentRecordID string `json:"payment_record_id"`
		Entitlement     struct {
			EntitlementID string `json:"entitlement_id"`
		} `json:"entitlement"`
	}
	if err := json.NewDecoder(confirmResp.Body).Decode(&confirmed); err != nil {
		t.Fatalf("decode confirm response: %v", err)
	}

	duplicateConfirmResp := performJSONWithIdempotency(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/orders/"+order.OrderID+"/payments/manual-confirm", map[string]any{
		"external_reference": "cash-2026-03-14-001",
		"amount_minor":       49000,
		"currency":           "RUB",
		"paid_at":            "2026-03-14T10:15:00Z",
	}, adminCSRF, "pay-2")
	if duplicateConfirmResp.StatusCode != http.StatusOK {
		t.Fatalf("duplicate confirm status: %d", duplicateConfirmResp.StatusCode)
	}

	tree = fetchStudentTree(t, studentClient, testApp, courseID)
	if tree.Modules[0].Lessons[0].Access.AccessState != "granted" {
		t.Fatalf("expected granted after confirm, got %s", tree.Modules[0].Lessons[0].Access.AccessState)
	}

	startResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/start", map[string]any{}, studentCSRF)
	if startResp.StatusCode != http.StatusOK {
		t.Fatalf("start after confirm status: %d", startResp.StatusCode)
	}
	defer startResp.Body.Close()
	var started struct {
		SessionID    string `json:"session_id"`
		StateVersion int64  `json:"state_version"`
		NodeID       string `json:"node_id"`
	}
	if err := json.NewDecoder(startResp.Body).Decode(&started); err != nil {
		t.Fatalf("decode started paid session: %v", err)
	}

	revokeResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/entitlements/"+confirmed.Entitlement.EntitlementID+"/revoke", map[string]any{
		"reason": "revoke",
	}, adminCSRF)
	if revokeResp.StatusCode != http.StatusOK {
		t.Fatalf("revoke entitlement status: %d", revokeResp.StatusCode)
	}

	tree = fetchStudentTree(t, studentClient, testApp, courseID)
	if tree.Modules[0].Lessons[0].Access.AccessState != "locked_paid" {
		t.Fatalf("expected locked_paid after revoke, got %s", tree.Modules[0].Lessons[0].Access.AccessState)
	}

	sessionResp, err := studentClient.Get(testApp.Server.URL + "/api/v1/student/lesson-sessions/" + started.SessionID)
	if err != nil {
		t.Fatalf("session after revoke: %v", err)
	}
	if sessionResp.StatusCode != http.StatusConflict {
		t.Fatalf("session after revoke status: %d", sessionResp.StatusCode)
	}

	nextAfterRevokeResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+started.SessionID+"/next", map[string]any{
		"state_version":    started.StateVersion,
		"expected_node_id": started.NodeID,
	}, studentCSRF)
	if nextAfterRevokeResp.StatusCode != http.StatusConflict {
		t.Fatalf("session next after revoke status: %d", nextAfterRevokeResp.StatusCode)
	}

	answerAfterRevokeResp := performJSONWithIdempotency(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+started.SessionID+"/answer", map[string]any{
		"state_version": started.StateVersion,
		"node_id":       started.NodeID,
		"answer":        map[string]any{"kind": "single_choice", "option_id": "a1"},
	}, studentCSRF, "answer-after-revoke")
	if answerAfterRevokeResp.StatusCode != http.StatusConflict {
		t.Fatalf("session answer after revoke status: %d", answerAfterRevokeResp.StatusCode)
	}

	var sessionStatus, terminationReason string
	if err := testApp.DB.Pool().QueryRow(context.Background(), `
		select status, termination_reason
		from lesson_sessions
		where id = $1
	`, started.SessionID).Scan(&sessionStatus, &terminationReason); err != nil {
		t.Fatalf("query terminated session: %v", err)
	}
	if sessionStatus != "terminated" || terminationReason != "entitlement_revoked" {
		t.Fatalf("unexpected terminated session state: %s %s", sessionStatus, terminationReason)
	}

	var paymentCount, fulfillmentCount, entitlementCount int
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from payment_records where order_id = $1`, order.OrderID).Scan(&paymentCount); err != nil {
		t.Fatalf("count payment records: %v", err)
	}
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from entitlement_fulfillment_log where order_id = $1`, order.OrderID).Scan(&fulfillmentCount); err != nil {
		t.Fatalf("count fulfillment logs: %v", err)
	}
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from entitlements where student_id = $1 and target_course_id = $2 and target_lesson_id = 'lesson_1'`, studentID, courseID).Scan(&entitlementCount); err != nil {
		t.Fatalf("count entitlements: %v", err)
	}
	if paymentCount != 1 || fulfillmentCount != 1 || entitlementCount != 1 {
		t.Fatalf("unexpected payment/fulfillment/entitlement counts: %d %d %d", paymentCount, fulfillmentCount, entitlementCount)
	}
}

func TestCommerce_OrderCanBeConfirmedAfterOfferArchived(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)
	studentClient := httpclient.New(t)
	studentCSRF, studentID := loginAsRole(t, studentClient, testApp, "student-commerce-archive-confirm", "student")

	courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Archive Confirm Course", map[string]any{
		"modules": []any{
			map[string]any{
				"id": "module_1",
				"lessons": []any{
					map[string]any{
						"id":    "lesson_1",
						"title": "Lesson",
						"graph": map[string]any{
							"startNodeId": "n1",
							"nodes":       []any{map[string]any{"id": "n1", "kind": "end", "text": "Done"}},
						},
					},
				},
			},
		},
	})

	createOfferResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/offers", map[string]any{
		"target_type":        "lesson",
		"target_course_id":   courseID,
		"target_lesson_id":   "lesson_1",
		"title":              "Archive Confirm Offer",
		"description":        "Premium",
		"price_amount_minor": 49000,
		"price_currency":     "RUB",
	}, adminCSRF)
	if createOfferResp.StatusCode != http.StatusCreated {
		t.Fatalf("create archive-confirm offer status: %d", createOfferResp.StatusCode)
	}
	defer createOfferResp.Body.Close()
	var createdOffer struct {
		OfferID string `json:"offer_id"`
	}
	if err := json.NewDecoder(createOfferResp.Body).Decode(&createdOffer); err != nil {
		t.Fatalf("decode archive-confirm offer: %v", err)
	}

	for _, status := range []string{"active"} {
		resp := performJSON(t, adminClient, http.MethodPut, testApp.Server.URL+"/api/v1/admin/commerce/offers/"+createdOffer.OfferID, map[string]any{
			"title":              "Archive Confirm Offer",
			"description":        "Premium",
			"price_amount_minor": 49000,
			"price_currency":     "RUB",
			"status":             status,
		}, adminCSRF)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("set offer %s status: %d", status, resp.StatusCode)
		}
	}

	purchaseResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/offers/"+createdOffer.OfferID+"/purchase-requests", map[string]any{}, studentCSRF)
	if purchaseResp.StatusCode != http.StatusCreated {
		t.Fatalf("purchase request archive-confirm status: %d", purchaseResp.StatusCode)
	}
	defer purchaseResp.Body.Close()
	var purchase struct {
		PurchaseRequestID string `json:"purchase_request_id"`
	}
	if err := json.NewDecoder(purchaseResp.Body).Decode(&purchase); err != nil {
		t.Fatalf("decode archive-confirm purchase: %v", err)
	}

	orderResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/orders/manual", map[string]any{
		"student_id":          studentID,
		"offer_id":            createdOffer.OfferID,
		"purchase_request_id": purchase.PurchaseRequestID,
	}, adminCSRF)
	if orderResp.StatusCode != http.StatusCreated {
		t.Fatalf("manual order archive-confirm status: %d", orderResp.StatusCode)
	}
	defer orderResp.Body.Close()
	var order struct {
		OrderID string `json:"order_id"`
	}
	if err := json.NewDecoder(orderResp.Body).Decode(&order); err != nil {
		t.Fatalf("decode archive-confirm order: %v", err)
	}

	archiveResp := performJSON(t, adminClient, http.MethodPut, testApp.Server.URL+"/api/v1/admin/commerce/offers/"+createdOffer.OfferID, map[string]any{
		"title":              "Archive Confirm Offer",
		"description":        "Premium",
		"price_amount_minor": 49000,
		"price_currency":     "RUB",
		"status":             "archived",
	}, adminCSRF)
	if archiveResp.StatusCode != http.StatusOK {
		t.Fatalf("archive offer before confirm status: %d", archiveResp.StatusCode)
	}

	confirmResp := performJSONWithIdempotency(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/orders/"+order.OrderID+"/payments/manual-confirm", map[string]any{
		"external_reference": "archive-confirm-1",
		"amount_minor":       49000,
		"currency":           "RUB",
		"paid_at":            "2026-03-15T12:00:00Z",
	}, adminCSRF, "archive-confirm")
	if confirmResp.StatusCode != http.StatusOK {
		t.Fatalf("manual confirm after archive status: %d", confirmResp.StatusCode)
	}
}

func TestCommerce_OfferValidationAndComplimentaryGrant(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)
	teacherClient := httpclient.New(t)
	teacherCSRF, _ := loginAsRole(t, teacherClient, testApp, "teacher-commerce-offer", "teacher")
	studentClient := httpclient.New(t)
	studentCSRF, studentID := loginAsRole(t, studentClient, testApp, "student-commerce-comp", "student")

	profileResp := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/profile", map[string]any{
		"display_name":      "Teacher",
		"organization_name": "Org",
		"avatar_asset_id":   nil,
	}, teacherCSRF)
	if profileResp.StatusCode != http.StatusOK {
		t.Fatalf("teacher profile status: %d", profileResp.StatusCode)
	}
	createTeacherCourseResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses", map[string]any{
		"title":       "Teacher paid?",
		"description": "No",
	}, teacherCSRF)
	if createTeacherCourseResp.StatusCode != http.StatusCreated {
		t.Fatalf("teacher create status: %d", createTeacherCourseResp.StatusCode)
	}
	defer createTeacherCourseResp.Body.Close()
	var teacherCourse struct {
		CourseID string `json:"course_id"`
	}
	if err := json.NewDecoder(createTeacherCourseResp.Body).Decode(&teacherCourse); err != nil {
		t.Fatalf("decode teacher course: %v", err)
	}

	teacherOfferResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/offers", map[string]any{
		"target_type":        "course",
		"target_course_id":   teacherCourse.CourseID,
		"title":              "Teacher paid",
		"description":        "No",
		"price_amount_minor": 1000,
		"price_currency":     "RUB",
	}, adminCSRF)
	if teacherOfferResp.StatusCode != http.StatusConflict {
		t.Fatalf("teacher content offer status: %d", teacherOfferResp.StatusCode)
	}

	if _, err := testApp.DB.Pool().Exec(context.Background(), `
		insert into commercial_offers(owner_kind, target_type, target_course_id, title, description, price_amount_minor, price_currency, status, created_by_account_id)
		values ('platform', 'course', $1, 'bad', 'bad', 1000, 'RUB', 'draft', '00000000-0000-0000-0000-000000000999')
	`, teacherCourse.CourseID); err == nil {
		t.Fatalf("expected db trigger to reject teacher-owned monetization")
	}

	platformCourseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Complimentary Course", map[string]any{
		"modules": []any{
			map[string]any{
				"id": "module_1",
				"lessons": []any{
					map[string]any{
						"id":    "lesson_1",
						"title": "Premium lesson",
						"graph": map[string]any{
							"startNodeId": "n1",
							"nodes": []any{
								map[string]any{"id": "n1", "kind": "single_choice", "prompt": "Q", "options": []any{map[string]any{"id": "a1", "text": "A", "result": "correct", "feedback": "ok", "nextNodeId": "n2"}}},
								map[string]any{"id": "n2", "kind": "end"},
							},
						},
					},
				},
			},
		},
	})

	invalidOfferResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/offers", map[string]any{
		"target_type":        "lesson",
		"target_course_id":   platformCourseID,
		"target_lesson_id":   "missing",
		"title":              "Missing lesson",
		"description":        "No",
		"price_amount_minor": 1000,
		"price_currency":     "RUB",
	}, adminCSRF)
	if invalidOfferResp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("invalid offer target status: %d", invalidOfferResp.StatusCode)
	}

	createOfferResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/offers", map[string]any{
		"target_type":        "lesson",
		"target_course_id":   platformCourseID,
		"target_lesson_id":   "lesson_1",
		"title":              "Premium lesson",
		"description":        "Premium",
		"price_amount_minor": 1000,
		"price_currency":     "RUB",
	}, adminCSRF)
	if createOfferResp.StatusCode != http.StatusCreated {
		t.Fatalf("create platform offer status: %d", createOfferResp.StatusCode)
	}
	defer createOfferResp.Body.Close()
	var offer struct {
		OfferID string `json:"offer_id"`
	}
	if err := json.NewDecoder(createOfferResp.Body).Decode(&offer); err != nil {
		t.Fatalf("decode platform offer: %v", err)
	}

	activateOfferResp := performJSON(t, adminClient, http.MethodPut, testApp.Server.URL+"/api/v1/admin/commerce/offers/"+offer.OfferID, map[string]any{
		"title":              "Premium lesson",
		"description":        "Premium",
		"price_amount_minor": 1000,
		"price_currency":     "RUB",
		"status":             "active",
	}, adminCSRF)
	if activateOfferResp.StatusCode != http.StatusOK {
		t.Fatalf("activate platform offer status: %d", activateOfferResp.StatusCode)
	}

	purchaseResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/offers/"+offer.OfferID+"/purchase-requests", map[string]any{}, studentCSRF)
	if purchaseResp.StatusCode != http.StatusCreated {
		t.Fatalf("purchase request for complimentary scenario status: %d", purchaseResp.StatusCode)
	}
	defer purchaseResp.Body.Close()
	var purchase struct {
		PurchaseRequestID string `json:"purchase_request_id"`
	}
	if err := json.NewDecoder(purchaseResp.Body).Decode(&purchase); err != nil {
		t.Fatalf("decode purchase request for complimentary scenario: %v", err)
	}

	orderResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/orders/manual", map[string]any{
		"student_id":          studentID,
		"offer_id":            offer.OfferID,
		"purchase_request_id": purchase.PurchaseRequestID,
	}, adminCSRF)
	if orderResp.StatusCode != http.StatusCreated {
		t.Fatalf("manual order for complimentary scenario status: %d", orderResp.StatusCode)
	}

	grantResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/entitlements/grants", map[string]any{
		"student_id":       studentID,
		"target_type":      "lesson",
		"target_course_id": platformCourseID,
		"target_lesson_id": "lesson_1",
	}, adminCSRF)
	if grantResp.StatusCode != http.StatusCreated {
		t.Fatalf("complimentary grant status: %d", grantResp.StatusCode)
	}

	tree := fetchStudentTree(t, studentClient, testApp, platformCourseID)
	if tree.Modules[0].Lessons[0].Access.AccessState != "granted" {
		t.Fatalf("expected granted after complimentary grant, got %s", tree.Modules[0].Lessons[0].Access.AccessState)
	}

	startResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+platformCourseID+"/lessons/lesson_1/start", map[string]any{}, studentCSRF)
	if startResp.StatusCode != http.StatusOK {
		t.Fatalf("start after complimentary grant status: %d", startResp.StatusCode)
	}

	var orderStatus string
	var requestStatus string
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select status from commercial_orders where student_id = $1 and target_course_id = $2 and target_lesson_id = 'lesson_1'`, studentID, platformCourseID).Scan(&orderStatus); err != nil {
		t.Fatalf("query canceled order: %v", err)
	}
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select status from purchase_requests where id = $1`, purchase.PurchaseRequestID).Scan(&requestStatus); err != nil {
		t.Fatalf("query processed request: %v", err)
	}
	if orderStatus != "canceled" || requestStatus != "processed" {
		t.Fatalf("unexpected order/request status after complimentary grant: %s %s", orderStatus, requestStatus)
	}

	duplicateGrantResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/entitlements/grants", map[string]any{
		"student_id":       studentID,
		"target_type":      "lesson",
		"target_course_id": platformCourseID,
		"target_lesson_id": "lesson_1",
	}, adminCSRF)
	if duplicateGrantResp.StatusCode != http.StatusConflict {
		t.Fatalf("duplicate complimentary grant status: %d", duplicateGrantResp.StatusCode)
	}
}

func TestCommerce_ManualConfirmStillWorksAfterOfferArchived(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)
	studentClient := httpclient.New(t)
	studentCSRF, studentID := loginAsRole(t, studentClient, testApp, "student-commerce-archived-confirm", "student")

	courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Archived Confirm Course", map[string]any{
		"modules": []any{
			map[string]any{
				"id": "module_1",
				"lessons": []any{
					map[string]any{
						"id":    "lesson_1",
						"title": "Premium",
						"graph": map[string]any{
							"startNodeId": "n1",
							"nodes":       []any{map[string]any{"id": "n1", "kind": "end", "text": "Done"}},
						},
					},
				},
			},
		},
	})

	createOfferResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/offers", map[string]any{
		"target_type":        "lesson",
		"target_course_id":   courseID,
		"target_lesson_id":   "lesson_1",
		"title":              "Archived Confirm Offer",
		"description":        "Premium",
		"price_amount_minor": 49000,
		"price_currency":     "RUB",
	}, adminCSRF)
	if createOfferResp.StatusCode != http.StatusCreated {
		t.Fatalf("create archived-confirm offer status: %d", createOfferResp.StatusCode)
	}
	defer createOfferResp.Body.Close()
	var offer struct {
		OfferID string `json:"offer_id"`
	}
	if err := json.NewDecoder(createOfferResp.Body).Decode(&offer); err != nil {
		t.Fatalf("decode archived-confirm offer: %v", err)
	}

	activateResp := performJSON(t, adminClient, http.MethodPut, testApp.Server.URL+"/api/v1/admin/commerce/offers/"+offer.OfferID, map[string]any{
		"title":              "Archived Confirm Offer",
		"description":        "Premium",
		"price_amount_minor": 49000,
		"price_currency":     "RUB",
		"status":             "active",
	}, adminCSRF)
	if activateResp.StatusCode != http.StatusOK {
		t.Fatalf("activate archived-confirm offer status: %d", activateResp.StatusCode)
	}

	purchaseResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/offers/"+offer.OfferID+"/purchase-requests", map[string]any{}, studentCSRF)
	if purchaseResp.StatusCode != http.StatusCreated {
		t.Fatalf("purchase archived-confirm status: %d", purchaseResp.StatusCode)
	}
	defer purchaseResp.Body.Close()
	var purchase struct {
		PurchaseRequestID string `json:"purchase_request_id"`
	}
	if err := json.NewDecoder(purchaseResp.Body).Decode(&purchase); err != nil {
		t.Fatalf("decode archived-confirm purchase: %v", err)
	}

	orderResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/orders/manual", map[string]any{
		"student_id":          studentID,
		"offer_id":            offer.OfferID,
		"purchase_request_id": purchase.PurchaseRequestID,
	}, adminCSRF)
	if orderResp.StatusCode != http.StatusCreated {
		t.Fatalf("create archived-confirm order status: %d", orderResp.StatusCode)
	}
	defer orderResp.Body.Close()
	var order struct {
		OrderID string `json:"order_id"`
	}
	if err := json.NewDecoder(orderResp.Body).Decode(&order); err != nil {
		t.Fatalf("decode archived-confirm order: %v", err)
	}

	archiveResp := performJSON(t, adminClient, http.MethodPut, testApp.Server.URL+"/api/v1/admin/commerce/offers/"+offer.OfferID, map[string]any{
		"title":              "Archived Confirm Offer",
		"description":        "Premium",
		"price_amount_minor": 49000,
		"price_currency":     "RUB",
		"status":             "archived",
	}, adminCSRF)
	if archiveResp.StatusCode != http.StatusOK {
		t.Fatalf("archive archived-confirm offer status: %d", archiveResp.StatusCode)
	}

	confirmResp := performJSONWithIdempotency(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/orders/"+order.OrderID+"/payments/manual-confirm", map[string]any{
		"external_reference": "archive-confirm-1",
		"amount_minor":       49000,
		"currency":           "RUB",
		"paid_at":            "2026-03-15T14:30:00Z",
	}, adminCSRF, "archive-confirm")
	if confirmResp.StatusCode != http.StatusOK {
		t.Fatalf("manual confirm after archive status: %d", confirmResp.StatusCode)
	}

	var orderStatus, entitlementStatus string
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select status from commercial_orders where id = $1`, order.OrderID).Scan(&orderStatus); err != nil {
		t.Fatalf("query archived-confirm order: %v", err)
	}
	var paymentCount int
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from payment_records where order_id = $1`, order.OrderID).Scan(&paymentCount); err != nil {
		t.Fatalf("query archived-confirm payment count: %v", err)
	}
	if err := testApp.DB.Pool().QueryRow(context.Background(), `
		select status
		from entitlements
		where student_id = $1 and target_course_id = $2 and target_lesson_id = 'lesson_1'
	`, studentID, courseID).Scan(&entitlementStatus); err != nil {
		t.Fatalf("query archived-confirm entitlement: %v", err)
	}
	if orderStatus != "fulfilled" || paymentCount != 1 || entitlementStatus != "active" {
		t.Fatalf("unexpected archived-confirm final state order=%s payment_count=%d entitlement=%s", orderStatus, paymentCount, entitlementStatus)
	}
}

func TestCommerce_ParentCheckoutAndTBankNotificationConfirm(t *testing.T) {
	const (
		terminalKey = "test-terminal"
		password    = "test-password"
		paymentID   = "777001"
	)

	fakeTBank := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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

		if got := strings.TrimSpace(scalarToString(payload["TerminalKey"])); got != terminalKey {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if got := strings.TrimSpace(scalarToString(payload["PayType"])); got != "O" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		redirectDueDate := strings.TrimSpace(scalarToString(payload["RedirectDueDate"]))
		if redirectDueDate == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if _, err := time.Parse(time.RFC3339, redirectDueDate); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		data, ok := payload["DATA"].(map[string]any)
		if !ok {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if got := strings.TrimSpace(scalarToString(data["OperationInitiatorType"])); got != "0" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		expectedToken := signTBankTokenFromPayload(payload, password)
		if !strings.EqualFold(expectedToken, strings.TrimSpace(scalarToString(payload["Token"]))) {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		orderID := strings.TrimSpace(scalarToString(payload["OrderId"]))
		if orderID == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"Success":    true,
			"ErrorCode":  "0",
			"PaymentId":  paymentID,
			"OrderId":    orderID,
			"Status":     "NEW",
			"PaymentURL": "https://pay.test/checkout/" + orderID,
		})
	}))
	defer fakeTBank.Close()

	t.Setenv("PRAVO_TBANK_TERMINAL_KEY", terminalKey)
	t.Setenv("PRAVO_TBANK_PASSWORD", password)
	t.Setenv("PRAVO_TBANK_API_BASE_URL", fakeTBank.URL)
	t.Setenv("PRAVO_TBANK_NOTIFICATION_PATH", "/api/payment/webhook")
	t.Setenv("PRAVO_TBANK_SUCCESS_URL", "https://smartgoschool.ru/success")
	t.Setenv("PRAVO_TBANK_FAIL_URL", "https://smartgoschool.ru/fail")
	t.Setenv("PRAVO_TBANK_PENDING_TTL_MINUTES", "60")

	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)
	parentClient := httpclient.New(t)
	parentCSRF, _ := loginAsRole(t, parentClient, testApp, "parent-commerce-online", "parent")
	studentClient := httpclient.New(t)
	studentCSRF, studentID := loginAsRole(t, studentClient, testApp, "student-commerce-online", "student")

	guardianToken := createGuardianInvite(t, parentClient, testApp, parentCSRF)
	claimResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/guardian-links/claim", map[string]string{"token": guardianToken}, studentCSRF)
	defer claimResp.Body.Close()
	if claimResp.StatusCode != http.StatusOK {
		t.Fatalf("guardian claim status: %d", claimResp.StatusCode)
	}

	courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Parent Checkout Course", map[string]any{
		"modules": []any{
			map[string]any{
				"id": "module_1",
				"lessons": []any{
					map[string]any{
						"id":    "lesson_1",
						"title": "Paid lesson",
						"graph": map[string]any{
							"startNodeId": "n1",
							"nodes":       []any{map[string]any{"id": "n1", "kind": "end", "text": "Done"}},
						},
					},
				},
			},
		},
	})

	createOfferResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/offers", map[string]any{
		"target_type":        "lesson",
		"target_course_id":   courseID,
		"target_lesson_id":   "lesson_1",
		"title":              "Online parent offer",
		"description":        "Premium",
		"price_amount_minor": 12900,
		"price_currency":     "RUB",
	}, adminCSRF)
	if createOfferResp.StatusCode != http.StatusCreated {
		t.Fatalf("create online offer status: %d", createOfferResp.StatusCode)
	}
	defer createOfferResp.Body.Close()
	var createdOffer struct {
		OfferID string `json:"offer_id"`
	}
	if err := json.NewDecoder(createOfferResp.Body).Decode(&createdOffer); err != nil {
		t.Fatalf("decode online offer: %v", err)
	}

	activateOfferResp := performJSON(t, adminClient, http.MethodPut, testApp.Server.URL+"/api/v1/admin/commerce/offers/"+createdOffer.OfferID, map[string]any{
		"title":              "Online parent offer",
		"description":        "Premium",
		"price_amount_minor": 12900,
		"price_currency":     "RUB",
		"status":             "active",
	}, adminCSRF)
	if activateOfferResp.StatusCode != http.StatusOK {
		t.Fatalf("activate online offer status: %d", activateOfferResp.StatusCode)
	}

	offersResp, err := parentClient.Get(testApp.Server.URL + "/api/v1/parent/children/" + studentID + "/commerce/offers")
	if err != nil {
		t.Fatalf("list parent paid offers: %v", err)
	}
	if offersResp.StatusCode != http.StatusOK {
		t.Fatalf("list parent paid offers status: %d", offersResp.StatusCode)
	}
	defer offersResp.Body.Close()
	var offersView struct {
		Items []struct {
			OfferID     string `json:"offer_id"`
			AccessState string `json:"access_state"`
		} `json:"items"`
	}
	if err := json.NewDecoder(offersResp.Body).Decode(&offersView); err != nil {
		t.Fatalf("decode parent paid offers: %v", err)
	}
	if len(offersView.Items) == 0 || offersView.Items[0].OfferID != createdOffer.OfferID {
		t.Fatalf("unexpected paid offers list: %+v", offersView.Items)
	}
	if offersView.Items[0].AccessState != "locked_paid" {
		t.Fatalf("expected locked_paid before checkout, got %s", offersView.Items[0].AccessState)
	}

	checkoutResp := performJSON(t, parentClient, http.MethodPost, testApp.Server.URL+"/api/v1/parent/children/"+studentID+"/commerce/offers/"+createdOffer.OfferID+"/checkout", map[string]any{}, parentCSRF)
	if checkoutResp.StatusCode != http.StatusCreated {
		t.Fatalf("parent checkout status: %d", checkoutResp.StatusCode)
	}
	defer checkoutResp.Body.Close()
	var checkout struct {
		OrderID     string `json:"order_id"`
		AccessState string `json:"access_state"`
		PaymentURL  string `json:"payment_url"`
		PaymentID   string `json:"payment_id"`
	}
	if err := json.NewDecoder(checkoutResp.Body).Decode(&checkout); err != nil {
		t.Fatalf("decode checkout response: %v", err)
	}
	if checkout.OrderID == "" || checkout.PaymentURL == "" {
		t.Fatalf("unexpected checkout payload: %+v", checkout)
	}
	if checkout.AccessState != "awaiting_payment_confirmation" {
		t.Fatalf("unexpected checkout access_state: %s", checkout.AccessState)
	}

	tree := fetchStudentTree(t, studentClient, testApp, courseID)
	if tree.Modules[0].Lessons[0].Access.AccessState != "awaiting_payment_confirmation" {
		t.Fatalf("expected awaiting_payment_confirmation after checkout, got %s", tree.Modules[0].Lessons[0].Access.AccessState)
	}

	notification := map[string]any{
		"TerminalKey": terminalKey,
		"OrderId":     checkout.OrderID,
		"PaymentId":   paymentID,
		"Status":      "CONFIRMED",
		"Success":     true,
		"Amount":      12900,
	}
	notification["Token"] = signTBankTokenFromPayload(notification, password)

	webhookResp := performJSON(t, parentClient, http.MethodPost, testApp.Server.URL+"/api/payment/webhook", notification, "")
	defer webhookResp.Body.Close()
	if webhookResp.StatusCode != http.StatusOK {
		t.Fatalf("tbank notification status: %d", webhookResp.StatusCode)
	}
	body, _ := io.ReadAll(webhookResp.Body)
	if strings.TrimSpace(string(body)) != "OK" {
		t.Fatalf("unexpected notification body: %s", strings.TrimSpace(string(body)))
	}

	duplicateWebhookResp := performJSON(t, parentClient, http.MethodPost, testApp.Server.URL+"/api/v1/billing/tbank/notifications", notification, "")
	defer duplicateWebhookResp.Body.Close()
	if duplicateWebhookResp.StatusCode != http.StatusOK {
		t.Fatalf("duplicate tbank notification status: %d", duplicateWebhookResp.StatusCode)
	}

	tree = fetchStudentTree(t, studentClient, testApp, courseID)
	if tree.Modules[0].Lessons[0].Access.AccessState != "granted" {
		t.Fatalf("expected granted after tbank confirm, got %s", tree.Modules[0].Lessons[0].Access.AccessState)
	}

	startResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/start", map[string]any{}, studentCSRF)
	defer startResp.Body.Close()
	if startResp.StatusCode != http.StatusOK {
		t.Fatalf("start after tbank confirm status: %d", startResp.StatusCode)
	}

	var orderStatus, sessionStatus string
	var paymentCount, entitlementCount int
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select status from commercial_orders where id = $1`, checkout.OrderID).Scan(&orderStatus); err != nil {
		t.Fatalf("query online order status: %v", err)
	}
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select status from tbank_payment_sessions where order_id = $1`, checkout.OrderID).Scan(&sessionStatus); err != nil {
		t.Fatalf("query tbank session status: %v", err)
	}
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from payment_records where order_id = $1`, checkout.OrderID).Scan(&paymentCount); err != nil {
		t.Fatalf("count online payment records: %v", err)
	}
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from entitlements where order_id = $1 and status = 'active'`, checkout.OrderID).Scan(&entitlementCount); err != nil {
		t.Fatalf("count online entitlements: %v", err)
	}
	if orderStatus != "fulfilled" || sessionStatus != "paid" || paymentCount != 1 || entitlementCount != 1 {
		t.Fatalf("unexpected final online billing state order=%s session=%s payments=%d entitlements=%d", orderStatus, sessionStatus, paymentCount, entitlementCount)
	}
}

func TestCommerce_TBankNotificationRejectsInvalidToken(t *testing.T) {
	const (
		terminalKey = "test-terminal-invalid"
		password    = "test-password-invalid"
	)

	t.Setenv("PRAVO_TBANK_TERMINAL_KEY", terminalKey)
	t.Setenv("PRAVO_TBANK_PASSWORD", password)
	t.Setenv("PRAVO_TBANK_API_BASE_URL", "https://securepay.tinkoff.ru")

	testApp := app.New(t)
	client := httpclient.New(t)

	resp := performJSON(t, client, http.MethodPost, testApp.Server.URL+"/api/v1/billing/tbank/notifications", map[string]any{
		"TerminalKey": terminalKey,
		"OrderId":     "11111111-1111-1111-1111-111111111111",
		"PaymentId":   "1",
		"Status":      "CONFIRMED",
		"Success":     true,
		"Amount":      100,
		"Token":       "bad-token",
	}, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("invalid tbank token notification status: %d", resp.StatusCode)
	}
}

func signTBankTokenFromPayload(payload map[string]any, password string) string {
	normalized := make(map[string]string, len(payload)+1)
	for key, value := range payload {
		if key == "Token" {
			continue
		}
		switch value.(type) {
		case map[string]any, []any:
			continue
		}
		normalized[key] = scalarToString(value)
	}
	normalized["Password"] = password

	keys := make([]string, 0, len(normalized))
	for key := range normalized {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	var b strings.Builder
	for _, key := range keys {
		b.WriteString(normalized[key])
	}
	sum := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(sum[:])
}

func scalarToString(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return v
	case bool:
		if v {
			return "true"
		}
		return "false"
	case json.Number:
		return v.String()
	case int:
		return strconv.Itoa(v)
	case int64:
		return strconv.FormatInt(v, 10)
	case int32:
		return strconv.FormatInt(int64(v), 10)
	case float64:
		return strconv.FormatInt(int64(v), 10)
	case float32:
		return strconv.FormatInt(int64(v), 10)
	default:
		return fmt.Sprint(v)
	}
}
