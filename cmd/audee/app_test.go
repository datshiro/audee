package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"reflect"
	"strings"
	"testing"

	"github.com/datshiro/audee/internal/agent"
	"github.com/datshiro/audee/internal/channels"
	"github.com/datshiro/audee/internal/logging"
	"github.com/datshiro/audee/internal/session"
)

type scriptedRunner struct {
	results   []agent.Result
	err       error
	histories [][]agent.Message
}

func (r *scriptedRunner) Run(_ context.Context, history []agent.Message) (agent.Result, error) {
	r.histories = append(r.histories, history)
	if r.err != nil {
		return agent.Result{Rounds: 1}, r.err
	}
	res := r.results[0]
	r.results = r.results[1:]
	return res, nil
}

type recordingSender struct{ sent []channels.OutboundMessage }

func (s *recordingSender) Send(_ context.Context, out channels.OutboundMessage) error {
	s.sent = append(s.sent, out)
	return nil
}

func newApp(r runner) (*app, *recordingSender, *bytes.Buffer) {
	var logs bytes.Buffer
	s := &recordingSender{}
	return &app{runner: r, store: session.NewStore(0), send: s, log: logging.New(&logs, slog.LevelDebug)}, s, &logs
}

func msg(chatID, text string) channels.InboundMessage {
	return channels.InboundMessage{Channel: "telegram", ChatID: chatID, UserID: "42", Text: text}
}

func user(s string) agent.Message { return agent.Message{Role: agent.RoleUser, Content: s} }

func final(s string) agent.Message { return agent.Message{Role: agent.RoleAssistant, Content: s} }

var tokyoTurn = agent.Result{
	Messages: []agent.Message{
		{Role: agent.RoleAssistant, ToolCalls: []agent.ToolCall{{ID: "c1", Name: "current_time", Arguments: `{"timezone":"Asia/Tokyo"}`}}},
		{Role: agent.RoleTool, ToolCallID: "c1", Content: "12:04"},
		final("12:04 in Tokyo."),
	},
	Reply:  "12:04 in Tokyo.",
	Rounds: 2,
}

var londonTurn = agent.Result{Messages: []agent.Message{final("04:04 in London.")}, Reply: "04:04 in London.", Rounds: 1}

func TestApp_FollowUpSeesPriorTurns(t *testing.T) {
	r := &scriptedRunner{results: []agent.Result{tokyoTurn, londonTurn}}
	a, sent, _ := newApp(r)

	a.handle(t.Context(), msg("1", "Time in Tokyo?"))
	a.handle(t.Context(), msg("1", "and in London?"))

	want := append(append([]agent.Message{user("Time in Tokyo?")}, tokyoTurn.Messages...), user("and in London?"))
	if !reflect.DeepEqual(r.histories[1], want) {
		t.Errorf("second run history =\n%+v\nwant\n%+v", r.histories[1], want)
	}
	if n := len(sent.sent); n != 2 {
		t.Fatalf("sent %d replies, want 2", n)
	}
	if got := sent.sent[1]; got.Text != "04:04 in London." || got.ChatID != "1" || got.Channel != "telegram" {
		t.Errorf("reply = %+v", got)
	}
}

func TestApp_ResetForgetsContext(t *testing.T) {
	r := &scriptedRunner{results: []agent.Result{tokyoTurn, londonTurn}}
	a, sent, _ := newApp(r)

	a.handle(t.Context(), msg("1", "Time in Tokyo?"))
	a.handle(t.Context(), msg("1", " /reset "))
	a.handle(t.Context(), msg("1", "and in London?"))

	if len(r.histories) != 2 {
		t.Fatalf("runner called %d times, want 2 (/reset must not reach the model)", len(r.histories))
	}
	if want := []agent.Message{user("and in London?")}; !reflect.DeepEqual(r.histories[1], want) {
		t.Errorf("history after reset = %+v, want only the new turn", r.histories[1])
	}
	if sent.sent[1].Text != resetReply {
		t.Errorf("reset reply = %q", sent.sent[1].Text)
	}
}

func TestApp_SessionsAreSeparate(t *testing.T) {
	r := &scriptedRunner{results: []agent.Result{tokyoTurn, londonTurn}}
	a, _, _ := newApp(r)

	a.handle(t.Context(), msg("1", "Time in Tokyo?"))
	a.handle(t.Context(), msg("2", "and in London?"))

	if want := []agent.Message{user("and in London?")}; !reflect.DeepEqual(r.histories[1], want) {
		t.Errorf("chat 2 saw chat 1's history: %+v", r.histories[1])
	}
}

func TestApp_RunErrorKeepsHistoryAndApologises(t *testing.T) {
	r := &scriptedRunner{err: errors.New("upstream 500")}
	a, sent, logs := newApp(r)

	a.handle(t.Context(), msg("1", "hi"))

	if sent.sent[0].Text != failureReply {
		t.Errorf("reply = %q, want the generic failure reply", sent.sent[0].Text)
	}
	if strings.Contains(sent.sent[0].Text, "upstream") {
		t.Error("internal error text reached the user")
	}
	if h := a.store.History("telegram:1"); len(h) != 0 {
		t.Errorf("failed turn was stored: %+v", h)
	}
	if !strings.Contains(logs.String(), `"msg":"run failed"`) {
		t.Errorf("no run-failed log line:\n%s", logs)
	}
}

func TestApp_LogsOneLinePerRun(t *testing.T) {
	a, _, logs := newApp(&scriptedRunner{results: []agent.Result{tokyoTurn}})

	a.handle(t.Context(), msg("1", "Time in Tokyo?"))

	var line struct {
		Msg        string   `json:"msg"`
		Session    string   `json:"session"`
		Rounds     int      `json:"rounds"`
		Tools      []string `json:"tools"`
		DurationMS *int64   `json:"duration_ms"`
	}
	var runs int
	for _, raw := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
		if err := json.Unmarshal([]byte(raw), &line); err != nil {
			t.Fatalf("log line is not JSON: %s", raw)
		}
		if line.Msg == "run" {
			runs++
			if line.Session != "telegram:1" || line.Rounds != 2 || !reflect.DeepEqual(line.Tools, []string{"current_time"}) || line.DurationMS == nil {
				t.Errorf("run line = %s", raw)
			}
		}
	}
	if runs != 1 {
		t.Errorf("found %d run lines, want 1:\n%s", runs, logs)
	}
}
