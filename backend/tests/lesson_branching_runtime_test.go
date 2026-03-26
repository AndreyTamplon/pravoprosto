package tests

import (
	"encoding/json"
	"net/http"
	"testing"

	"pravoprost/backend/internal/testkit/app"
	httpclient "pravoprost/backend/internal/testkit/http"
)

func TestStudentRuntime_MultiVerdictSingleChoiceSupportsMultipleCorrectAndPartial(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)

	courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Multi Verdict Choice", map[string]any{
		"modules": []any{
			map[string]any{
				"id":    "module_1",
				"title": "Module 1",
				"lessons": []any{
					map[string]any{
						"id":    "lesson_1",
						"title": "Lesson 1",
						"graph": map[string]any{
							"startNodeId": "q1",
							"nodes": []any{
								map[string]any{
									"id":     "q1",
									"kind":   "single_choice",
									"prompt": "Какой шаг безопаснее?",
									"options": []any{
										map[string]any{"id": "a", "text": "Проверю отзывы", "result": "correct", "feedback": "Полностью верно", "nextNodeId": "ok"},
										map[string]any{"id": "b", "text": "Сравню цену с другими сайтами", "result": "correct", "feedback": "Тоже правильный ход", "nextNodeId": "ok"},
										map[string]any{"id": "c", "text": "Просто посмотрю красивый дизайн", "result": "partial", "feedback": "Этого мало, но это уже лучше импульсивной оплаты", "nextNodeId": "partial"},
										map[string]any{"id": "d", "text": "Сразу оплачу", "result": "incorrect", "feedback": "Это опасный выбор", "nextNodeId": "bad"},
									},
								},
								map[string]any{"id": "ok", "kind": "story", "body": map[string]any{"text": "Правильная ветка"}, "nextNodeId": "end"},
								map[string]any{"id": "partial", "kind": "story", "body": map[string]any{"text": "Почти правильная ветка"}, "nextNodeId": "end"},
								map[string]any{"id": "bad", "kind": "story", "body": map[string]any{"text": "Неправильная ветка"}, "nextNodeId": "end"},
								map[string]any{"id": "end", "kind": "end", "text": "Done"},
							},
						},
					},
				},
			},
		},
	})

	testCases := []struct {
		name            string
		code            string
		optionID        string
		wantVerdict     string
		wantXP          int
		wantHeartsDelta int
		wantStoryText   string
	}{
		{name: "correct A", code: "student-multi-a", optionID: "a", wantVerdict: "correct", wantXP: 10, wantHeartsDelta: 0, wantStoryText: "Правильная ветка"},
		{name: "correct B", code: "student-multi-b", optionID: "b", wantVerdict: "correct", wantXP: 10, wantHeartsDelta: 0, wantStoryText: "Правильная ветка"},
		{name: "partial", code: "student-multi-c", optionID: "c", wantVerdict: "partial", wantXP: 5, wantHeartsDelta: 0, wantStoryText: "Почти правильная ветка"},
		{name: "incorrect", code: "student-multi-d", optionID: "d", wantVerdict: "incorrect", wantXP: 0, wantHeartsDelta: -1, wantStoryText: "Неправильная ветка"},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			studentClient := httpclient.New(t)
			studentCSRF, _ := loginAsRole(t, studentClient, testApp, tc.code, "student")

			startResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/start", map[string]any{}, studentCSRF)
			if startResp.StatusCode != http.StatusOK {
				t.Fatalf("start status: %d", startResp.StatusCode)
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

			answerResp := performJSONWithIdempotency(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/answer", map[string]any{
				"state_version": start.StateVersion,
				"node_id":       start.NodeID,
				"answer":        map[string]any{"option_id": tc.optionID},
			}, studentCSRF, "idem-"+tc.optionID)
			if answerResp.StatusCode != http.StatusOK {
				t.Fatalf("answer status: %d", answerResp.StatusCode)
			}
			defer answerResp.Body.Close()
			var answer struct {
				Verdict     string `json:"verdict"`
				XPDelta     int    `json:"xp_delta"`
				HeartsDelta int    `json:"hearts_delta"`
				NextStep    *struct {
					Payload map[string]any `json:"payload"`
				} `json:"next_step"`
			}
			if err := json.NewDecoder(answerResp.Body).Decode(&answer); err != nil {
				t.Fatalf("decode answer: %v", err)
			}
			if answer.Verdict != tc.wantVerdict || answer.XPDelta != tc.wantXP || answer.HeartsDelta != tc.wantHeartsDelta {
				t.Fatalf("unexpected outcome: %+v", answer)
			}
			if answer.NextStep == nil || answer.NextStep.Payload["text"] != tc.wantStoryText {
				t.Fatalf("unexpected next step payload: %+v", answer.NextStep)
			}
		})
	}
}

