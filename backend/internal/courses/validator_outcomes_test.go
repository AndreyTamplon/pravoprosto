package courses

import "testing"

// outcomeGraphContent wraps a free_text node (with the given outcomes and default
// outcome) in an otherwise-valid single-lesson course so validateContent only
// flags outcome-specific problems.
func outcomeGraphContent(outcomes []any, defaultOutcome any) map[string]any {
	rubric := map[string]any{"referenceAnswer": "ref", "outcomes": outcomes}
	if defaultOutcome != nil {
		rubric["defaultOutcome"] = defaultOutcome
	}
	return map[string]any{
		"modules": []any{
			map[string]any{
				"id":    "m1",
				"title": "Module",
				"lessons": []any{
					map[string]any{
						"id":    "l1",
						"title": "Lesson",
						"graph": map[string]any{
							"startNodeId": "intro",
							"nodes": []any{
								map[string]any{"id": "intro", "kind": "story", "body": map[string]any{"text": "s"}, "nextNodeId": "free"},
								map[string]any{"id": "free", "kind": "free_text", "prompt": "q", "rubric": rubric},
								map[string]any{"id": "ok", "kind": "story", "body": map[string]any{"text": "ok"}, "nextNodeId": "end"},
								map[string]any{"id": "end", "kind": "end", "text": "done"},
							},
						},
					},
				},
			},
		},
	}
}

func hasErrorCode(errs []ValidationError, code string) bool {
	for _, err := range errs {
		if err.Code == code {
			return true
		}
	}
	return false
}

func TestValidateFreeTextOutcomes(t *testing.T) {
	validOutcomes := []any{
		map[string]any{"id": "a", "criteria": "c1", "verdict": "correct", "feedback": "f1", "nextNodeId": "ok"},
		map[string]any{"id": "b", "criteria": "c2", "verdict": "incorrect", "feedback": "f2", "nextNodeId": "ok"},
	}
	validDefault := map[string]any{"verdict": "incorrect", "feedback": "f3", "nextNodeId": "ok"}

	outcomeCodes := []string{"missing_outcomes", "invalid_outcome", "missing_correct_outcome", "missing_default_outcome", "invalid_default_outcome"}

	t.Run("valid outcomes pass", func(t *testing.T) {
		errs := validateContent(outcomeGraphContent(validOutcomes, validDefault))
		for _, code := range outcomeCodes {
			if hasErrorCode(errs, code) {
				t.Fatalf("unexpected %s for valid outcomes: %+v", code, errs)
			}
		}
	})

	t.Run("missing correct outcome", func(t *testing.T) {
		outcomes := []any{
			map[string]any{"id": "a", "criteria": "c", "verdict": "incorrect", "feedback": "f", "nextNodeId": "ok"},
			map[string]any{"id": "b", "criteria": "c", "verdict": "partial", "feedback": "f", "nextNodeId": "ok"},
		}
		errs := validateContent(outcomeGraphContent(outcomes, validDefault))
		if !hasErrorCode(errs, "missing_correct_outcome") {
			t.Fatalf("expected missing_correct_outcome, got %+v", errs)
		}
	})

	t.Run("outcome without feedback is invalid", func(t *testing.T) {
		outcomes := []any{
			map[string]any{"id": "a", "criteria": "c", "verdict": "correct", "feedback": "", "nextNodeId": "ok"},
		}
		errs := validateContent(outcomeGraphContent(outcomes, validDefault))
		if !hasErrorCode(errs, "invalid_outcome") {
			t.Fatalf("expected invalid_outcome, got %+v", errs)
		}
	})

	t.Run("missing default outcome", func(t *testing.T) {
		errs := validateContent(outcomeGraphContent(validOutcomes, nil))
		if !hasErrorCode(errs, "missing_default_outcome") {
			t.Fatalf("expected missing_default_outcome, got %+v", errs)
		}
	})

	t.Run("only correct outcome, no partial or incorrect", func(t *testing.T) {
		// Diana's case: one correct + one incorrect, no partial — must be valid.
		outcomes := []any{
			map[string]any{"id": "a", "criteria": "c", "verdict": "correct", "feedback": "f", "nextNodeId": "ok"},
			map[string]any{"id": "b", "criteria": "c", "verdict": "incorrect", "feedback": "f", "nextNodeId": "ok"},
		}
		errs := validateContent(outcomeGraphContent(outcomes, validDefault))
		for _, code := range outcomeCodes {
			if hasErrorCode(errs, code) {
				t.Fatalf("unexpected %s when partial omitted: %+v", code, errs)
			}
		}
	})
}
