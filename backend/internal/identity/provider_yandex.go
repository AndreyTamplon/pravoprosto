package identity

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"golang.org/x/oauth2"
	yandexOAuth "golang.org/x/oauth2/yandex"
	platformlogging "pravoprost/backend/internal/platform/logging"
)

type YandexProvider struct {
	oauthConfig oauth2.Config
	httpClient  *http.Client
	logger      *slog.Logger
	// UserInfoURL can be overridden for testing
	UserInfoURL string
}

type YandexProviderConfig struct {
	ClientID     string
	ClientSecret string
	// Override endpoints for testing (empty = use real Yandex endpoints)
	AuthURL     string
	TokenURL    string
	UserInfoURL string
	Logger      *slog.Logger
}

func NewYandexProvider(cfg YandexProviderConfig) *YandexProvider {
	endpoint := yandexOAuth.Endpoint
	if cfg.AuthURL != "" {
		endpoint.AuthURL = cfg.AuthURL
	}
	if cfg.TokenURL != "" {
		endpoint.TokenURL = cfg.TokenURL
	}
	userInfoURL := "https://login.yandex.ru/info"
	if cfg.UserInfoURL != "" {
		userInfoURL = cfg.UserInfoURL
	}
	return &YandexProvider{
		oauthConfig: oauth2.Config{
			ClientID:     cfg.ClientID,
			ClientSecret: cfg.ClientSecret,
			Endpoint:     endpoint,
		},
		httpClient:  &http.Client{Timeout: 10 * time.Second},
		logger:      cfg.Logger,
		UserInfoURL: userInfoURL,
	}
}

func (p *YandexProvider) Name() string { return "yandex" }

func (p *YandexProvider) AuthCodeURL(state string, redirectURI string) string {
	return p.oauthConfig.AuthCodeURL(state,
		oauth2.SetAuthURLParam("redirect_uri", redirectURI),
		oauth2.SetAuthURLParam("force_confirm", "yes"),
	)
}

func (p *YandexProvider) Exchange(ctx context.Context, code string, redirectURI string) (ResolvedIdentity, error) {
	logger := platformlogging.FromContext(ctx, p.logger).With("provider", "yandex")
	cfg := p.oauthConfig
	cfg.RedirectURL = redirectURI

	token, err := cfg.Exchange(ctx, code)
	if err != nil {
		logger.Warn("yandex token exchange failed", "err", err)
		return ResolvedIdentity{}, fmt.Errorf("yandex token exchange: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.UserInfoURL+"?format=json", nil)
	if err != nil {
		logger.Error("failed to build yandex userinfo request", "err", err)
		return ResolvedIdentity{}, fmt.Errorf("yandex userinfo request: %w", err)
	}
	req.Header.Set("Authorization", "OAuth "+token.AccessToken)

	resp, err := p.httpClient.Do(req)
	if err != nil {
		logger.Warn("yandex userinfo request failed", "err", err)
		return ResolvedIdentity{}, fmt.Errorf("yandex userinfo fetch: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		logger.Warn("yandex userinfo returned error status", "status", resp.StatusCode)
		return ResolvedIdentity{}, fmt.Errorf("yandex userinfo status %d: %s", resp.StatusCode, string(body))
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		logger.Warn("failed to read yandex userinfo response", "err", err)
		return ResolvedIdentity{}, fmt.Errorf("yandex userinfo read: %w", err)
	}

	var profile struct {
		ID           string   `json:"id"`
		Login        string   `json:"login"`
		DisplayName  string   `json:"display_name"`
		RealName     string   `json:"real_name"`
		FirstName    string   `json:"first_name"`
		LastName     string   `json:"last_name"`
		DefaultEmail string   `json:"default_email"`
		Emails       []string `json:"emails"`
		Sex          string   `json:"sex"`
		PSUID        string   `json:"psuid"`
	}
	if err := json.Unmarshal(body, &profile); err != nil {
		logger.Warn("failed to decode yandex userinfo response", "err", err)
		return ResolvedIdentity{}, fmt.Errorf("yandex userinfo decode: %w", err)
	}
	if profile.ID == "" {
		logger.Warn("yandex userinfo response missing user id")
		return ResolvedIdentity{}, fmt.Errorf("yandex userinfo: empty user id")
	}

	var raw map[string]any
	_ = json.Unmarshal(body, &raw)

	displayName := profile.DisplayName
	if displayName == "" {
		displayName = profile.RealName
	}
	if displayName == "" && profile.FirstName != "" {
		displayName = profile.FirstName
		if profile.LastName != "" {
			displayName += " " + profile.LastName
		}
	}

	return ResolvedIdentity{
		Subject:       profile.ID,
		Email:         profile.DefaultEmail,
		EmailVerified: true, // Yandex verifies email at registration
		DisplayName:   displayName,
		RawProfile:    raw,
	}, nil
}
