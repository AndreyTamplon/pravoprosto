package tests

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"pravoprost/backend/internal/testkit/app"
	httpclient "pravoprost/backend/internal/testkit/http"
)

func TestStudentCatalogTree_PrerequisitePinnedRevisionAndTeacherLock(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)

	contentV1 := map[string]any{
		"modules": []any{
			map[string]any{
				"id":    "module_1",
				"title": "Module 1",
				"lessons": []any{
					map[string]any{
						"id":    "lesson_1",
						"title": "Lesson 1",
						"graph": map[string]any{
							"startNodeId": "n1",
							"nodes": []any{
								map[string]any{"id": "n1", "kind": "story", "body": map[string]any{"text": "Start"}, "nextNodeId": "n2"},
								map[string]any{"id": "n2", "kind": "end", "text": "Done"},
							},
						},
					},
					map[string]any{
						"id":    "lesson_2",
						"title": "Lesson 2",
						"graph": map[string]any{
							"startNodeId": "m1",
							"nodes": []any{
								map[string]any{"id": "m1", "kind": "story", "body": map[string]any{"text": "Next"}, "nextNodeId": "m2"},
								map[string]any{"id": "m2", "kind": "end", "text": "Done"},
							},
						},
					},
				},
			},
		},
	}
	platformCourseID, revisionV1 := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Platform Course", contentV1)

	studentClient := httpclient.New(t)
	studentCSRF, _ := loginAsRole(t, studentClient, testApp, "student-runtime-a", "student")

	catalogResp, err := studentClient.Get(testApp.Server.URL + "/api/v1/student/catalog")
	if err != nil {
		t.Fatalf("student catalog: %v", err)
	}
	defer catalogResp.Body.Close()
	var catalog struct {
		Sections []struct {
			Section string `json:"section"`
			Items   []struct {
				CourseID string `json:"course_id"`
			} `json:"items"`
		} `json:"sections"`
	}
	if err := json.NewDecoder(catalogResp.Body).Decode(&catalog); err != nil {
		t.Fatalf("decode catalog: %v", err)
	}
	found := false
	for _, section := range catalog.Sections {
		for _, item := range section.Items {
			if item.CourseID == platformCourseID {
				found = true
			}
		}
	}
	if !found {
		t.Fatalf("platform course missing from catalog")
	}

	tree := fetchStudentTree(t, studentClient, testApp, platformCourseID)
	if tree.CourseRevisionID != revisionV1 {
		t.Fatalf("unexpected initial revision: %s", tree.CourseRevisionID)
	}
	if len(tree.Modules) != 1 || len(tree.Modules[0].Lessons) != 2 {
		t.Fatalf("unexpected initial tree: %+v", tree.Modules)
	}
	if tree.Modules[0].Lessons[0].Access.AccessState != "free" {
		t.Fatalf("first lesson should be free, got %s", tree.Modules[0].Lessons[0].Access.AccessState)
	}
	if tree.Modules[0].Lessons[1].Access.AccessState != "locked_prerequisite" {
		t.Fatalf("second lesson should be locked by prerequisite, got %s", tree.Modules[0].Lessons[1].Access.AccessState)
	}

	lockedResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+platformCourseID+"/lessons/lesson_2/start", map[string]any{}, studentCSRF)
	if lockedResp.StatusCode != http.StatusConflict {
		t.Fatalf("locked prerequisite start status: %d", lockedResp.StatusCode)
	}

	startResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+platformCourseID+"/lessons/lesson_1/start", map[string]any{}, studentCSRF)
	if startResp.StatusCode != http.StatusOK {
		t.Fatalf("start lesson_1 status: %d", startResp.StatusCode)
	}
	defer startResp.Body.Close()
	var firstStart struct {
		SessionID string `json:"session_id"`
	}
	if err := json.NewDecoder(startResp.Body).Decode(&firstStart); err != nil {
		t.Fatalf("decode first start: %v", err)
	}

	resumeResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+platformCourseID+"/lessons/lesson_1/start", map[string]any{}, studentCSRF)
	if resumeResp.StatusCode != http.StatusOK {
		t.Fatalf("resume lesson_1 status: %d", resumeResp.StatusCode)
	}
	defer resumeResp.Body.Close()
	var secondStart struct {
		SessionID string `json:"session_id"`
	}
	if err := json.NewDecoder(resumeResp.Body).Decode(&secondStart); err != nil {
		t.Fatalf("decode second start: %v", err)
	}
	if secondStart.SessionID != firstStart.SessionID {
		t.Fatalf("expected same active session, got %s and %s", firstStart.SessionID, secondStart.SessionID)
	}

	contentV2 := map[string]any{
		"modules": []any{
			map[string]any{
				"id":    "module_1",
				"title": "Module 1",
				"lessons": []any{
					map[string]any{
						"id":    "lesson_1",
						"title": "Lesson 1",
						"graph": map[string]any{
							"startNodeId": "n1",
							"nodes": []any{
								map[string]any{"id": "n1", "kind": "story", "body": map[string]any{"text": "Start"}, "nextNodeId": "n2"},
								map[string]any{"id": "n2", "kind": "end", "text": "Done"},
							},
						},
					},
					map[string]any{
						"id":    "lesson_2",
						"title": "Lesson 2",
						"graph": map[string]any{
							"startNodeId": "m1",
							"nodes": []any{
								map[string]any{"id": "m1", "kind": "story", "body": map[string]any{"text": "Next"}, "nextNodeId": "m2"},
								map[string]any{"id": "m2", "kind": "end", "text": "Done"},
							},
						},
					},
					map[string]any{
						"id":    "lesson_3",
						"title": "Lesson 3",
						"graph": map[string]any{
							"startNodeId": "x1",
							"nodes": []any{
								map[string]any{"id": "x1", "kind": "story", "body": map[string]any{"text": "Latest"}, "nextNodeId": "x2"},
								map[string]any{"id": "x2", "kind": "end", "text": "Done"},
							},
						},
					},
				},
			},
		},
	}
	revisionV2 := republishPlatformCourse(t, adminClient, testApp, adminCSRF, platformCourseID, "Platform Course", contentV2)
	if revisionV2 == revisionV1 {
		t.Fatalf("expected new revision after republish")
	}

	pinnedTree := fetchStudentTree(t, studentClient, testApp, platformCourseID)
	if pinnedTree.CourseRevisionID != revisionV1 {
		t.Fatalf("started course should stay pinned to old revision, got %s", pinnedTree.CourseRevisionID)
	}
	if len(pinnedTree.Modules[0].Lessons) != 2 {
		t.Fatalf("pinned tree should still expose old revision lessons, got %d", len(pinnedTree.Modules[0].Lessons))
	}

	freshStudentClient := httpclient.New(t)
	_, _ = loginAsRole(t, freshStudentClient, testApp, "student-runtime-b", "student")
	freshTree := fetchStudentTree(t, freshStudentClient, testApp, platformCourseID)
	if freshTree.CourseRevisionID != revisionV2 {
		t.Fatalf("fresh student should see new revision, got %s", freshTree.CourseRevisionID)
	}
	if len(freshTree.Modules[0].Lessons) != 3 {
		t.Fatalf("fresh student should see latest lessons, got %d", len(freshTree.Modules[0].Lessons))
	}

	teacherClient := httpclient.New(t)
	teacherCSRF, _ := loginAsRole(t, teacherClient, testApp, "teacher-private-runtime", "teacher")
	profileResp := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/profile", map[string]any{
		"display_name":      "Teacher",
		"organization_name": "Org",
		"avatar_asset_id":   nil,
	}, teacherCSRF)
	if profileResp.StatusCode != http.StatusOK {
		t.Fatalf("teacher profile status: %d", profileResp.StatusCode)
	}
	createResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses", map[string]any{
		"title":       "Private",
		"description": "Hidden",
	}, teacherCSRF)
	if createResp.StatusCode != http.StatusCreated {
		t.Fatalf("teacher create status: %d", createResp.StatusCode)
	}
	defer createResp.Body.Close()
	var teacherCreated struct {
		CourseID string `json:"course_id"`
	}
	if err := json.NewDecoder(createResp.Body).Decode(&teacherCreated); err != nil {
		t.Fatalf("decode teacher course: %v", err)
	}
	updateResp := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/courses/"+teacherCreated.CourseID+"/draft", map[string]any{
		"draft_version":  1,
		"title":          "Private",
		"description":    "Hidden",
		"cover_asset_id": nil,
		"content": map[string]any{
			"modules": []any{
				map[string]any{
					"id": "module_1",
					"lessons": []any{
						map[string]any{
							"id":    "lesson_1",
							"title": "Private lesson",
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
		},
	}, teacherCSRF)
	if updateResp.StatusCode != http.StatusOK {
		t.Fatalf("teacher update status: %d", updateResp.StatusCode)
	}
	adminApproveTeacherCourse(t, adminClient, testApp, adminCSRF, teacherClient, teacherCSRF, teacherCreated.CourseID)

	privateTreeResp, err := studentClient.Get(testApp.Server.URL + "/api/v1/student/courses/" + teacherCreated.CourseID)
	if err != nil {
		t.Fatalf("student private tree: %v", err)
	}
	if privateTreeResp.StatusCode != http.StatusForbidden {
		t.Fatalf("teacher course tree lock status: %d", privateTreeResp.StatusCode)
	}
	privateStartResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+teacherCreated.CourseID+"/lessons/lesson_1/start", map[string]any{}, studentCSRF)
	if privateStartResp.StatusCode != http.StatusForbidden {
		t.Fatalf("teacher course start lock status: %d", privateStartResp.StatusCode)
	}
}

