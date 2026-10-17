package logging

import (
	"bytes"
	"errors"
	"log/slog"
	"net/url"
	"strings"
	"testing"
)

func TestRedactsSecretsEverywhere(t *testing.T) {
	const token = "123456:AAH-tg_Secret"
	const key = "sk-proj-abc123"

	var buf bytes.Buffer
	log := New(&buf, slog.LevelDebug, token, key, "")

	urlErr := &url.Error{Op: "Post", URL: "https://api.telegram.org/bot" + token + "/getUpdates", Err: errors.New("dial tcp: no route")}
	log.Info("calling with key "+key, "token", token)
	log.Error("poll failed", "err", urlErr)
	log.WithGroup("llm").Debug("request", slog.Group("auth", "header", "Bearer "+key))

	out := buf.String()
	for _, s := range []string{token, key} {
		if strings.Contains(out, s) {
			t.Errorf("log output contains secret %q:\n%s", s, out)
		}
	}
	if got := strings.Count(out, Redacted); got != 4 {
		t.Errorf("found %d %s markers, want 4:\n%s", got, Redacted, out)
	}
	if !strings.Contains(out, "/bot"+Redacted+"/getUpdates") {
		t.Errorf("bot URL not redacted in place:\n%s", out)
	}
}

func TestLevelFilters(t *testing.T) {
	var buf bytes.Buffer
	log := New(&buf, slog.LevelInfo)
	log.Debug("hidden")
	if buf.Len() != 0 {
		t.Errorf("debug line written at info level: %s", buf.String())
	}
}
