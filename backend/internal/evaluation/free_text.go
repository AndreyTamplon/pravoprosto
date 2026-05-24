package evaluation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	platformconfig "pravoprost/backend/internal/platform/config"
	platformlogging "pravoprost/backend/internal/platform/logging"
)

type FreeTextEvaluator interface {
	Evaluate(ctx context.Context, input FreeTextEvaluationInput) (Result, error)
}

// EvaluationOutcome is a single author-defined outcome the LLM can pick.
// The verdict label drives scoring; criteria describe when the outcome applies.
type EvaluationOutcome struct {
	ID       string
	Verdict  string
	Criteria string
}

type FreeTextEvaluationInput struct {
	Prompt          string
	ReferenceAnswer string
	Outcomes        []EvaluationOutcome
	StudentAnswer   string
}

type Result struct {
	OutcomeID string
	Feedback  string
	TraceID   string
	Model     string
	LatencyMS int
}

type openAICompatibleAdapter struct {
	baseURL string
	apiKey  string
	logger  *slog.Logger
	model   string
	timeout time.Duration
	client  *http.Client
}

func NewOpenAICompatibleAdapter(cfg platformconfig.Config, logger *slog.Logger) FreeTextEvaluator {
	return &openAICompatibleAdapter{
		baseURL: strings.TrimRight(cfg.LLMBaseURL, "/"),
		apiKey:  cfg.LLMAPIKey,
		logger:  logger,
		model:   cfg.LLMModel,
		timeout: cfg.LLMTimeout,
		client:  &http.Client{},
	}
}

func buildFreeTextPrompt(input FreeTextEvaluationInput) string {
	var b strings.Builder
	fmt.Fprintf(&b, "PROMPT:%s\nREFERENCE:%s\nOUTCOMES:\n", input.Prompt, input.ReferenceAnswer)
	for _, outcome := range input.Outcomes {
		fmt.Fprintf(&b, "- id=%s verdict=%s: %s\n", outcome.ID, outcome.Verdict, outcome.Criteria)
	}
	fmt.Fprintf(&b, "ANSWER:%s", input.StudentAnswer)
	return b.String()
}

func (a *openAICompatibleAdapter) Evaluate(ctx context.Context, input FreeTextEvaluationInput) (Result, error) {
	timeoutCtx, cancel := context.WithTimeout(ctx, a.timeout)
	defer cancel()
	logger := platformlogging.FromContext(timeoutCtx, a.logger).With(
		"provider", "openai_compatible",
		"model", a.model,
	)

	requestBody := map[string]any{
		"model": a.model,
		"messages": []map[string]string{
			{
				"role": "system",
				"content": "You grade a student's free-text answer by matching it to exactly one outcome. " +
					"Each outcome has an id, a verdict label (correct, partial, or incorrect) and criteria describing when it applies. " +
					"Choose the single outcome whose criteria best fit the answer. " +
					"Return strict JSON only with keys outcome_id and feedback. " +
					"outcome_id must be one of the provided ids, or \"none\" if no criteria fit the answer.",
			},
			{
				"role":    "user",
				"content": buildFreeTextPrompt(input),
			},
		},
		"response_format": map[string]string{"type": "json_object"},
		"temperature":     0,
	}
	payload, err := json.Marshal(requestBody)
	if err != nil {
		logger.Error("failed to marshal llm request", "err", err)
		return Result{}, fmt.Errorf("%w: marshal request", ErrTemporarilyUnavailable)
	}

	startedAt := time.Now()
	req, err := http.NewRequestWithContext(timeoutCtx, http.MethodPost, a.baseURL+"/v1/chat/completions", bytes.NewReader(payload))
	if err != nil {
		logger.Error("failed to build llm request", "err", err)
		return Result{}, fmt.Errorf("%w: build request", ErrTemporarilyUnavailable)
	}
	req.Header.Set("Content-Type", "application/json")
	if strings.TrimSpace(a.apiKey) != "" {
		req.Header.Set("Authorization", "Bearer "+a.apiKey)
	}

	resp, err := a.client.Do(req)
	if err != nil {
		logger.Warn("llm transport failure", "err", err, "latency_ms", time.Since(startedAt).Milliseconds())
		return Result{}, fmt.Errorf("%w: transport failure", ErrTemporarilyUnavailable)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= http.StatusBadRequest {
		logger.Warn("llm provider returned error status", "status", resp.StatusCode, "latency_ms", time.Since(startedAt).Milliseconds())
		return Result{}, fmt.Errorf("%w: provider status %d", ErrTemporarilyUnavailable, resp.StatusCode)
	}

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		logger.Warn("failed to read llm response", "err", err, "latency_ms", time.Since(startedAt).Milliseconds())
		return Result{}, fmt.Errorf("%w: read response", ErrTemporarilyUnavailable)
	}

	var completion struct {
		ID      string `json:"id"`
		Model   string `json:"model"`
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &completion); err != nil {
		logger.Warn("failed to decode llm response", "err", err, "latency_ms", time.Since(startedAt).Milliseconds())
		return Result{}, fmt.Errorf("%w: decode provider response", ErrTemporarilyUnavailable)
	}
	if len(completion.Choices) == 0 || strings.TrimSpace(completion.Choices[0].Message.Content) == "" {
		logger.Warn("llm response missing choices", "latency_ms", time.Since(startedAt).Milliseconds())
		return Result{}, fmt.Errorf("%w: empty provider response", ErrTemporarilyUnavailable)
	}

	var structured struct {
		OutcomeID string `json:"outcome_id"`
		Feedback  string `json:"feedback"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(completion.Choices[0].Message.Content)), &structured); err != nil {
		logger.Warn("failed to decode llm structured content", "err", err, "latency_ms", time.Since(startedAt).Milliseconds())
		return Result{}, fmt.Errorf("%w: parse structured content", ErrTemporarilyUnavailable)
	}
	outcomeID := strings.TrimSpace(structured.OutcomeID)
	if outcomeID == "" {
		logger.Warn("llm returned empty outcome_id", "latency_ms", time.Since(startedAt).Milliseconds())
		return Result{}, fmt.Errorf("%w: empty outcome_id", ErrTemporarilyUnavailable)
	}
	if outcomeID != "none" && !outcomeIDAllowed(outcomeID, input.Outcomes) {
		logger.Warn("llm returned unsupported outcome_id", "outcome_id", outcomeID, "latency_ms", time.Since(startedAt).Milliseconds())
		return Result{}, fmt.Errorf("%w: unknown outcome_id", ErrTemporarilyUnavailable)
	}

	traceID := strings.TrimSpace(resp.Header.Get("X-Request-Id"))
	if traceID == "" {
		traceID = completion.ID
	}
	model := strings.TrimSpace(completion.Model)
	if model == "" {
		model = a.model
	}
	latencyMS := int(time.Since(startedAt).Milliseconds())
	logger.Info("llm evaluation completed", "outcome_id", outcomeID, "latency_ms", latencyMS, "provider_trace_id", traceID)
	return Result{
		OutcomeID: outcomeID,
		Feedback:  strings.TrimSpace(structured.Feedback),
		TraceID:   traceID,
		Model:     model,
		LatencyMS: latencyMS,
	}, nil
}

func outcomeIDAllowed(id string, outcomes []EvaluationOutcome) bool {
	for _, outcome := range outcomes {
		if outcome.ID == id {
			return true
		}
	}
	return false
}

var ErrTemporarilyUnavailable = errors.New("llm_temporarily_unavailable")
