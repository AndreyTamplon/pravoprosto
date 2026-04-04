package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"pravoprost/backend/internal/bootstrap"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	app, err := bootstrap.NewApp(ctx)
	if err != nil {
		slog.Error("failed to bootstrap app", "err", err)
		os.Exit(1)
	}

	runErr := make(chan error, 1)
	go func() {
		runErr <- app.Run(ctx)
	}()

	select {
	case err := <-runErr:
		if err != nil {
			slog.Error("server stopped with error", "err", err)
			os.Exit(1)
		}
		return
	case <-ctx.Done():
	}

	if err := app.Close(); err != nil {
		slog.Error("graceful shutdown failed", "err", err)
		os.Exit(1)
	}

	if err := <-runErr; err != nil {
		slog.Error("server shutdown returned error", "err", err)
		os.Exit(1)
	}
}
