package main

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/datshiro/audee/internal/agent"
	"github.com/datshiro/audee/internal/channels"
	"github.com/datshiro/audee/internal/session"
)

const (
	resetCommand = "/reset"
	resetReply   = "History cleared."
	failureReply = "Sorry, something went wrong. Please try again."
	emptyReply   = "(no reply)"
	sendTimeout  = 30 * time.Second
)

type runner interface {
	Run(ctx context.Context, history []agent.Message) (agent.Result, error)
}

type sender interface {
	Send(ctx context.Context, out channels.OutboundMessage) error
}

// app wires channel → session → loop → reply.
type app struct {
	runner runner
	store  *session.Store
	send   sender
	log    *slog.Logger
}

func (a *app) handle(ctx context.Context, in channels.InboundMessage) {
	out := channels.OutboundMessage{Channel: in.Channel, ChatID: in.ChatID, Text: a.respond(ctx, in)}
	// A fresh context, so a run that timed out still gets its failure reply delivered.
	sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), sendTimeout)
	defer cancel()
	if err := a.send.Send(sctx, out); err != nil {
		a.log.Error("send reply failed", "session", in.SessionKey(), "err", err)
	}
}

func (a *app) respond(ctx context.Context, in channels.InboundMessage) string {
	key := in.SessionKey()
	if strings.TrimSpace(in.Text) == resetCommand {
		a.store.Reset(key)
		a.log.Info("session reset", "session", key)
		return resetReply
	}

	turn := agent.Message{Role: agent.RoleUser, Content: in.Text}
	start := time.Now()
	res, err := a.runner.Run(ctx, append(a.store.History(key), turn))
	attrs := []any{
		"session", key,
		"rounds", res.Rounds,
		"tools", toolNames(res.Messages),
		"duration_ms", time.Since(start).Milliseconds(),
	}
	if err != nil {
		a.log.Error("run failed", append(attrs, "err", err)...)
		return failureReply
	}
	a.log.Info("run", attrs...)

	a.store.Append(key, append([]agent.Message{turn}, res.Messages...)...)
	if strings.TrimSpace(res.Reply) == "" {
		return emptyReply
	}
	return res.Reply
}

func toolNames(msgs []agent.Message) []string {
	names := []string{}
	for _, m := range msgs {
		for _, c := range m.ToolCalls {
			names = append(names, c.Name)
		}
	}
	return names
}
