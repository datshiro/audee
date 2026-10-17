// Package telegram receives messages by long polling, so the process opens no listening port.
package telegram

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"time"
	"unicode/utf16"

	"github.com/mymmrac/telego"
	tu "github.com/mymmrac/telego/telegoutil"

	"github.com/datshiro/audee/internal/channels"
)

const (
	Name = "telegram"
	// maxMessageLen is Telegram's limit, counted in UTF-16 code units.
	maxMessageLen  = 4096
	pollTimeoutSec = 30
	// handlerTimeout bounds one run; it also bounds how long shutdown waits for it.
	handlerTimeout = 2 * time.Minute
)

type Adapter struct {
	bot     *telego.Bot
	allowed map[int64]bool
	log     *slog.Logger
}

// New builds the adapter. log must redact the token: telego's debug output
// and its network errors embed /bot<token>/ URLs.
func New(token string, allowedUserIDs []int64, log *slog.Logger) (*Adapter, error) {
	bot, err := telego.NewBot(token, telego.WithLogger(telegoLogger{log}))
	if err != nil {
		return nil, fmt.Errorf("telegram: %w", err)
	}
	allowed := make(map[int64]bool, len(allowedUserIDs))
	for _, id := range allowedUserIDs {
		allowed[id] = true
	}
	return &Adapter{bot: bot, allowed: allowed, log: log}, nil
}

// Run long-polls until ctx is cancelled. Updates are handled one at a time;
// an in-flight update is finished before Run returns.
func (a *Adapter) Run(ctx context.Context, handle channels.Handler) error {
	updates, err := a.bot.UpdatesViaLongPolling(ctx, &telego.GetUpdatesParams{
		Timeout:        pollTimeoutSec,
		AllowedUpdates: []string{"message"},
	})
	if err != nil {
		return fmt.Errorf("telegram: start long polling: %w", err)
	}
	a.log.Info("telegram long polling started", "allowed_users", len(a.allowed))
	// Return on ctx.Done instead of waiting for the channel to close: telego's
	// in-flight poll and its retry sleep both ignore cancellation.
	for {
		select {
		case <-ctx.Done():
			a.log.Info("telegram long polling stopped")
			return nil
		case u, ok := <-updates:
			if !ok {
				return nil
			}
			in, ok := a.inbound(u)
			if !ok {
				continue
			}
			hctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), handlerTimeout)
			handle(hctx, in)
			cancel()
		}
	}
}

// inbound applies the allowlist before anything else, then keeps text messages only.
func (a *Adapter) inbound(u telego.Update) (channels.InboundMessage, bool) {
	m := u.Message
	if m == nil || m.From == nil {
		return channels.InboundMessage{}, false
	}
	if !a.allowed[m.From.ID] {
		a.log.Info("ignored user", "user_id", m.From.ID, "chat_id", m.Chat.ID)
		return channels.InboundMessage{}, false
	}
	if m.Text == "" {
		a.log.Debug("ignored non-text message", "chat_id", m.Chat.ID)
		return channels.InboundMessage{}, false
	}
	return channels.InboundMessage{
		Channel: Name,
		ChatID:  strconv.FormatInt(m.Chat.ID, 10),
		UserID:  strconv.FormatInt(m.From.ID, 10),
		Text:    m.Text,
	}, true
}

func (a *Adapter) Send(ctx context.Context, out channels.OutboundMessage) error {
	chatID, err := strconv.ParseInt(out.ChatID, 10, 64)
	if err != nil {
		return fmt.Errorf("telegram: bad chat ID %q: %w", out.ChatID, err)
	}
	for _, part := range split(out.Text, maxMessageLen) {
		if _, err := a.bot.SendMessage(ctx, tu.Message(tu.ID(chatID), part)); err != nil {
			return fmt.Errorf("telegram: send message: %w", err)
		}
	}
	return nil
}

// split cuts text into parts of at most limit UTF-16 code units without breaking a rune.
func split(text string, limit int) []string {
	var parts []string
	start, units := 0, 0
	for i, r := range text {
		n := utf16.RuneLen(r)
		if n < 0 {
			n = 1
		}
		if units+n > limit {
			parts = append(parts, text[start:i])
			start, units = i, 0
		}
		units += n
	}
	if start < len(text) {
		parts = append(parts, text[start:])
	}
	return parts
}

type telegoLogger struct {
	log *slog.Logger
}

func (l telegoLogger) Debugf(format string, args ...any) {
	l.log.Debug(fmt.Sprintf(format, args...), "component", "telego")
}

func (l telegoLogger) Errorf(format string, args ...any) {
	l.log.Error(fmt.Sprintf(format, args...), "component", "telego")
}
