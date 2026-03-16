package tests

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"testing"

	"pravoprost/backend/internal/testkit/app"
	httpclient "pravoprost/backend/internal/testkit/http"
)

func TestPreview_TeacherAndAdminCanDrivePreview(t *testing.T) {
	testApp := app.New(t)
	teacherClient := httpclient.New(t)
	teacherCSRF, _ := loginAsRole(t, teacherClient, testApp, "teacher-preview", "teacher")
	_ = performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/profile", map[string]any{
		"display_name":      "Preview Teacher",
		"organization_name": "School",
		"avatar_asset_id":   nil,
	}, teacherCSRF)

	createResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses", map[string]any{
		"title":       "Preview Course",
		"description": "Basics",
	}, teacherCSRF)
	defer createResp.Body.Close()
	var created struct {
		CourseID string `json:"course_id"`
	}
	_ = json.NewDecoder(createResp.Body).Decode(&created)

	content := map[string]any{
		"modules": []any{
			map[string]any{
				"id": "module_1",
				"lessons": []any{
					map[string]any{
						"id":    "lesson_1",
						"title": "Scenario",
						"graph": map[string]any{
							"startNodeId": "n1",
							"nodes": []any{
								map[string]any{"id": "n1", "kind": "story", "nextNodeId": "n2", "body": map[string]any{"text": "Start"}},
								map[string]any{
									"id":     "n2",
									"kind":   "free_text",
									"prompt": "Why?",
									"rubric": map[string]any{"referenceAnswer": "safe password"},
									"transitions": []any{
										map[string]any{"onVerdict": "correct", "nextNodeId": "n3"},
										map[string]any{"onVerdict": "partial", "nextNodeId": "n3"},
										map[string]any{"onVerdict": "incorrect", "nextNodeId": "n3"},
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
		"draft_version":  1,
		"title":          "Preview Course",
		"description":    "Basics",
		"cover_asset_id": nil,
		"content":        content,
	}, teacherCSRF)
	if updateResp.StatusCode != http.StatusOK {
		t.Fatalf("update draft for preview status: %d", updateResp.StatusCode)
	}

	startResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/preview", map[string]any{"lesson_id": "lesson_1"}, teacherCSRF)
	if startResp.StatusCode != http.StatusOK {
		t.Fatalf("start preview status: %d", startResp.StatusCode)
	}
	defer startResp.Body.Close()
	var preview struct {
		PreviewSessionID string `json:"preview_session_id"`
		Step             struct {
			StateVersion int64  `json:"state_version"`
			NodeID       string `json:"node_id"`
			NodeKind     string `json:"node_kind"`
		} `json:"step"`
	}
	_ = json.NewDecoder(startResp.Body).Decode(&preview)
	if preview.Step.NodeKind != "story" {
		t.Fatalf("expected story node, got %s", preview.Step.NodeKind)
	}

	nextResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/preview-sessions/"+preview.PreviewSessionID+"/next", map[string]any{"state_version": preview.Step.StateVersion}, teacherCSRF)
	if nextResp.StatusCode != http.StatusOK {
		t.Fatalf("preview next status: %d", nextResp.StatusCode)
	}
	defer nextResp.Body.Close()
	var next struct {
		Step struct {
			StateVersion int64  `json:"state_version"`
			NodeID       string `json:"node_id"`
			NodeKind     string `json:"node_kind"`
		} `json:"step"`
	}
	_ = json.NewDecoder(nextResp.Body).Decode(&next)
	if next.Step.NodeKind != "free_text" {
		t.Fatalf("expected free_text node, got %s", next.Step.NodeKind)
	}

	answerResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/preview-sessions/"+preview.PreviewSessionID+"/answer", map[string]any{
		"state_version": next.Step.StateVersion,
		"node_id":       next.Step.NodeID,
		"answer":        map[string]any{"text": "This keeps a safe password"},
	}, teacherCSRF)
	if answerResp.StatusCode != http.StatusOK {
		t.Fatalf("preview answer status: %d", answerResp.StatusCode)
	}
}

func TestPublication_SubmitReviewApproveRejectAndDirectAdminPublish(t *testing.T) {
	testApp := app.New(t)
	teacherClient := httpclient.New(t)
	teacherCSRF, _ := loginAsRole(t, teacherClient, testApp, "teacher-publish", "teacher")
	_ = performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/profile", map[string]any{
		"display_name":      "Teacher",
		"organization_name": "Org",
		"avatar_asset_id":   nil,
	}, teacherCSRF)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)

	createResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses", map[string]any{
		"title":       "Publish Course",
		"description": "Basics",
	}, teacherCSRF)
	defer createResp.Body.Close()
	var created struct {
		CourseID string `json:"course_id"`
	}
	_ = json.NewDecoder(createResp.Body).Decode(&created)

	validContent := map[string]any{
		"modules": []any{
			map[string]any{
				"id": "module_1",
				"lessons": []any{
					map[string]any{
						"id":    "lesson_1",
						"title": "L1",
						"graph": map[string]any{
							"startNodeId": "n1",
							"nodes": []any{
								map[string]any{"id": "n1", "kind": "story", "nextNodeId": "n2"},
								map[string]any{"id": "n2", "kind": "end"},
							},
						},
					},
				},
			},
		},
	}
	updateResp := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/draft", map[string]any{
		"draft_version":  1,
		"title":          "Publish Course",
		"description":    "Basics",
		"cover_asset_id": nil,
		"content":        validContent,
	}, teacherCSRF)
	if updateResp.StatusCode != http.StatusOK {
		t.Fatalf("update for publish status: %d", updateResp.StatusCode)
	}

	submitResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/submit-review", map[string]any{}, teacherCSRF)
	if submitResp.StatusCode != http.StatusOK {
		t.Fatalf("submit review status: %d", submitResp.StatusCode)
	}
	defer submitResp.Body.Close()
	var review struct {
		ReviewID string `json:"review_id"`
	}
	_ = json.NewDecoder(submitResp.Body).Decode(&review)

	queueResp, err := adminClient.Get(testApp.Server.URL + "/api/v1/admin/moderation/queue")
	if err != nil {
		t.Fatalf("moderation queue: %v", err)
	}
	if queueResp.StatusCode != http.StatusOK {
		t.Fatalf("moderation queue status: %d", queueResp.StatusCode)
	}

	approveResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/moderation/reviews/"+review.ReviewID+"/approve", map[string]any{"comment": "ok"}, adminCSRF)
	if approveResp.StatusCode != http.StatusOK {
		t.Fatalf("approve review status: %d", approveResp.StatusCode)
	}

	reapproveResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/moderation/reviews/"+review.ReviewID+"/approve", map[string]any{"comment": "again"}, adminCSRF)
	if reapproveResp.StatusCode != http.StatusConflict {
		t.Fatalf("reapprove status: %d", reapproveResp.StatusCode)
	}

	adminCreateResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/courses", map[string]any{
		"title":       "Platform",
		"description": "Basics",
	}, adminCSRF)
	defer adminCreateResp.Body.Close()
	var adminCreated struct {
		CourseID string `json:"course_id"`
	}
	_ = json.NewDecoder(adminCreateResp.Body).Decode(&adminCreated)
	adminUpdateResp := performJSON(t, adminClient, http.MethodPut, testApp.Server.URL+"/api/v1/admin/courses/"+adminCreated.CourseID+"/draft", map[string]any{
		"draft_version":  1,
		"title":          "Platform",
		"description":    "Basics",
		"cover_asset_id": nil,
		"content":        validContent,
	}, adminCSRF)
	if adminUpdateResp.StatusCode != http.StatusOK {
		t.Fatalf("admin update draft status: %d", adminUpdateResp.StatusCode)
	}
	publishResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/courses/"+adminCreated.CourseID+"/publish", map[string]any{}, adminCSRF)
	if publishResp.StatusCode != http.StatusOK {
		t.Fatalf("admin publish status: %d", publishResp.StatusCode)
	}
}

