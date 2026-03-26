package courses

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

type parsedLesson struct {
	ID    string
	Title string
	Graph lessonGraph
}

type lessonGraph struct {
	StartNodeID string
	NodeMap     map[string]graphNode
	Order       []string
}

type graphNode struct {
	ID          string
	Kind        string
	NextNodeID  string
	Prompt      string
	Text        string
	AssetURL    string
	Options     []graphOption
	Transitions map[string]string
	Rubric      map[string]any
}

type graphOption struct {
	ID         string
	Text       string
	Result     string
	Feedback   string
	NextNodeID string
}

type previewSession struct {
	ID           string
	OwnerRole    string
	OwnerID      string
	CourseID     string
	LessonID     string
	ReturnPath   string
	Graph        lessonGraph
	History      []previewPathEntry
	CurrentID    string
	StateVersion int64
	LastTouched  time.Time
}

type previewPathEntry struct {
	NodeID           string
	NodeKind         string
	DecisionOptionID string
	Active           bool
}

type revisionLesson struct {
	ModuleID  string
	LessonID  string
	Title     string
	SortOrder int
}

func findLesson(contentRaw json.RawMessage, lessonID string) (parsedLesson, error) {
	content := map[string]any{}
	if err := json.Unmarshal(contentRaw, &content); err != nil {
		return parsedLesson{}, err
	}
	modules, _ := content["modules"].([]any)
	for _, rawModule := range modules {
		module, _ := rawModule.(map[string]any)
		lessons, _ := module["lessons"].([]any)
		for _, rawLesson := range lessons {
			lesson, _ := rawLesson.(map[string]any)
			if asString(lesson["id"]) == lessonID {
				return parsedLesson{
					ID:    lessonID,
					Title: asString(lesson["title"]),
					Graph: parseGraph(lesson["graph"]),
				}, nil
			}
		}
	}
	return parsedLesson{}, ErrCourseNotFound
}

func parseGraph(raw any) lessonGraph {
	graphMap, _ := raw.(map[string]any)
	nodes, _ := graphMap["nodes"].([]any)
	nodeMap := make(map[string]graphNode, len(nodes))
	order := make([]string, 0, len(nodes))
	for _, rawNode := range nodes {
		nodeData, _ := rawNode.(map[string]any)
		node := graphNode{
			ID:          asString(nodeData["id"]),
			Kind:        asString(nodeData["kind"]),
			NextNodeID:  asString(nodeData["nextNodeId"]),
			Prompt:      asString(nodeData["prompt"]),
			Text:        asString(nodeData["text"]),
			AssetURL:    asString(nodeData["asset_url"]),
			Transitions: map[string]string{},
		}
		if body, ok := nodeData["body"].(map[string]any); ok {
			node.Text = firstNonEmpty(node.Text, asString(body["text"]))
			node.AssetURL = firstNonEmpty(node.AssetURL, asString(body["assetUrl"]), asString(body["asset_url"]))
		}
		if rubric, ok := nodeData["rubric"].(map[string]any); ok {
			node.Rubric = rubric
		}
		if options, ok := nodeData["options"].([]any); ok {
			for _, rawOption := range options {
				optionMap, _ := rawOption.(map[string]any)
				node.Options = append(node.Options, graphOption{
					ID:         asString(optionMap["id"]),
					Text:       asString(optionMap["text"]),
					Result:     asString(optionMap["result"]),
					Feedback:   asString(optionMap["feedback"]),
					NextNodeID: asString(optionMap["nextNodeId"]),
				})
			}
		}
		if transitions, ok := nodeData["transitions"].([]any); ok {
			for _, rawTransition := range transitions {
				transitionMap, _ := rawTransition.(map[string]any)
				node.Transitions[asString(transitionMap["onVerdict"])] = asString(transitionMap["nextNodeId"])
			}
		}
		nodeMap[node.ID] = node
		order = append(order, node.ID)
	}
	return lessonGraph{
		StartNodeID: asString(graphMap["startNodeId"]),
		NodeMap:     nodeMap,
		Order:       order,
	}
}

