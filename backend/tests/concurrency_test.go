package tests

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"

	"pravoprost/backend/internal/testkit/app"
	httpclient "pravoprost/backend/internal/testkit/http"
)

func TestConcurrency_RaceMatrix(t *testing.T) {
	t.Run("P1 parallel onboarding picks exactly one final role", func(t *testing.T) {
		testApp := app.New(t)
		clientA := httpclient.New(t)
		clientB := httpclient.New(t)
		csrfA, accountID := loginWithoutOnboarding(t, clientA, testApp, "parallel-onboarding")
		csrfB, sameAccountID := loginWithoutOnboarding(t, clientB, testApp, "parallel-onboarding")
		if accountID != sameAccountID {
			t.Fatalf("expected same account for parallel onboarding, got %s and %s", accountID, sameAccountID)
		}

		results := runParallelStatuses(t, func() int {
			resp := performJSON(t, clientA, http.MethodPost, testApp.Server.URL+"/api/v1/onboarding/role", map[string]any{"role": "student"}, csrfA)
			return resp.StatusCode
		}, func() int {
			resp := performJSON(t, clientB, http.MethodPost, testApp.Server.URL+"/api/v1/onboarding/role", map[string]any{"role": "parent"}, csrfB)
			return resp.StatusCode
		})
		if countStatus(results, http.StatusOK) != 1 || countStatus(results, http.StatusConflict) != 1 {
			t.Fatalf("unexpected onboarding race statuses: %+v", results)
		}

		var finalRole string
		if err := testApp.DB.Pool().QueryRow(context.Background(), `select role from accounts where id = $1`, accountID).Scan(&finalRole); err != nil {
			t.Fatalf("query final onboarding role: %v", err)
		}
		if finalRole != "student" && finalRole != "parent" {
			t.Fatalf("unexpected final onboarding role: %s", finalRole)
		}
	})

	t.Run("P2 parallel guardian claims compete for final parent slot", func(t *testing.T) {
		testApp := app.New(t)
		parent1Client := httpclient.New(t)
		parent1CSRF, _ := loginAsRole(t, parent1Client, testApp, "parent-race-a", "parent")
		parent2Client := httpclient.New(t)
		parent2CSRF, _ := loginAsRole(t, parent2Client, testApp, "parent-race-b", "parent")
		parent3Client := httpclient.New(t)
		parent3CSRF, _ := loginAsRole(t, parent3Client, testApp, "parent-race-c", "parent")
		studentA := httpclient.New(t)
		studentCSRF, studentID := loginAsRole(t, studentA, testApp, "student-race-guardian", "student")
		studentB := httpclient.New(t)
		studentBCSRF, _ := loginAsRole(t, studentB, testApp, "student-race-guardian", "student")

		if status := performJSON(t, studentA, http.MethodPost, testApp.Server.URL+"/api/v1/student/guardian-links/claim", map[string]string{"token": createGuardianInvite(t, parent1Client, testApp, parent1CSRF)}, studentCSRF).StatusCode; status != http.StatusOK {
			t.Fatalf("initial guardian claim status: %d", status)
		}

		token2 := createGuardianInvite(t, parent2Client, testApp, parent2CSRF)
		token3 := createGuardianInvite(t, parent3Client, testApp, parent3CSRF)
		results := runParallelStatuses(t, func() int {
			resp := performJSON(t, studentA, http.MethodPost, testApp.Server.URL+"/api/v1/student/guardian-links/claim", map[string]string{"token": token2}, studentCSRF)
			return resp.StatusCode
		}, func() int {
			resp := performJSON(t, studentB, http.MethodPost, testApp.Server.URL+"/api/v1/student/guardian-links/claim", map[string]string{"token": token3}, studentBCSRF)
			return resp.StatusCode
		})
		if countStatus(results, http.StatusOK) != 1 || countConflictLike(results) != 1 {
			t.Fatalf("unexpected guardian race statuses: %+v", results)
		}

		var activeLinks int
		if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from guardian_links where student_id = $1 and status = 'active'`, studentID).Scan(&activeLinks); err != nil {
			t.Fatalf("count guardian links: %v", err)
		}
		if activeLinks != 2 {
			t.Fatalf("expected exactly two active guardian links, got %d", activeLinks)
		}
	})

	t.Run("P3 parallel lesson start yields one active session and one active course_progress", func(t *testing.T) {
		testApp := app.New(t)
		adminClient := httpclient.New(t)
		adminCSRF := loginExistingAdmin(t, adminClient, testApp)
		courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Race Start Course", map[string]any{
			"modules": []any{
				map[string]any{
					"id":    "module_1",
					"title": "Module",
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
		studentA := httpclient.New(t)
		csrfA, studentID := loginAsRole(t, studentA, testApp, "student-race-start", "student")
		studentB := httpclient.New(t)
		csrfB, _ := loginAsRole(t, studentB, testApp, "student-race-start", "student")

		sessionIDs := make([]string, 0, 2)
		mu := sync.Mutex{}
		statuses := runParallelStatuses(t, func() int {
			resp := performJSON(t, studentA, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/start", map[string]any{}, csrfA)
			defer resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				var body struct {
					SessionID string `json:"session_id"`
				}
				_ = json.NewDecoder(resp.Body).Decode(&body)
				mu.Lock()
				sessionIDs = append(sessionIDs, body.SessionID)
				mu.Unlock()
			}
			return resp.StatusCode
		}, func() int {
			resp := performJSON(t, studentB, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/start", map[string]any{}, csrfB)
			defer resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				var body struct {
					SessionID string `json:"session_id"`
				}
				_ = json.NewDecoder(resp.Body).Decode(&body)
				mu.Lock()
				sessionIDs = append(sessionIDs, body.SessionID)
				mu.Unlock()
			}
			return resp.StatusCode
		})
		if countStatus(statuses, http.StatusOK) != 2 {
			t.Fatalf("parallel lesson start should stay duplicate-safe, got %+v", statuses)
		}
		if len(sessionIDs) != 2 || sessionIDs[0] != sessionIDs[1] {
			t.Fatalf("expected both starts to converge to same session, got %+v", sessionIDs)
		}

		var activeSessions, activeProgress int
		if err := testApp.DB.Pool().QueryRow(context.Background(), `
			select count(*)
			from lesson_sessions ls
			join course_progress cp on cp.id = ls.course_progress_id
			where ls.student_id = $1 and cp.course_id = $2 and ls.lesson_id = 'lesson_1' and ls.status = 'in_progress'
		`, studentID, courseID).Scan(&activeSessions); err != nil {
			t.Fatalf("count active sessions: %v", err)
		}
		if err := testApp.DB.Pool().QueryRow(context.Background(), `
			select count(*)
			from course_progress
			where student_id = $1 and course_id = $2 and status = 'in_progress'
		`, studentID, courseID).Scan(&activeProgress); err != nil {
			t.Fatalf("count active progress: %v", err)
		}
		if activeSessions != 1 || activeProgress != 1 {
			t.Fatalf("unexpected active runtime rows sessions=%d progress=%d", activeSessions, activeProgress)
		}
	})

	t.Run("P4 parallel course start leaves one active course_progress", func(t *testing.T) {
		testApp := app.New(t)
		adminClient := httpclient.New(t)
		adminCSRF := loginExistingAdmin(t, adminClient, testApp)
		courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Race Course Progress", map[string]any{
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
		studentA := httpclient.New(t)
		csrfA, studentID := loginAsRole(t, studentA, testApp, "student-race-course-progress", "student")
		studentB := httpclient.New(t)
		csrfB, _ := loginAsRole(t, studentB, testApp, "student-race-course-progress", "student")

		statuses := runParallelStatuses(t, func() int {
			resp := performJSON(t, studentA, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/start", map[string]any{}, csrfA)
			return resp.StatusCode
		}, func() int {
			resp := performJSON(t, studentB, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/start", map[string]any{}, csrfB)
			return resp.StatusCode
		})
		if countStatus(statuses, http.StatusOK) != 2 {
			t.Fatalf("unexpected course start race statuses: %+v", statuses)
		}

		var activeProgress int
		if err := testApp.DB.Pool().QueryRow(context.Background(), `
			select count(*)
			from course_progress
			where student_id = $1 and course_id = $2 and status = 'in_progress'
		`, studentID, courseID).Scan(&activeProgress); err != nil {
			t.Fatalf("count parallel course_progress: %v", err)
		}
		if activeProgress != 1 {
			t.Fatalf("expected one active course_progress, got %d", activeProgress)
		}
	})

	t.Run("P5 parallel answer with same idempotency key creates one attempt", func(t *testing.T) {
		testApp := app.New(t)
		adminClient := httpclient.New(t)
		adminCSRF := loginExistingAdmin(t, adminClient, testApp)
		courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Race Answer Course", map[string]any{
			"modules": []any{
				map[string]any{
					"id": "module_1",
					"lessons": []any{
						map[string]any{
							"id":    "lesson_1",
							"title": "Lesson",
							"graph": map[string]any{
								"startNodeId": "q1",
								"nodes": []any{
									map[string]any{"id": "q1", "kind": "single_choice", "prompt": "Q", "options": []any{map[string]any{"id": "a1", "text": "A", "result": "correct", "feedback": "ok", "nextNodeId": "n2"}}},
									map[string]any{"id": "n2", "kind": "end", "text": "Done"},
								},
							},
						},
					},
				},
			},
		})
		studentA := httpclient.New(t)
		csrfA, studentID := loginAsRole(t, studentA, testApp, "student-race-answer", "student")
		studentB := httpclient.New(t)
		csrfB, _ := loginAsRole(t, studentB, testApp, "student-race-answer", "student")

		startResp := performJSON(t, studentA, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/start", map[string]any{}, csrfA)
		if startResp.StatusCode != http.StatusOK {
			t.Fatalf("start for answer race status: %d", startResp.StatusCode)
		}
		defer startResp.Body.Close()
		var start struct {
			SessionID    string `json:"session_id"`
			StateVersion int64  `json:"state_version"`
			NodeID       string `json:"node_id"`
		}
		if err := json.NewDecoder(startResp.Body).Decode(&start); err != nil {
			t.Fatalf("decode answer race start: %v", err)
		}

		statuses := runParallelStatuses(t, func() int {
			resp := performJSONWithIdempotency(t, studentA, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/answer", map[string]any{
				"state_version": start.StateVersion,
				"node_id":       start.NodeID,
				"answer":        map[string]any{"kind": "single_choice", "option_id": "a1"},
			}, csrfA, "same-idem")
			return resp.StatusCode
		}, func() int {
			resp := performJSONWithIdempotency(t, studentB, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/answer", map[string]any{
				"state_version": start.StateVersion,
				"node_id":       start.NodeID,
				"answer":        map[string]any{"kind": "single_choice", "option_id": "a1"},
			}, csrfB, "same-idem")
			return resp.StatusCode
		})
		if countStatus(statuses, http.StatusOK) != 1 || countConflictLike(statuses) != 1 {
			t.Fatalf("unexpected answer race statuses: %+v", statuses)
		}

		var attempts, events int
		if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from step_attempts where lesson_session_id = $1`, start.SessionID).Scan(&attempts); err != nil {
			t.Fatalf("count answer race attempts: %v", err)
		}
		if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from game_events where student_id = $1`, studentID).Scan(&events); err != nil {
			t.Fatalf("count answer race events: %v", err)
		}
		if attempts != 1 || events != 1 {
			t.Fatalf("unexpected duplicate side effects attempts=%d events=%d", attempts, events)
		}
	})

	t.Run("P6 parallel stale and current answer versions leave one winner", func(t *testing.T) {
		testApp := app.New(t)
		adminClient := httpclient.New(t)
		adminCSRF := loginExistingAdmin(t, adminClient, testApp)
		courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Race State Version", map[string]any{
			"modules": []any{
				map[string]any{
					"id": "module_1",
					"lessons": []any{
						map[string]any{
							"id":    "lesson_1",
							"title": "Lesson",
							"graph": map[string]any{
								"startNodeId": "q1",
								"nodes": []any{
									map[string]any{"id": "q1", "kind": "single_choice", "prompt": "Q", "options": []any{map[string]any{"id": "a1", "text": "A", "result": "correct", "feedback": "ok", "nextNodeId": "n2"}}},
									map[string]any{"id": "n2", "kind": "end", "text": "Done"},
								},
							},
						},
					},
				},
			},
		})
		studentA := httpclient.New(t)
		csrfA, _ := loginAsRole(t, studentA, testApp, "student-race-state-version", "student")
		studentB := httpclient.New(t)
		csrfB, _ := loginAsRole(t, studentB, testApp, "student-race-state-version", "student")

		startResp := performJSON(t, studentA, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/start", map[string]any{}, csrfA)
		if startResp.StatusCode != http.StatusOK {
			t.Fatalf("start for state version race status: %d", startResp.StatusCode)
		}
		defer startResp.Body.Close()
		var start struct {
			SessionID    string `json:"session_id"`
			StateVersion int64  `json:"state_version"`
			NodeID       string `json:"node_id"`
		}
		if err := json.NewDecoder(startResp.Body).Decode(&start); err != nil {
			t.Fatalf("decode state version race start: %v", err)
		}

		statuses := runParallelStatuses(t, func() int {
			resp := performJSONWithIdempotency(t, studentA, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/answer", map[string]any{
				"state_version": start.StateVersion,
				"node_id":       start.NodeID,
				"answer":        map[string]any{"kind": "single_choice", "option_id": "a1"},
			}, csrfA, "state-version-current")
			return resp.StatusCode
		}, func() int {
			resp := performJSONWithIdempotency(t, studentB, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/answer", map[string]any{
				"state_version": start.StateVersion - 1,
				"node_id":       start.NodeID,
				"answer":        map[string]any{"kind": "single_choice", "option_id": "a1"},
			}, csrfB, "state-version-stale")
			return resp.StatusCode
		})
		if countStatus(statuses, http.StatusOK) != 1 || countStatus(statuses, http.StatusConflict) != 1 {
			t.Fatalf("unexpected stale/current answer statuses: %+v", statuses)
		}

		var attempts int
		if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from step_attempts where lesson_session_id = $1`, start.SessionID).Scan(&attempts); err != nil {
			t.Fatalf("count state version race attempts: %v", err)
		}
		if attempts != 1 {
			t.Fatalf("expected one attempt from stale/current race, got %d", attempts)
		}
	})

	t.Run("P7 parallel submit review leaves one pending review", func(t *testing.T) {
		testApp := app.New(t)
		teacherA := httpclient.New(t)
		csrfA, _ := loginAsRole(t, teacherA, testApp, "teacher-race-review", "teacher")
		teacherB := httpclient.New(t)
		csrfB, _ := loginAsRole(t, teacherB, testApp, "teacher-race-review", "teacher")
		_ = performJSON(t, teacherA, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/profile", map[string]any{
			"display_name":      "Teacher",
			"organization_name": "Org",
			"avatar_asset_id":   nil,
		}, csrfA)

		createResp := performJSON(t, teacherA, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses", map[string]any{
			"title":       "Race Review",
			"description": "Basics",
		}, csrfA)
		if createResp.StatusCode != http.StatusCreated {
			t.Fatalf("create race review course status: %d", createResp.StatusCode)
		}
		defer createResp.Body.Close()
		var created struct {
			CourseID string `json:"course_id"`
		}
		if err := json.NewDecoder(createResp.Body).Decode(&created); err != nil {
			t.Fatalf("decode race review course: %v", err)
		}
		updateResp := performJSON(t, teacherA, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/draft", map[string]any{
			"draft_version":  1,
			"title":          "Race Review",
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
									"nodes":       []any{map[string]any{"id": "n1", "kind": "end", "text": "Done"}},
								},
							},
						},
					},
				},
			},
		}, csrfA)
		if updateResp.StatusCode != http.StatusOK {
			t.Fatalf("update race review draft status: %d", updateResp.StatusCode)
		}

		statuses := runParallelStatuses(t, func() int {
			resp := performJSON(t, teacherA, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/submit-review", map[string]any{}, csrfA)
			return resp.StatusCode
		}, func() int {
			resp := performJSON(t, teacherB, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/submit-review", map[string]any{}, csrfB)
			return resp.StatusCode
		})
		if countStatus(statuses, http.StatusOK) != 1 || countConflictLike(statuses) != 1 {
			t.Fatalf("unexpected submit review race statuses: %+v", statuses)
		}

		var pendingReviews int
		if err := testApp.DB.Pool().QueryRow(context.Background(), `
			select count(*)
			from course_reviews r
			join course_drafts d on d.id = r.course_draft_id
			where d.course_id = $1 and r.status = 'pending'
		`, created.CourseID).Scan(&pendingReviews); err != nil {
			t.Fatalf("count pending reviews: %v", err)
		}
		if pendingReviews != 1 {
			t.Fatalf("expected one pending review, got %d", pendingReviews)
		}
	})

	t.Run("P8 and P10 parallel manual confirm stays idempotent", func(t *testing.T) {
		testApp := app.New(t)
		adminA := httpclient.New(t)
		adminCSRFA := loginExistingAdmin(t, adminA, testApp)
		adminB := httpclient.New(t)
		adminCSRFB := loginExistingAdmin(t, adminB, testApp)
		studentClient := httpclient.New(t)
		studentCSRF, studentID := loginAsRole(t, studentClient, testApp, "student-race-payment", "student")
		orderID := prepareAwaitingManualOrder(t, testApp, adminA, adminCSRFA, studentClient, studentCSRF, studentID, "order-race-course")

		statuses := runParallelStatuses(t, func() int {
			resp := performJSONWithIdempotency(t, adminA, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/orders/"+orderID+"/payments/manual-confirm", map[string]any{
				"external_reference": "race-ref-1",
				"amount_minor":       49000,
				"currency":           "RUB",
				"paid_at":            "2026-03-14T12:00:00Z",
			}, adminCSRFA, "pay-race")
			return resp.StatusCode
		}, func() int {
			resp := performJSONWithIdempotency(t, adminB, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/orders/"+orderID+"/payments/manual-confirm", map[string]any{
				"external_reference": "race-ref-1",
				"amount_minor":       49000,
				"currency":           "RUB",
				"paid_at":            "2026-03-14T12:00:00Z",
			}, adminCSRFB, "pay-race")
			return resp.StatusCode
		})
		if countStatus(statuses, http.StatusOK) != 2 {
			t.Fatalf("unexpected same-idempotency confirm statuses: %+v", statuses)
		}

		var payments, fulfillments int
		if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from payment_records where order_id = $1`, orderID).Scan(&payments); err != nil {
			t.Fatalf("count payment records same-idem: %v", err)
		}
		if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from entitlement_fulfillment_log where order_id = $1`, orderID).Scan(&fulfillments); err != nil {
			t.Fatalf("count fulfillments same-idem: %v", err)
		}
		if payments != 1 || fulfillments != 1 {
			t.Fatalf("unexpected same-idem side effects payments=%d fulfillments=%d", payments, fulfillments)
		}

		orderID = prepareAwaitingManualOrder(t, testApp, adminA, adminCSRFA, studentClient, studentCSRF, studentID, "order-race-course-2")
		statuses = runParallelStatuses(t, func() int {
			resp := performJSONWithIdempotency(t, adminA, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/orders/"+orderID+"/payments/manual-confirm", map[string]any{
				"external_reference": "race-ref-2",
				"amount_minor":       49000,
				"currency":           "RUB",
				"paid_at":            "2026-03-14T13:00:00Z",
			}, adminCSRFA, "pay-race-a")
			return resp.StatusCode
		}, func() int {
			resp := performJSONWithIdempotency(t, adminB, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/orders/"+orderID+"/payments/manual-confirm", map[string]any{
				"external_reference": "race-ref-2",
				"amount_minor":       49000,
				"currency":           "RUB",
				"paid_at":            "2026-03-14T13:00:00Z",
			}, adminCSRFB, "pay-race-b")
			return resp.StatusCode
		})
		if countStatus(statuses, http.StatusOK) != 2 {
			t.Fatalf("unexpected same-external-reference confirm statuses: %+v", statuses)
		}

		if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from payment_records where order_id = $1`, orderID).Scan(&payments); err != nil {
			t.Fatalf("count payment records same external ref: %v", err)
		}
		if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from entitlement_fulfillment_log where order_id = $1`, orderID).Scan(&fulfillments); err != nil {
			t.Fatalf("count fulfillments same external ref: %v", err)
		}
		if payments != 1 || fulfillments != 1 {
			t.Fatalf("unexpected same external ref side effects payments=%d fulfillments=%d", payments, fulfillments)
		}
	})

	t.Run("P9 parallel entitlement revoke and grant leaves no duplicate active entitlements", func(t *testing.T) {
		testApp := app.New(t)
		adminA := httpclient.New(t)
		adminCSRFA := loginExistingAdmin(t, adminA, testApp)
		adminB := httpclient.New(t)
		adminCSRFB := loginExistingAdmin(t, adminB, testApp)
		studentClient := httpclient.New(t)
		_, studentID := loginAsRole(t, studentClient, testApp, "student-race-grant-revoke", "student")
		courseID, _ := publishPlatformCourse(t, adminA, testApp, adminCSRFA, "Grant Revoke Race", map[string]any{
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
		grantResp := performJSON(t, adminA, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/entitlements/grants", map[string]any{
			"student_id":       studentID,
			"target_type":      "lesson",
			"target_course_id": courseID,
			"target_lesson_id": "lesson_1",
		}, adminCSRFA)
		if grantResp.StatusCode != http.StatusCreated {
			t.Fatalf("initial race grant status: %d", grantResp.StatusCode)
		}
		defer grantResp.Body.Close()
		var granted struct {
			EntitlementID string `json:"entitlement_id"`
		}
		if err := json.NewDecoder(grantResp.Body).Decode(&granted); err != nil {
			t.Fatalf("decode initial race grant: %v", err)
		}

		statuses := runParallelStatuses(t, func() int {
			resp := performJSON(t, adminA, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/entitlements/"+granted.EntitlementID+"/revoke", map[string]any{
				"reason": "race revoke",
			}, adminCSRFA)
			return resp.StatusCode
		}, func() int {
			resp := performJSON(t, adminB, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/entitlements/grants", map[string]any{
				"student_id":       studentID,
				"target_type":      "lesson",
				"target_course_id": courseID,
				"target_lesson_id": "lesson_1",
			}, adminCSRFB)
			return resp.StatusCode
		})
		if countStatus(statuses, http.StatusOK)+countStatus(statuses, http.StatusCreated) == 0 {
			t.Fatalf("unexpected grant/revoke race statuses: %+v", statuses)
		}

		var activeEntitlements int
		if err := testApp.DB.Pool().QueryRow(context.Background(), `
			select count(*)
			from entitlements
			where student_id = $1 and target_course_id = $2 and target_lesson_id = 'lesson_1' and status = 'active'
		`, studentID, courseID).Scan(&activeEntitlements); err != nil {
			t.Fatalf("count active entitlements after grant/revoke race: %v", err)
		}
		if activeEntitlements > 1 {
			t.Fatalf("grant/revoke race left duplicate active entitlements: %d", activeEntitlements)
		}
	})

	t.Run("P11 parallel complimentary grant and order resolution leave deterministic final state", func(t *testing.T) {
		testApp := app.New(t)
		adminA := httpclient.New(t)
		adminCSRFA := loginExistingAdmin(t, adminA, testApp)
		adminB := httpclient.New(t)
		adminCSRFB := loginExistingAdmin(t, adminB, testApp)
		studentClient := httpclient.New(t)
		studentCSRF, studentID := loginAsRole(t, studentClient, testApp, "student-race-grant-order", "student")
		orderID := prepareAwaitingManualOrder(t, testApp, adminA, adminCSRFA, studentClient, studentCSRF, studentID, "grant-order-race")

		var targetCourseID string
		if err := testApp.DB.Pool().QueryRow(context.Background(), `
			select target_course_id::text
			from commercial_orders
			where id = $1
		`, orderID).Scan(&targetCourseID); err != nil {
			t.Fatalf("query race order target: %v", err)
		}

		statuses := runParallelStatuses(t, func() int {
			resp := performJSONWithIdempotency(t, adminA, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/orders/"+orderID+"/payments/manual-confirm", map[string]any{
				"external_reference": "grant-order-race-ref",
				"amount_minor":       49000,
				"currency":           "RUB",
				"paid_at":            "2026-03-15T15:00:00Z",
			}, adminCSRFA, "grant-order-race-pay")
			return resp.StatusCode
		}, func() int {
			resp := performJSON(t, adminB, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/entitlements/grants", map[string]any{
				"student_id":       studentID,
				"target_type":      "lesson",
				"target_course_id": targetCourseID,
				"target_lesson_id": "lesson_1",
			}, adminCSRFB)
			return resp.StatusCode
		})
		if countStatus(statuses, http.StatusOK)+countStatus(statuses, http.StatusCreated) == 0 {
			t.Fatalf("unexpected grant/order race statuses: %+v", statuses)
		}

		var orderStatus string
		var activeEntitlements, paymentRecords, fulfillmentLogs int
		if err := testApp.DB.Pool().QueryRow(context.Background(), `select status from commercial_orders where id = $1`, orderID).Scan(&orderStatus); err != nil {
			t.Fatalf("query race order status: %v", err)
		}
		if err := testApp.DB.Pool().QueryRow(context.Background(), `
			select count(*)
			from entitlements
			where student_id = $1 and target_course_id = $2 and target_lesson_id = 'lesson_1' and status = 'active'
		`, studentID, targetCourseID).Scan(&activeEntitlements); err != nil {
			t.Fatalf("count active entitlements after grant/order race: %v", err)
		}
		if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from payment_records where order_id = $1`, orderID).Scan(&paymentRecords); err != nil {
			t.Fatalf("count payment records after grant/order race: %v", err)
		}
		if err := testApp.DB.Pool().QueryRow(context.Background(), `select count(*) from entitlement_fulfillment_log where order_id = $1`, orderID).Scan(&fulfillmentLogs); err != nil {
			t.Fatalf("count fulfillment logs after grant/order race: %v", err)
		}
		if orderStatus != "fulfilled" && orderStatus != "canceled" {
			t.Fatalf("unexpected final order status after grant/order race: %s", orderStatus)
		}
		if activeEntitlements != 1 || paymentRecords > 1 || fulfillmentLogs > 1 {
			t.Fatalf("unexpected grant/order race side effects entitlements=%d payments=%d fulfillments=%d", activeEntitlements, paymentRecords, fulfillmentLogs)
		}
	})
}

func runParallelStatuses(t *testing.T, fns ...func() int) []int {
	t.Helper()
	results := make([]int, len(fns))
	start := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(len(fns))
	for i, fn := range fns {
		go func(idx int, run func() int) {
			defer wg.Done()
			<-start
			results[idx] = run()
		}(i, fn)
	}
	close(start)
	wg.Wait()
	return results
}

func countStatus(statuses []int, want int) int {
	total := 0
	for _, status := range statuses {
		if status == want {
			total++
		}
	}
	return total
}

func countConflictLike(statuses []int) int {
	total := 0
	for _, status := range statuses {
		if status == http.StatusConflict || status == http.StatusForbidden {
			total++
		}
	}
	return total
}

func loginWithoutOnboarding(t *testing.T, client *http.Client, testApp *app.TestApp, code string) (string, string) {
	t.Helper()
	startResp, err := client.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/start")
	if err != nil {
		t.Fatalf("start unselected login: %v", err)
	}
	state := strings.Split(strings.Split(startResp.Header.Get("Location"), "state=")[1], "&")[0]
	callbackResp, err := client.Get(testApp.Server.URL + "/api/v1/auth/sso/yandex/callback?state=" + state + "&code=" + code)
	if err != nil {
		t.Fatalf("callback unselected login: %v", err)
	}
	if callbackResp.StatusCode != http.StatusFound {
		t.Fatalf("callback unselected login status: %d", callbackResp.StatusCode)
	}
	sessionResp, err := client.Get(testApp.Server.URL + "/api/v1/session")
	if err != nil {
		t.Fatalf("fetch unselected session: %v", err)
	}
	defer sessionResp.Body.Close()
	var session struct {
		CSRFToken string `json:"csrf_token"`
		User      struct {
			AccountID string `json:"account_id"`
		} `json:"user"`
	}
	if err := json.NewDecoder(sessionResp.Body).Decode(&session); err != nil {
		t.Fatalf("decode unselected session: %v", err)
	}
	return session.CSRFToken, session.User.AccountID
}

func prepareAwaitingManualOrder(t *testing.T, testApp *app.TestApp, adminClient *http.Client, adminCSRF string, studentClient *http.Client, studentCSRF string, studentID string, title string) string {
	t.Helper()
	courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, title, map[string]any{
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
		"price_amount_minor": 49000,
		"price_currency":     "RUB",
	}, adminCSRF)
	if createOfferResp.StatusCode != http.StatusCreated {
		t.Fatalf("create race offer status: %d", createOfferResp.StatusCode)
	}
	defer createOfferResp.Body.Close()
	var offer struct {
		OfferID string `json:"offer_id"`
	}
	if err := json.NewDecoder(createOfferResp.Body).Decode(&offer); err != nil {
		t.Fatalf("decode race offer: %v", err)
	}
	activateOfferResp := performJSON(t, adminClient, http.MethodPut, testApp.Server.URL+"/api/v1/admin/commerce/offers/"+offer.OfferID, map[string]any{
		"title":              "Paid lesson",
		"description":        "Paid lesson",
		"price_amount_minor": 49000,
		"price_currency":     "RUB",
		"status":             "active",
	}, adminCSRF)
	if activateOfferResp.StatusCode != http.StatusOK {
		t.Fatalf("activate race offer status: %d", activateOfferResp.StatusCode)
	}
	purchaseResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/offers/"+offer.OfferID+"/purchase-requests", map[string]any{}, studentCSRF)
	if purchaseResp.StatusCode != http.StatusCreated {
		t.Fatalf("purchase race request status: %d", purchaseResp.StatusCode)
	}
	defer purchaseResp.Body.Close()
	var purchase struct {
		PurchaseRequestID string `json:"purchase_request_id"`
	}
	if err := json.NewDecoder(purchaseResp.Body).Decode(&purchase); err != nil {
		t.Fatalf("decode race purchase request: %v", err)
	}
	orderResp := performJSON(t, adminClient, http.MethodPost, testApp.Server.URL+"/api/v1/admin/commerce/orders/manual", map[string]any{
		"student_id":          studentID,
		"offer_id":            offer.OfferID,
		"purchase_request_id": purchase.PurchaseRequestID,
	}, adminCSRF)
	if orderResp.StatusCode != http.StatusCreated {
		t.Fatalf("create race order status: %d", orderResp.StatusCode)
	}
	defer orderResp.Body.Close()
	var order struct {
		OrderID string `json:"order_id"`
	}
	if err := json.NewDecoder(orderResp.Body).Decode(&order); err != nil {
		t.Fatalf("decode race order: %v", err)
	}
	return order.OrderID
}