func TestStudentRuntime_StoryToEndCompletionUnlocksNextLesson(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)

	courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Story To End Runtime", map[string]any{
		"modules": []any{
			map[string]any{
				"id":    "module_1",
				"title": "Module 1",
				"lessons": []any{
					map[string]any{
						"id":    "lesson_1",
						"title": "Lesson 1",
						"graph": map[string]any{
							"startNodeId": "intro",
							"nodes": []any{
								map[string]any{"id": "intro", "kind": "story", "body": map[string]any{"text": "Intro"}, "nextNodeId": "question"},
								map[string]any{
									"id":     "question",
									"kind":   "single_choice",
									"prompt": "Question",
									"options": []any{
										map[string]any{"id": "a1", "text": "Correct", "result": "correct", "feedback": "Correct", "nextNodeId": "after"},
										map[string]any{"id": "a2", "text": "Wrong", "result": "incorrect", "feedback": "Wrong", "nextNodeId": "after"},
									},
								},
								map[string]any{"id": "after", "kind": "story", "body": map[string]any{"text": "After"}, "nextNodeId": "end"},
								map[string]any{"id": "end", "kind": "end", "text": "Done"},
							},
						},
					},
					map[string]any{
						"id":    "lesson_2",
						"title": "Lesson 2",
						"graph": map[string]any{
							"startNodeId": "s1",
							"nodes": []any{
								map[string]any{"id": "s1", "kind": "story", "body": map[string]any{"text": "Second"}, "nextNodeId": "s2"},
								map[string]any{"id": "s2", "kind": "end", "text": "Done"},
							},
						},
					},
				},
			},
		},
	})

	studentClient := httpclient.New(t)
	studentCSRF, studentID := loginAsRole(t, studentClient, testApp, "story-to-end-student", "student")

	initialTree := fetchStudentTree(t, studentClient, testApp, courseID)
	if initialTree.Modules[0].Lessons[0].Access.AccessState != "free" {
		t.Fatalf("first lesson should be free, got %s", initialTree.Modules[0].Lessons[0].Access.AccessState)
	}
	if initialTree.Modules[0].Lessons[1].Access.AccessState != "locked_prerequisite" {
		t.Fatalf("second lesson should start locked, got %s", initialTree.Modules[0].Lessons[1].Access.AccessState)
	}

	startResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/start", map[string]any{}, studentCSRF)
	if startResp.StatusCode != http.StatusOK {
		t.Fatalf("start lesson_1 status: %d", startResp.StatusCode)
	}
	defer startResp.Body.Close()
	var start struct {
		SessionID    string `json:"session_id"`
		StateVersion int64  `json:"state_version"`
		NodeID       string `json:"node_id"`
	}
	if err := json.NewDecoder(startResp.Body).Decode(&start); err != nil {
		t.Fatalf("decode start: %v", err)
	}

	questionResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/next", map[string]any{
		"state_version":    start.StateVersion,
		"expected_node_id": start.NodeID,
	}, studentCSRF)
	if questionResp.StatusCode != http.StatusOK {
		t.Fatalf("question next status: %d", questionResp.StatusCode)
	}
	defer questionResp.Body.Close()
	var question struct {
		StateVersion int64  `json:"state_version"`
		NodeID       string `json:"node_id"`
	}
	if err := json.NewDecoder(questionResp.Body).Decode(&question); err != nil {
		t.Fatalf("decode question: %v", err)
	}

	answerResp := performJSONWithIdempotency(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/answer", map[string]any{
		"state_version": question.StateVersion,
		"node_id":       question.NodeID,
		"answer":        map[string]any{"option_id": "a1"},
	}, studentCSRF, "story-to-end-answer")
	if answerResp.StatusCode != http.StatusOK {
		t.Fatalf("answer status: %d", answerResp.StatusCode)
	}
	defer answerResp.Body.Close()
	var answer struct {
		NextStep *struct {
			StateVersion int64  `json:"state_version"`
			NodeID       string `json:"node_id"`
			NodeKind     string `json:"node_kind"`
		} `json:"next_step"`
	}
	if err := json.NewDecoder(answerResp.Body).Decode(&answer); err != nil {
		t.Fatalf("decode answer: %v", err)
	}
	if answer.NextStep == nil || answer.NextStep.NodeKind != "story" {
		t.Fatalf("expected story next step, got %+v", answer.NextStep)
	}

	endResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/next", map[string]any{
		"state_version":    answer.NextStep.StateVersion,
		"expected_node_id": answer.NextStep.NodeID,
	}, studentCSRF)
	if endResp.StatusCode != http.StatusOK {
		t.Fatalf("story-to-end next status: %d", endResp.StatusCode)
	}
	defer endResp.Body.Close()

	var lessonStatus string
	if err := testApp.DB.Pool().QueryRow(context.Background(), `
		select status
		from lesson_progress
		where student_id = $1 and lesson_id = 'lesson_1'
	`, studentID).Scan(&lessonStatus); err != nil {
		t.Fatalf("query lesson progress: %v", err)
	}
	if lessonStatus != "completed" {
		t.Fatalf("expected lesson_1 completed after story->end flow, got %s", lessonStatus)
	}

	treeAfterCompletion := fetchStudentTree(t, studentClient, testApp, courseID)
	if treeAfterCompletion.Modules[0].Lessons[0].Status != "completed" {
		t.Fatalf("expected first lesson status completed in tree, got %s", treeAfterCompletion.Modules[0].Lessons[0].Status)
	}
	if treeAfterCompletion.Modules[0].Lessons[0].Access.AccessState != "completed" {
		t.Fatalf(
			"expected first lesson access_state completed in tree, got %s (second lesson access=%s)",
			treeAfterCompletion.Modules[0].Lessons[0].Access.AccessState,
			treeAfterCompletion.Modules[0].Lessons[1].Access.AccessState,
		)
	}
	if treeAfterCompletion.Modules[0].Lessons[1].Access.AccessState != "free" {
		t.Fatalf("expected second lesson unlocked after story->end completion, got %s", treeAfterCompletion.Modules[0].Lessons[1].Access.AccessState)
	}
}

