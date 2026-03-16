package tests

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"pravoprost/backend/internal/testkit/app"
	httpclient "pravoprost/backend/internal/testkit/http"
)

func TestAssets_InvalidUploadAndProfileOwnership(t *testing.T) {
	testApp := app.New(t)
	ownerClient := httpclient.New(t)
	ownerCSRF, _ := loginAsRole(t, ownerClient, testApp, "student-assets-owner", "student")
	otherClient := httpclient.New(t)
	otherCSRF, _ := loginAsRole(t, otherClient, testApp, "student-assets-other", "student")

	invalidMimeResp := performJSON(t, ownerClient, http.MethodPost, testApp.Server.URL+"/api/v1/assets/upload-requests", map[string]any{
		"file_name":  "avatar.pdf",
		"mime_type":  "application/pdf",
		"size_bytes": 1024,
	}, ownerCSRF)
	if invalidMimeResp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("invalid mime upload status: %d", invalidMimeResp.StatusCode)
	}

	oversizeResp := performJSON(t, ownerClient, http.MethodPost, testApp.Server.URL+"/api/v1/assets/upload-requests", map[string]any{
		"file_name":  "avatar.png",
		"mime_type":  "image/png",
		"size_bytes": 11 * 1024 * 1024,
	}, ownerCSRF)
	if oversizeResp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("oversize upload status: %d", oversizeResp.StatusCode)
	}

	validUploadResp := performJSON(t, ownerClient, http.MethodPost, testApp.Server.URL+"/api/v1/assets/upload-requests", map[string]any{
		"file_name":  "avatar.png",
		"mime_type":  "image/png",
		"size_bytes": 2048,
	}, ownerCSRF)
	if validUploadResp.StatusCode != http.StatusCreated {
		t.Fatalf("valid upload status: %d", validUploadResp.StatusCode)
	}
	defer validUploadResp.Body.Close()
	var upload struct {
		AssetID string `json:"asset_id"`
	}
	if err := json.NewDecoder(validUploadResp.Body).Decode(&upload); err != nil {
		t.Fatalf("decode valid upload: %v", err)
	}

	unownedAvatarResp := performJSON(t, otherClient, http.MethodPut, testApp.Server.URL+"/api/v1/student/profile", map[string]any{
		"display_name":    "Other",
		"avatar_asset_id": upload.AssetID,
	}, otherCSRF)
	if unownedAvatarResp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("unowned avatar attach status: %d", unownedAvatarResp.StatusCode)
	}

	nonexistentAvatarResp := performJSON(t, otherClient, http.MethodPut, testApp.Server.URL+"/api/v1/student/profile", map[string]any{
		"display_name":    "Other",
		"avatar_asset_id": "11111111-1111-1111-1111-111111111111",
	}, otherCSRF)
	if nonexistentAvatarResp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("nonexistent avatar attach status: %d", nonexistentAvatarResp.StatusCode)
	}
}

