package tests

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"pravoprost/backend/internal/testkit/app"
	httpclient "pravoprost/backend/internal/testkit/http"
)

func TestAuthoring_TeacherGateCreateAndDraftLifecycle(t *testing.T) {
	testApp := app.New(t)
	teacherClient := httpclient.New(t)
	teacherCSRF, _ := loginAsRole(t, teacherClient, testApp, "teacher-author", "teacher")

	listResp, err := teacherClient.Get(testApp.Server.URL + "/api/v1/teacher/courses")
	if err != nil {
		t.Fatalf("teacher courses list before profile: %v", err)
	}
	if listResp.StatusCode != http.StatusConflict {
		t.Fatalf("teacher list gate status: %d", listResp.StatusCode)
	}

	blockedResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses", map[string]any{
		"title":       "Money",
		"description": "Basics",
	}, teacherCSRF)
	if blockedResp.StatusCode != http.StatusConflict {
		t.Fatalf("teacher gate status: %d", blockedResp.StatusCode)
	}

	profileResp := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/profile", map[string]any{
		"display_name":      "Maria",
		"organization_name": "School 1",
		"avatar_asset_id":   nil,
	}, teacherCSRF)
	if profileResp.StatusCode != http.StatusOK {
		t.Fatalf("teacher profile update status: %d", profileResp.StatusCode)
	}

	createResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses", map[string]any{
		"title":       "Money",
		"description": "Basics",
		"age_min":     9,
		"age_max":     12,
	}, teacherCSRF)
	if createResp.StatusCode != http.StatusCreated {
		t.Fatalf("teacher create course status: %d", createResp.StatusCode)
	}
	defer createResp.Body.Close()
	var created struct {
		CourseID string `json:"course_id"`
	}
	if err := json.NewDecoder(createResp.Body).Decode(&created); err != nil {
		t.Fatalf("decode create course: %v", err)
	}

	draftResp, err := teacherClient.Get(testApp.Server.URL + "/api/v1/teacher/courses/" + created.CourseID + "/draft")
	if err != nil {
		t.Fatalf("get teacher draft: %v", err)
	}
	if draftResp.StatusCode != http.StatusOK {
		t.Fatalf("get teacher draft status: %d", draftResp.StatusCode)
	}
	defer draftResp.Body.Close()
	var draft struct {
		DraftVersion int64 `json:"draft_version"`
		Validation   struct {
			IsValid bool `json:"is_valid"`
		} `json:"validation"`
	}
	if err := json.NewDecoder(draftResp.Body).Decode(&draft); err != nil {
		t.Fatalf("decode draft: %v", err)
	}
	if !draft.Validation.IsValid {
		t.Fatalf("empty draft should be valid")
	}

	validContent := map[string]any{
		"modules": []any{
			map[string]any{
				"id":    "module_1",
				"title": "Safe buying",
				"lessons": []any{
					map[string]any{
						"id":    "lesson_1",
						"title": "Links",
						"graph": map[string]any{
							"startNodeId": "n1",
							"nodes": []any{
								map[string]any{"id": "n1", "kind": "story", "nextNodeId": "n2"},
								map[string]any{
									"id":   "n2",
									"kind": "single_choice",
									"options": []any{
										map[string]any{"id": "a1", "text": "Open", "result": "incorrect", "feedback": "No", "nextNodeId": "n3"},
										map[string]any{"id": "a2", "text": "Ask adult", "result": "correct", "feedback": "Yes", "nextNodeId": "n3"},
									},
								},
								map[string]any{"id": "n3", "kind": "end"},
							},
						},
					},
				},
			},
		},
	}

	updateResp := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/draft", map[string]any{
		"draft_version":  draft.DraftVersion,
		"title":          "Money updated",
		"description":    "Basics",
		"age_min":        9,
		"age_max":        12,
		"cover_asset_id": nil,
		"content":        validContent,
	}, teacherCSRF)
	if updateResp.StatusCode != http.StatusOK {
		t.Fatalf("update draft status: %d", updateResp.StatusCode)
	}

	staleResp := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/draft", map[string]any{
		"draft_version":  draft.DraftVersion,
		"title":          "Money updated",
		"description":    "Basics",
		"age_min":        9,
		"age_max":        12,
		"cover_asset_id": nil,
		"content":        validContent,
	}, teacherCSRF)
	if staleResp.StatusCode != http.StatusConflict {
		t.Fatalf("stale draft version status: %d", staleResp.StatusCode)
	}
}