func TestTeacherAccessRuntime_StoryToEndCompletionUnlocksNextLesson(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)

	teacherClient := httpclient.New(t)
	teacherCSRF, _ := loginAsRole(t, teacherClient, testApp, "teacher-runtime-story-end", "teacher")
	profileResp := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/profile", map[string]any{
		"display_name":      "Teacher",
		"organization_name": "Org",
		"avatar_asset_id":   nil,
	}, teacherCSRF)
	if profileResp.StatusCode != http.StatusOK {
		t.Fatalf("teacher profile status: %d", profileResp.StatusCode)
	}

	createResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses", map[string]any{
		"title":       "Teacher Story To End",
		"description": "Published",
	}, teacherCSRF)
	if createResp.StatusCode != http.StatusCreated {
		t.Fatalf("teacher create course status: %d", createResp.StatusCode)
	}
	defer createResp.Body.Close()
	var created struct {
		CourseID string `json:"course_id"`
	}
	if err := json.NewDecoder(createResp.Body).Decode(&created); err != nil {
		t.Fatalf("decode teacher course: %v", err)
	}

	updateResp := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/draft", map[string]any{
		"draft_version":  1,
		"title":          "Teacher Story To End",
		"description":    "Published",
		"cover_asset_id": nil,
		"content": map[string]any{
			"modules": []any{
				map[string]any{
					"id":    "module_1",
					"title": "Module 1",
					"lessons": []any{
						map[string]any{
							"id":    "lesson_1",
							"title": "Lesson 1",
							"graph": map[string]any{
								"startNodeId": "intro",
								"nodes": []any{
									map[string]any{"id": "intro", "kind": "story", "body": map[string]any{"text": "Intro"}, "nextNodeId": "question"},
									map[string]any{
										"id":     "question",
										"kind":   "single_choice",
										"prompt": "Question",
										"options": []any{
											map[string]any{"id": "a1", "text": "Correct", "result": "correct", "feedback": "Correct", "nextNodeId": "after"},
										},
									},
									map[string]any{"id": "after", "kind": "story", "body": map[string]any{"text": "After"}, "nextNodeId": "end"},
									map[string]any{"id": "end", "kind": "end", "text": "Done"},
								},
							},
						},
						map[string]any{
							"id":    "lesson_2",
							"title": "Lesson 2",
							"graph": map[string]any{
								"startNodeId": "s1",
								"nodes": []any{
									map[string]any{"id": "s1", "kind": "story", "body": map[string]any{"text": "Second"}, "nextNodeId": "s2"},
									map[string]any{"id": "s2", "kind": "end", "text": "Done"},
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

	linkResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/access-links", map[string]any{}, teacherCSRF)
	if linkResp.StatusCode != http.StatusCreated {
		t.Fatalf("teacher create access link status: %d", linkResp.StatusCode)
	}
	defer linkResp.Body.Close()
	var link struct {
		ClaimURL string `json:"claim_url"`
	}
	if err := json.NewDecoder(linkResp.Body).Decode(&link); err != nil {
		t.Fatalf("decode teacher access link: %v", err)
	}
	token := strings.TrimPrefix(strings.Split(link.ClaimURL, "#")[1], "token=")

	studentClient := httpclient.New(t)
	studentCSRF, studentID := loginAsRole(t, studentClient, testApp, "teacher-access-story-end-student", "student")
	claimResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/course-links/claim", map[string]any{
		"token": token,
	}, studentCSRF)
	if claimResp.StatusCode != http.StatusOK {
		t.Fatalf("teacher claim link status: %d", claimResp.StatusCode)
	}

	startResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+created.CourseID+"/lessons/lesson_1/start", map[string]any{}, studentCSRF)
	if startResp.StatusCode != http.StatusOK {
		t.Fatalf("teacher start lesson_1 status: %d", startResp.StatusCode)
	}
	defer startResp.Body.Close()
	var start struct {
		SessionID    string `json:"session_id"`
		StateVersion int64  `json:"state_version"`
		NodeID       string `json:"node_id"`
	}
	if err := json.NewDecoder(startResp.Body).Decode(&start); err != nil {
		t.Fatalf("decode teacher start: %v", err)
	}

	questionResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/next", map[string]any{
		"state_version":    start.StateVersion,
		"expected_node_id": start.NodeID,
	}, studentCSRF)
	if questionResp.StatusCode != http.StatusOK {
		t.Fatalf("teacher question next status: %d", questionResp.StatusCode)
	}
	defer questionResp.Body.Close()
	var question struct {
		StateVersion int64  `json:"state_version"`
		NodeID       string `json:"node_id"`
	}
	if err := json.NewDecoder(questionResp.Body).Decode(&question); err != nil {
		t.Fatalf("decode teacher question: %v", err)
	}

	answerResp := performJSONWithIdempotency(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/answer", map[string]any{
		"state_version": question.StateVersion,
		"node_id":       question.NodeID,
		"answer":        map[string]any{"option_id": "a1"},
	}, studentCSRF, "teacher-story-end-answer")
	if answerResp.StatusCode != http.StatusOK {
		t.Fatalf("teacher answer status: %d", answerResp.StatusCode)
	}
	defer answerResp.Body.Close()
	var answer struct {
		NextStep *struct {
			StateVersion int64  `json:"state_version"`
			NodeID       string `json:"node_id"`
			NodeKind     string `json:"node_kind"`
		} `json:"next_step"`
	}
	if err := json.NewDecoder(answerResp.Body).Decode(&answer); err != nil {
		t.Fatalf("decode teacher answer: %v", err)
	}
	if answer.NextStep == nil || answer.NextStep.NodeKind != "story" {
		t.Fatalf("expected teacher story next step, got %+v", answer.NextStep)
	}

	endResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/next", map[string]any{
		"state_version":    answer.NextStep.StateVersion,
		"expected_node_id": answer.NextStep.NodeID,
	}, studentCSRF)
	if endResp.StatusCode != http.StatusOK {
		t.Fatalf("teacher story-to-end next status: %d", endResp.StatusCode)
	}
	defer endResp.Body.Close()

	treeAfterCompletion := fetchStudentTree(t, studentClient, testApp, created.CourseID)
	if treeAfterCompletion.Modules[0].Lessons[0].Status != "completed" {
		t.Fatalf("expected teacher lesson_1 completed status in tree, got %s", treeAfterCompletion.Modules[0].Lessons[0].Status)
	}
	if treeAfterCompletion.Modules[0].Lessons[0].Access.AccessState != "completed" {
		t.Fatalf("expected teacher lesson_1 completed access_state in tree, got %s", treeAfterCompletion.Modules[0].Lessons[0].Access.AccessState)
	}
	if treeAfterCompletion.Modules[0].Lessons[1].Access.AccessState != "free" {
		t.Fatalf("expected teacher lesson_2 unlocked after story->end completion, got %s for student %s", treeAfterCompletion.Modules[0].Lessons[1].Access.AccessState, studentID)
	}
}

