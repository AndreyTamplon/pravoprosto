package httpserver

import (
	"encoding/json"
	"net/http"
)

type ErrorEnvelope struct {
	Error APIError `json:"error"`
}

type APIError struct {
	Code      string         `json:"code"`
	Message   string         `json:"message"`
	Details   map[string]any `json:"details,omitempty"`
	RequestID string         `json:"request_id,omitempty"`
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code string, message string, details map[string]any) {
	writeJSON(w, status, ErrorEnvelope{
		Error: APIError{
			Code:    code,
			Message: message,
			Details: details,
		},
	})
}

func writeInternalError(w http.ResponseWriter) {
	writeError(w, http.StatusInternalServerError, "internal_error", "Internal server error", nil)
}
