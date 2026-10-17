package agent_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/datshiro/audee/internal/agent"
	"github.com/datshiro/audee/internal/providers/fake"
	"github.com/datshiro/audee/internal/tools"
	"github.com/datshiro/audee/internal/tools/clock"
)

var fixedNow = time.Date(2026, 9, 26, 3, 4, 5, 0, time.UTC)

type stubTool struct {
	name  string
	fn    func(ctx context.Context, args json.RawMessage) (string, error)
	calls []string
}

func (s *stubTool) Name() string                { return s.name }
func (s *stubTool) Description() string         { return "test tool " + s.name }
func (s *stubTool) Parameters() json.RawMessage { return json.RawMessage(`{"type":"object"}`) }
func (s *stubTool) Call(ctx context.Context, args json.RawMessage) (string, error) {
	s.calls = append(s.calls, string(args))
	return s.fn(ctx, args)
}

func registry(t *testing.T, ts ...tools.Tool) *tools.Registry {
	t.Helper()
	if len(ts) == 0 {
		ts = []tools.Tool{clock.New(func() time.Time { return fixedNow })}
	}
	r, err := tools.NewRegistry(ts...)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func userTurn(text string) []agent.Message {
	return []agent.Message{{Role: agent.RoleUser, Content: text}}
}

func callTools(calls ...agent.ToolCall) agent.Message {
	return agent.Message{Role: agent.RoleAssistant, ToolCalls: calls}
}

func answer(text string) agent.Message {
	return agent.Message{Role: agent.RoleAssistant, Content: text}
}

func timeCall(id, zone string) agent.ToolCall {
	return agent.ToolCall{ID: id, Name: "current_time", Arguments: fmt.Sprintf(`{"timezone":%q}`, zone)}
}

// assertAnswered checks the chat-completions invariant: every assistant tool
// call is followed immediately by exactly one tool message per call, in order.
func assertAnswered(t *testing.T, msgs []agent.Message) {
	t.Helper()
	results := map[string]int{}
	for _, m := range msgs {
		if m.Role == agent.RoleTool {
			results[m.ToolCallID]++
		}
	}
	for id, n := range results {
		if n != 1 {
			t.Fatalf("tool call %q has %d results, want exactly 1", id, n)
		}
	}
	for i := 0; i < len(msgs); i++ {
		calls := msgs[i].ToolCalls
		for j, c := range calls {
			k := i + 1 + j
			if k >= len(msgs) || msgs[k].Role != agent.RoleTool || msgs[k].ToolCallID != c.ID {
				t.Fatalf("tool call %q (message %d) is not answered at position %d:\n%+v", c.ID, i, k, msgs)
			}
		}
		i += len(calls)
	}
}

func toolMessage(t *testing.T, msgs []agent.Message, id string) agent.Message {
	t.Helper()
	for _, m := range msgs {
		if m.Role == agent.RoleTool && m.ToolCallID == id {
			return m
		}
	}
	t.Fatalf("no tool message for call %q in %+v", id, msgs)
	return agent.Message{}
}

func TestRun_FinalAnswer(t *testing.T) {
	p := fake.Script(answer("Hello!"))
	loop := &agent.Loop{Provider: p, Tools: registry(t)}
	history := userTurn("hi")

	res, err := loop.Run(context.Background(), history)
	if err != nil {
		t.Fatal(err)
	}
	if res.Reply != "Hello!" || res.Rounds != 1 {
		t.Errorf("Reply = %q, Rounds = %d; want Hello!, 1", res.Reply, res.Rounds)
	}
	if len(res.Messages) != 1 || res.Messages[0].Role != agent.RoleAssistant ||
		res.Messages[0].Content != "Hello!" || len(res.Messages[0].ToolCalls) != 0 {
		t.Errorf("Messages = %+v, want one plain assistant message", res.Messages)
	}

	req := p.Requests()[0]
	if !reflect.DeepEqual(req.Messages, history) {
		t.Errorf("first request messages = %+v, want the history", req.Messages)
	}
	if len(req.Tools) != 1 || req.Tools[0].Name != "current_time" || !json.Valid(req.Tools[0].Parameters) {
		t.Errorf("request tools = %+v, want the current_time spec", req.Tools)
	}
}

func TestRun_OneToolRound(t *testing.T) {
	p := fake.Script(callTools(timeCall("c1", "Asia/Tokyo")), answer("It is 12:04 in Tokyo."))
	loop := &agent.Loop{Provider: p, Tools: registry(t)}

	res, err := loop.Run(context.Background(), userTurn("time in Tokyo?"))
	if err != nil {
		t.Fatal(err)
	}
	if res.Rounds != 2 || res.Reply != "It is 12:04 in Tokyo." {
		t.Errorf("Rounds = %d, Reply = %q", res.Rounds, res.Reply)
	}
	if len(res.Messages) != 3 {
		t.Fatalf("Messages = %+v, want assistant call, tool result, final answer", res.Messages)
	}
	assertAnswered(t, res.Messages)

	if tools := p.Requests()[1].Tools; len(tools) != 1 {
		t.Errorf("second request tools = %+v, want the tools offered every round", tools)
	}
	second := p.Requests()[1].Messages
	if len(second) != 3 {
		t.Fatalf("second request = %+v, want user, assistant call, tool result", second)
	}
	obs := toolMessage(t, second, "c1")
	if !strings.Contains(obs.Content, "2026-09-26T12:04:05+09:00") {
		t.Errorf("observation = %q, want the Tokyo time", obs.Content)
	}
}

func TestRun_ToolErrorIsObservation(t *testing.T) {
	boom := &stubTool{name: "flaky", fn: func(context.Context, json.RawMessage) (string, error) {
		return "", errors.New("disk on fire")
	}}
	p := fake.Script(
		callTools(agent.ToolCall{ID: "c1", Name: "flaky", Arguments: `{}`}),
		answer("The tool failed, sorry."),
	)
	loop := &agent.Loop{Provider: p, Tools: registry(t, boom)}

	res, err := loop.Run(context.Background(), userTurn("go"))
	if err != nil {
		t.Fatalf("a tool error must not fail the run: %v", err)
	}
	if res.Reply != "The tool failed, sorry." {
		t.Errorf("Reply = %q", res.Reply)
	}
	obs := toolMessage(t, p.Requests()[1].Messages, "c1")
	if !strings.Contains(obs.Content, "disk on fire") {
		t.Errorf("observation = %q, want the tool's error text", obs.Content)
	}
}

func TestRun_StopsAtRoundCap(t *testing.T) {
	tests := []struct {
		name      string
		maxRounds int
		wantCalls int
	}{
		{"configured cap", 3, 3},
		{"zero means default", 0, agent.DefaultMaxRounds},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := fake.New(func(call int, _ agent.ChatRequest) (agent.Message, error) {
				return callTools(timeCall(fmt.Sprintf("c%d", call), "UTC")), nil
			})
			loop := &agent.Loop{Provider: p, Tools: registry(t), MaxRounds: tt.maxRounds}

			res, err := loop.Run(context.Background(), userTurn("loop forever"))
			if err != nil {
				t.Fatalf("hitting the cap is not an error: %v", err)
			}
			if got := len(p.Requests()); got != tt.wantCalls {
				t.Errorf("provider calls = %d, want %d", got, tt.wantCalls)
			}
			if res.Rounds != tt.wantCalls {
				t.Errorf("Rounds = %d, want %d", res.Rounds, tt.wantCalls)
			}
			if strings.TrimSpace(res.Reply) == "" {
				t.Error("Reply is empty, want a user-facing message")
			}
			last := res.Messages[len(res.Messages)-1]
			if last.Role != agent.RoleAssistant || len(last.ToolCalls) != 0 || last.Content != res.Reply {
				t.Errorf("last message = %+v, want a plain assistant message carrying Reply", last)
			}
			assertAnswered(t, res.Messages)
		})
	}
}