func TestStudentRuntime_BranchingSingleChoiceSuccessBranchCompletesLesson(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)

	courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Branching Story To End", map[string]any{
		"modules": []any{
			map[string]any{
				"id":    "module_1",
				"title": "Module 1",
				"lessons": []any{
					map[string]any{
						"id":    "lesson_1",
						"title": "Lesson 1",
						"graph": map[string]any{
							"startNodeId": "intro",
							"nodes": []any{
								map[string]any{"id": "intro", "kind": "story", "body": map[string]any{"text": "Intro"}, "nextNodeId": "question"},
								map[string]any{
									"id":     "question",
									"kind":   "single_choice",
									"prompt": "Question",
									"options": []any{
										map[string]any{"id": "correct", "text": "Correct", "result": "correct", "feedback": "Correct", "nextNodeId": "success"},
										map[string]any{"id": "wrong", "text": "Wrong", "result": "incorrect", "feedback": "Wrong", "nextNodeId": "retry"},
									},
								},
								map[string]any{"id": "success", "kind": "story", "body": map[string]any{"text": "Success"}, "nextNodeId": "end"},
								map[string]any{"id": "retry", "kind": "story", "body": map[string]any{"text": "Retry"}, "nextNodeId": "end"},
								map[string]any{"id": "end", "kind": "end", "text": "Done"},
							},
						},
					},
					map[string]any{
						"id":    "lesson_2",
						"title": "Lesson 2",
						"graph": map[string]any{
							"startNodeId": "s1",
							"nodes": []any{
								map[string]any{"id": "s1", "kind": "story", "body": map[string]any{"text": "Second"}, "nextNodeId": "s2"},
								map[string]any{"id": "s2", "kind": "end", "text": "Done"},
							},
						},
					},
				},
			},
		},
	})

	studentClient := httpclient.New(t)
	studentCSRF, _ := loginAsRole(t, studentClient, testApp, "student-branching-success", "student")

	startResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/start", map[string]any{}, studentCSRF)
	if startResp.StatusCode != http.StatusOK {
		t.Fatalf("start lesson_1 status: %d", startResp.StatusCode)
	}
	defer startResp.Body.Close()
	var start struct {
		SessionID    string `json:"session_id"`
		StateVersion int64  `json:"state_version"`
		NodeID       string `json:"node_id"`
	}
	if err := json.NewDecoder(startResp.Body).Decode(&start); err != nil {
		t.Fatalf("decode start: %v", err)
	}

	questionResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/next", map[string]any{
		"state_version":    start.StateVersion,
		"expected_node_id": start.NodeID,
	}, studentCSRF)
	if questionResp.StatusCode != http.StatusOK {
		t.Fatalf("question next status: %d", questionResp.StatusCode)
	}
	defer questionResp.Body.Close()
	var question struct {
		StateVersion int64  `json:"state_version"`
		NodeID       string `json:"node_id"`
	}
	if err := json.NewDecoder(questionResp.Body).Decode(&question); err != nil {
		t.Fatalf("decode question: %v", err)
	}

	answerResp := performJSONWithIdempotency(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/answer", map[string]any{
		"state_version": question.StateVersion,
		"node_id":       question.NodeID,
		"answer":        map[string]any{"option_id": "correct"},
	}, studentCSRF, "branching-success-answer")
	if answerResp.StatusCode != http.StatusOK {
		t.Fatalf("answer status: %d", answerResp.StatusCode)
	}
	defer answerResp.Body.Close()
	var answer struct {
		NextStep *struct {
			StateVersion int64  `json:"state_version"`
			NodeID       string `json:"node_id"`
			NodeKind     string `json:"node_kind"`
		} `json:"next_step"`
	}
	if err := json.NewDecoder(answerResp.Body).Decode(&answer); err != nil {
		t.Fatalf("decode answer: %v", err)
	}
	if answer.NextStep == nil || answer.NextStep.NodeKind != "story" {
		t.Fatalf("expected story next step, got %+v", answer.NextStep)
	}

	endResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/next", map[string]any{
		"state_version":    answer.NextStep.StateVersion,
		"expected_node_id": answer.NextStep.NodeID,
	}, studentCSRF)
	if endResp.StatusCode != http.StatusOK {
		t.Fatalf("story-to-end next status: %d", endResp.StatusCode)
	}
	defer endResp.Body.Close()

	treeAfterCompletion := fetchStudentTree(t, studentClient, testApp, courseID)
	if treeAfterCompletion.Modules[0].Lessons[0].Status != "completed" {
		t.Fatalf("expected lesson_1 completed after branching success path, got %s", treeAfterCompletion.Modules[0].Lessons[0].Status)
	}
	if treeAfterCompletion.Modules[0].Lessons[0].Access.AccessState != "completed" {
		t.Fatalf("expected lesson_1 completed access_state after branching success path, got %s", treeAfterCompletion.Modules[0].Lessons[0].Access.AccessState)
	}
	if treeAfterCompletion.Progress == nil || treeAfterCompletion.Progress["completed_lessons"] != 1.0 {
		t.Fatalf("expected completed_lessons=1 after branching success path, got %+v", treeAfterCompletion.Progress)
	}
	if treeAfterCompletion.Modules[0].Lessons[1].Access.AccessState != "free" {
		t.Fatalf("expected lesson_2 unlocked after branching success path, got %s", treeAfterCompletion.Modules[0].Lessons[1].Access.AccessState)
	}
}

func TestTeacherAccessRuntime_BranchingSingleChoiceSuccessBranchCompletesLesson(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)

	teacherClient := httpclient.New(t)
	teacherCSRF, _ := loginAsRole(t, teacherClient, testApp, "teacher-branching-runtime", "teacher")
	profileResp := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/profile", map[string]any{
		"display_name":      "Teacher",
		"organization_name": "Org",
		"avatar_asset_id":   nil,
	}, teacherCSRF)
	if profileResp.StatusCode != http.StatusOK {
		t.Fatalf("teacher profile status: %d", profileResp.StatusCode)
	}

	createResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses", map[string]any{
		"title":       "Teacher Branching Story To End",
		"description": "Published",
	}, teacherCSRF)
	if createResp.StatusCode != http.StatusCreated {
		t.Fatalf("teacher create course status: %d", createResp.StatusCode)
	}
	defer createResp.Body.Close()
	var created struct {
		CourseID string `json:"course_id"`
	}
	if err := json.NewDecoder(createResp.Body).Decode(&created); err != nil {
		t.Fatalf("decode teacher course: %v", err)
	}

	updateResp := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/draft", map[string]any{
		"draft_version":  1,
		"title":          "Teacher Branching Story To End",
		"description":    "Published",
		"cover_asset_id": nil,
		"content": map[string]any{
			"modules": []any{
				map[string]any{
					"id":    "module_1",
					"title": "Module 1",
					"lessons": []any{
						map[string]any{
							"id":    "lesson_1",
							"title": "Lesson 1",
							"graph": map[string]any{
								"startNodeId": "intro",
								"nodes": []any{
									map[string]any{"id": "intro", "kind": "story", "body": map[string]any{"text": "Intro"}, "nextNodeId": "question"},
									map[string]any{
										"id":     "question",
										"kind":   "single_choice",
										"prompt": "Question",
										"options": []any{
											map[string]any{"id": "correct", "text": "Correct", "result": "correct", "feedback": "Correct", "nextNodeId": "success"},
											map[string]any{"id": "wrong", "text": "Wrong", "result": "incorrect", "feedback": "Wrong", "nextNodeId": "retry"},
										},
									},
									map[string]any{"id": "success", "kind": "story", "body": map[string]any{"text": "Success"}, "nextNodeId": "end"},
									map[string]any{"id": "retry", "kind": "story", "body": map[string]any{"text": "Retry"}, "nextNodeId": "end"},
									map[string]any{"id": "end", "kind": "end", "text": "Done"},
								},
							},
						},
						map[string]any{
							"id":    "lesson_2",
							"title": "Lesson 2",
							"graph": map[string]any{
								"startNodeId": "s1",
								"nodes": []any{
									map[string]any{"id": "s1", "kind": "story", "body": map[string]any{"text": "Second"}, "nextNodeId": "s2"},
									map[string]any{"id": "s2", "kind": "end", "text": "Done"},
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

	linkResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/access-links", map[string]any{}, teacherCSRF)
	if linkResp.StatusCode != http.StatusCreated {
		t.Fatalf("teacher create access link status: %d", linkResp.StatusCode)
	}
	defer linkResp.Body.Close()
	var link struct {
		ClaimURL string `json:"claim_url"`
	}
	if err := json.NewDecoder(linkResp.Body).Decode(&link); err != nil {
		t.Fatalf("decode teacher access link: %v", err)
	}
	token := strings.TrimPrefix(strings.Split(link.ClaimURL, "#")[1], "token=")

	studentClient := httpclient.New(t)
	studentCSRF, _ := loginAsRole(t, studentClient, testApp, "teacher-access-branching-student", "student")
	claimResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/course-links/claim", map[string]any{
		"token": token,
	}, studentCSRF)
	if claimResp.StatusCode != http.StatusOK {
		t.Fatalf("teacher claim link status: %d", claimResp.StatusCode)
	}

	startResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+created.CourseID+"/lessons/lesson_1/start", map[string]any{}, studentCSRF)
	if startResp.StatusCode != http.StatusOK {
		t.Fatalf("teacher start lesson_1 status: %d", startResp.StatusCode)
	}
	defer startResp.Body.Close()
	var start struct {
		SessionID    string `json:"session_id"`
		StateVersion int64  `json:"state_version"`
		NodeID       string `json:"node_id"`
	}
	if err := json.NewDecoder(startResp.Body).Decode(&start); err != nil {
		t.Fatalf("decode teacher start: %v", err)
	}

	questionResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/next", map[string]any{
		"state_version":    start.StateVersion,
		"expected_node_id": start.NodeID,
	}, studentCSRF)
	if questionResp.StatusCode != http.StatusOK {
		t.Fatalf("teacher question next status: %d", questionResp.StatusCode)
	}
	defer questionResp.Body.Close()
	var question struct {
		StateVersion int64  `json:"state_version"`
		NodeID       string `json:"node_id"`
	}
	if err := json.NewDecoder(questionResp.Body).Decode(&question); err != nil {
		t.Fatalf("decode teacher question: %v", err)
	}

	answerResp := performJSONWithIdempotency(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/answer", map[string]any{
		"state_version": question.StateVersion,
		"node_id":       question.NodeID,
		"answer":        map[string]any{"option_id": "correct"},
	}, studentCSRF, "teacher-branching-success-answer")
	if answerResp.StatusCode != http.StatusOK {
		t.Fatalf("teacher answer status: %d", answerResp.StatusCode)
	}
	defer answerResp.Body.Close()
	var answer struct {
		NextStep *struct {
			StateVersion int64  `json:"state_version"`
			NodeID       string `json:"node_id"`
			NodeKind     string `json:"node_kind"`
		} `json:"next_step"`
	}
	if err := json.NewDecoder(answerResp.Body).Decode(&answer); err != nil {
		t.Fatalf("decode teacher answer: %v", err)
	}
	if answer.NextStep == nil || answer.NextStep.NodeKind != "story" {
		t.Fatalf("expected teacher story next step, got %+v", answer.NextStep)
	}

	endResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/next", map[string]any{
		"state_version":    answer.NextStep.StateVersion,
		"expected_node_id": answer.NextStep.NodeID,
	}, studentCSRF)
	if endResp.StatusCode != http.StatusOK {
		t.Fatalf("teacher story-to-end next status: %d", endResp.StatusCode)
	}
	defer endResp.Body.Close()

	treeAfterCompletion := fetchStudentTree(t, studentClient, testApp, created.CourseID)
	if treeAfterCompletion.Modules[0].Lessons[0].Status != "completed" {
		t.Fatalf("expected teacher lesson_1 completed after branching success path, got %s", treeAfterCompletion.Modules[0].Lessons[0].Status)
	}
	if treeAfterCompletion.Modules[0].Lessons[0].Access.AccessState != "completed" {
		t.Fatalf("expected teacher lesson_1 completed access_state after branching success path, got %s", treeAfterCompletion.Modules[0].Lessons[0].Access.AccessState)
	}
	if treeAfterCompletion.Progress == nil || treeAfterCompletion.Progress["completed_lessons"] != 1.0 {
		t.Fatalf("expected teacher completed_lessons=1 after branching success path, got %+v", treeAfterCompletion.Progress)
	}
	if treeAfterCompletion.Modules[0].Lessons[1].Access.AccessState != "free" {
		t.Fatalf("expected teacher lesson_2 unlocked after branching success path, got %s", treeAfterCompletion.Modules[0].Lessons[1].Access.AccessState)
	}
}

