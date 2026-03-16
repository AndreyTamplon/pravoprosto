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

func TestTeacherAccess_LinkLifecycleStudentVisibilityAndTeacherViews(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)
	teacherClient := httpclient.New(t)
	teacherCSRF, _ := loginAsRole(t, teacherClient, testApp, "teacher-access-links", "teacher")
	studentClient := httpclient.New(t)
	studentCSRF, studentID := loginAsRole(t, studentClient, testApp, "student-access-links", "student")

	profileResp := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/profile", map[string]any{
		"display_name":      "Teacher",
		"organization_name": "Org",
		"avatar_asset_id":   nil,
	}, teacherCSRF)
	if profileResp.StatusCode != http.StatusOK {
		t.Fatalf("teacher profile status: %d", profileResp.StatusCode)
	}

	createResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses", map[string]any{
		"title":       "Private Access Course",
		"description": "Hidden",
	}, teacherCSRF)
	if createResp.StatusCode != http.StatusCreated {
		t.Fatalf("teacher create course status: %d", createResp.StatusCode)
	}
	defer createResp.Body.Close()
	var created struct {
		CourseID string `json:"course_id"`
	}
	if err := json.NewDecoder(createResp.Body).Decode(&created); err != nil {
		t.Fatalf("decode teacher create: %v", err)
	}

	prePublishLinkResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/access-links", map[string]any{
		"expires_at": "2026-04-01T00:00:00Z",
	}, teacherCSRF)
	if prePublishLinkResp.StatusCode != http.StatusConflict {
		t.Fatalf("pre-publish link status: %d", prePublishLinkResp.StatusCode)
	}

	updateResp := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/draft", map[string]any{
		"draft_version":  1,
		"title":          "Private Access Course",
		"description":    "Hidden",
		"cover_asset_id": nil,
		"content": map[string]any{
			"modules": []any{
				map[string]any{
					"id": "module_1",
					"lessons": []any{
						map[string]any{
							"id":    "lesson_1",
							"title": "Question",
							"graph": map[string]any{
								"startNodeId": "n1",
								"nodes": []any{
									map[string]any{
										"id":     "n1",
										"kind":   "single_choice",
										"prompt": "Choose",
										"options": []any{
											map[string]any{"id": "a1", "text": "Right", "result": "correct", "feedback": "Yes", "nextNodeId": "n2"},
											map[string]any{"id": "a2", "text": "Wrong", "result": "incorrect", "feedback": "No", "nextNodeId": "n2"},
										},
									},
									map[string]any{"id": "n2", "kind": "end"},
								},
							},
						},
					},
				},
			},
		},
	}, teacherCSRF)
	if updateResp.StatusCode != http.StatusOK {
		t.Fatalf("teacher update draft status: %d", updateResp.StatusCode)
	}
	adminApproveTeacherCourse(t, adminClient, testApp, adminCSRF, teacherClient, teacherCSRF, created.CourseID)

	beforeClaimCatalogResp, err := studentClient.Get(testApp.Server.URL + "/api/v1/student/catalog")
	if err != nil {
		t.Fatalf("student catalog before claim: %v", err)
	}
	defer beforeClaimCatalogResp.Body.Close()
	var beforeClaimCatalog struct {
		Sections []struct {
			Section string `json:"section"`
			Items   []struct {
				CourseID string `json:"course_id"`
			} `json:"items"`
		} `json:"sections"`
	}
	if err := json.NewDecoder(beforeClaimCatalogResp.Body).Decode(&beforeClaimCatalog); err != nil {
		t.Fatalf("decode pre-claim catalog: %v", err)
	}
	for _, section := range beforeClaimCatalog.Sections {
		if section.Section != "teacher_access" {
			continue
		}
		for _, item := range section.Items {
			if item.CourseID == created.CourseID {
				t.Fatalf("teacher course must not be visible before claim")
			}
		}
	}

	lockedTreeResp, err := studentClient.Get(testApp.Server.URL + "/api/v1/student/courses/" + created.CourseID)
	if err != nil {
		t.Fatalf("teacher tree before claim: %v", err)
	}
	if lockedTreeResp.StatusCode != http.StatusForbidden {
		t.Fatalf("teacher tree before claim status: %d", lockedTreeResp.StatusCode)
	}

	createLinkResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/access-links", map[string]any{
		"expires_at": "2026-04-01T00:00:00Z",
	}, teacherCSRF)
	if createLinkResp.StatusCode != http.StatusCreated {
		t.Fatalf("create access link status: %d", createLinkResp.StatusCode)
	}
	defer createLinkResp.Body.Close()
	var link struct {
		LinkID   string `json:"link_id"`
		ClaimURL string `json:"claim_url"`
	}
	if err := json.NewDecoder(createLinkResp.Body).Decode(&link); err != nil {
		t.Fatalf("decode created access link: %v", err)
	}
	token := strings.TrimPrefix(strings.Split(link.ClaimURL, "#")[1], "token=")

	listResp, err := teacherClient.Get(testApp.Server.URL + "/api/v1/teacher/courses/" + created.CourseID + "/access-links")
	if err != nil {
		t.Fatalf("list access links: %v", err)
	}
	defer listResp.Body.Close()
	var listed struct {
		Items []struct {
			LinkID   string `json:"link_id"`
			ClaimURL string `json:"claim_url"`
		} `json:"items"`
	}
	if err := json.NewDecoder(listResp.Body).Decode(&listed); err != nil {
		t.Fatalf("decode listed links: %v", err)
	}
	if len(listed.Items) != 1 || listed.Items[0].LinkID != link.LinkID || listed.Items[0].ClaimURL == "" {
		t.Fatalf("unexpected listed links payload: %+v", listed)
	}

	claimResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/course-links/claim", map[string]any{
		"token": token,
	}, studentCSRF)
	if claimResp.StatusCode != http.StatusOK {
		t.Fatalf("claim link status: %d", claimResp.StatusCode)
	}

	listToken := strings.TrimPrefix(strings.Split(listed.Items[0].ClaimURL, "#")[1], "token=")
	duplicateClaimResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/course-links/claim", map[string]any{
		"token": listToken,
	}, studentCSRF)
	if duplicateClaimResp.StatusCode != http.StatusOK {
		t.Fatalf("duplicate claim status: %d", duplicateClaimResp.StatusCode)
	}

	treeResp, err := studentClient.Get(testApp.Server.URL + "/api/v1/student/courses/" + created.CourseID)
	if err != nil {
		t.Fatalf("teacher tree after claim: %v", err)
	}
	if treeResp.StatusCode != http.StatusOK {
		t.Fatalf("teacher tree after claim status: %d", treeResp.StatusCode)
	}

	startResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+created.CourseID+"/lessons/lesson_1/start", map[string]any{}, studentCSRF)
	if startResp.StatusCode != http.StatusOK {
		t.Fatalf("teacher course start after claim status: %d", startResp.StatusCode)
	}
	defer startResp.Body.Close()
	var started struct {
		SessionID    string `json:"session_id"`
		StateVersion int64  `json:"state_version"`
		NodeID       string `json:"node_id"`
	}
	if err := json.NewDecoder(startResp.Body).Decode(&started); err != nil {
		t.Fatalf("decode started teacher session: %v", err)
	}

	studentsResp, err := teacherClient.Get(testApp.Server.URL + "/api/v1/teacher/courses/" + created.CourseID + "/students")
	if err != nil {
		t.Fatalf("teacher students list: %v", err)
	}
	defer studentsResp.Body.Close()
	var students struct {
		Students []struct {
			StudentID string `json:"student_id"`
		} `json:"students"`
	}
	if err := json.NewDecoder(studentsResp.Body).Decode(&students); err != nil {
		t.Fatalf("decode teacher students: %v", err)
	}
	if len(students.Students) != 1 || students.Students[0].StudentID != studentID {
		t.Fatalf("unexpected teacher students payload: %+v", students)
	}

	studentDetailResp, err := teacherClient.Get(testApp.Server.URL + "/api/v1/teacher/courses/" + created.CourseID + "/students/" + studentID)
	if err != nil {
		t.Fatalf("teacher student detail: %v", err)
	}
	if studentDetailResp.StatusCode != http.StatusOK {
		t.Fatalf("teacher student detail status: %d", studentDetailResp.StatusCode)
	}

	secondLinkResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/access-links", map[string]any{
		"expires_at": "2026-04-01T00:00:00Z",
	}, teacherCSRF)
	if secondLinkResp.StatusCode != http.StatusCreated {
		t.Fatalf("second create link status: %d", secondLinkResp.StatusCode)
	}
	defer secondLinkResp.Body.Close()
	var secondLink struct {
		LinkID   string `json:"link_id"`
		ClaimURL string `json:"claim_url"`
	}
	if err := json.NewDecoder(secondLinkResp.Body).Decode(&secondLink); err != nil {
		t.Fatalf("decode second link: %v", err)
	}
	revokeResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/access-links/"+secondLink.LinkID+"/revoke", map[string]any{}, teacherCSRF)
	if revokeResp.StatusCode != http.StatusOK {
		t.Fatalf("revoke access link status: %d", revokeResp.StatusCode)
	}
	revokedToken := strings.TrimPrefix(strings.Split(secondLink.ClaimURL, "#")[1], "token=")
	revokedClaimResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/course-links/claim", map[string]any{
		"token": revokedToken,
	}, studentCSRF)
	if revokedClaimResp.StatusCode != http.StatusConflict {
		t.Fatalf("revoked claim status: %d", revokedClaimResp.StatusCode)
	}

	expiredLinkResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/access-links", map[string]any{
		"expires_at": "2025-01-01T00:00:00Z",
	}, teacherCSRF)
	if expiredLinkResp.StatusCode != http.StatusCreated {
		t.Fatalf("expired link create status: %d", expiredLinkResp.StatusCode)
	}
	defer expiredLinkResp.Body.Close()
	var expiredLink struct {
		ClaimURL string `json:"claim_url"`
	}
	if err := json.NewDecoder(expiredLinkResp.Body).Decode(&expiredLink); err != nil {
		t.Fatalf("decode expired link: %v", err)
	}
	expiredToken := strings.TrimPrefix(strings.Split(expiredLink.ClaimURL, "#")[1], "token=")
	expiredClaimResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/course-links/claim", map[string]any{
		"token": expiredToken,
	}, studentCSRF)
	if expiredClaimResp.StatusCode != http.StatusConflict {
		t.Fatalf("expired claim status: %d", expiredClaimResp.StatusCode)
	}

	if _, err := testApp.DB.Pool().Exec(context.Background(), `
		update course_access_grants
		set archived_at = now()
		where course_id = $1 and student_id = $2 and archived_at is null
	`, created.CourseID, studentID); err != nil {
		t.Fatalf("archive course grant: %v", err)
	}

	afterArchiveTreeResp, err := studentClient.Get(testApp.Server.URL + "/api/v1/student/courses/" + created.CourseID)
	if err != nil {
		t.Fatalf("tree after archive: %v", err)
	}
	if afterArchiveTreeResp.StatusCode != http.StatusForbidden {
		t.Fatalf("tree after archive status: %d", afterArchiveTreeResp.StatusCode)
	}

	sessionByIDResp, err := studentClient.Get(testApp.Server.URL + "/api/v1/student/lesson-sessions/" + started.SessionID)
	if err != nil {
		t.Fatalf("session by id after archive: %v", err)
	}
	if sessionByIDResp.StatusCode != http.StatusForbidden {
		t.Fatalf("session by id after archive status: %d", sessionByIDResp.StatusCode)
	}

	nextAfterArchiveResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+started.SessionID+"/next", map[string]any{
		"state_version":    started.StateVersion,
		"expected_node_id": started.NodeID,
	}, studentCSRF)
	if nextAfterArchiveResp.StatusCode != http.StatusForbidden {
		t.Fatalf("next after archive status: %d", nextAfterArchiveResp.StatusCode)
	}

	answerAfterArchiveResp := performJSONWithIdempotency(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+started.SessionID+"/answer", map[string]any{
		"state_version": started.StateVersion,
		"node_id":       started.NodeID,
		"answer":        map[string]any{"kind": "single_choice", "option_id": "a1"},
	}, studentCSRF, "teacher-archived-answer")
	if answerAfterArchiveResp.StatusCode != http.StatusForbidden {
		t.Fatalf("answer after archive status: %d", answerAfterArchiveResp.StatusCode)
	}

	archiveCourseResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/archive", map[string]any{}, teacherCSRF)
	if archiveCourseResp.StatusCode != http.StatusOK {
		t.Fatalf("archive course status: %d", archiveCourseResp.StatusCode)
	}

	listAfterArchiveResp, err := teacherClient.Get(testApp.Server.URL + "/api/v1/teacher/courses")
	if err != nil {
		t.Fatalf("teacher courses after archive: %v", err)
	}
	defer listAfterArchiveResp.Body.Close()
	var listedAfterArchive struct {
		Items []struct {
			CourseID string `json:"course_id"`
		} `json:"items"`
	}
	if err := json.NewDecoder(listAfterArchiveResp.Body).Decode(&listedAfterArchive); err != nil {
		t.Fatalf("decode courses after archive: %v", err)
	}
	for _, item := range listedAfterArchive.Items {
		if item.CourseID == created.CourseID {
			t.Fatalf("archived course should disappear from teacher list")
		}
	}
}