func TestRun_ParallelToolCalls(t *testing.T) {
	p := fake.Script(
		callTools(timeCall("c1", "Asia/Tokyo"), timeCall("c2", "Asia/Ho_Chi_Minh")),
		answer("Tokyo 12:04, Hanoi 10:04."),
	)
	loop := &agent.Loop{Provider: p, Tools: registry(t)}

	res, err := loop.Run(context.Background(), userTurn("Tokyo and Hanoi?"))
	if err != nil {
		t.Fatal(err)
	}
	second := p.Requests()[1].Messages
	assertAnswered(t, second)
	if len(second) != 4 {
		t.Fatalf("second request = %+v, want user, assistant, two tool results", second)
	}
	if !strings.Contains(toolMessage(t, second, "c1").Content, "+09:00") ||
		!strings.Contains(toolMessage(t, second, "c2").Content, "+07:00") {
		t.Errorf("results are not matched to their call IDs: %+v", second)
	}
	assertAnswered(t, res.Messages)
}

func TestRun_BadToolCallsBecomeObservations(t *testing.T) {
	tests := []struct {
		name     string
		call     agent.ToolCall
		wantText string
	}{
		{"unknown tool", agent.ToolCall{ID: "c1", Name: "launch_rockets", Arguments: `{}`}, "launch_rockets"},
		{"malformed JSON", agent.ToolCall{ID: "c1", Name: "current_time", Arguments: `{"timezone":`}, ""},
		{"invalid zone", timeCall("c1", "Asia/Hanoi"), "Asia/Hanoi"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := fake.Script(callTools(tt.call), answer("done"))
			loop := &agent.Loop{Provider: p, Tools: registry(t)}

			if _, err := loop.Run(context.Background(), userTurn("go")); err != nil {
				t.Fatalf("a bad tool call must not fail the run: %v", err)
			}
			obs := toolMessage(t, p.Requests()[1].Messages, "c1")
			if strings.TrimSpace(obs.Content) == "" || !strings.Contains(obs.Content, tt.wantText) {
				t.Errorf("observation = %q, want non-empty text containing %q", obs.Content, tt.wantText)
			}
		})
	}
}