func TestStudentRuntime_FreeTextUsesAuthoredFeedbackByVerdict(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)

	courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Free Text Feedback", map[string]any{
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
								map[string]any{"id": "intro", "kind": "story", "body": map[string]any{"text": "Start"}, "nextNodeId": "free"},
								map[string]any{
									"id":     "free",
									"kind":   "free_text",
									"prompt": "Почему нельзя использовать один пароль везде?",
									"rubric": map[string]any{
										"referenceAnswer": "Один взлом откроет доступ ко всем аккаунтам.",
										"criteriaByVerdict": map[string]any{
											"correct":   "Упоминает риск для всех аккаунтов.",
											"partial":   "Упоминает опасность, но не раскрывает масштаб.",
											"incorrect": "Не объясняет основной риск.",
										},
										"feedbackByVerdict": map[string]any{
											"correct":   "Авторская обратная связь: полный ответ.",
											"partial":   "Авторская обратная связь: почти правильно.",
											"incorrect": "Авторская обратная связь: неверно.",
										},
									},
									"transitions": []any{
										map[string]any{"onVerdict": "correct", "nextNodeId": "ok"},
										map[string]any{"onVerdict": "partial", "nextNodeId": "partial"},
										map[string]any{"onVerdict": "incorrect", "nextNodeId": "bad"},
									},
								},
								map[string]any{"id": "ok", "kind": "story", "body": map[string]any{"text": "Correct path"}, "nextNodeId": "end"},
								map[string]any{"id": "partial", "kind": "story", "body": map[string]any{"text": "Partial path"}, "nextNodeId": "end"},
								map[string]any{"id": "bad", "kind": "story", "body": map[string]any{"text": "Incorrect path"}, "nextNodeId": "end"},
								map[string]any{"id": "end", "kind": "end", "text": "Done"},
							},
						},
					},
				},
			},
		},
	})

	testCases := []struct {
		name         string
		code         string
		answer       string
		wantVerdict  string
		wantFeedback string
		wantStory    string
	}{
		{name: "correct", code: "student-free-correct", answer: "[llm:correct] all accounts", wantVerdict: "correct", wantFeedback: "Авторская обратная связь: полный ответ.", wantStory: "Correct path"},
		{name: "partial", code: "student-free-partial", answer: "[llm:partial] dangerous", wantVerdict: "partial", wantFeedback: "Авторская обратная связь: почти правильно.", wantStory: "Partial path"},
		{name: "incorrect", code: "student-free-incorrect", answer: "[llm:incorrect] idk", wantVerdict: "incorrect", wantFeedback: "Авторская обратная связь: неверно.", wantStory: "Incorrect path"},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			studentClient := httpclient.New(t)
			studentCSRF, _ := loginAsRole(t, studentClient, testApp, tc.code, "student")

			sessionID, stateVersion, nodeID := startFreeTextSession(t, studentClient, testApp, studentCSRF, courseID)
			answerResp := performJSONWithIdempotency(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+sessionID+"/answer", map[string]any{
				"state_version": stateVersion,
				"node_id":       nodeID,
				"answer":        map[string]any{"text": tc.answer},
			}, studentCSRF, "idem-"+tc.name)
			if answerResp.StatusCode != http.StatusOK {
				t.Fatalf("answer status: %d", answerResp.StatusCode)
			}
			defer answerResp.Body.Close()
			var answer struct {
				Verdict      string `json:"verdict"`
				FeedbackText string `json:"feedback_text"`
				NextStep     *struct {
					Payload map[string]any `json:"payload"`
				} `json:"next_step"`
			}
			if err := json.NewDecoder(answerResp.Body).Decode(&answer); err != nil {
				t.Fatalf("decode answer: %v", err)
			}
			if answer.Verdict != tc.wantVerdict || answer.FeedbackText != tc.wantFeedback {
				t.Fatalf("unexpected free-text outcome: %+v", answer)
			}
			if answer.NextStep == nil || answer.NextStep.Payload["text"] != tc.wantStory {
				t.Fatalf("unexpected next step: %+v", answer.NextStep)
			}
		})
	}
}