func TestAuthoring_DraftAssetOwnershipAndShapeValidation(t *testing.T) {
	testApp := app.New(t)

	assetOwnerClient := httpclient.New(t)
	assetOwnerCSRF, _ := loginAsRole(t, assetOwnerClient, testApp, "teacher-asset-owner", "teacher")
	profileResp := performJSON(t, assetOwnerClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/profile", map[string]any{
		"display_name":      "Owner",
		"organization_name": "School 2",
		"avatar_asset_id":   nil,
	}, assetOwnerCSRF)
	if profileResp.StatusCode != http.StatusOK {
		t.Fatalf("asset owner profile status: %d", profileResp.StatusCode)
	}
	uploadResp := performJSON(t, assetOwnerClient, http.MethodPost, testApp.Server.URL+"/api/v1/assets/upload-requests", map[string]any{
		"file_name":  "cover.png",
		"mime_type":  "image/png",
		"size_bytes": 512,
	}, assetOwnerCSRF)
	if uploadResp.StatusCode != http.StatusCreated {
		t.Fatalf("asset upload status: %d", uploadResp.StatusCode)
	}
	defer uploadResp.Body.Close()
	var uploaded struct {
		AssetID string `json:"asset_id"`
	}
	if err := json.NewDecoder(uploadResp.Body).Decode(&uploaded); err != nil {
		t.Fatalf("decode uploaded asset: %v", err)
	}

	teacherClient := httpclient.New(t)
	teacherCSRF, _ := loginAsRole(t, teacherClient, testApp, "teacher-asset-user", "teacher")
	profileResp = performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/profile", map[string]any{
		"display_name":      "Author",
		"organization_name": "School 3",
		"avatar_asset_id":   nil,
	}, teacherCSRF)
	if profileResp.StatusCode != http.StatusOK {
		t.Fatalf("teacher profile status: %d", profileResp.StatusCode)
	}
	createResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses", map[string]any{
		"title":       "Safety",
		"description": "Basics",
	}, teacherCSRF)
	if createResp.StatusCode != http.StatusCreated {
		t.Fatalf("teacher create status: %d", createResp.StatusCode)
	}
	defer createResp.Body.Close()
	var created struct {
		CourseID string `json:"course_id"`
	}
	if err := json.NewDecoder(createResp.Body).Decode(&created); err != nil {
		t.Fatalf("decode created course: %v", err)
	}

	notOwnedAssetResp := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/draft", map[string]any{
		"draft_version":  1,
		"title":          "Safety",
		"description":    "Basics",
		"cover_asset_id": uploaded.AssetID,
		"content": map[string]any{
			"modules": []any{
				map[string]any{
					"id": "module_1",
					"lessons": []any{
						map[string]any{
							"id":    "lesson_1",
							"title": "Story",
							"graph": map[string]any{
								"startNodeId": "n1",
								"nodes": []any{
									map[string]any{
										"id":         "n1",
										"kind":       "story",
										"body":       map[string]any{"text": "Look", "assetId": uploaded.AssetID},
										"nextNodeId": "n2",
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
	if notOwnedAssetResp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("asset ownership validation status: %d", notOwnedAssetResp.StatusCode)
	}

	invalidShapeResp := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/draft", map[string]any{
		"draft_version":  1,
		"title":          "Safety",
		"description":    "Basics",
		"cover_asset_id": "not-a-uuid",
		"content":        []any{},
	}, teacherCSRF)
	if invalidShapeResp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("invalid draft shape status: %d", invalidShapeResp.StatusCode)
	}
}

func TestAuthoring_OwnershipBoundariesAndOwnedAssetReferences(t *testing.T) {
	testApp := app.New(t)

	teacherClient := httpclient.New(t)
	teacherCSRF, _ := loginAsRole(t, teacherClient, testApp, "teacher-owned-asset", "teacher")
	profileResp := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/profile", map[string]any{
		"display_name":      "Owner Teacher",
		"organization_name": "School 7",
		"avatar_asset_id":   nil,
	}, teacherCSRF)
	if profileResp.StatusCode != http.StatusOK {
		t.Fatalf("teacher owner profile status: %d", profileResp.StatusCode)
	}
	uploadResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/assets/upload-requests", map[string]any{
		"file_name":  "owned-cover.png",
		"mime_type":  "image/png",
		"size_bytes": 1024,
	}, teacherCSRF)
	if uploadResp.StatusCode != http.StatusCreated {
		t.Fatalf("owned asset upload status: %d", uploadResp.StatusCode)
	}
	defer uploadResp.Body.Close()
	var uploaded struct {
		AssetID string `json:"asset_id"`
	}
	if err := json.NewDecoder(uploadResp.Body).Decode(&uploaded); err != nil {
		t.Fatalf("decode owned uploaded asset: %v", err)
	}

	createTeacherResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses", map[string]any{
		"title":       "Owned Asset Course",
		"description": "Basics",
	}, teacherCSRF)
	if createTeacherResp.StatusCode != http.StatusCreated {
		t.Fatalf("create teacher course status: %d", createTeacherResp.StatusCode)
	}
	defer createTeacherResp.Body.Close()
	var teacherCourse struct {
		CourseID string `json:"course_id"`
	}
	if err := json.NewDecoder(createTeacherResp.Body).Decode(&teacherCourse); err != nil {
		t.Fatalf("decode teacher course with owned asset: %v", err)
	}

	ownedAssetUpdate := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/courses/"+teacherCourse.CourseID+"/draft", map[string]any{
		"draft_version":  1,
		"title":          "Owned Asset Course",
		"description":    "Basics",
		"cover_asset_id": uploaded.AssetID,
		"content": map[string]any{
			"modules": []any{
				map[string]any{
					"id": "module_1",
					"lessons": []any{
						map[string]any{
							"id":    "lesson_1",
							"title": "Story",
							"graph": map[string]any{
								"startNodeId": "n1",
								"nodes": []any{
									map[string]any{
										"id":         "n1",
										"kind":       "story",
										"body":       map[string]any{"text": "Look", "assetId": uploaded.AssetID},
										"nextNodeId": "n2",
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
	if ownedAssetUpdate.StatusCode != http.StatusOK {
		t.Fatalf("owned asset draft update status: %d", ownedAssetUpdate.StatusCode)
	}

	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)
	adminTeacherDraftResp, err := adminClient.Get(testApp.Server.URL + "/api/v1/admin/courses/" + teacherCourse.CourseID + "/draft")
	if err != nil {
		t.Fatalf("admin get teacher draft via admin route: %v", err)
	}
	if adminTeacherDraftResp.StatusCode != http.StatusNotFound {
		t.Fatalf("admin teacher draft via admin route status: %d", adminTeacherDraftResp.StatusCode)
	}

	createAdminResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/courses", map[string]any{
		"title":       "Platform Ownership",
		"description": "Basics",
	}, adminCSRF)
	if createAdminResp.StatusCode != http.StatusCreated {
		t.Fatalf("create admin course status: %d", createAdminResp.StatusCode)
	}
	defer createAdminResp.Body.Close()
	var adminCourse struct {
		CourseID string `json:"course_id"`
	}
	if err := json.NewDecoder(createAdminResp.Body).Decode(&adminCourse); err != nil {
		t.Fatalf("decode admin course: %v", err)
	}

	teacherReadsAdminDraft, err := teacherClient.Get(testApp.Server.URL + "/api/v1/teacher/courses/" + adminCourse.CourseID + "/draft")
	if err != nil {
		t.Fatalf("teacher get admin draft: %v", err)
	}
	if teacherReadsAdminDraft.StatusCode != http.StatusNotFound {
		t.Fatalf("teacher get admin draft status: %d", teacherReadsAdminDraft.StatusCode)
	}

	teacherUpdatesAdminDraft := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/courses/"+adminCourse.CourseID+"/draft", map[string]any{
		"draft_version":  1,
		"title":          "Platform Ownership",
		"description":    "Basics",
		"cover_asset_id": nil,
		"content": map[string]any{
			"modules": []any{
				map[string]any{
					"id": "module_1",
					"lessons": []any{
						map[string]any{
							"id":    "lesson_1",
							"title": "End",
							"graph": map[string]any{
								"startNodeId": "n1",
								"nodes":       []any{map[string]any{"id": "n1", "kind": "end"}},
							},
						},
					},
				},
			},
		},
	}, teacherCSRF)
	if teacherUpdatesAdminDraft.StatusCode != http.StatusNotFound {
		t.Fatalf("teacher update admin draft status: %d", teacherUpdatesAdminDraft.StatusCode)
	}
}

func TestAuthoring_DraftValidationErrorsAndAdminCreate(t *testing.T) {
	testApp := app.New(t)

	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)
	createResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/courses", map[string]any{
		"title":       "Platform Course",
		"description": "Basics",
	}, adminCSRF)
	if createResp.StatusCode != http.StatusCreated {
		t.Fatalf("admin create course status: %d", createResp.StatusCode)
	}
	defer createResp.Body.Close()
	var created struct {
		CourseID string `json:"course_id"`
	}
	if err := json.NewDecoder(createResp.Body).Decode(&created); err != nil {
		t.Fatalf("decode admin create: %v", err)
	}

	invalidContent := map[string]any{
		"modules": []any{
			map[string]any{
				"id": "module_1",
				"lessons": []any{
					map[string]any{
						"id":    "lesson_1",
						"title": "FT",
						"graph": map[string]any{
							"startNodeId": "n1",
							"nodes": []any{
								map[string]any{"id": "n1", "kind": "story", "nextNodeId": "n2"},
								map[string]any{
									"id":   "n2",
									"kind": "free_text",
									"transitions": []any{
										map[string]any{"onVerdict": "correct", "nextNodeId": "n3"},
									},
								},
								map[string]any{"id": "n3", "kind": "end"},
								map[string]any{"id": "n4", "kind": "end"},
							},
						},
					},
					map[string]any{
						"id":    "lesson_1",
						"title": "Duplicate lesson",
						"graph": map[string]any{
							"startNodeId": "x1",
							"nodes":       []any{map[string]any{"id": "x1", "kind": "end"}},
						},
					},
				},
			},
		},
	}

	updateResp := performJSON(t, adminClient, http.MethodPut, testApp.Server.URL+"/api/v1/admin/courses/"+created.CourseID+"/draft", map[string]any{
		"draft_version":  1,
		"title":          "Platform Course",
		"description":    "Basics",
		"age_min":        nil,
		"age_max":        nil,
		"cover_asset_id": nil,
		"content":        invalidContent,
	}, adminCSRF)
	if updateResp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("invalid draft status: %d", updateResp.StatusCode)
	}
}

