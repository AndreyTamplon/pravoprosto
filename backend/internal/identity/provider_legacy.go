package identity

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	platformlogging "pravoprost/backend/internal/platform/logging"
)

// LegacyExternalProvider delegates to an external SSO service (the old approach).
// Used when PRAVO_SSO_BASE_URL is set and no real provider is configured.
type LegacyExternalProvider struct {
	name       string
	baseURL    string
	httpClient *http.Client
	logger     *slog.Logger
}

func NewLegacyExternalProvider(name string, baseURL string, logger *slog.Logger) *LegacyExternalProvider {
	return &LegacyExternalProvider{
		name:       name,
		baseURL:    baseURL,
		httpClient: &http.Client{Timeout: 5 * time.Second},
		logger:     logger,
	}
}

func (p *LegacyExternalProvider) Name() string { return p.name }

func (p *LegacyExternalProvider) AuthCodeURL(state string, redirectURI string) string {
	u, _ := url.Parse(strings.TrimRight(p.baseURL, "/") + "/" + p.name + "/authorize")
	q := u.Query()
	q.Set("state", state)
	q.Set("redirect_uri", redirectURI)
	u.RawQuery = q.Encode()
	return u.String()
}

func (p *LegacyExternalProvider) Exchange(ctx context.Context, code string, _ string) (ResolvedIdentity, error) {
	logger := platformlogging.FromContext(ctx, p.logger).With("provider", p.name)
	endpoint := strings.TrimRight(p.baseURL, "/") + "/" + p.name + "/exchange?code=" + url.QueryEscape(code)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		logger.Error("failed to build legacy sso request", "err", err)
		return ResolvedIdentity{}, err
	}
	resp, err := p.httpClient.Do(req)
	if err != nil {
		logger.Warn("legacy sso exchange failed", "err", err)
		return ResolvedIdentity{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= http.StatusBadRequest {
		logger.Warn("legacy sso exchange returned error status", "status", resp.StatusCode)
		return ResolvedIdentity{}, fmt.Errorf("legacy sso exchange: status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		logger.Warn("failed to read legacy sso response", "err", err)
		return ResolvedIdentity{}, err
	}

	var payload struct {
		Subject  string         `json:"subject"`
		Email    string         `json:"email"`
		Verified bool           `json:"verified"`
		Name     string         `json:"name"`
		Raw      map[string]any `json:"raw"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		logger.Warn("failed to decode legacy sso response", "err", err)
		return ResolvedIdentity{}, err
	}
	if payload.Subject == "" {
		logger.Warn("legacy sso response missing subject")
		return ResolvedIdentity{}, fmt.Errorf("legacy sso: empty subject")
	}
	return ResolvedIdentity{
		Subject:       payload.Subject,
		Email:         payload.Email,
		EmailVerified: payload.Verified,
		DisplayName:   payload.Name,
		RawProfile:    payload.Raw,
	}, nil
}