func TestTeacherAccess_AdminGrantAllowsTeacherPrivateAndRejectsPlatform(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)
	teacherClient := httpclient.New(t)
	teacherCSRF, _ := loginAsRole(t, teacherClient, testApp, "teacher-admin-grant", "teacher")
	studentClient := httpclient.New(t)
	_, studentID := loginAsRole(t, studentClient, testApp, "student-admin-grant", "student")

	profileResp := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/profile", map[string]any{
		"display_name":      "Teacher",
		"organization_name": "Org",
		"avatar_asset_id":   nil,
	}, teacherCSRF)
	if profileResp.StatusCode != http.StatusOK {
		t.Fatalf("teacher profile status: %d", profileResp.StatusCode)
	}

	platformCourseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Platform Paid Candidate", map[string]any{
		"modules": []any{
			map[string]any{
				"id": "module_1",
				"lessons": []any{
					map[string]any{
						"id":    "lesson_1",
						"title": "Platform lesson",
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

	platformGrantResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/courses/"+platformCourseID+"/access-grants", map[string]any{
		"student_id": studentID,
	}, adminCSRF)
	if platformGrantResp.StatusCode != http.StatusConflict {
		t.Fatalf("platform grant reject status: %d", platformGrantResp.StatusCode)
	}

	invalidStudentResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/courses/"+platformCourseID+"/access-grants", map[string]any{
		"student_id": "not-a-uuid",
	}, adminCSRF)
	if invalidStudentResp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("invalid student id status: %d", invalidStudentResp.StatusCode)
	}

	parentClient := httpclient.New(t)
	_, parentID := loginAsRole(t, parentClient, testApp, "parent-admin-grant", "parent")
	parentGrantResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/courses/"+platformCourseID+"/access-grants", map[string]any{
		"student_id": parentID,
	}, adminCSRF)
	if parentGrantResp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("parent student id reject status: %d", parentGrantResp.StatusCode)
	}

	createResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses", map[string]any{
		"title":       "Teacher Private Grant",
		"description": "Private",
	}, teacherCSRF)
	if createResp.StatusCode != http.StatusCreated {
		t.Fatalf("teacher create status: %d", createResp.StatusCode)
	}
	defer createResp.Body.Close()
	var created struct {
		CourseID string `json:"course_id"`
	}
	if err := json.NewDecoder(createResp.Body).Decode(&created); err != nil {
		t.Fatalf("decode teacher create: %v", err)
	}

	updateResp := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/draft", map[string]any{
		"draft_version":  1,
		"title":          "Teacher Private Grant",
		"description":    "Private",
		"cover_asset_id": nil,
		"content": map[string]any{
			"modules": []any{
				map[string]any{
					"id": "module_1",
					"lessons": []any{
						map[string]any{
							"id":    "lesson_1",
							"title": "Teacher lesson",
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
		},
	}, teacherCSRF)
	if updateResp.StatusCode != http.StatusOK {
		t.Fatalf("teacher update status: %d", updateResp.StatusCode)
	}
	adminApproveTeacherCourse(t, adminClient, testApp, adminCSRF, teacherClient, teacherCSRF, created.CourseID)

	grantResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/courses/"+created.CourseID+"/access-grants", map[string]any{
		"student_id": studentID,
	}, adminCSRF)
	if grantResp.StatusCode != http.StatusCreated {
		t.Fatalf("teacher private grant status: %d", grantResp.StatusCode)
	}

	treeResp, err := studentClient.Get(testApp.Server.URL + "/api/v1/student/courses/" + created.CourseID)
	if err != nil {
		t.Fatalf("tree after admin grant: %v", err)
	}
	if treeResp.StatusCode != http.StatusOK {
		t.Fatalf("tree after admin grant status: %d", treeResp.StatusCode)
	}
}
