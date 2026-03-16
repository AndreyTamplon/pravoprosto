package courses

import "fmt"

type assetReference struct {
	Path    string
	AssetID string
}

func validateContent(content map[string]any) []ValidationError {
	errors := make([]ValidationError, 0)
	moduleIDs := map[string]bool{}
	lessonIDs := map[string]bool{}

	modules, _ := content["modules"].([]any)
	for moduleIndex, rawModule := range modules {
		module, ok := rawModule.(map[string]any)
		if !ok {
			errors = append(errors, ValidationError{
				Path:    fmt.Sprintf("modules[%d]", moduleIndex),
				Code:    "invalid_module",
				Message: "Module must be an object",
			})
			continue
		}
		moduleID := asString(module["id"])
		if moduleID == "" {
			errors = append(errors, ValidationError{
				Path:    fmt.Sprintf("modules[%d].id", moduleIndex),
				Code:    "missing_module_id",
				Message: "Module id is required",
			})
		} else if moduleIDs[moduleID] {
			errors = append(errors, ValidationError{
				Path:    fmt.Sprintf("modules[%d].id", moduleIndex),
				Code:    "duplicate_module_id",
				Message: "Module id must be unique",
			})
		} else {
			moduleIDs[moduleID] = true
		}

		lessons, _ := module["lessons"].([]any)
		for lessonIndex, rawLesson := range lessons {
			lesson, ok := rawLesson.(map[string]any)
			if !ok {
				errors = append(errors, ValidationError{
					Path:    fmt.Sprintf("modules[%d].lessons[%d]", moduleIndex, lessonIndex),
					Code:    "invalid_lesson",
					Message: "Lesson must be an object",
				})
				continue
			}
			lessonID := asString(lesson["id"])
			if lessonID == "" {
				errors = append(errors, ValidationError{
					Path:    fmt.Sprintf("modules[%d].lessons[%d].id", moduleIndex, lessonIndex),
					Code:    "missing_lesson_id",
					Message: "Lesson id is required",
				})
			} else if lessonIDs[lessonID] {
				errors = append(errors, ValidationError{
					Path:    fmt.Sprintf("modules[%d].lessons[%d].id", moduleIndex, lessonIndex),
					Code:    "duplicate_lesson_id",
					Message: "Lesson id must be unique within the course",
				})
			} else {
				lessonIDs[lessonID] = true
			}
			graph, _ := lesson["graph"].(map[string]any)
			errors = append(errors, validateLessonGraph(moduleIndex, lessonIndex, graph)...)
		}
	}
	return errors
}

func collectAssetReferences(value any, path string) []assetReference {
	refs := make([]assetReference, 0)
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			childPath := key
			if path != "" {
				childPath = path + "." + key
			}
			if (key == "assetId" || key == "asset_id") && asString(child) != "" {
				refs = append(refs, assetReference{
					Path:    childPath,
					AssetID: asString(child),
				})
			}
			refs = append(refs, collectAssetReferences(child, childPath)...)
		}
	case []any:
		for index, child := range typed {
			childPath := fmt.Sprintf("[%d]", index)
			if path != "" {
				childPath = fmt.Sprintf("%s[%d]", path, index)
			}
			refs = append(refs, collectAssetReferences(child, childPath)...)
		}
	}
	return refs
}

