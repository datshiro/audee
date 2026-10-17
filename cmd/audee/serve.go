package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/spf13/cobra"

	"github.com/datshiro/audee/internal/agent"
	"github.com/datshiro/audee/internal/channels/telegram"
	"github.com/datshiro/audee/internal/config"
	"github.com/datshiro/audee/internal/logging"
	"github.com/datshiro/audee/internal/providers/openai"
	"github.com/datshiro/audee/internal/session"
	"github.com/datshiro/audee/internal/tools"
	"github.com/datshiro/audee/internal/tools/clock"
)

func serveCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "serve",
		Short: "Run the Telegram bot",
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := config.FromEnv()
			if err != nil {
				return fmt.Errorf("config: %w", err)
			}
			log := logging.New(os.Stderr, cfg.LogLevel, cfg.Secrets()...)
			if err := serve(cmd.Context(), cfg, log); err != nil {
				log.Error("serve stopped", "err", err)
				return errLogged
			}
			return nil
		},
	}
}

func serve(ctx context.Context, cfg config.Config, log *slog.Logger) error {
	log.Info("starting", "version", version, "config", cfg.String())

	registry, err := tools.NewRegistry(clock.New(nil))
	if err != nil {
		return err
	}
	tg, err := telegram.New(cfg.TelegramBotToken, cfg.AllowedUserIDs, log)
	if err != nil {
		return err
	}
	a := &app{
		runner: &agent.Loop{
			Provider:  openai.New(cfg.LLMBaseURL, cfg.LLMAPIKey, cfg.LLMModel, 0),
			Tools:     registry,
			MaxRounds: cfg.MaxRounds,
		},
		store: session.NewStore(session.DefaultMaxMessages),
		send:  tg,
		log:   log,
	}

	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := tg.Run(ctx, a.handle); err != nil {
		return err
	}
	log.Info("shutdown complete")
	return nil
}