func TestPreview_StaleVersionAndAdminSessionOwnership(t *testing.T) {
	testApp := app.New(t)
	adminOwner := httpclient.New(t)
	adminOwnerCSRF := loginExistingAdmin(t, adminOwner, testApp)

	adminOther := httpclient.New(t)
	startResp, err := adminOther.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/start")
	if err != nil {
		t.Fatalf("start second admin sso: %v", err)
	}
	startLocation, _ := url.Parse(startResp.Header.Get("Location"))
	callbackResp, err := adminOther.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/callback?state=" + startLocation.Query().Get("state") + "&code=admin-preview-2")
	if err != nil {
		t.Fatalf("callback second admin sso: %v", err)
	}
	if callbackResp.StatusCode != http.StatusFound {
		t.Fatalf("callback second admin status: %d", callbackResp.StatusCode)
	}
	if _, err := testApp.DB.Pool().Exec(context.Background(), `
		update accounts
		set role = 'admin', status = 'active'
		where id = (
			select account_id from external_identities
			where provider = 'yandex' and provider_subject = 'admin-preview-2'
		);
		insert into admin_profiles(account_id, display_name)
		select account_id, 'Admin Two'
		from external_identities
		where provider = 'yandex' and provider_subject = 'admin-preview-2'
		on conflict (account_id) do nothing;
	`); err != nil {
		t.Fatalf("promote second admin: %v", err)
	}
	adminOtherSession, err := adminOther.Get(testApp.Server.URL + "/api/v1/session")
	if err != nil {
		t.Fatalf("second admin session: %v", err)
	}
	defer adminOtherSession.Body.Close()
	var adminOtherBody struct {
		CSRFToken string `json:"csrf_token"`
	}
	if err := json.NewDecoder(adminOtherSession.Body).Decode(&adminOtherBody); err != nil {
		t.Fatalf("decode second admin session: %v", err)
	}

	courseID, _ := publishPlatformCourse(t, adminOwner, testApp, adminOwnerCSRF, "Preview Policy", map[string]any{
		"modules": []any{
			map[string]any{
				"id": "module_1",
				"lessons": []any{
					map[string]any{
						"id":    "lesson_1",
						"title": "Preview",
						"graph": map[string]any{
							"startNodeId": "n1",
							"nodes": []any{
								map[string]any{"id": "n1", "kind": "story", "body": map[string]any{"text": "Start"}, "nextNodeId": "n2"},
								map[string]any{"id": "n2", "kind": "end", "text": "Done"},
							},
						},
					},
				},
			},
		},
	})

	previewResp := performJSON(t, adminOwner, http.MethodPost, testApp.Server.URL+"/api/v1/admin/courses/"+courseID+"/preview", map[string]any{"lesson_id": "lesson_1"}, adminOwnerCSRF)
	if previewResp.StatusCode != http.StatusOK {
		t.Fatalf("admin owner preview start status: %d", previewResp.StatusCode)
	}
	defer previewResp.Body.Close()
	var preview struct {
		PreviewSessionID string `json:"preview_session_id"`
		Step             struct {
			StateVersion int64 `json:"state_version"`
		} `json:"step"`
	}
	if err := json.NewDecoder(previewResp.Body).Decode(&preview); err != nil {
		t.Fatalf("decode preview ownership test: %v", err)
	}

	staleNext := performJSON(t, adminOwner, http.MethodPost, testApp.Server.URL+"/api/v1/preview-sessions/"+preview.PreviewSessionID+"/next", map[string]any{
		"state_version": preview.Step.StateVersion - 1,
	}, adminOwnerCSRF)
	if staleNext.StatusCode != http.StatusConflict {
		t.Fatalf("stale preview next status: %d", staleNext.StatusCode)
	}

	foreignAdminNext := performJSON(t, adminOther, http.MethodPost, testApp.Server.URL+"/api/v1/preview-sessions/"+preview.PreviewSessionID+"/next", map[string]any{
		"state_version": preview.Step.StateVersion,
	}, adminOtherBody.CSRFToken)
	if foreignAdminNext.StatusCode != http.StatusNotFound {
		t.Fatalf("foreign admin preview next status: %d", foreignAdminNext.StatusCode)
	}
}

