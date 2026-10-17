package channels

import "context"

// InboundMessage is a channel-neutral user message that already passed the channel's allowlist.
type InboundMessage struct {
	Channel string
	ChatID  string
	UserID  string
	Text    string
}

// SessionKey names the conversation, for example "telegram:12345".
func (m InboundMessage) SessionKey() string {
	return m.Channel + ":" + m.ChatID
}

type OutboundMessage struct {
	Channel string
	ChatID  string
	Text    string
}

type Handler func(ctx context.Context, in InboundMessage)
