package tests

import (
	"encoding/json"
	"net/http"
	"testing"

	"pravoprost/backend/internal/testkit/app"
	httpclient "pravoprost/backend/internal/testkit/http"
)

func TestPreview_DecisionBranchingSupportsBacktracking(t *testing.T) {
	testApp := app.New(t)
	teacherClient := httpclient.New(t)
	teacherCSRF, _ := loginAsRole(t, teacherClient, testApp, "teacher-preview-decision", "teacher")
	_ = performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/profile", map[string]any{
		"display_name":      "Preview Teacher",
		"organization_name": "School",
		"avatar_asset_id":   nil,
	}, teacherCSRF)

	createResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/teacher/courses", map[string]any{
		"title":       "Preview Decision Course",
		"description": "Basics",
	}, teacherCSRF)
	if createResp.StatusCode != http.StatusCreated {
		t.Fatalf("create course status: %d", createResp.StatusCode)
	}
	defer createResp.Body.Close()
	var created struct {
		CourseID string `json:"course_id"`
	}
	if err := json.NewDecoder(createResp.Body).Decode(&created); err != nil {
		t.Fatalf("decode created course: %v", err)
	}

	updateResp := performJSON(t, teacherClient, http.MethodPut, testApp.Server.URL+"/api/v1/teacher/courses/"+created.CourseID+"/draft", map[string]any{
		"draft_version":  1,
		"title":          "Preview Decision Course",
		"description":    "Basics",
		"cover_asset_id": nil,
		"content": map[string]any{
			"modules": []any{
				map[string]any{
					"id": "module_1",
					"lessons": []any{
						map[string]any{
							"id":    "lesson_1",
							"title": "Scenario",
							"graph": map[string]any{
								"startNodeId": "intro",
								"nodes": []any{
									map[string]any{"id": "intro", "kind": "story", "body": map[string]any{"text": "Start"}, "nextNodeId": "decision_1"},
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
		},
	}, teacherCSRF)
	if updateResp.StatusCode != http.StatusOK {
		t.Fatalf("update draft status: %d", updateResp.StatusCode)
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
		} `json:"step"`
	}
	if err := json.NewDecoder(startResp.Body).Decode(&preview); err != nil {
		t.Fatalf("decode preview start: %v", err)
	}

	nextResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/preview-sessions/"+preview.PreviewSessionID+"/next", map[string]any{
		"state_version":    preview.Step.StateVersion,
		"expected_node_id": preview.Step.NodeID,
	}, teacherCSRF)
	if nextResp.StatusCode != http.StatusOK {
		t.Fatalf("preview next status: %d", nextResp.StatusCode)
	}
	defer nextResp.Body.Close()
	var decision struct {
		Step struct {
			StateVersion int64  `json:"state_version"`
			NodeID       string `json:"node_id"`
			NodeKind     string `json:"node_kind"`
		} `json:"step"`
	}
	if err := json.NewDecoder(nextResp.Body).Decode(&decision); err != nil {
		t.Fatalf("decode preview decision: %v", err)
	}
	if decision.Step.NodeKind != "decision" {
		t.Fatalf("expected decision node, got %+v", decision.Step)
	}

	chooseA := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/preview-sessions/"+preview.PreviewSessionID+"/decision", map[string]any{
		"state_version": decision.Step.StateVersion,
		"node_id":       decision.Step.NodeID,
		"option_id":     "a",
	}, teacherCSRF)
	if chooseA.StatusCode != http.StatusOK {
		t.Fatalf("preview choose A status: %d", chooseA.StatusCode)
	}
	defer chooseA.Body.Close()
	var storyA struct {
		Step struct {
			StateVersion int64          `json:"state_version"`
			Payload      map[string]any `json:"payload"`
			Navigation   struct {
				CanGoBack bool `json:"can_go_back"`
			} `json:"navigation"`
		} `json:"step"`
	}
	if err := json.NewDecoder(chooseA.Body).Decode(&storyA); err != nil {
		t.Fatalf("decode preview story A: %v", err)
	}
	if storyA.Step.Payload["text"] != "Ветка A" || !storyA.Step.Navigation.CanGoBack {
		t.Fatalf("unexpected preview branch A: %+v", storyA)
	}

	backResp := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/preview-sessions/"+preview.PreviewSessionID+"/back", map[string]any{
		"state_version": storyA.Step.StateVersion,
	}, teacherCSRF)
	if backResp.StatusCode != http.StatusOK {
		t.Fatalf("preview back status: %d", backResp.StatusCode)
	}
	defer backResp.Body.Close()
	var rewound struct {
		Step struct {
			StateVersion int64  `json:"state_version"`
			NodeID       string `json:"node_id"`
			NodeKind     string `json:"node_kind"`
		} `json:"step"`
	}
	if err := json.NewDecoder(backResp.Body).Decode(&rewound); err != nil {
		t.Fatalf("decode preview rewound: %v", err)
	}
	if rewound.Step.NodeKind != "decision" {
		t.Fatalf("expected preview decision after back, got %+v", rewound)
	}

	chooseB := performJSON(t, teacherClient, http.MethodPost, testApp.Server.URL+"/api/v1/preview-sessions/"+preview.PreviewSessionID+"/decision", map[string]any{
		"state_version": rewound.Step.StateVersion,
		"node_id":       rewound.Step.NodeID,
		"option_id":     "b",
	}, teacherCSRF)
	if chooseB.StatusCode != http.StatusOK {
		t.Fatalf("preview choose B status: %d", chooseB.StatusCode)
	}
	defer chooseB.Body.Close()
	var storyB struct {
		Step struct {
			Payload map[string]any `json:"payload"`
		} `json:"step"`
	}
	if err := json.NewDecoder(chooseB.Body).Decode(&storyB); err != nil {
		t.Fatalf("decode preview story B: %v", err)
	}
	if storyB.Step.Payload["text"] != "Ветка B" {
		t.Fatalf("unexpected preview branch B: %+v", storyB)
	}
}
