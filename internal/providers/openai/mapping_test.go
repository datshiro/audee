package openai

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/datshiro/audee/internal/agent"
)

const finalAnswerFixture = `{
  "id": "chatcmpl-1",
  "object": "chat.completion",
  "model": "gpt-test",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "It is 12:04 in Tokyo.", "refusal": null},
    "finish_reason": "stop"
  }],
  "usage": {"prompt_tokens": 50, "completion_tokens": 9, "total_tokens": 59}
}`

const twoToolCallsFixture = `{
  "id": "chatcmpl-2",
  "object": "chat.completion",
  "model": "gpt-test",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        {"id": "call_tokyo", "type": "function", "function": {"name": "current_time", "arguments": "{\"timezone\":\"Asia/Tokyo\"}"}},
        {"id": "call_hcm", "type": "function", "function": {"name": "current_time", "arguments": "{\"timezone\":\"Asia/Ho_Chi_Minh\"}"}}
      ]
    },
    "finish_reason": "tool_calls"
  }]
}`

// serve returns a server that records the decoded request body and replies with fixture.
func serve(t *testing.T, fixture string) (*Client, *map[string]any) {
	t.Helper()
	got := new(map[string]any)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(b, got); err != nil {
			t.Errorf("request body is not JSON: %v\n%s", err, b)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(fixture))
	}))
	t.Cleanup(srv.Close)
	return New(srv.URL, testKey, "gpt-test", 0), got
}

func TestChat_EncodesRequest(t *testing.T) {
	c, got := serve(t, finalAnswerFixture)
	req := agent.ChatRequest{
		Messages: []agent.Message{
			{Role: agent.RoleSystem, Content: "Be brief."},
			{Role: agent.RoleUser, Content: "Tokyo and Hanoi?"},
			{Role: agent.RoleAssistant, ToolCalls: []agent.ToolCall{
				{ID: "call_tokyo", Name: "current_time", Arguments: `{"timezone":"Asia/Tokyo"}`},
				{ID: "call_hcm", Name: "current_time", Arguments: `{"timezone":"Asia/Ho_Chi_Minh"}`},
			}},
			{Role: agent.RoleTool, ToolCallID: "call_tokyo", Content: "2026-09-26T12:04:05+09:00"},
			{Role: agent.RoleTool, ToolCallID: "call_hcm", Content: "2026-09-26T10:04:05+07:00"},
		},
		Tools: []agent.ToolSpec{{
			Name:        "current_time",
			Description: "Returns the time.",
			Parameters:  json.RawMessage(`{"type":"object","properties":{"timezone":{"type":"string"}},"required":["timezone"]}`),
		}},
	}
	if _, err := c.Chat(t.Context(), req); err != nil {
		t.Fatal(err)
	}

	body := *got
	if body["model"] != "gpt-test" {
		t.Errorf("model = %v", body["model"])
	}
	if _, ok := body["stream"]; ok && body["stream"] != false {
		t.Errorf("stream = %v, want absent or false", body["stream"])
	}

	msgs, _ := body["messages"].([]any)
	if len(msgs) != 5 {
		t.Fatalf("messages = %v, want 5 entries", body["messages"])
	}
	wantRoles := []string{"system", "user", "assistant", "tool", "tool"}
	for i, want := range wantRoles {
		if role := field(msgs[i], "role"); role != want {
			t.Errorf("messages[%d].role = %v, want %s", i, role, want)
		}
	}
	if field(msgs[1], "content") != "Tokyo and Hanoi?" {
		t.Errorf("user content = %v", field(msgs[1], "content"))
	}

	calls, _ := field(msgs[2], "tool_calls").([]any)
	if len(calls) != 2 {
		t.Fatalf("assistant tool_calls = %v, want 2", field(msgs[2], "tool_calls"))
	}
	for i, want := range req.Messages[2].ToolCalls {
		call := calls[i]
		fn := field(call, "function")
		if field(call, "id") != want.ID || field(call, "type") != "function" || field(fn, "name") != want.Name {
			t.Errorf("tool_calls[%d] = %v", i, call)
		}
		// chat-completions carries arguments as a JSON-encoded string, not an object.
		if args, ok := field(fn, "arguments").(string); !ok || args != want.Arguments {
			t.Errorf("tool_calls[%d].function.arguments = %#v, want the string %q", i, field(fn, "arguments"), want.Arguments)
		}
	}

	if field(msgs[3], "tool_call_id") != "call_tokyo" || field(msgs[3], "content") != "2026-09-26T12:04:05+09:00" {
		t.Errorf("tool message = %v", msgs[3])
	}
	if field(msgs[4], "tool_call_id") != "call_hcm" {
		t.Errorf("tool message = %v", msgs[4])
	}

	tools, _ := body["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("tools = %v, want 1", body["tools"])
	}
	fn := field(tools[0], "function")
	if field(tools[0], "type") != "function" || field(fn, "name") != "current_time" || field(fn, "description") != "Returns the time." {
		t.Errorf("tools[0] = %v", tools[0])
	}
	// parameters is an embedded JSON Schema object, unlike arguments.
	if params, ok := field(fn, "parameters").(map[string]any); !ok || params["type"] != "object" {
		t.Errorf("tools[0].function.parameters = %#v, want a JSON object", field(fn, "parameters"))
	}
}