func TestPublication_RejectResubmitVersioningAndRevisionIntegrity(t *testing.T) {
	testApp := app.New(t)
	teacherClient := httpclient.New(t)
	teacherCSRF, _ := loginAsRole(t, teacherClient, testApp, "teacher-publish-matrix", "teacher")
	_ = performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/profile", map[string]any{
		"display_name":      "Teacher Matrix",
		"organization_name": "Org",
		"avatar_asset_id":   nil,
	}, teacherCSRF)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)

	createResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses", map[string]any{
		"title":       "Matrix Course",
		"description": "Basics",
	}, teacherCSRF)
	if createResp.StatusCode != http.StatusCreated {
		t.Fatalf("create teacher matrix course status: %d", createResp.StatusCode)
	}
	defer createResp.Body.Close()
	var created struct {
		CourseID string `json:"course_id"`
	}
	if err := json.NewDecoder(createResp.Body).Decode(&created); err != nil {
		t.Fatalf("decode created matrix course: %v", err)
	}

	contentV1 := map[string]any{
		"modules": []any{
			map[string]any{
				"id": "module_1",
				"lessons": []any{
					map[string]any{
						"id":    "lesson_1",
						"title": "One",
						"graph": map[string]any{
							"startNodeId": "n1",
							"nodes":       []any{map[string]any{"id": "n1", "kind": "end", "text": "Done"}},
						},
					},
				},
			},
		},
	}
	updateResp := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/draft", map[string]any{
		"draft_version":  1,
		"title":          "Matrix Course",
		"description":    "Basics",
		"cover_asset_id": nil,
		"content":        contentV1,
	}, teacherCSRF)
	if updateResp.StatusCode != http.StatusOK {
		t.Fatalf("initial matrix draft update status: %d", updateResp.StatusCode)
	}

	submitResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/submit-review", map[string]any{}, teacherCSRF)
	if submitResp.StatusCode != http.StatusOK {
		t.Fatalf("submit rejected review status: %d", submitResp.StatusCode)
	}
	defer submitResp.Body.Close()
	var review1 struct {
		ReviewID string `json:"review_id"`
	}
	if err := json.NewDecoder(submitResp.Body).Decode(&review1); err != nil {
		t.Fatalf("decode review1: %v", err)
	}

	rejectResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/moderation/reviews/"+review1.ReviewID+"/reject", map[string]any{
		"comment": "needs fixes",
	}, adminCSRF)
	if rejectResp.StatusCode != http.StatusOK {
		t.Fatalf("reject review1 status: %d", rejectResp.StatusCode)
	}
	rejectAgain := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/moderation/reviews/"+review1.ReviewID+"/reject", map[string]any{
		"comment": "again",
	}, adminCSRF)
	if rejectAgain.StatusCode != http.StatusConflict {
		t.Fatalf("reject resolved review1 status: %d", rejectAgain.StatusCode)
	}
	approveRejected := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/moderation/reviews/"+review1.ReviewID+"/approve", map[string]any{
		"comment": "late approve",
	}, adminCSRF)
	if approveRejected.StatusCode != http.StatusConflict {
		t.Fatalf("approve rejected review1 status: %d", approveRejected.StatusCode)
	}

	reviewStatusResp, err := teacherClient.Get(testApp.Server.URL + "/api/v1/teacher/courses/" + created.CourseID + "/review-status")
	if err != nil {
		t.Fatalf("teacher review status request: %v", err)
	}
	defer reviewStatusResp.Body.Close()
	var reviewStatus struct {
		Current *struct {
			Status        string  `json:"status"`
			ReviewComment *string `json:"review_comment"`
		} `json:"current"`
		History []struct {
			ReviewID      string  `json:"review_id"`
			Status        string  `json:"status"`
			ReviewComment *string `json:"review_comment"`
		} `json:"history"`
	}
	if err := json.NewDecoder(reviewStatusResp.Body).Decode(&reviewStatus); err != nil {
		t.Fatalf("decode review status after reject: %v", err)
	}
	if reviewStatus.Current == nil || reviewStatus.Current.Status != "rejected" || reviewStatus.Current.ReviewComment == nil || *reviewStatus.Current.ReviewComment != "needs fixes" {
		t.Fatalf("unexpected rejected review status payload: %+v", reviewStatus)
	}

	draftResp, err := teacherClient.Get(testApp.Server.URL + "/api/v1/teacher/courses/" + created.CourseID + "/draft")
	if err != nil {
		t.Fatalf("get draft after reject: %v", err)
	}
	defer draftResp.Body.Close()
	var draft struct {
		DraftVersion   int64  `json:"draft_version"`
		WorkflowStatus string `json:"workflow_status"`
	}
	if err := json.NewDecoder(draftResp.Body).Decode(&draft); err != nil {
		t.Fatalf("decode draft after reject: %v", err)
	}
	if draft.WorkflowStatus != "changes_requested" {
		t.Fatalf("unexpected workflow after reject: %s", draft.WorkflowStatus)
	}

	var revisionsAfterReject int
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from course_revisions where course_id = $1`, created.CourseID).Scan(&revisionsAfterReject); err != nil {
		t.Fatalf("count revisions after reject: %v", err)
	}
	if revisionsAfterReject != 0 {
		t.Fatalf("approve-after-reject must not create revisions, got %d", revisionsAfterReject)
	}

	contentV2 := map[string]any{
		"modules": []any{
			map[string]any{
				"id": "module_1",
				"lessons": []any{
					map[string]any{
						"id":    "lesson_1",
						"title": "One v1",
						"graph": map[string]any{
							"startNodeId": "n1",
							"nodes":       []any{map[string]any{"id": "n1", "kind": "end", "text": "Done"}},
						},
					},
					map[string]any{
						"id":    "lesson_2",
						"title": "Two v1",
						"graph": map[string]any{
							"startNodeId": "m1",
							"nodes":       []any{map[string]any{"id": "m1", "kind": "end", "text": "Done"}},
						},
					},
				},
			},
		},
	}
	resubmitUpdate := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/draft", map[string]any{
		"draft_version":  draft.DraftVersion,
		"title":          "Matrix Published V1",
		"description":    "Approved once",
		"cover_asset_id": nil,
		"content":        contentV2,
	}, teacherCSRF)
	if resubmitUpdate.StatusCode != http.StatusOK {
		t.Fatalf("resubmit update status: %d", resubmitUpdate.StatusCode)
	}

	submitResp = performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/submit-review", map[string]any{}, teacherCSRF)
	if submitResp.StatusCode != http.StatusOK {
		t.Fatalf("submit approved review status: %d", submitResp.StatusCode)
	}
	defer submitResp.Body.Close()
	var review2 struct {
		ReviewID string `json:"review_id"`
	}
	if err := json.NewDecoder(submitResp.Body).Decode(&review2); err != nil {
		t.Fatalf("decode review2: %v", err)
	}
	approveResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/moderation/reviews/"+review2.ReviewID+"/approve", map[string]any{
		"comment": "looks good",
	}, adminCSRF)
	if approveResp.StatusCode != http.StatusOK {
		t.Fatalf("approve review2 status: %d", approveResp.StatusCode)
	}
	rejectApproved := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/moderation/reviews/"+review2.ReviewID+"/reject", map[string]any{
		"comment": "too late",
	}, adminCSRF)
	if rejectApproved.StatusCode != http.StatusConflict {
		t.Fatalf("reject approved review2 status: %d", rejectApproved.StatusCode)
	}

	var revision1ID, revision1Title, revision1Content string
	var revision1Version int
	var revision1Current bool
	if err := testApp.DB.Pool().QueryRow(context.Background(), `
		select id::text, version_no, title, content_json::text, is_current
		from course_revisions
		where course_id = $1
		order by version_no asc
		limit 1
	`, created.CourseID).Scan(&revision1ID, &revision1Version, &revision1Title, &revision1Content, &revision1Current); err != nil {
		t.Fatalf("query revision1: %v", err)
	}
	if revision1Version != 1 || !revision1Current || revision1Title != "Matrix Published V1" {
		t.Fatalf("unexpected first revision snapshot: id=%s version=%d current=%v title=%s", revision1ID, revision1Version, revision1Current, revision1Title)
	}
	var revision1Lessons int
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from course_revision_lessons where course_revision_id = $1`, revision1ID).Scan(&revision1Lessons); err != nil {
		t.Fatalf("count revision1 lessons: %v", err)
	}
	if revision1Lessons != 2 {
		t.Fatalf("expected two materialized lessons in revision1, got %d", revision1Lessons)
	}

	draftResp, err = teacherClient.Get(testApp.Server.URL + "/api/v1/teacher/courses/" + created.CourseID + "/draft")
	if err != nil {
		t.Fatalf("get draft after first publish: %v", err)
	}
	defer draftResp.Body.Close()
	if err := json.NewDecoder(draftResp.Body).Decode(&draft); err != nil {
		t.Fatalf("decode draft after first publish: %v", err)
	}

	contentV3 := map[string]any{
		"modules": []any{
			map[string]any{
				"id": "module_1",
				"lessons": []any{
					map[string]any{
						"id":    "lesson_1",
						"title": "One v2",
						"graph": map[string]any{
							"startNodeId": "z1",
							"nodes":       []any{map[string]any{"id": "z1", "kind": "end", "text": "Done"}},
						},
					},
				},
			},
		},
	}
	secondUpdate := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/draft", map[string]any{
		"draft_version":  draft.DraftVersion,
		"title":          "Matrix Published V2",
		"description":    "Approved twice",
		"cover_asset_id": nil,
		"content":        contentV3,
	}, teacherCSRF)
	if secondUpdate.StatusCode != http.StatusOK {
		t.Fatalf("second draft update status: %d", secondUpdate.StatusCode)
	}

	var unchangedTitle, unchangedContent string
	if err := testApp.DB.Pool().QueryRow(context.Background(), `
		select title, content_json::text
		from course_revisions
		where id = $1
	`, revision1ID).Scan(&unchangedTitle, &unchangedContent); err != nil {
		t.Fatalf("query unchanged revision1: %v", err)
	}
	if unchangedTitle != revision1Title || unchangedContent != revision1Content {
		t.Fatalf("published revision must stay immutable after draft edits")
	}

	submitResp = performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/submit-review", map[string]any{}, teacherCSRF)
	if submitResp.StatusCode != http.StatusOK {
		t.Fatalf("submit third review status: %d", submitResp.StatusCode)
	}
	defer submitResp.Body.Close()
	var review3 struct {
		ReviewID string `json:"review_id"`
	}
	if err := json.NewDecoder(submitResp.Body).Decode(&review3); err != nil {
		t.Fatalf("decode review3: %v", err)
	}
	approveResp = performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/moderation/reviews/"+review3.ReviewID+"/approve", map[string]any{
		"comment": "approved again",
	}, adminCSRF)
	if approveResp.StatusCode != http.StatusOK {
		t.Fatalf("approve review3 status: %d", approveResp.StatusCode)
	}

	rows, err := testApp.DB.Pool().Query(context.Background(), `
		select id::text, version_no, title, is_current, disabled_at is not null
		from course_revisions
		where course_id = $1
		order by version_no asc
	`, created.CourseID)
	if err != nil {
		t.Fatalf("query revision history: %v", err)
	}
	defer rows.Close()
	type revisionRow struct {
		ID         string
		VersionNo  int
		Title      string
		IsCurrent  bool
		IsDisabled bool
	}
	revisions := make([]revisionRow, 0)
	for rows.Next() {
		var row revisionRow
		if err := rows.Scan(&row.ID, &row.VersionNo, &row.Title, &row.IsCurrent, &row.IsDisabled); err != nil {
			t.Fatalf("scan revision row: %v", err)
		}
		revisions = append(revisions, row)
	}
	if len(revisions) != 2 || revisions[0].VersionNo != 1 || revisions[1].VersionNo != 2 {
		t.Fatalf("unexpected revision ordering: %+v", revisions)
	}
	if revisions[0].IsCurrent || !revisions[0].IsDisabled || !revisions[1].IsCurrent || revisions[1].Title != "Matrix Published V2" {
		t.Fatalf("unexpected final revision states: %+v", revisions)
	}
	var revision2Lessons int
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from course_revision_lessons where course_revision_id = $1`, revisions[1].ID).Scan(&revision2Lessons); err != nil {
		t.Fatalf("count revision2 lessons: %v", err)
	}
	if revision2Lessons != 1 {
		t.Fatalf("expected one lesson in revision2 materialization, got %d", revision2Lessons)
	}
}

func TestPublication_AdminDirectPublishRejectsTeacherOwnedCourse(t *testing.T) {
	testApp := app.New(t)
	teacherClient := httpclient.New(t)
	teacherCSRF, _ := loginAsRole(t, teacherClient, testApp, "teacher-direct-publish-deny", "teacher")
	_ = performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/profile", map[string]any{
		"display_name":      "Teacher",
		"organization_name": "Org",
		"avatar_asset_id":   nil,
	}, teacherCSRF)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)

	createResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses", map[string]any{
		"title":       "Teacher Course",
		"description": "Basics",
	}, teacherCSRF)
	if createResp.StatusCode != http.StatusCreated {
		t.Fatalf("create teacher direct-publish course status: %d", createResp.StatusCode)
	}
	defer createResp.Body.Close()
	var created struct {
		CourseID string `json:"course_id"`
	}
	if err := json.NewDecoder(createResp.Body).Decode(&created); err != nil {
		t.Fatalf("decode teacher direct-publish course: %v", err)
	}

	updateResp := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/draft", map[string]any{
		"draft_version":  1,
		"title":          "Teacher Course",
		"description":    "Basics",
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
	if updateResp.StatusCode != http.StatusOK {
		t.Fatalf("update teacher direct-publish course status: %d", updateResp.StatusCode)
	}

	publishResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/courses/"+created.CourseID+"/publish", map[string]any{}, adminCSRF)
	if publishResp.StatusCode != http.StatusConflict {
		t.Fatalf("admin direct publish teacher-owned status: %d", publishResp.StatusCode)
	}
}