func TestStudentRuntime_IdempotentStoryToEndNextCompletesInconsistentSession(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)

	courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Idempotent Story To End", map[string]any{
		"modules": []any{
			map[string]any{
				"id":    "module_1",
				"title": "Module 1",
				"lessons": []any{
					map[string]any{
						"id":    "lesson_1",
						"title": "Lesson 1",
						"graph": map[string]any{
							"startNodeId": "intro",
							"nodes": []any{
								map[string]any{"id": "intro", "kind": "story", "body": map[string]any{"text": "Intro"}, "nextNodeId": "question"},
								map[string]any{
									"id":     "question",
									"kind":   "single_choice",
									"prompt": "Question",
									"options": []any{
										map[string]any{"id": "correct", "text": "Correct", "result": "correct", "feedback": "Correct", "nextNodeId": "success"},
										map[string]any{"id": "wrong", "text": "Wrong", "result": "incorrect", "feedback": "Wrong", "nextNodeId": "retry"},
									},
								},
								map[string]any{"id": "success", "kind": "story", "body": map[string]any{"text": "Success"}, "nextNodeId": "end"},
								map[string]any{"id": "retry", "kind": "story", "body": map[string]any{"text": "Retry"}, "nextNodeId": "end"},
								map[string]any{"id": "end", "kind": "end", "text": "Done"},
							},
						},
					},
					map[string]any{
						"id":    "lesson_2",
						"title": "Lesson 2",
						"graph": map[string]any{
							"startNodeId": "s1",
							"nodes": []any{
								map[string]any{"id": "s1", "kind": "story", "body": map[string]any{"text": "Second"}, "nextNodeId": "s2"},
								map[string]any{"id": "s2", "kind": "end", "text": "Done"},
							},
						},
					},
				},
			},
		},
	})

	studentClient := httpclient.New(t)
	studentCSRF, _ := loginAsRole(t, studentClient, testApp, "student-idempotent-story-end", "student")

	startResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/start", map[string]any{}, studentCSRF)
	if startResp.StatusCode != http.StatusOK {
		t.Fatalf("start lesson_1 status: %d", startResp.StatusCode)
	}
	defer startResp.Body.Close()
	var start struct {
		SessionID    string `json:"session_id"`
		StateVersion int64  `json:"state_version"`
		NodeID       string `json:"node_id"`
	}
	if err := json.NewDecoder(startResp.Body).Decode(&start); err != nil {
		t.Fatalf("decode start: %v", err)
	}

	questionResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/next", map[string]any{
		"state_version":    start.StateVersion,
		"expected_node_id": start.NodeID,
	}, studentCSRF)
	if questionResp.StatusCode != http.StatusOK {
		t.Fatalf("question next status: %d", questionResp.StatusCode)
	}
	defer questionResp.Body.Close()
	var question struct {
		StateVersion int64  `json:"state_version"`
		NodeID       string `json:"node_id"`
	}
	if err := json.NewDecoder(questionResp.Body).Decode(&question); err != nil {
		t.Fatalf("decode question: %v", err)
	}

	answerResp := performJSONWithIdempotency(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/answer", map[string]any{
		"state_version": question.StateVersion,
		"node_id":       question.NodeID,
		"answer":        map[string]any{"option_id": "correct"},
	}, studentCSRF, "idempotent-story-end-answer")
	if answerResp.StatusCode != http.StatusOK {
		t.Fatalf("answer status: %d", answerResp.StatusCode)
	}
	defer answerResp.Body.Close()
	var answer struct {
		NextStep *struct {
			StateVersion int64  `json:"state_version"`
			NodeID       string `json:"node_id"`
			NodeKind     string `json:"node_kind"`
		} `json:"next_step"`
	}
	if err := json.NewDecoder(answerResp.Body).Decode(&answer); err != nil {
		t.Fatalf("decode answer: %v", err)
	}
	if answer.NextStep == nil || answer.NextStep.NodeKind != "story" {
		t.Fatalf("expected story next step, got %+v", answer.NextStep)
	}

	if _, err := testApp.DB.Pool().Exec(context.Background(), `
		update lesson_sessions
		set current_node_id = 'end',
		    state_version = $2
		where id = $1
	`, start.SessionID, answer.NextStep.StateVersion+1); err != nil {
		t.Fatalf("force inconsistent end session: %v", err)
	}

	endResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/next", map[string]any{
		"state_version":    answer.NextStep.StateVersion,
		"expected_node_id": answer.NextStep.NodeID,
	}, studentCSRF)
	if endResp.StatusCode != http.StatusOK {
		t.Fatalf("idempotent story-to-end next status: %d", endResp.StatusCode)
	}
	defer endResp.Body.Close()

	treeAfterCompletion := fetchStudentTree(t, studentClient, testApp, courseID)
	if treeAfterCompletion.Modules[0].Lessons[0].Status != "completed" {
		t.Fatalf("expected lesson_1 completed after idempotent story->end next, got %s", treeAfterCompletion.Modules[0].Lessons[0].Status)
	}
	if treeAfterCompletion.Modules[0].Lessons[0].Access.AccessState != "completed" {
		t.Fatalf("expected lesson_1 completed access_state after idempotent story->end next, got %s", treeAfterCompletion.Modules[0].Lessons[0].Access.AccessState)
	}
	if treeAfterCompletion.Progress == nil || treeAfterCompletion.Progress["completed_lessons"] != 1.0 {
		t.Fatalf("expected completed_lessons=1 after idempotent story->end next, got %+v", treeAfterCompletion.Progress)
	}
	if treeAfterCompletion.Modules[0].Lessons[1].Access.AccessState != "free" {
		t.Fatalf("expected lesson_2 unlocked after idempotent story->end next, got %s", treeAfterCompletion.Modules[0].Lessons[1].Access.AccessState)
	}
}