func TestChat_KeepsEmptyContent(t *testing.T) {
	c, got := serve(t, finalAnswerFixture)
	req := agent.ChatRequest{Messages: []agent.Message{
		{Role: agent.RoleUser, Content: "go"},
		{Role: agent.RoleAssistant, ToolCalls: []agent.ToolCall{{ID: "c1", Name: "noop", Arguments: `{}`}}},
		{Role: agent.RoleTool, ToolCallID: "c1", Content: ""},
		{Role: agent.RoleAssistant, Content: ""},
		{Role: agent.RoleUser, Content: "again"},
	}}
	if _, err := c.Chat(t.Context(), req); err != nil {
		t.Fatal(err)
	}
	msgs, _ := (*got)["messages"].([]any)
	if len(msgs) != 5 {
		t.Fatalf("messages = %v, want 5 entries", (*got)["messages"])
	}
	// The API rejects a tool or plain assistant message without content, so
	// empty text must still be sent. A tool-calling assistant may send null.
	for _, i := range []int{2, 3} {
		m, _ := msgs[i].(map[string]any)
		if content, ok := m["content"]; !ok || content != "" {
			t.Errorf("messages[%d].content = %#v (present=%v), want \"\"", i, content, ok)
		}
	}
}

func TestChat_OmitsEmptyTools(t *testing.T) {
	c, got := serve(t, finalAnswerFixture)
	req := agent.ChatRequest{Messages: []agent.Message{{Role: agent.RoleUser, Content: "hi"}}}
	if _, err := c.Chat(t.Context(), req); err != nil {
		t.Fatal(err)
	}
	// The API rejects "tools": [] so an empty list must be left out.
	if tools, ok := (*got)["tools"]; ok {
		t.Errorf("tools = %v, want the key omitted", tools)
	}
}

func TestChat_SendsStreamFalseExplicitly(t *testing.T) {
	// Some gateways (e.g. 9router) default to streaming when "stream" is absent, so
	// it must be sent as an explicit false rather than omitted.
	c, got := serve(t, finalAnswerFixture)
	req := agent.ChatRequest{Messages: []agent.Message{{Role: agent.RoleUser, Content: "hi"}}}
	if _, err := c.Chat(t.Context(), req); err != nil {
		t.Fatal(err)
	}
	stream, ok := (*got)["stream"]
	if !ok || stream != false {
		t.Errorf("stream = %v (present=%v), want the literal false, present", stream, ok)
	}
}

func TestChat_DecodesResponses(t *testing.T) {
	tests := []struct {
		name    string
		fixture string
		want    agent.Message
	}{
		{
			name:    "final answer",
			fixture: finalAnswerFixture,
			want:    agent.Message{Role: agent.RoleAssistant, Content: "It is 12:04 in Tokyo."},
		},
		{
			name:    "two tool calls with null content",
			fixture: twoToolCallsFixture,
			want: agent.Message{Role: agent.RoleAssistant, ToolCalls: []agent.ToolCall{
				{ID: "call_tokyo", Name: "current_time", Arguments: `{"timezone":"Asia/Tokyo"}`},
				{ID: "call_hcm", Name: "current_time", Arguments: `{"timezone":"Asia/Ho_Chi_Minh"}`},
			}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c, _ := serve(t, tt.fixture)
			resp, err := c.Chat(t.Context(), agent.ChatRequest{Messages: []agent.Message{{Role: agent.RoleUser, Content: "hi"}}})
			if err != nil {
				t.Fatal(err)
			}
			got := resp.Message
			if len(got.ToolCalls) == 0 {
				got.ToolCalls = nil
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("message = %+v\nwant      %+v", resp.Message, tt.want)
			}
		})
	}
}

func TestChat_RejectsUnusableResponses(t *testing.T) {
	tests := map[string]string{
		"no choices": `{"id":"x","choices":[]}`,
		"not JSON":   `<html>gateway error</html>`,
	}
	for name, fixture := range tests {
		t.Run(name, func(t *testing.T) {
			c, _ := serve(t, fixture)
			if _, err := c.Chat(t.Context(), agent.ChatRequest{Messages: []agent.Message{{Role: agent.RoleUser, Content: "hi"}}}); err == nil {
				t.Error("want an error")
			}
		})
	}
}