func buildStepView(sessionID string, courseID string, lessonID string, stateVersion int64, graph lessonGraph, currentID string, node graphNode) StepView {
	payload := map[string]any{}
	switch node.Kind {
	case "story":
		payload["text"] = node.Text
		if node.AssetURL != "" {
			payload["asset_url"] = node.AssetURL
		}
	case "single_choice":
		payload["prompt"] = node.Prompt
		options := make([]map[string]any, 0, len(node.Options))
		for _, option := range node.Options {
			options = append(options, map[string]any{
				"id":   option.ID,
				"text": option.Text,
			})
		}
		payload["options"] = options
	case "decision":
		payload["prompt"] = node.Prompt
		options := make([]map[string]any, 0, len(node.Options))
		for _, option := range node.Options {
			options = append(options, map[string]any{
				"id":   option.ID,
				"text": option.Text,
			})
		}
		payload["options"] = options
	case "free_text":
		payload["prompt"] = node.Prompt
	case "end":
		payload["text"] = firstNonEmpty(node.Text, "End")
	}
	total := len(graph.Order)
	completed := 0
	for index, nodeID := range graph.Order {
		if nodeID == currentID {
			completed = index + 1
			break
		}
	}
	progress := 0.0
	if total > 0 {
		progress = float64(completed) / float64(total)
	}
	return StepView{
		SessionID:      sessionID,
		CourseID:       courseID,
		LessonID:       lessonID,
		StateVersion:   stateVersion,
		NodeID:         currentID,
		NodeKind:       node.Kind,
		Payload:        payload,
		StepsCompleted: completed,
		StepsTotal:     total,
		ProgressRatio:  progress,
		GameState:      nil,
		Navigation:     StepNavigation{},
	}
}

func flattenLessons(courseID string, revisionID string, contentRaw json.RawMessage) ([]revisionLesson, error) {
	content := map[string]any{}
	if err := json.Unmarshal(contentRaw, &content); err != nil {
		return nil, err
	}
	modules, _ := content["modules"].([]any)
	out := make([]revisionLesson, 0)
	sortOrder := 1
	for _, rawModule := range modules {
		module, _ := rawModule.(map[string]any)
		moduleID := asString(module["id"])
		lessons, _ := module["lessons"].([]any)
		for _, rawLesson := range lessons {
			lesson, _ := rawLesson.(map[string]any)
			out = append(out, revisionLesson{
				ModuleID:  moduleID,
				LessonID:  asString(lesson["id"]),
				Title:     asString(lesson["title"]),
				SortOrder: sortOrder,
			})
			sortOrder++
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no lessons to publish")
	}
	return out, nil
}

func ptrStep(step StepView) *StepView {
	return &step
}

func buildPreviewEnvelope(session *previewSession) PreviewStepEnvelope {
	node := session.Graph.NodeMap[session.CurrentID]
	step := buildStepView(session.ID, session.CourseID, session.LessonID, session.StateVersion, session.Graph, session.CurrentID, node)
	step.Navigation = previewNavigation(session)
	return PreviewStepEnvelope{
		Preview:          true,
		PreviewSessionID: session.ID,
		ReturnPath:       session.ReturnPath,
		Step:             step,
	}
}

func previewNavigation(session *previewSession) StepNavigation {
	currentIndex := latestActivePreviewHistoryIndex(session)
	if currentIndex <= 0 {
		return StepNavigation{}
	}
	for index := currentIndex - 1; index >= 0; index-- {
		entry := session.History[index]
		if !entry.Active || entry.NodeKind != "decision" {
			continue
		}
		backKind := "decision"
		backTargetNodeID := entry.NodeID
		return StepNavigation{
			CanGoBack:        true,
			BackKind:         &backKind,
			BackTargetNodeID: &backTargetNodeID,
		}
	}
	return StepNavigation{}
}

func latestActivePreviewHistoryIndex(session *previewSession) int {
	for index := len(session.History) - 1; index >= 0; index-- {
		if session.History[index].Active {
			return index
		}
	}
	return -1
}

func appendPreviewHistory(session *previewSession, node graphNode, decisionOptionID string) {
	session.History = append(session.History, previewPathEntry{
		NodeID:           node.ID,
		NodeKind:         node.Kind,
		DecisionOptionID: decisionOptionID,
		Active:           true,
	})
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