func TestStudentRuntime_ExecutionProgressAndGamification(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)

	courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Runtime Course", map[string]any{
		"modules": []any{
			map[string]any{
				"id":    "module_1",
				"title": "Runtime",
				"lessons": []any{
					map[string]any{
						"id":    "lesson_1",
						"title": "Runtime Lesson",
						"graph": map[string]any{
							"startNodeId": "n1",
							"nodes": []any{
								map[string]any{"id": "n1", "kind": "story", "body": map[string]any{"text": "Start"}, "nextNodeId": "n2"},
								map[string]any{
									"id":     "n2",
									"kind":   "single_choice",
									"prompt": "Choose",
									"options": []any{
										map[string]any{"id": "a1", "text": "Wrong", "result": "incorrect", "feedback": "No", "nextNodeId": "n3"},
										map[string]any{"id": "a2", "text": "Right", "result": "correct", "feedback": "Yes", "nextNodeId": "n3"},
									},
								},
								map[string]any{
									"id":     "n3",
									"kind":   "free_text",
									"prompt": "Why?",
									"rubric": map[string]any{"referenceAnswer": "safe password"},
									"transitions": []any{
										map[string]any{"onVerdict": "correct", "nextNodeId": "n4"},
										map[string]any{"onVerdict": "partial", "nextNodeId": "n4"},
										map[string]any{"onVerdict": "incorrect", "nextNodeId": "n4"},
									},
								},
								map[string]any{"id": "n4", "kind": "end", "text": "Done"},
							},
						},
					},
				},
			},
		},
	})

	studentClient := httpclient.New(t)
	studentCSRF, studentID := loginAsRole(t, studentClient, testApp, "student-runtime-main", "student")

	startResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/start", map[string]any{}, studentCSRF)
	if startResp.StatusCode != http.StatusOK {
		t.Fatalf("start runtime lesson status: %d", startResp.StatusCode)
	}
	defer startResp.Body.Close()
	var start struct {
		SessionID    string `json:"session_id"`
		StateVersion int64  `json:"state_version"`
		NodeID       string `json:"node_id"`
		NodeKind     string `json:"node_kind"`
	}
	if err := json.NewDecoder(startResp.Body).Decode(&start); err != nil {
		t.Fatalf("decode start step: %v", err)
	}
	if start.NodeKind != "story" {
		t.Fatalf("expected story start, got %s", start.NodeKind)
	}

	restoreByLessonResp, err := studentClient.Get(testApp.Server.URL + "/api/v1/student/courses/" + courseID + "/lessons/lesson_1/session")
	if err != nil {
		t.Fatalf("restore by lesson: %v", err)
	}
	defer restoreByLessonResp.Body.Close()
	var restoreByLesson struct {
		SessionID string `json:"session_id"`
	}
	if err := json.NewDecoder(restoreByLessonResp.Body).Decode(&restoreByLesson); err != nil {
		t.Fatalf("decode restore by lesson: %v", err)
	}
	if restoreByLesson.SessionID != start.SessionID {
		t.Fatalf("restore by lesson returned wrong session: %s", restoreByLesson.SessionID)
	}

	restoreByIDResp, err := studentClient.Get(testApp.Server.URL + "/api/v1/student/lesson-sessions/" + start.SessionID)
	if err != nil {
		t.Fatalf("restore by session id: %v", err)
	}
	defer restoreByIDResp.Body.Close()
	var restoreByID struct {
		SessionID string `json:"session_id"`
	}
	if err := json.NewDecoder(restoreByIDResp.Body).Decode(&restoreByID); err != nil {
		t.Fatalf("decode restore by id: %v", err)
	}
	if restoreByID.SessionID != start.SessionID {
		t.Fatalf("restore by id returned wrong session: %s", restoreByID.SessionID)
	}

	nextResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/next", map[string]any{
		"state_version":    start.StateVersion,
		"expected_node_id": start.NodeID,
	}, studentCSRF)
	if nextResp.StatusCode != http.StatusOK {
		t.Fatalf("next status: %d", nextResp.StatusCode)
	}
	defer nextResp.Body.Close()
	var questionStep struct {
		SessionID    string `json:"session_id"`
		StateVersion int64  `json:"state_version"`
		NodeID       string `json:"node_id"`
		NodeKind     string `json:"node_kind"`
	}
	if err := json.NewDecoder(nextResp.Body).Decode(&questionStep); err != nil {
		t.Fatalf("decode question step: %v", err)
	}
	if questionStep.NodeKind != "single_choice" {
		t.Fatalf("expected single_choice after next, got %s", questionStep.NodeKind)
	}

	duplicateNextResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/next", map[string]any{
		"state_version":    start.StateVersion,
		"expected_node_id": start.NodeID,
	}, studentCSRF)
	if duplicateNextResp.StatusCode != http.StatusOK {
		t.Fatalf("duplicate-safe next status: %d", duplicateNextResp.StatusCode)
	}

	conflictNextResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/next", map[string]any{
		"state_version":    start.StateVersion,
		"expected_node_id": "wrong-node",
	}, studentCSRF)
	if conflictNextResp.StatusCode != http.StatusConflict {
		t.Fatalf("wrong node next conflict status: %d", conflictNextResp.StatusCode)
	}

	answerResp := performJSONWithIdempotency(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/answer", map[string]any{
		"state_version": questionStep.StateVersion,
		"node_id":       questionStep.NodeID,
		"answer":        map[string]any{"kind": "single_choice", "option_id": "a2"},
	}, studentCSRF, "answer-1")
	if answerResp.StatusCode != http.StatusOK {
		t.Fatalf("single choice answer status: %d", answerResp.StatusCode)
	}
	defer answerResp.Body.Close()
	var answer struct {
		Verdict     string `json:"verdict"`
		XPDelta     int    `json:"xp_delta"`
		HeartsDelta int    `json:"hearts_delta"`
		NextAction  string `json:"next_action"`
		GameState   struct {
			XPTotal       int64 `json:"xp_total"`
			HeartsCurrent int   `json:"hearts_current"`
		} `json:"game_state"`
		NextStep *struct {
			StateVersion int64  `json:"state_version"`
			NodeID       string `json:"node_id"`
			NodeKind     string `json:"node_kind"`
		} `json:"next_step"`
	}
	if err := json.NewDecoder(answerResp.Body).Decode(&answer); err != nil {
		t.Fatalf("decode answer: %v", err)
	}
	if answer.Verdict != "correct" || answer.XPDelta != 10 || answer.HeartsDelta != 0 {
		t.Fatalf("unexpected single choice outcome: %+v", answer)
	}
	if answer.NextStep == nil || answer.NextStep.NodeKind != "free_text" {
		t.Fatalf("expected free_text next step, got %+v", answer.NextStep)
	}

	duplicateAnswerResp := performJSONWithIdempotency(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/answer", map[string]any{
		"state_version": questionStep.StateVersion,
		"node_id":       questionStep.NodeID,
		"answer":        map[string]any{"kind": "single_choice", "option_id": "a2"},
	}, studentCSRF, "answer-1")
	if duplicateAnswerResp.StatusCode != http.StatusConflict {
		t.Fatalf("duplicate answer status: %d", duplicateAnswerResp.StatusCode)
	}

	completeResp := performJSONWithIdempotency(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/answer", map[string]any{
		"state_version": answer.NextStep.StateVersion,
		"node_id":       answer.NextStep.NodeID,
		"answer":        map[string]any{"kind": "free_text", "text": "Some idea"},
	}, studentCSRF, "answer-2")
	if completeResp.StatusCode != http.StatusOK {
		t.Fatalf("free text completion status: %d", completeResp.StatusCode)
	}
	defer completeResp.Body.Close()
	var completion struct {
		Verdict          string `json:"verdict"`
		XPDelta          int    `json:"xp_delta"`
		NextAction       string `json:"next_action"`
		LessonCompletion *struct {
			LessonID          string `json:"lesson_id"`
			AccuracyPercent   int    `json:"accuracy_percent"`
			CurrentStreakDays int    `json:"current_streak_days"`
		} `json:"lesson_completion"`
	}
	if err := json.NewDecoder(completeResp.Body).Decode(&completion); err != nil {
		t.Fatalf("decode completion: %v", err)
	}
	if completion.Verdict != "partial" || completion.XPDelta != 5 || completion.NextAction != "lesson_completed" || completion.LessonCompletion == nil {
		t.Fatalf("unexpected completion payload: %+v", completion)
	}

	sessionAfterCompleteResp, err := studentClient.Get(testApp.Server.URL + "/api/v1/student/lesson-sessions/" + start.SessionID)
	if err != nil {
		t.Fatalf("session after completion: %v", err)
	}
	if sessionAfterCompleteResp.StatusCode != http.StatusConflict {
		t.Fatalf("completed session fetch status: %d", sessionAfterCompleteResp.StatusCode)
	}

	var correctAnswers, partialAnswers, incorrectAnswers int
	var progressStatus string
	if err := testApp.DB.Pool().QueryRow(context.Background(), `
		select status, correct_answers, partial_answers, incorrect_answers
		from course_progress
		where student_id = $1 and course_id = $2
	`, studentID, courseID).Scan(&progressStatus, &correctAnswers, &partialAnswers, &incorrectAnswers); err != nil {
		t.Fatalf("query course progress: %v", err)
	}
	if progressStatus != "completed" || correctAnswers != 1 || partialAnswers != 1 || incorrectAnswers != 0 {
		t.Fatalf("unexpected course progress counters: %s %d %d %d", progressStatus, correctAnswers, partialAnswers, incorrectAnswers)
	}

	var lessonStatus string
	var attemptsCount, replayCount int
	if err := testApp.DB.Pool().QueryRow(context.Background(), `
		select status, attempts_count, replay_count
		from lesson_progress
		where student_id = $1 and lesson_id = 'lesson_1'
	`, studentID).Scan(&lessonStatus, &attemptsCount, &replayCount); err != nil {
		t.Fatalf("query lesson progress: %v", err)
	}
	if lessonStatus != "completed" || attemptsCount != 2 || replayCount != 0 {
		t.Fatalf("unexpected lesson progress: %s attempts=%d replay=%d", lessonStatus, attemptsCount, replayCount)
	}

	gameStateResp, err := studentClient.Get(testApp.Server.URL + "/api/v1/student/game-state")
	if err != nil {
		t.Fatalf("game state: %v", err)
	}
	defer gameStateResp.Body.Close()
	var gameState struct {
		XPTotal       int64 `json:"xp_total"`
		HeartsCurrent int   `json:"hearts_current"`
		Badges        []struct {
			BadgeCode string `json:"badge_code"`
		} `json:"badges"`
	}
	if err := json.NewDecoder(gameStateResp.Body).Decode(&gameState); err != nil {
		t.Fatalf("decode game state: %v", err)
	}
	if gameState.XPTotal != 15 || gameState.HeartsCurrent != 5 || len(gameState.Badges) != 1 || gameState.Badges[0].BadgeCode != "first_lesson" {
		t.Fatalf("unexpected game state: %+v", gameState)
	}

	var attemptCount, eventCount, badgeCount int
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from step_attempts sa join lesson_sessions ls on ls.id = sa.lesson_session_id where ls.student_id = $1`, studentID).Scan(&attemptCount); err != nil {
		t.Fatalf("count attempts: %v", err)
	}
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from game_events where student_id = $1`, studentID).Scan(&eventCount); err != nil {
		t.Fatalf("count game events: %v", err)
	}
	if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from student_badges where student_id = $1`, studentID).Scan(&badgeCount); err != nil {
		t.Fatalf("count badges: %v", err)
	}
	if attemptCount != 2 || eventCount != 2 || badgeCount != 1 {
		t.Fatalf("unexpected persisted counts attempts=%d events=%d badges=%d", attemptCount, eventCount, badgeCount)
	}

	retryResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/retry", map[string]any{}, studentCSRF)
	if retryResp.StatusCode != http.StatusOK {
		t.Fatalf("retry lesson status: %d", retryResp.StatusCode)
	}
	defer retryResp.Body.Close()
	var retryStart struct {
		SessionID    string `json:"session_id"`
		StateVersion int64  `json:"state_version"`
		NodeID       string `json:"node_id"`
	}
	if err := json.NewDecoder(retryResp.Body).Decode(&retryStart); err != nil {
		t.Fatalf("decode retry start: %v", err)
	}
	if retryStart.SessionID == start.SessionID {
		t.Fatalf("retry should create new session")
	}

	retryNextResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+retryStart.SessionID+"/next", map[string]any{
		"state_version":    retryStart.StateVersion,
		"expected_node_id": retryStart.NodeID,
	}, studentCSRF)
	if retryNextResp.StatusCode != http.StatusOK {
		t.Fatalf("retry next status: %d", retryNextResp.StatusCode)
	}
	defer retryNextResp.Body.Close()
	var retryQuestion struct {
		StateVersion int64  `json:"state_version"`
		NodeID       string `json:"node_id"`
	}
	if err := json.NewDecoder(retryNextResp.Body).Decode(&retryQuestion); err != nil {
		t.Fatalf("decode retry question: %v", err)
	}

	retryWrongResp := performJSONWithIdempotency(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+retryStart.SessionID+"/answer", map[string]any{
		"state_version": retryQuestion.StateVersion,
		"node_id":       retryQuestion.NodeID,
		"answer":        map[string]any{"kind": "single_choice", "option_id": "a1"},
	}, studentCSRF, "retry-answer-1")
	if retryWrongResp.StatusCode != http.StatusOK {
		t.Fatalf("retry incorrect answer status: %d", retryWrongResp.StatusCode)
	}
	defer retryWrongResp.Body.Close()
	var retryWrong struct {
		Verdict     string `json:"verdict"`
		HeartsDelta int    `json:"hearts_delta"`
		NextStep    *struct {
			StateVersion int64  `json:"state_version"`
			NodeID       string `json:"node_id"`
		} `json:"next_step"`
	}
	if err := json.NewDecoder(retryWrongResp.Body).Decode(&retryWrong); err != nil {
		t.Fatalf("decode retry wrong answer: %v", err)
	}
	if retryWrong.Verdict != "incorrect" || retryWrong.HeartsDelta != -1 || retryWrong.NextStep == nil {
		t.Fatalf("unexpected retry wrong outcome: %+v", retryWrong)
	}

	retryFinishResp := performJSONWithIdempotency(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+retryStart.SessionID+"/answer", map[string]any{
		"state_version": retryWrong.NextStep.StateVersion,
		"node_id":       retryWrong.NextStep.NodeID,
		"answer":        map[string]any{"kind": "free_text", "text": "This uses a safe password"},
	}, studentCSRF, "retry-answer-2")
	if retryFinishResp.StatusCode != http.StatusOK {
		t.Fatalf("retry finish status: %d", retryFinishResp.StatusCode)
	}

	if _, err := testApp.DB.Pool().Exec(context.Background(), `update student_game_state set hearts_current = 0, hearts_updated_at = now(), updated_at = now() where student_id = $1`, studentID); err != nil {
		t.Fatalf("drain hearts: %v", err)
	}

	blockedRetryResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/retry", map[string]any{}, studentCSRF)
	if blockedRetryResp.StatusCode != http.StatusOK {
		t.Fatalf("third retry start status: %d", blockedRetryResp.StatusCode)
	}
	defer blockedRetryResp.Body.Close()
	var blockedStart struct {
		SessionID    string `json:"session_id"`
		StateVersion int64  `json:"state_version"`
		NodeID       string `json:"node_id"`
	}
	if err := json.NewDecoder(blockedRetryResp.Body).Decode(&blockedStart); err != nil {
		t.Fatalf("decode blocked retry start: %v", err)
	}

	blockedNextResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+blockedStart.SessionID+"/next", map[string]any{
		"state_version":    blockedStart.StateVersion,
		"expected_node_id": blockedStart.NodeID,
	}, studentCSRF)
	if blockedNextResp.StatusCode != http.StatusOK {
		t.Fatalf("blocked retry next status: %d", blockedNextResp.StatusCode)
	}
	defer blockedNextResp.Body.Close()
	var blockedQuestion struct {
		StateVersion int64  `json:"state_version"`
		NodeID       string `json:"node_id"`
	}
	if err := json.NewDecoder(blockedNextResp.Body).Decode(&blockedQuestion); err != nil {
		t.Fatalf("decode blocked question: %v", err)
	}

	outOfHeartsResp := performJSONWithIdempotency(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+blockedStart.SessionID+"/answer", map[string]any{
		"state_version": blockedQuestion.StateVersion,
		"node_id":       blockedQuestion.NodeID,
		"answer":        map[string]any{"kind": "single_choice", "option_id": "a2"},
	}, studentCSRF, "blocked-answer")
	if outOfHeartsResp.StatusCode != http.StatusConflict {
		t.Fatalf("out of hearts status: %d", outOfHeartsResp.StatusCode)
	}

	if err := testApp.DB.Pool().QueryRow(context.Background(), `
		select status, replay_count
		from lesson_progress
		where student_id = $1 and lesson_id = 'lesson_1'
	`, studentID).Scan(&lessonStatus, &replayCount); err != nil {
		t.Fatalf("query replay count after retries: %v", err)
	}
	if replayCount != 2 {
		t.Fatalf("unexpected replay count after retries: %d", replayCount)
	}

	if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from step_attempts sa join lesson_sessions ls on ls.id = sa.lesson_session_id where ls.student_id = $1`, studentID).Scan(&attemptCount); err != nil {
		t.Fatalf("recount attempts: %v", err)
	}
	if attemptCount != 4 {
		t.Fatalf("out_of_hearts should not commit extra attempt, got %d", attemptCount)
	}
}

