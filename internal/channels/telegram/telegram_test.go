package telegram

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/mymmrac/telego"

	"github.com/datshiro/audee/internal/channels"
	"github.com/datshiro/audee/internal/logging"
)

func textUpdate(userID, chatID int64, text string) telego.Update {
	return telego.Update{Message: &telego.Message{
		From: &telego.User{ID: userID},
		Chat: telego.Chat{ID: chatID},
		Text: text,
	}}
}

func TestInbound_Allowlist(t *testing.T) {
	var logs bytes.Buffer
	a := &Adapter{allowed: map[int64]bool{42: true}, log: logging.New(&logs, slog.LevelDebug)}

	tests := []struct {
		name   string
		update telego.Update
		want   channels.InboundMessage
		ok     bool
	}{
		{"allowed text", textUpdate(42, 1001, "hi"), channels.InboundMessage{Channel: "telegram", ChatID: "1001", UserID: "42", Text: "hi"}, true},
		{"stranger is ignored", textUpdate(7, 1002, "hi"), channels.InboundMessage{}, false},
		{"allowed non-text", textUpdate(42, 1001, ""), channels.InboundMessage{}, false},
		{"no message", telego.Update{}, channels.InboundMessage{}, false},
		{"no sender", telego.Update{Message: &telego.Message{Text: "hi"}}, channels.InboundMessage{}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := a.inbound(tt.update)
			if ok != tt.ok || got != tt.want {
				t.Errorf("inbound = %+v, %v; want %+v, %v", got, ok, tt.want, tt.ok)
			}
		})
	}

	out := logs.String()
	if strings.Count(out, `"msg":"ignored user"`) != 1 || !strings.Contains(out, `"user_id":7`) || !strings.Contains(out, `"chat_id":1002`) {
		t.Errorf("want exactly one ignored-user line with user and chat IDs:\n%s", out)
	}
	if strings.Contains(out, `"hi"`) {
		t.Errorf("an ignored user's text must not be logged:\n%s", out)
	}
}

func TestInbound_EmptyAllowlistIgnoresEveryone(t *testing.T) {
	a := &Adapter{allowed: map[int64]bool{}, log: logging.New(&bytes.Buffer{}, slog.LevelInfo)}
	if _, ok := a.inbound(textUpdate(42, 1, "hi")); ok {
		t.Error("empty allowlist let a user through")
	}
}

func TestSplit(t *testing.T) {
	tests := []struct {
		name  string
		text  string
		limit int
		want  []string
	}{
		{"short", "hello", 10, []string{"hello"}},
		{"empty", "", 10, nil},
		{"exact", "abcd", 4, []string{"abcd"}},
		{"ascii", "abcdefghij", 4, []string{"abcd", "efgh", "ij"}},
		{"multibyte runes stay whole", "ăâđêôơư", 3, []string{"ăâđ", "êôơ", "ư"}},
		{"emoji count two units", "a😀b😀", 3, []string{"a😀", "b😀"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := split(tt.text, tt.limit)
			if strings.Join(got, "|") != strings.Join(tt.want, "|") || len(got) != len(tt.want) {
				t.Errorf("split = %q, want %q", got, tt.want)
			}
		})
	}

	long := strings.Repeat("x", maxMessageLen*2+5)
	parts := split(long, maxMessageLen)
	if len(parts) != 3 || strings.Join(parts, "") != long {
		t.Fatalf("got %d parts", len(parts))
	}
	for _, p := range parts {
		if n := len(utf16.Encode([]rune(p))); n > maxMessageLen {
			t.Errorf("part has %d units", n)
		}
	}
}