func TestACL_SecurityAndAdminOrderQueryContracts(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)
	studentClient := httpclient.New(t)
	studentCSRF, studentID := loginAsRole(t, studentClient, testApp, "student-acl", "student")
	parentClient := httpclient.New(t)
	_, _ = loginAsRole(t, parentClient, testApp, "parent-acl", "parent")
	teacherClient := httpclient.New(t)
	teacherCSRF, _ := loginAsRole(t, teacherClient, testApp, "teacher-acl", "teacher")

	for _, tc := range []struct {
		name   string
		client *http.Client
		method string
		url    string
		body   string
		csrf   string
		status int
	}{
		{name: "student_cannot_parent", client: studentClient, method: http.MethodGet, url: testApp.Server.URL + "/api/v1/parent/children", status: http.StatusForbidden},
		{name: "student_cannot_teacher", client: studentClient, method: http.MethodGet, url: testApp.Server.URL + "/api/v1/teacher/profile", status: http.StatusForbidden},
		{name: "student_cannot_admin", client: studentClient, method: http.MethodGet, url: testApp.Server.URL + "/api/v1/admin/users", status: http.StatusForbidden},
		{name: "parent_cannot_student", client: parentClient, method: http.MethodGet, url: testApp.Server.URL + "/api/v1/student/catalog", status: http.StatusForbidden},
		{name: "teacher_cannot_moderate", client: teacherClient, method: http.MethodGet, url: testApp.Server.URL + "/api/v1/admin/moderation/queue", status: http.StatusForbidden},
		{name: "teacher_cannot_create_offer", client: teacherClient, method: http.MethodPost, url: testApp.Server.URL + "/api/v1/admin/commerce/offers", body: `{"target_type":"course"}`, csrf: teacherCSRF, status: http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var req *http.Request
			var err error
			if tc.body == "" {
				req, err = http.NewRequest(tc.method, tc.url, nil)
			} else {
				req, err = http.NewRequest(tc.method, tc.url, strings.NewReader(tc.body))
				req.Header.Set("Content-Type", "application/json")
			}
			if err != nil {
				t.Fatalf("build request: %v", err)
			}
			if tc.csrf != "" {
				req.Header.Set("X-CSRF-Token", tc.csrf)
			}
			resp, err := tc.client.Do(req)
			if err != nil {
				t.Fatalf("do request: %v", err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != tc.status {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tc.status)
			}
		})
	}

	noCookieResp, err := http.Get(testApp.Server.URL + "/api/v1/student/catalog")
	if err != nil {
		t.Fatalf("no cookie catalog request: %v", err)
	}
	defer noCookieResp.Body.Close()
	if noCookieResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no cookie status: %d", noCookieResp.StatusCode)
	}

	missingCSRFPayload := strings.NewReader(`{"file_name":"avatar.png","mime_type":"image/png","size_bytes":1024}`)
	missingCSRFReq, err := http.NewRequest(http.MethodPost, testApp.Server.URL+"/api/v1/assets/upload-requests", missingCSRFPayload)
	if err != nil {
		t.Fatalf("build missing csrf request: %v", err)
	}
	missingCSRFReq.Header.Set("Content-Type", "application/json")
	missingCSRFResp, err := studentClient.Do(missingCSRFReq)
	if err != nil {
		t.Fatalf("missing csrf request: %v", err)
	}
	defer missingCSRFResp.Body.Close()
	if missingCSRFResp.StatusCode != http.StatusForbidden {
		t.Fatalf("missing csrf status: %d", missingCSRFResp.StatusCode)
	}

	adminUsersResp, err := adminClient.Get(testApp.Server.URL + "/api/v1/admin/users")
	if err != nil {
		t.Fatalf("admin users query: %v", err)
	}
	defer adminUsersResp.Body.Close()
	if adminUsersResp.StatusCode != http.StatusOK {
		t.Fatalf("admin users query status: %d", adminUsersResp.StatusCode)
	}

	adminModerationResp, err := adminClient.Get(testApp.Server.URL + "/api/v1/admin/moderation/queue")
	if err != nil {
		t.Fatalf("admin moderation query: %v", err)
	}
	defer adminModerationResp.Body.Close()
	if adminModerationResp.StatusCode != http.StatusOK {
		t.Fatalf("admin moderation query status: %d", adminModerationResp.StatusCode)
	}

	courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Orders Query Course", map[string]any{
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
		"title":              "Paid lesson",
		"description":        "Paid lesson",
		"price_amount_minor": 19900,
		"price_currency":     "RUB",
	}, adminCSRF)
	if createOfferResp.StatusCode != http.StatusCreated {
		t.Fatalf("create offer for order query status: %d", createOfferResp.StatusCode)
	}
	defer createOfferResp.Body.Close()
	var offer struct {
		OfferID string `json:"offer_id"`
	}
	if err := json.NewDecoder(createOfferResp.Body).Decode(&offer); err != nil {
		t.Fatalf("decode offer for order query: %v", err)
	}
	activateOfferResp := performJSON(t, adminClient, http.MethodPut, testApp.Server.URL+"/api/v1/admin/commerce/offers/"+offer.OfferID, map[string]any{
		"title":              "Paid lesson",
		"description":        "Paid lesson",
		"price_amount_minor": 19900,
		"price_currency":     "RUB",
		"status":             "active",
	}, adminCSRF)
	if activateOfferResp.StatusCode != http.StatusOK {
		t.Fatalf("activate offer for order query status: %d", activateOfferResp.StatusCode)
	}

	purchaseResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/offers/"+offer.OfferID+"/purchase-requests", map[string]any{}, studentCSRF)
	if purchaseResp.StatusCode != http.StatusCreated {
		t.Fatalf("purchase request for order query status: %d", purchaseResp.StatusCode)
	}
	defer purchaseResp.Body.Close()
	var purchase struct {
		PurchaseRequestID string `json:"purchase_request_id"`
	}
	if err := json.NewDecoder(purchaseResp.Body).Decode(&purchase); err != nil {
		t.Fatalf("decode purchase request for order query: %v", err)
	}

	orderResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/orders/manual", map[string]any{
		"student_id":          studentID,
		"offer_id":            offer.OfferID,
		"purchase_request_id": purchase.PurchaseRequestID,
	}, adminCSRF)
	if orderResp.StatusCode != http.StatusCreated {
		t.Fatalf("manual order query status: %d", orderResp.StatusCode)
	}
	defer orderResp.Body.Close()
	var order struct {
		OrderID string `json:"order_id"`
		Status  string `json:"status"`
	}
	if err := json.NewDecoder(orderResp.Body).Decode(&order); err != nil {
		t.Fatalf("decode order query order: %v", err)
	}
	if order.Status != "awaiting_confirmation" {
		t.Fatalf("unexpected initial order status: %s", order.Status)
	}

	awaitingOrdersResp, err := adminClient.Get(testApp.Server.URL + "/api/v1/admin/commerce/orders?status=awaiting_confirmation&student_id=" + studentID)
	if err != nil {
		t.Fatalf("awaiting orders query: %v", err)
	}
	defer awaitingOrdersResp.Body.Close()
	if awaitingOrdersResp.StatusCode != http.StatusOK {
		t.Fatalf("awaiting orders query status: %d", awaitingOrdersResp.StatusCode)
	}
	var awaitingOrders struct {
		Items []struct {
			OrderID string `json:"order_id"`
			Status  string `json:"status"`
			Student struct {
				AccountID string `json:"account_id"`
			} `json:"student"`
		} `json:"items"`
	}
	if err := json.NewDecoder(awaitingOrdersResp.Body).Decode(&awaitingOrders); err != nil {
		t.Fatalf("decode awaiting orders: %v", err)
	}
	if len(awaitingOrders.Items) != 1 || awaitingOrders.Items[0].OrderID != order.OrderID || awaitingOrders.Items[0].Status != "awaiting_confirmation" || awaitingOrders.Items[0].Student.AccountID != studentID {
		t.Fatalf("unexpected awaiting orders payload: %+v", awaitingOrders.Items)
	}

	confirmResp := performJSONWithIdempotency(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/orders/"+order.OrderID+"/payments/manual-confirm", map[string]any{
		"external_reference": "order-query-ref",
		"amount_minor":       19900,
		"currency":           "RUB",
		"paid_at":            "2026-03-14T12:00:00Z",
	}, adminCSRF, "order-query-confirm")
	if confirmResp.StatusCode != http.StatusOK {
		t.Fatalf("confirm order query status: %d", confirmResp.StatusCode)
	}

	fulfilledOrdersResp, err := adminClient.Get(testApp.Server.URL + "/api/v1/admin/commerce/orders?status=fulfilled")
	if err != nil {
		t.Fatalf("fulfilled orders query: %v", err)
	}
	defer fulfilledOrdersResp.Body.Close()
	if fulfilledOrdersResp.StatusCode != http.StatusOK {
		t.Fatalf("fulfilled orders query status: %d", fulfilledOrdersResp.StatusCode)
	}
	var fulfilledOrders struct {
		Items []struct {
			OrderID string `json:"order_id"`
			Status  string `json:"status"`
		} `json:"items"`
	}
	if err := json.NewDecoder(fulfilledOrdersResp.Body).Decode(&fulfilledOrders); err != nil {
		t.Fatalf("decode fulfilled orders: %v", err)
	}
	foundOrder := false
	for _, item := range fulfilledOrders.Items {
		if item.OrderID == order.OrderID && item.Status == "fulfilled" {
			foundOrder = true
		}
	}
	if !foundOrder {
		t.Fatalf("fulfilled order missing from admin order list")
	}
}
