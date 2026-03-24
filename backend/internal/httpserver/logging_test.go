package httpserver

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
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

func TestResponseRecorderPreservesOptionalInterfaces(t *testing.T) {
	recorder := &responseRecorder{ResponseWriter: newInterfacePreservingWriter(), status: http.StatusOK}

	if _, ok := any(recorder).(http.Flusher); !ok {
		t.Fatal("responseRecorder should implement http.Flusher")
	}
	if _, ok := any(recorder).(http.Hijacker); !ok {
		t.Fatal("responseRecorder should implement http.Hijacker")
	}
	if _, ok := any(recorder).(http.Pusher); !ok {
		t.Fatal("responseRecorder should implement http.Pusher")
	}
	if _, ok := any(recorder).(io.ReaderFrom); !ok {
		t.Fatal("responseRecorder should implement io.ReaderFrom")
	}
}

func TestResponseRecorderOptionalInterfacesFallBackGracefully(t *testing.T) {
	recorder := &responseRecorder{ResponseWriter: httptest.NewRecorder(), status: http.StatusOK}

	if _, _, err := recorder.Hijack(); err == nil {
		t.Fatal("expected hijack to fail when underlying writer does not support it")
	}
	if err := recorder.Push("/asset.js", nil); err != http.ErrNotSupported {
		t.Fatalf("expected ErrNotSupported from Push, got %v", err)
	}
	recorder.Flush()
}

func TestResponseRecorderWriteHeaderKeepsFirstStatus(t *testing.T) {
	underlying := httptest.NewRecorder()
	recorder := &responseRecorder{ResponseWriter: underlying, status: http.StatusOK}

	recorder.WriteHeader(http.StatusCreated)
	recorder.WriteHeader(http.StatusConflict)

	if recorder.status != http.StatusCreated {
		t.Fatalf("expected recorder to keep first status, got %d", recorder.status)
	}
	if underlying.Code != http.StatusCreated {
		t.Fatalf("expected underlying recorder to keep first status, got %d", underlying.Code)
	}
}

type interfacePreservingWriter struct {
	*httptest.ResponseRecorder
}

func newInterfacePreservingWriter() *interfacePreservingWriter {
	return &interfacePreservingWriter{ResponseRecorder: httptest.NewRecorder()}
}

func (w *interfacePreservingWriter) Flush() {}

func (w *interfacePreservingWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return nil, nil, nil
}

func (w *interfacePreservingWriter) Push(string, *http.PushOptions) error {
	return nil
}
