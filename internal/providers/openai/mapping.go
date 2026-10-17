package openai

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/datshiro/audee/internal/agent"
)

// maxProviderErrorLen bounds how much of a gateway's error message we surface in our own error.
const maxProviderErrorLen = 300

type wireRequest struct {
	Model    string        `json:"model"`
	Messages []wireMessage `json:"messages"`
	Tools    []wireTool    `json:"tools,omitempty"`
	// Stream must be sent explicitly: some gateways (e.g. 9router) default to
	// streaming when the field is absent and reply with an SSE body we can't parse.
	Stream bool `json:"stream"`
}

type wireMessage struct {
	Role       string         `json:"role"`
	Content    *string        `json:"content"`
	ToolCalls  []wireToolCall `json:"tool_calls,omitempty"`
	ToolCallID string         `json:"tool_call_id,omitempty"`
}

type wireToolCall struct {
	ID       string           `json:"id"`
	Type     string           `json:"type"`
	Function wireFunctionCall `json:"function"`
}

type wireFunctionCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type wireTool struct {
	Type     string       `json:"type"`
	Function wireFunction `json:"function"`
}

type wireFunction struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	Parameters  json.RawMessage `json:"parameters,omitempty"`
}

type wireResponse struct {
	Choices []wireChoice `json:"choices"`
	// Data holds the chat-completion object when a gateway wraps it in an envelope
	// instead of returning it at the top level (e.g. the Cline API replies
	// {"data": {...standard chat.completion...}, "success": true}).
	Data json.RawMessage `json:"data,omitempty"`
	// Error is set by some OpenAI-compatible gateways that return HTTP 200 with the
	// real failure embedded in the body instead of the status code. Its shape varies:
	// an {message, code} object (e.g. OpenRouter) or a plain string (e.g. the Cline
	// API replies {"error": "...", "success": false}), so it's decoded lazily.
	Error json.RawMessage `json:"error,omitempty"`
}

type wireError struct {
	Message string `json:"message"`
	Code    any    `json:"code,omitempty"`
}

type wireChoice struct {
	Message      wireResponseMessage `json:"message"`
	FinishReason string              `json:"finish_reason,omitempty"`
}

type wireResponseMessage struct {
	Content   *string        `json:"content"`
	ToolCalls []wireToolCall `json:"tool_calls,omitempty"`
}

// encodeRequest turns the neutral request into a chat-completions JSON body.
// The contract is pinned by mapping_test.go.
func encodeRequest(model string, req agent.ChatRequest) ([]byte, error) {
	messages := make([]wireMessage, len(req.Messages))
	for i, m := range req.Messages {
		messages[i] = encodeMessage(m)
	}

	var tools []wireTool
	if len(req.Tools) > 0 {
		tools = make([]wireTool, len(req.Tools))
		for i, t := range req.Tools {
			tools[i] = wireTool{
				Type: "function",
				Function: wireFunction{
					Name:        t.Name,
					Description: t.Description,
					Parameters:  t.Parameters,
				},
			}
		}
	}

	body, err := json.Marshal(wireRequest{Model: model, Messages: messages, Tools: tools})
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}
	return body, nil
}

func encodeMessage(m agent.Message) wireMessage {
	wm := wireMessage{Role: string(m.Role), ToolCallID: m.ToolCallID}
	// The API rejects a tool or plain-assistant message with no content, so send "" for those.
	// Only a tool-calling assistant with no text may omit it (send null) instead.
	if m.Content != "" || len(m.ToolCalls) == 0 {
		content := m.Content
		wm.Content = &content
	}
	if len(m.ToolCalls) > 0 {
		wm.ToolCalls = make([]wireToolCall, len(m.ToolCalls))
		for i, tc := range m.ToolCalls {
			wm.ToolCalls[i] = wireToolCall{
				ID:   tc.ID,
				Type: "function",
				Function: wireFunctionCall{
					Name:      tc.Name,
					Arguments: tc.Arguments,
				},
			}
		}
	}
	return wm
}

// decodeResponse turns a chat-completions JSON body into the first choice's neutral message.
func decodeResponse(body []byte) (agent.Message, error) {
	var wr wireResponse
	if err := json.Unmarshal(body, &wr); err != nil {
		return agent.Message{}, fmt.Errorf("unmarshal response: %w", err)
	}
	if len(wr.Choices) == 0 && len(wr.Data) > 0 {
		var inner wireResponse
		if err := json.Unmarshal(wr.Data, &inner); err != nil {
			return agent.Message{}, fmt.Errorf("unmarshal response data: %w", err)
		}
		if len(inner.Error) == 0 {
			inner.Error = wr.Error
		}
		wr = inner
	}

	if len(wr.Choices) == 0 {
		return agent.Message{}, providerError(wr.Error, "response has no choices")
	}

	choice := wr.Choices[0]
	if choice.FinishReason == "error" {
		return agent.Message{}, providerError(wr.Error, `finish_reason "error" with no message from the provider`)
	}

	rm := choice.Message
	msg := agent.Message{Role: agent.RoleAssistant}
	if rm.Content != nil {
		msg.Content = *rm.Content
	}
	if len(rm.ToolCalls) > 0 {
		msg.ToolCalls = make([]agent.ToolCall, len(rm.ToolCalls))
		for i, tc := range rm.ToolCalls {
			msg.ToolCalls[i] = agent.ToolCall{
				ID:        tc.ID,
				Name:      tc.Function.Name,
				Arguments: tc.Function.Arguments,
			}
		}
	}
	return msg, nil
}

// providerError reports a gateway's own error, if any, else fallback. The raw value may be
// an {message, code} object or a plain string, so an object decode is tried first.
func providerError(raw json.RawMessage, fallback string) error {
	if len(raw) == 0 {
		return errors.New(fallback)
	}

	var obj wireError
	if err := json.Unmarshal(raw, &obj); err == nil && obj.Message != "" {
		return fmt.Errorf("provider error: %s", truncate(obj.Message, maxProviderErrorLen))
	}

	var msg string
	if err := json.Unmarshal(raw, &msg); err == nil && msg != "" {
		return fmt.Errorf("provider error: %s", truncate(msg, maxProviderErrorLen))
	}

	return errors.New(fallback)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return strings.ToValidUTF8(s[:n], "") + "…"
}
