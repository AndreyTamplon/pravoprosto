package tests

import (
	"encoding/json"
	"net/http"
	"testing"

	"pravoprost/backend/internal/testkit/app"
	httpclient "pravoprost/backend/internal/testkit/http"
)

// freeTextOutcomesContent builds a course whose free_text question uses the new
// dynamic-outcome rubric: two distinct "correct" outcomes with different
// feedback/branches (Diana's scenario), one "incorrect" outcome, and a default
// "else" outcome. Routing lives inside each outcome's nextNodeId (no transitions).
func freeTextOutcomesContent() map[string]any {
	return map[string]any{
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
										"outcomes": []any{
											map[string]any{"id": "oc_full", "criteria": "Объясняет риск для всех аккаунтов.", "verdict": "correct", "feedback": "Полный ответ!", "nextNodeId": "full"},
											map[string]any{"id": "oc_basic", "criteria": "Называет опасность, но без масштаба.", "verdict": "correct", "feedback": "Верно, но кратко.", "nextNodeId": "basic"},
											map[string]any{"id": "oc_wrong", "criteria": "Не объясняет риск.", "verdict": "incorrect", "feedback": "Это неверно.", "nextNodeId": "bad"},
										},
										"defaultOutcome": map[string]any{"verdict": "incorrect", "feedback": "Ответ не по теме.", "nextNodeId": "bad"},
									},
								},
								map[string]any{"id": "full", "kind": "story", "body": map[string]any{"text": "Full path"}, "nextNodeId": "end"},
								map[string]any{"id": "basic", "kind": "story", "body": map[string]any{"text": "Basic path"}, "nextNodeId": "end"},
								map[string]any{"id": "bad", "kind": "story", "body": map[string]any{"text": "Wrong path"}, "nextNodeId": "end"},
								map[string]any{"id": "end", "kind": "end", "text": "Done"},
							},
						},
					},
				},
			},
		},
	}
}

func TestStudentRuntime_FreeTextOutcomesSelection(t *testing.T) {
	testApp := app.New(t)
	adminClient := httpclient.New(t)
	adminCSRF := loginExistingAdmin(t, adminClient, testApp)

	courseID, _ := publishPlatformCourse(t, adminClient, testApp, adminCSRF, "Free Text Outcomes", freeTextOutcomesContent())

	testCases := []struct {
		name         string
		code         string
		answer       string
		wantVerdict  string
		wantFeedback string
		wantStory    string
	}{
		// Two correct outcomes are distinguished only by the picked outcome id.
		{name: "first_correct", code: "ft-oc-full", answer: "[llm:outcome:oc_full] every account is exposed", wantVerdict: "correct", wantFeedback: "Полный ответ!", wantStory: "Full path"},
		{name: "second_correct", code: "ft-oc-basic", answer: "[llm:outcome:oc_basic] it is dangerous", wantVerdict: "correct", wantFeedback: "Верно, но кратко.", wantStory: "Basic path"},
		{name: "incorrect", code: "ft-oc-wrong", answer: "[llm:outcome:oc_wrong] no idea", wantVerdict: "incorrect", wantFeedback: "Это неверно.", wantStory: "Wrong path"},
		// "none" routes to the default ("else") outcome.
		{name: "default_else", code: "ft-oc-none", answer: "[llm:none] something unrelated", wantVerdict: "incorrect", wantFeedback: "Ответ не по теме.", wantStory: "Wrong path"},
		// Back-compat: a bare verdict marker picks the first outcome of that verdict.
		{name: "verdict_marker", code: "ft-oc-verdict", answer: "[llm:correct] all accounts", wantVerdict: "correct", wantFeedback: "Полный ответ!", wantStory: "Full path"},
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
			}, studentCSRF, "idem-oc-"+tc.name)
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
				t.Fatalf("unexpected outcome: got verdict=%q feedback=%q, want verdict=%q feedback=%q", answer.Verdict, answer.FeedbackText, tc.wantVerdict, tc.wantFeedback)
			}
			if answer.NextStep == nil || answer.NextStep.Payload["text"] != tc.wantStory {
				t.Fatalf("unexpected next step: %+v", answer.NextStep)
			}
		})
	}
}