func TestAuthoring_CrossOwnerRoutesAndOwnedAssetHappyPath(t *testing.T) {
	testApp := app.New(t)

	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)
	adminCreateResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/courses", map[string]any{
		"title":       "Admin Owned",
		"description": "Platform",
	}, adminCSRF)
	if adminCreateResp.StatusCode != http.StatusCreated {
		t.Fatalf("admin create course status: %d", adminCreateResp.StatusCode)
	}
	defer adminCreateResp.Body.Close()
	var adminCreated struct {
		CourseID string `json:"course_id"`
	}
	if err := json.NewDecoder(adminCreateResp.Body).Decode(&adminCreated); err != nil {
		t.Fatalf("decode admin created course: %v", err)
	}

	teacherClient := httpclient.New(t)
	teacherCSRF, _ := loginAsRole(t, teacherClient, testApp, "teacher-authoring-acl", "teacher")
	profileResp := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/profile", map[string]any{
		"display_name":      "Author",
		"organization_name": "School",
		"avatar_asset_id":   nil,
	}, teacherCSRF)
	if profileResp.StatusCode != http.StatusOK {
		t.Fatalf("teacher profile status: %d", profileResp.StatusCode)
	}

	teacherGetAdminDraftResp, err := teacherClient.Get(testApp.Server.URL + "/api/v1/teacher/courses/" + adminCreated.CourseID + "/draft")
	if err != nil {
		t.Fatalf("teacher get admin draft: %v", err)
	}
	if teacherGetAdminDraftResp.StatusCode != http.StatusNotFound {
		t.Fatalf("teacher get admin draft status: %d", teacherGetAdminDraftResp.StatusCode)
	}
	teacherUpdateAdminDraftResp := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/courses/"+adminCreated.CourseID+"/draft", map[string]any{
		"draft_version":  1,
		"title":          "Should fail",
		"description":    "No access",
		"cover_asset_id": nil,
		"content": map[string]any{
			"modules": []any{
				map[string]any{
					"id": "module_1",
					"lessons": []any{
						map[string]any{
							"id":    "lesson_1",
							"title": "Lesson",
							"graph": map[string]any{
								"startNodeId": "n1",
								"nodes":       []any{map[string]any{"id": "n1", "kind": "end"}},
							},
						},
					},
				},
			},
		},
	}, teacherCSRF)
	if teacherUpdateAdminDraftResp.StatusCode != http.StatusNotFound {
		t.Fatalf("teacher update admin draft status: %d", teacherUpdateAdminDraftResp.StatusCode)
	}

	teacherCreateResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses", map[string]any{
		"title":       "Teacher Owned",
		"description": "Private",
	}, teacherCSRF)
	if teacherCreateResp.StatusCode != http.StatusCreated {
		t.Fatalf("teacher create course status: %d", teacherCreateResp.StatusCode)
	}
	defer teacherCreateResp.Body.Close()
	var teacherCreated struct {
		CourseID string `json:"course_id"`
	}
	if err := json.NewDecoder(teacherCreateResp.Body).Decode(&teacherCreated); err != nil {
		t.Fatalf("decode teacher created course: %v", err)
	}

	adminGetTeacherDraftResp, err := adminClient.Get(testApp.Server.URL + "/api/v1/admin/courses/" + teacherCreated.CourseID + "/draft")
	if err != nil {
		t.Fatalf("admin get teacher draft: %v", err)
	}
	if adminGetTeacherDraftResp.StatusCode != http.StatusNotFound {
		t.Fatalf("admin get teacher draft status: %d", adminGetTeacherDraftResp.StatusCode)
	}

	uploadResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/assets/upload-requests", map[string]any{
		"file_name":  "cover.png",
		"mime_type":  "image/png",
		"size_bytes": 1024,
	}, teacherCSRF)
	if uploadResp.StatusCode != http.StatusCreated {
		t.Fatalf("teacher owned asset upload status: %d", uploadResp.StatusCode)
	}
	defer uploadResp.Body.Close()
	var uploaded struct {
		AssetID string `json:"asset_id"`
	}
	if err := json.NewDecoder(uploadResp.Body).Decode(&uploaded); err != nil {
		t.Fatalf("decode teacher owned asset: %v", err)
	}

	ownedAssetResp := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/courses/"+teacherCreated.CourseID+"/draft", map[string]any{
		"draft_version":  1,
		"title":          "Teacher Owned",
		"description":    "Private",
		"cover_asset_id": uploaded.AssetID,
		"content": map[string]any{
			"modules": []any{
				map[string]any{
					"id": "module_1",
					"lessons": []any{
						map[string]any{
							"id":    "lesson_1",
							"title": "Illustrated",
							"graph": map[string]any{
								"startNodeId": "n1",
								"nodes": []any{
									map[string]any{
										"id":         "n1",
										"kind":       "story",
										"body":       map[string]any{"text": "Look", "assetId": uploaded.AssetID},
										"nextNodeId": "n2",
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
	if ownedAssetResp.StatusCode != http.StatusOK {
		t.Fatalf("teacher owned asset draft update status: %d", ownedAssetResp.StatusCode)
	}

	var coverAssetID string
	if err := testApp.DB.Pool().QueryRow(context.Background(), `
		select coalesce(cover_asset_id::text, '')
		from course_drafts
		where course_id = $1
	`, teacherCreated.CourseID).Scan(&coverAssetID); err != nil {
		t.Fatalf("query stored cover asset: %v", err)
	}
	if coverAssetID != uploaded.AssetID {
		t.Fatalf("unexpected stored cover asset id: %s", coverAssetID)
	}
}