func TestRun_MalformedArgumentsSkipTheTool(t *testing.T) {
	spy := &stubTool{name: "spy", fn: func(context.Context, json.RawMessage) (string, error) { return "ok", nil }}
	p := fake.Script(callTools(agent.ToolCall{ID: "c1", Name: "spy", Arguments: `not json`}), answer("done"))
	loop := &agent.Loop{Provider: p, Tools: registry(t, spy)}

	if _, err := loop.Run(context.Background(), userTurn("go")); err != nil {
		t.Fatal(err)
	}
	if len(spy.calls) != 0 {
		t.Errorf("tool was called with malformed arguments %q", spy.calls)
	}
}

func TestRun_ProviderErrorFailsTheRun(t *testing.T) {
	upstream := errors.New("upstream 500")
	p := fake.New(func(int, agent.ChatRequest) (agent.Message, error) { return agent.Message{}, upstream })
	loop := &agent.Loop{Provider: p, Tools: registry(t)}

	if _, err := loop.Run(context.Background(), userTurn("hi")); !errors.Is(err, upstream) {
		t.Errorf("err = %v, want it to wrap %v", err, upstream)
	}
}

func TestRun_ProviderErrorReportsRoundsAttempted(t *testing.T) {
	upstream := errors.New("upstream 500")
	p := fake.New(func(call int, _ agent.ChatRequest) (agent.Message, error) {
		if call == 0 {
			return callTools(timeCall("c1", "UTC")), nil
		}
		return agent.Message{}, upstream
	})
	loop := &agent.Loop{Provider: p, Tools: registry(t)}

	res, err := loop.Run(context.Background(), userTurn("hi"))
	if !errors.Is(err, upstream) {
		t.Errorf("err = %v, want it to wrap %v", err, upstream)
	}
	if res.Rounds != 2 {
		t.Errorf("Rounds = %d, want 2 (the failed round counts)", res.Rounds)
	}
}

func TestRun_ToolPanicBecomesObservation(t *testing.T) {
	boom := &stubTool{name: "boomer", fn: func(context.Context, json.RawMessage) (string, error) {
		panic("kaboom")
	}}
	p := fake.Script(
		callTools(agent.ToolCall{ID: "c1", Name: "boomer", Arguments: `{}`}),
		answer("recovered, thanks."),
	)
	loop := &agent.Loop{Provider: p, Tools: registry(t, boom)}

	res, err := loop.Run(context.Background(), userTurn("go"))
	if err != nil {
		t.Fatalf("a panicking tool must not fail the run: %v", err)
	}
	if res.Reply != "recovered, thanks." {
		t.Errorf("Reply = %q, want the loop to continue to the final answer", res.Reply)
	}
	obs := toolMessage(t, p.Requests()[1].Messages, "c1")
	if strings.TrimSpace(obs.Content) == "" ||
		!strings.Contains(obs.Content, "boomer") || !strings.Contains(obs.Content, "kaboom") {
		t.Errorf("observation = %q, want it to mention the tool name and panic value", obs.Content)
	}
}

func TestRun_ContextCancellation(t *testing.T) {
	t.Run("already cancelled", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		loop := &agent.Loop{Provider: fake.Script(answer("never")), Tools: registry(t)}

		if _, err := loop.Run(ctx, userTurn("hi")); !errors.Is(err, context.Canceled) {
			t.Errorf("err = %v, want context.Canceled", err)
		}
	})

	t.Run("cancelled during a tool call", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		slow := &stubTool{name: "slow", fn: func(ctx context.Context, _ json.RawMessage) (string, error) {
			cancel()
			<-ctx.Done()
			return "", ctx.Err()
		}}
		p := fake.New(func(int, agent.ChatRequest) (agent.Message, error) {
			return callTools(agent.ToolCall{ID: "c1", Name: "slow", Arguments: `{}`}), nil
		})
		loop := &agent.Loop{Provider: p, Tools: registry(t, slow)}

		if _, err := loop.Run(ctx, userTurn("hi")); !errors.Is(err, context.Canceled) {
			t.Errorf("err = %v, want context.Canceled", err)
		}
		if got := len(p.Requests()); got > 2 {
			t.Errorf("provider called %d times after cancellation", got)
		}
	})
}
