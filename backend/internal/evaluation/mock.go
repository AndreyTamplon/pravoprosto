package evaluation

import (
	"fmt"
	"strings"
)

// This file holds the shared mock-LLM behavior used by both the standalone mock
// server (cmd/mockserver) and the in-test fake LLM (internal/testkit). Keeping
// the answer-parsing logic in one place means the production contract
// ({"outcome_id","feedback"}) and the test markers can never drift apart.
//
// Supported answer markers:
//   [llm:outcome:<id>]  pick exactly this outcome id
//   [llm:none]          no outcome matched -> default ("else") outcome
//   [llm:correct]       first outcome whose verdict is correct (back-compat)
//   [llm:partial]       first outcome whose verdict is partial
//   [llm:incorrect]     first outcome whose verdict is incorrect
//   [llm:malformed]     truncated JSON (provider parse failure)
//   [llm:unknown]       an outcome id not in the list (rejected by backend)
//   [llm:500]/[llm:timeout]/[llm:slow] provider failure modes (handled by caller)

type promptOutcome struct {
	id      string
	verdict string
}

// MockMode classifies the behavior requested by failure markers in the answer.
// Returns one of: "500", "timeout", "slow", "malformed", "unknown", "normal".
func MockMode(userContent string) string {
	lower := strings.ToLower(mockAnswerPart(userContent))
	switch {
	case strings.Contains(lower, "[llm:malformed]"):
		return "malformed"
	case strings.Contains(lower, "[llm:unknown]"):
		return "unknown"
	case strings.Contains(lower, "[llm:500]"):
		return "500"
	case strings.Contains(lower, "[llm:timeout]"):
		return "timeout"
	case strings.Contains(lower, "[llm:slow]"):
		return "slow"
	}
	return "normal"
}

// MockLLMContent builds the JSON string returned in the mock completion's
// message content. Callers handle the "500" and "timeout" modes (HTTP status /
// sleep) before calling this; "slow" falls through to a normal response.
func MockLLMContent(userContent string) string {
	switch MockMode(userContent) {
	case "malformed":
		return `{"outcome_id":`
	case "unknown":
		return `{"outcome_id":"__unknown__","feedback":"??"}`
	}
	outcomes := parsePromptOutcomes(userContent)
	id := resolveMockOutcomeID(mockAnswerPart(userContent), outcomes)
	return fmt.Sprintf(`{"outcome_id":%q,"feedback":%q}`, id, mockFeedback(id, outcomes))
}

func mockAnswerPart(userContent string) string {
	if parts := strings.SplitN(userContent, "\nANSWER:", 2); len(parts) == 2 {
		return parts[1]
	}
	return userContent
}

func parsePromptOutcomes(userContent string) []promptOutcome {
	var outcomes []promptOutcome
	for _, line := range strings.Split(userContent, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "- id=") {
			continue
		}
		rest := strings.TrimPrefix(line, "- id=")
		id := rest
		if idx := strings.IndexByte(rest, ' '); idx >= 0 {
			id = rest[:idx]
		}
		verdict := ""
		if idx := strings.Index(rest, "verdict="); idx >= 0 {
			value := rest[idx+len("verdict="):]
			if end := strings.IndexAny(value, ": "); end >= 0 {
				value = value[:end]
			}
			verdict = value
		}
		outcomes = append(outcomes, promptOutcome{id: id, verdict: verdict})
	}
	return outcomes
}

func resolveMockOutcomeID(answerContent string, outcomes []promptOutcome) string {
	if id, ok := extractOutcomeMarker(answerContent); ok {
		return id
	}
	lower := strings.ToLower(answerContent)
	if strings.Contains(lower, "[llm:none]") {
		return "none"
	}
	for _, verdict := range []string{"correct", "partial", "incorrect"} {
		if strings.Contains(lower, "[llm:"+verdict+"]") {
			return firstOutcomeByVerdictOrNone(outcomes, verdict)
		}
	}
	// No explicit marker: pick a verdict heuristically (used by manual/dev runs).
	verdict := "partial"
	switch {
	case strings.Contains(lower, "safe"), strings.Contains(lower, "нельзя"),
		strings.Contains(lower, "правильн"), strings.Contains(lower, "верн"):
		verdict = "correct"
	case strings.Contains(lower, "можно"), strings.Contains(lower, "ничего страшн"):
		verdict = "incorrect"
	}
	return firstOutcomeByVerdictOrNone(outcomes, verdict)
}

func firstOutcomeByVerdictOrNone(outcomes []promptOutcome, verdict string) string {
	for _, outcome := range outcomes {
		if outcome.verdict == verdict {
			return outcome.id
		}
	}
	return "none"
}

func extractOutcomeMarker(answerContent string) (string, bool) {
	const marker = "[llm:outcome:"
	idx := strings.Index(answerContent, marker)
	if idx < 0 {
		return "", false
	}
	rest := answerContent[idx+len(marker):]
	end := strings.IndexByte(rest, ']')
	if end < 0 {
		return "", false
	}
	return strings.TrimSpace(rest[:end]), true
}

func mockFeedback(outcomeID string, outcomes []promptOutcome) string {
	if outcomeID == "none" {
		return "Ответ не подошёл ни под один критерий"
	}
	for _, outcome := range outcomes {
		if outcome.id != outcomeID {
			continue
		}
		switch outcome.verdict {
		case "correct":
			return "Ответ корректный"
		case "partial":
			return "Часть ответа верна"
		default:
			return "Ответ неверный"
		}
	}
	return "Ответ оценён"
}