func TestStudentRuntime_DecisionBacktrackingAndResume(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)

	courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Decision Backtracking", map[string]any{
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
								map[string]any{"id": "intro", "kind": "story", "body": map[string]any{"text": "Intro"}, "nextNodeId": "decision_1"},
								map[string]any{
									"id":     "decision_1",
									"kind":   "decision",
									"prompt": "Что сделаешь?",
									"options": []any{
										map[string]any{"id": "a", "text": "Проверю факты", "nextNodeId": "story_a"},
										map[string]any{"id": "b", "text": "Сразу решу", "nextNodeId": "story_b"},
									},
								},
								map[string]any{"id": "story_a", "kind": "story", "body": map[string]any{"text": "Ветка A"}, "nextNodeId": "end"},
								map[string]any{"id": "story_b", "kind": "story", "body": map[string]any{"text": "Ветка B"}, "nextNodeId": "end"},
								map[string]any{"id": "end", "kind": "end", "text": "Done"},
							},
						},
					},
				},
			},
		},
	})

	studentClient := httpclient.New(t)
	studentCSRF, _ := loginAsRole(t, studentClient, testApp, "student-decision-back", "student")

	startResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/courses/"+courseID+"/lessons/lesson_1/start", map[string]any{}, studentCSRF)
	if startResp.StatusCode != http.StatusOK {
		t.Fatalf("start status: %d", startResp.StatusCode)
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

	nextResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/next", map[string]any{
		"state_version":    start.StateVersion,
		"expected_node_id": start.NodeID,
	}, studentCSRF)
	if nextResp.StatusCode != http.StatusOK {
		t.Fatalf("next status: %d", nextResp.StatusCode)
	}
	defer nextResp.Body.Close()
	var decision struct {
		StateVersion int64 `json:"state_version"`
		NodeID       string `json:"node_id"`
		NodeKind     string `json:"node_kind"`
	}
	if err := json.NewDecoder(nextResp.Body).Decode(&decision); err != nil {
		t.Fatalf("decode decision: %v", err)
	}
	if decision.NodeKind != "decision" {
		t.Fatalf("expected decision node, got %s", decision.NodeKind)
	}

	chooseA := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/decision", map[string]any{
		"state_version": decision.StateVersion,
		"node_id":       decision.NodeID,
		"option_id":     "a",
	}, studentCSRF)
	if chooseA.StatusCode != http.StatusOK {
		t.Fatalf("choose A status: %d", chooseA.StatusCode)
	}
	defer chooseA.Body.Close()
	var storyA struct {
		StateVersion int64 `json:"state_version"`
		NodeID       string `json:"node_id"`
		Payload      map[string]any `json:"payload"`
		Navigation   struct {
			CanGoBack bool `json:"can_go_back"`
		} `json:"navigation"`
	}
	if err := json.NewDecoder(chooseA.Body).Decode(&storyA); err != nil {
		t.Fatalf("decode story A: %v", err)
	}
	if storyA.Payload["text"] != "Ветка A" || !storyA.Navigation.CanGoBack {
		t.Fatalf("unexpected story A payload/navigation: %+v", storyA)
	}

	backResp := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/back", map[string]any{
		"state_version": storyA.StateVersion,
	}, studentCSRF)
	if backResp.StatusCode != http.StatusOK {
		t.Fatalf("back status: %d", backResp.StatusCode)
	}
	defer backResp.Body.Close()
	var rewound struct {
		StateVersion int64 `json:"state_version"`
		NodeID       string `json:"node_id"`
		NodeKind     string `json:"node_kind"`
	}
	if err := json.NewDecoder(backResp.Body).Decode(&rewound); err != nil {
		t.Fatalf("decode rewound: %v", err)
	}
	if rewound.NodeKind != "decision" {
		t.Fatalf("expected rewound decision node, got %+v", rewound)
	}

	resumeResp, err := studentClient.Get(testApp.Server.URL + "/api/v1/student/courses/" + courseID + "/lessons/lesson_1/session")
	if err != nil {
		t.Fatalf("resume request: %v", err)
	}
	defer resumeResp.Body.Close()
	if resumeResp.StatusCode != http.StatusOK {
		t.Fatalf("resume status: %d", resumeResp.StatusCode)
	}
	var resumed struct {
		NodeID   string `json:"node_id"`
		NodeKind string `json:"node_kind"`
	}
	if err := json.NewDecoder(resumeResp.Body).Decode(&resumed); err != nil {
		t.Fatalf("decode resumed: %v", err)
	}
	if resumed.NodeKind != "decision" || resumed.NodeID != "decision_1" {
		t.Fatalf("unexpected resumed state: %+v", resumed)
	}

	staleBack := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/back", map[string]any{
		"state_version": storyA.StateVersion,
	}, studentCSRF)
	if staleBack.StatusCode != http.StatusConflict {
		t.Fatalf("stale back status: %d", staleBack.StatusCode)
	}

	chooseB := performJSON(t, studentClient, http.MethodPost, testApp.Server.URL+"/api/v1/student/lesson-sessions/"+start.SessionID+"/decision", map[string]any{
		"state_version": rewound.StateVersion,
		"node_id":       rewound.NodeID,
		"option_id":     "b",
	}, studentCSRF)
	if chooseB.StatusCode != http.StatusOK {
		t.Fatalf("choose B status: %d", chooseB.StatusCode)
	}
	defer chooseB.Body.Close()
	var storyB struct {
		Payload map[string]any `json:"payload"`
	}
	if err := json.NewDecoder(chooseB.Body).Decode(&storyB); err != nil {
		t.Fatalf("decode story B: %v", err)
	}
	if storyB.Payload["text"] != "Ветка B" {
		t.Fatalf("unexpected branch after back: %+v", storyB)
	}
}
