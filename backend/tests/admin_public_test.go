package tests

import (
	"encoding/json"
	"net/http"
	"testing"

	"pravoprost/backend/internal/testkit/app"
	httpclient "pravoprost/backend/internal/testkit/http"
)

func TestAdminUsersAndPublicPromoCourses(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)
	studentClient := httpclient.New(t)
	_, studentID := loginAsRole(t, studentClient, testApp, "student-admin-list", "student")

	courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Promo Course", map[string]any{
		"modules": []any{
			map[string]any{
				"id": "module_1",
				"lessons": []any{
					map[string]any{
						"id":    "lesson_1",
						"title": "Promo lesson",
						"graph": map[string]any{
							"startNodeId": "n1",
							"nodes":       []any{map[string]any{"id": "n1", "kind": "end", "text": "Done"}},
						},
					},
				},
			},
		},
	})
	if courseID == "" {
		t.Fatalf("expected published course")
	}

	usersResp, err := adminClient.Get(testApp.Server.URL + "/api/v1/admin/users?role=student")
	if err != nil {
		t.Fatalf("admin users: %v", err)
	}
	defer usersResp.Body.Close()
	if usersResp.StatusCode != http.StatusOK {
		t.Fatalf("admin users status: %d", usersResp.StatusCode)
	}
	var users struct {
		Items []struct {
			AccountID string `json:"account_id"`
			Role      string `json:"role"`
		} `json:"items"`
	}
	if err := json.NewDecoder(usersResp.Body).Decode(&users); err != nil {
		t.Fatalf("decode admin users: %v", err)
	}
	found := false
	for _, item := range users.Items {
		if item.AccountID == studentID && item.Role == "student" {
			found = true
		}
	}
	if !found {
		t.Fatalf("student not found in admin users list")
	}

	detailResp, err := adminClient.Get(testApp.Server.URL + "/api/v1/admin/users/" + studentID)
	if err != nil {
		t.Fatalf("admin user detail: %v", err)
	}
	defer detailResp.Body.Close()
	if detailResp.StatusCode != http.StatusOK {
		t.Fatalf("admin user detail status: %d", detailResp.StatusCode)
	}

	promoResp, err := studentClient.Get(testApp.Server.URL + "/api/v1/public/promo-courses")
	if err != nil {
		t.Fatalf("promo courses: %v", err)
	}
	defer promoResp.Body.Close()
	if promoResp.StatusCode != http.StatusOK {
		t.Fatalf("promo courses status: %d", promoResp.StatusCode)
	}
	var promo struct {
		Items []struct {
			CourseID string `json:"course_id"`
		} `json:"items"`
	}
	if err := json.NewDecoder(promoResp.Body).Decode(&promo); err != nil {
		t.Fatalf("decode promo courses: %v", err)
	}
	found = false
	for _, item := range promo.Items {
		if item.CourseID == courseID {
			found = true
		}
	}
	if !found {
		t.Fatalf("published platform course missing from promo list")
	}
}