func validateLessonGraph(moduleIndex int, lessonIndex int, graph map[string]any) []ValidationError {
	basePath := fmt.Sprintf("modules[%d].lessons[%d].graph", moduleIndex, lessonIndex)
	errors := make([]ValidationError, 0)
	if graph == nil {
		return append(errors, ValidationError{
			Path:    basePath,
			Code:    "missing_graph",
			Message: "Lesson graph is required",
		})
	}

	startNodeID := asString(graph["startNodeId"])
	nodes, _ := graph["nodes"].([]any)
	if startNodeID == "" {
		errors = append(errors, ValidationError{
			Path:    basePath + ".startNodeId",
			Code:    "missing_start_node",
			Message: "Graph startNodeId is required",
		})
	}

	nodeMap := map[string]map[string]any{}
	edges := map[string][]string{}
	for nodeIndex, rawNode := range nodes {
		node, ok := rawNode.(map[string]any)
		if !ok {
			errors = append(errors, ValidationError{
				Path:    fmt.Sprintf("%s.nodes[%d]", basePath, nodeIndex),
				Code:    "invalid_node",
				Message: "Node must be an object",
			})
			continue
		}
		nodeID := asString(node["id"])
		if nodeID == "" {
			errors = append(errors, ValidationError{
				Path:    fmt.Sprintf("%s.nodes[%d].id", basePath, nodeIndex),
				Code:    "missing_node_id",
				Message: "Node id is required",
			})
			continue
		}
		if _, exists := nodeMap[nodeID]; exists {
			errors = append(errors, ValidationError{
				Path:    fmt.Sprintf("%s.nodes[%d].id", basePath, nodeIndex),
				Code:    "duplicate_node_id",
				Message: "Node ids must be unique",
			})
			continue
		}
		nodeMap[nodeID] = node
		edges[nodeID] = collectTargets(node, basePath, nodeIndex, &errors)
	}

	if startNodeID != "" {
		if _, exists := nodeMap[startNodeID]; !exists {
			errors = append(errors, ValidationError{
				Path:    basePath + ".startNodeId",
				Code:    "missing_start_target",
				Message: "startNodeId must point to an existing node",
			})
		}
	}

	for nodeID, targets := range edges {
		for _, target := range targets {
			if target == "" {
				continue
			}
			if _, exists := nodeMap[target]; !exists {
				errors = append(errors, ValidationError{
					Path:    basePath + ".nodes",
					Code:    "missing_transition_target",
					Message: fmt.Sprintf("Node %s points to missing target %s", nodeID, target),
				})
			}
		}
	}

	if startNodeID != "" {
		visited := map[string]bool{}
		stack := map[string]bool{}
		var visit func(string)
		visit = func(id string) {
			if stack[id] {
				errors = append(errors, ValidationError{
					Path:    basePath,
					Code:    "cycle_detected",
					Message: "Lesson graph must be acyclic",
				})
				return
			}
			if visited[id] {
				return
			}
			visited[id] = true
			stack[id] = true
			for _, target := range edges[id] {
				if _, exists := nodeMap[target]; exists {
					visit(target)
				}
			}
			stack[id] = false
		}
		visit(startNodeID)
		for nodeID := range nodeMap {
			if !visited[nodeID] {
				errors = append(errors, ValidationError{
					Path:    basePath,
					Code:    "unreachable_node",
					Message: fmt.Sprintf("Node %s is unreachable from startNodeId", nodeID),
				})
			}
		}
	}
	return errors
}

func collectTargets(node map[string]any, basePath string, nodeIndex int, errors *[]ValidationError) []string {
	kind := asString(node["kind"])
	targets := make([]string, 0)
	switch kind {
	case "story":
		nextID := asString(node["nextNodeId"])
		if nextID == "" && !asBool(node["terminal"]) {
			*errors = append(*errors, ValidationError{
				Path:    fmt.Sprintf("%s.nodes[%d].nextNodeId", basePath, nodeIndex),
				Code:    "missing_transition",
				Message: "Story node must define nextNodeId unless terminal",
			})
		}
		if nextID != "" {
			targets = append(targets, nextID)
		}
	case "single_choice":
		options, _ := node["options"].([]any)
		if len(options) == 0 {
			*errors = append(*errors, ValidationError{
				Path:    fmt.Sprintf("%s.nodes[%d].options", basePath, nodeIndex),
				Code:    "missing_options",
				Message: "Single choice node must define options",
			})
		}
		for optionIndex, rawOption := range options {
			option, _ := rawOption.(map[string]any)
			nextID := asString(option["nextNodeId"])
			if asString(option["id"]) == "" || asString(option["feedback"]) == "" || asString(option["result"]) == "" || nextID == "" {
				*errors = append(*errors, ValidationError{
					Path:    fmt.Sprintf("%s.nodes[%d].options[%d]", basePath, nodeIndex, optionIndex),
					Code:    "invalid_option",
					Message: "Single choice option must define id, result, feedback, and nextNodeId",
				})
			}
			if nextID != "" {
				targets = append(targets, nextID)
			}
		}
	case "free_text":
		transitions, _ := node["transitions"].([]any)
		found := map[string]bool{}
		for transitionIndex, rawTransition := range transitions {
			transition, _ := rawTransition.(map[string]any)
			verdict := asString(transition["onVerdict"])
			nextID := asString(transition["nextNodeId"])
			if verdict == "" || nextID == "" {
				*errors = append(*errors, ValidationError{
					Path:    fmt.Sprintf("%s.nodes[%d].transitions[%d]", basePath, nodeIndex, transitionIndex),
					Code:    "invalid_transition",
					Message: "Free text transition must define onVerdict and nextNodeId",
				})
				continue
			}
			found[verdict] = true
			targets = append(targets, nextID)
		}
		for _, verdict := range []string{"correct", "partial", "incorrect"} {
			if !found[verdict] {
				*errors = append(*errors, ValidationError{
					Path:    fmt.Sprintf("%s.nodes[%d]", basePath, nodeIndex),
					Code:    "missing_transition",
					Message: "Free text node must define transitions for all three verdicts",
				})
			}
		}
	case "end":
	default:
		*errors = append(*errors, ValidationError{
			Path:    basePath + ".nodes",
			Code:    "invalid_node_kind",
			Message: "Unsupported node kind",
		})
	}
	return targets
}

func asString(value any) string {
	str, _ := value.(string)
	return str
}

func asBool(value any) bool {
	boolean, _ := value.(bool)
	return boolean
}