func TestStudentRuntime_RetryRequiresCompletedEligibleLesson(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)

	courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Retry Gate Course", map[string]any{
		"modules": []any{
			map[string]any{
				"id": "module_1",
				"lessons": []any{
					map[string]any{
						"id":    "lesson_1",
						"title": "Lesson 1",
						"graph": map[string]any{
							"startNodeId": "n1",
							"nodes":       []any{map[string]any{"id": "n1", "kind": "story", "nextNodeId": "n2"}, map[string]any{"id": "n2", "kind": "end"}},
						},
					},
					map[string]any{
						"id":    "lesson_2",
						"title": "Lesson 2",
						"graph": map[string]any{
							"startNodeId": "m1",
							"nodes":       []any{map[string]any{"id": "m1", "kind": "story", "nextNodeId": "m2"}, map[string]any{"id": "m2", "kind": "end"}},
						},
					},
				},
			},
		},
	})

	studentClient := httpclient.New(t)
	studentCSRF, _ := loginAsRole(t, studentClient, testApp, "student-retry-gate", "student")

	noProgressRetry := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/retry", map[string]any{}, studentCSRF)
	if noProgressRetry.StatusCode != http.StatusConflict {
		t.Fatalf("retry without prior progress status: %d", noProgressRetry.StatusCode)
	}

	startResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/start", map[string]any{}, studentCSRF)
	if startResp.StatusCode != http.StatusOK {
		t.Fatalf("start retry gate lesson_1 status: %d", startResp.StatusCode)
	}
	defer startResp.Body.Close()
	var start struct {
		SessionID    string `json:"session_id"`
		StateVersion int64  `json:"state_version"`
		NodeID       string `json:"node_id"`
	}
	if err := json.NewDecoder(startResp.Body).Decode(&start); err != nil {
		t.Fatalf("decode retry gate start: %v", err)
	}

	lockedRetry := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_2/retry", map[string]any{}, studentCSRF)
	if lockedRetry.StatusCode != http.StatusConflict {
		t.Fatalf("retry locked future lesson status: %d", lockedRetry.StatusCode)
	}

	nextResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/next", map[string]any{
		"state_version":    start.StateVersion,
		"expected_node_id": start.NodeID,
	}, studentCSRF)
	if nextResp.StatusCode != http.StatusOK {
		t.Fatalf("advance retry gate lesson status: %d", nextResp.StatusCode)
	}

	inProgressRetry := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/retry", map[string]any{}, studentCSRF)
	if inProgressRetry.StatusCode != http.StatusConflict {
		t.Fatalf("retry in-progress lesson status: %d", inProgressRetry.StatusCode)
	}
}

