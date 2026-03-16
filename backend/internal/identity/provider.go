package identity

import (
	"context"
)

// ResolvedIdentity is the result of exchanging an auth code for user info.
type ResolvedIdentity struct {
	Subject       string
	Email         string
	EmailVerified bool
	DisplayName   string
	RawProfile    map[string]any
}

// SSOProvider exchanges an authorization code for a resolved identity.
type SSOProvider interface {
	// Name returns the provider identifier (e.g. "yandex").
	Name() string
	// AuthCodeURL returns the URL to redirect the user to for authorization.
	// state is the CSRF state, redirectURI is the callback URL.
	AuthCodeURL(state string, redirectURI string) string
	// Exchange trades an authorization code for user identity.
	Exchange(ctx context.Context, code string, redirectURI string) (ResolvedIdentity, error)
}

// ProviderRegistry holds configured SSO providers by name.
type ProviderRegistry struct {
	providers map[string]SSOProvider
}

func NewProviderRegistry() *ProviderRegistry {
	return &ProviderRegistry{providers: make(map[string]SSOProvider)}
}

func (r *ProviderRegistry) Register(p SSOProvider) {
	r.providers[p.Name()] = p
}

func (r *ProviderRegistry) Get(name string) (SSOProvider, bool) {
	p, ok := r.providers[name]
	return p, ok
}
