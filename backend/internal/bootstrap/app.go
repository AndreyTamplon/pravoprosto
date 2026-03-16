package bootstrap

import (
	"context"
	"net/http"
	"time"

	"pravoprost/backend/internal/httpserver"
	platformconfig "pravoprost/backend/internal/platform/config"
	"pravoprost/backend/internal/platform/db"
)

type App struct {
	config platformconfig.Config
	db     *db.DB
	server *http.Server
}

func NewApp(ctx context.Context) (*App, error) {
	cfg := platformconfig.Load()
	if err := cfg.ValidateRuntime(); err != nil {
		return nil, err
	}

	database, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}

	if err := database.ApplyMigrations(ctx); err != nil {
		_ = database.Close(ctx)
		return nil, err
	}

	handler := httpserver.NewRouter(httpserver.Dependencies{
		Config: cfg,
		DB:     database,
	})

	server := &http.Server{
		Addr:    cfg.HTTPAddr,
		Handler: handler,
	}

	return &App{
		config: cfg,
		db:     database,
		server: server,
	}, nil
}

func (a *App) Run(_ context.Context) error {
	return a.server.ListenAndServe()
}

func (a *App) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = a.server.Shutdown(ctx)
	return a.db.Close(ctx)
}