type studentTreeView struct {
	CourseRevisionID string `json:"course_revision_id"`
	Progress         map[string]any `json:"progress"`
	Modules          []struct {
		Lessons []struct {
			LessonID string `json:"lesson_id"`
			Status   string `json:"status"`
			Access   struct {
				AccessState string `json:"access_state"`
			} `json:"access"`
		} `json:"lessons"`
	} `json:"modules"`
}

func fetchStudentTree(t *testing.T, client *http.Client, testApp *app.TestApp, courseID string) studentTreeView {
	t.Helper()
	resp, err := client.Get(testApp.Server.URL + "/api/v1/student/courses/" + courseID)
	if err != nil {
		t.Fatalf("student tree: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("student tree status: %d", resp.StatusCode)
	}
	var tree studentTreeView
	if err := json.NewDecoder(resp.Body).Decode(&tree); err != nil {
		t.Fatalf("decode student tree: %v", err)
	}
	return tree
}

func publishPlatformCourse(t *testing.T, adminClient *http.Client, testApp *app.TestApp, adminCSRF string, title string, content map[string]any) (string, string) {
	t.Helper()
	createResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/courses", map[string]any{
		"title":       title,
		"description": "Published",
	}, adminCSRF)
	if createResp.StatusCode != http.StatusCreated {
		t.Fatalf("admin create platform course status: %d", createResp.StatusCode)
	}
	defer createResp.Body.Close()
	var created struct {
		CourseID string `json:"course_id"`
	}
	if err := json.NewDecoder(createResp.Body).Decode(&created); err != nil {
		t.Fatalf("decode platform create: %v", err)
	}
	revisionID := republishPlatformCourse(t, adminClient, testApp, adminCSRF, created.CourseID, title, content)
	return created.CourseID, revisionID
}

func republishPlatformCourse(t *testing.T, adminClient *http.Client, testApp *app.TestApp, adminCSRF string, courseID string, title string, content map[string]any) string {
	t.Helper()
	draftVersion := fetchAdminDraftVersion(t, adminClient, testApp, courseID)
	updateResp := performJSON(t, adminClient, http.MethodPut, testApp.Server.URL+"/api/v1/admin/courses/"+courseID+"/draft", map[string]any{
		"draft_version":  draftVersion,
		"title":          title,
		"description":    "Published",
		"cover_asset_id": nil,
		"content":        content,
	}, adminCSRF)
	if updateResp.StatusCode != http.StatusOK {
		t.Fatalf("admin update platform draft status: %d", updateResp.StatusCode)
	}

	publishResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/courses/"+courseID+"/publish", map[string]any{}, adminCSRF)
	if publishResp.StatusCode != http.StatusOK {
		t.Fatalf("admin publish platform course status: %d", publishResp.StatusCode)
	}
	defer publishResp.Body.Close()
	var published struct {
		CourseRevisionID string `json:"course_revision_id"`
	}
	if err := json.NewDecoder(publishResp.Body).Decode(&published); err != nil {
		t.Fatalf("decode platform publish: %v", err)
	}
	return published.CourseRevisionID
}

func fetchAdminDraftVersion(t *testing.T, adminClient *http.Client, testApp *app.TestApp, courseID string) int64 {
	t.Helper()
	resp, err := adminClient.Get(testApp.Server.URL + "/api/v1/admin/courses/" + courseID + "/draft")
	if err != nil {
		t.Fatalf("get admin draft: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get admin draft status: %d", resp.StatusCode)
	}
	var draft struct {
		DraftVersion int64 `json:"draft_version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&draft); err != nil {
		t.Fatalf("decode admin draft: %v", err)
	}
	return draft.DraftVersion
}

func adminApproveTeacherCourse(t *testing.T, adminClient *http.Client, testApp *app.TestApp, adminCSRF string, teacherClient *http.Client, teacherCSRF string, courseID string) {
	t.Helper()
	submitResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses/"+courseID+"/submit-review", map[string]any{}, teacherCSRF)
	if submitResp.StatusCode != http.StatusOK {
		t.Fatalf("submit teacher review status: %d", submitResp.StatusCode)
	}
	defer submitResp.Body.Close()
	var review struct {
		ReviewID string `json:"review_id"`
	}
	if err := json.NewDecoder(submitResp.Body).Decode(&review); err != nil {
		t.Fatalf("decode teacher review: %v", err)
	}
	approveResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/moderation/reviews/"+review.ReviewID+"/approve", map[string]any{"comment": "ok"}, adminCSRF)
	if approveResp.StatusCode != http.StatusOK {
		t.Fatalf("approve teacher review status: %d", approveResp.StatusCode)
	}
}

func performJSONWithIdempotency(t *testing.T, client *http.Client, method string, url string, payload any, csrf string, idempotencyKey string) *http.Response {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	req, err := http.NewRequest(method, url, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if csrf != "" {
		req.Header.Set("X-CSRF-Token", csrf)
	}
	if idempotencyKey != "" {
		req.Header.Set("Idempotency-Key", idempotencyKey)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	return resp
}
