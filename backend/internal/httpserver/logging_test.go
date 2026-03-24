package httpserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	platformlogging "pravoprost/backend/internal/platform/logging"
)

func TestWriteErrorIncludesRequestID(t *testing.T) {
	handler := requestContextMiddleware(platformlogging.NewDiscardLogger())(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Authentication required", nil)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/protected", nil)
	resp := httptest.NewRecorder()

	handler.ServeHTTP(resp, req)

	if resp.Code != http.StatusUnauthorized {
		t.Fatalf("expected status %d, got %d", http.StatusUnauthorized, resp.Code)
	}
	requestID := resp.Header().Get(requestIDHeader)
	if requestID == "" {
		t.Fatal("expected request ID header to be set")
	}

	var envelope ErrorEnvelope
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if envelope.Error.RequestID != requestID {
		t.Fatalf("expected error request_id %q to match header %q", envelope.Error.RequestID, requestID)
	}
}

func TestRecoveryMiddlewareReturnsInternalErrorWithRequestID(t *testing.T) {
	logger := platformlogging.NewDiscardLogger()
	handler := requestContextMiddleware(logger)(
		accessLogMiddleware(logger)(
			recoveryMiddleware(logger)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				panic("boom")
			})),
		),
	)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/panic", nil)
	resp := httptest.NewRecorder()

	handler.ServeHTTP(resp, req)

	if resp.Code != http.StatusInternalServerError {
		t.Fatalf("expected status %d, got %d", http.StatusInternalServerError, resp.Code)
	}
	requestID := resp.Header().Get(requestIDHeader)
	if requestID == "" {
		t.Fatal("expected request ID header to be set")
	}

	var envelope ErrorEnvelope
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if envelope.Error.Code != "internal_error" {
		t.Fatalf("expected internal_error code, got %q", envelope.Error.Code)
	}
	if envelope.Error.RequestID != requestID {
		t.Fatalf("expected error request_id %q to match header %q", envelope.Error.RequestID, requestID)
	}
}
