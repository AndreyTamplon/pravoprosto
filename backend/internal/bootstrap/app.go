package bootstrap

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"pravoprost/backend/internal/httpserver"
	platformconfig "pravoprost/backend/internal/platform/config"
	"pravoprost/backend/internal/platform/db"
	"pravoprost/backend/internal/platform/logging"
)

type App struct {
	config platformconfig.Config
	db     *db.DB
	logger *slog.Logger
	server *http.Server
}

func NewApp(ctx context.Context) (*App, error) {
	cfg := platformconfig.Load()
	logger := logging.NewLogger(cfg)
	slog.SetDefault(logger)
	if err := cfg.ValidateRuntime(); err != nil {
		logger.Error("runtime configuration validation failed", "err", err)
		return nil, err
	}

	logger.Info("opening database connection")
	database, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		logger.Error("database connection failed", "err", err)
		return nil, err
	}

	logger.Info("applying database migrations")
	if err := database.ApplyMigrations(ctx); err != nil {
		_ = database.Close(ctx)
		logger.Error("database migrations failed", "err", err)
		return nil, err
	}
	logger.Info("database ready")

	handler := httpserver.NewRouter(httpserver.Dependencies{
		Config: cfg,
		DB:     database,
		Logger: logging.Named(logger, "http"),
	})

	server := &http.Server{
		Addr:     cfg.HTTPAddr,
		Handler:  handler,
		ErrorLog: slog.NewLogLogger(logging.Named(logger, "http_server").Handler(), slog.LevelError),
	}

	return &App{
		config: cfg,
		db:     database,
		logger: logger,
		server: server,
	}, nil
}

func (a *App) Run(_ context.Context) error {
	a.logger.Info("http server starting", "addr", a.config.HTTPAddr)
	err := a.server.ListenAndServe()
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		a.logger.Error("http server stopped unexpectedly", "err", err)
		return err
	}
	a.logger.Info("http server stopped")
	return nil
}

func (a *App) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	a.logger.Info("shutting down http server")
	if err := a.server.Shutdown(ctx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		a.logger.Warn("http server shutdown returned error", "err", err)
	}
	a.logger.Info("closing database connection")
	return a.db.Close(ctx)
}