func TestChat_SurfacesProviderError(t *testing.T) {
	// Some OpenAI-compatible gateways (e.g. OpenRouter) reply HTTP 200 with the real
	// failure embedded in the body instead of the status code.
	tests := map[string]struct {
		fixture   string
		wantInErr string
	}{
		"no choices with a top-level error object": {
			fixture:   `{"error":{"message":"upstream boom","code":502}}`,
			wantInErr: "upstream boom",
		},
		"finish_reason error with no message": {
			fixture:   `{"choices":[{"index":0,"message":{"role":"assistant","content":null},"finish_reason":"error"}]}`,
			wantInErr: "finish_reason",
		},
	}
	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			c, _ := serve(t, tt.fixture)
			_, err := c.Chat(t.Context(), agent.ChatRequest{Messages: []agent.Message{{Role: agent.RoleUser, Content: "hi"}}})
			if err == nil {
				t.Fatal("want an error")
			}
			if !strings.Contains(err.Error(), tt.wantInErr) {
				t.Errorf("err = %v, want it to contain %q", err, tt.wantInErr)
			}
		})
	}
}

const envelopedFinalAnswerFixture = `{
  "data": {
    "id": "chatcmpl-3",
    "object": "chat.completion",
    "model": "gpt-test",
    "choices": [{
      "index": 0,
      "message": {"role": "assistant", "content": "It is 12:04 in Tokyo.", "refusal": null},
      "finish_reason": "stop"
    }],
    "usage": {"prompt_tokens": 50, "completion_tokens": 9, "total_tokens": 59}
  },
  "success": true
}`

const envelopedTwoToolCallsFixture = `{
  "data": {
    "id": "chatcmpl-4",
    "object": "chat.completion",
    "model": "gpt-test",
    "choices": [{
      "index": 0,
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {"id": "call_tokyo", "type": "function", "function": {"name": "current_time", "arguments": "{\"timezone\":\"Asia/Tokyo\"}"}},
          {"id": "call_hcm", "type": "function", "function": {"name": "current_time", "arguments": "{\"timezone\":\"Asia/Ho_Chi_Minh\"}"}}
        ],
        "provider_metadata": {"routed_to": "openai", "latency_ms": 812}
      },
      "finish_reason": "tool_calls"
    }]
  },
  "success": true
}`

// Some gateways (e.g. the Cline API) wrap the chat-completion object in a "data" field.
func TestChat_DecodesEnvelopedResponses(t *testing.T) {
	tests := []struct {
		name    string
		fixture string
		want    agent.Message
	}{
		{
			name:    "enveloped final answer",
			fixture: envelopedFinalAnswerFixture,
			want:    agent.Message{Role: agent.RoleAssistant, Content: "It is 12:04 in Tokyo."},
		},
		{
			name:    "enveloped two tool calls with null content",
			fixture: envelopedTwoToolCallsFixture,
			want: agent.Message{Role: agent.RoleAssistant, ToolCalls: []agent.ToolCall{
				{ID: "call_tokyo", Name: "current_time", Arguments: `{"timezone":"Asia/Tokyo"}`},
				{ID: "call_hcm", Name: "current_time", Arguments: `{"timezone":"Asia/Ho_Chi_Minh"}`},
			}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c, _ := serve(t, tt.fixture)
			resp, err := c.Chat(t.Context(), agent.ChatRequest{Messages: []agent.Message{{Role: agent.RoleUser, Content: "hi"}}})
			if err != nil {
				t.Fatal(err)
			}
			got := resp.Message
			if len(got.ToolCalls) == 0 {
				got.ToolCalls = nil
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("message = %+v\nwant      %+v", resp.Message, tt.want)
			}
		})
	}
}

func TestChat_SurfacesEnvelopedProviderError(t *testing.T) {
	// The gateway's error can live inside the envelope's "data" alongside a
	// finish_reason: "error" choice, not just at the top level.
	fixture := `{
	  "data": {
	    "choices": [{"index": 0, "message": {"role": "assistant", "content": null}, "finish_reason": "error"}],
	    "error": {"message": "upstream boom", "code": 502}
	  },
	  "success": true
	}`
	c, _ := serve(t, fixture)
	_, err := c.Chat(t.Context(), agent.ChatRequest{Messages: []agent.Message{{Role: agent.RoleUser, Content: "hi"}}})
	if err == nil {
		t.Fatal("want an error")
	}
	if want := "upstream boom"; !strings.Contains(err.Error(), want) {
		t.Errorf("err = %v, want it to contain %q", err, want)
	}
}

func TestChat_SurfacesStringProviderError(t *testing.T) {
	// The Cline API returns a plain string in "error", not an {message, code} object.
	c, _ := serve(t, `{"error":"invalid model format. Expected format: modelType/model","success":false}`)
	_, err := c.Chat(t.Context(), agent.ChatRequest{Messages: []agent.Message{{Role: agent.RoleUser, Content: "hi"}}})
	if err == nil {
		t.Fatal("want an error")
	}
	if want := "invalid model format"; !strings.Contains(err.Error(), want) {
		t.Errorf("err = %v, want it to contain %q", err, want)
	}
}

func field(v any, key string) any {
	m, _ := v.(map[string]any)
	return m[key]
}
