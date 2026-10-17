package agent

import (
	"context"
	"encoding/json"
)

type Role string

const (
	RoleSystem    Role = "system"
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
	RoleTool      Role = "tool"
)

// Message is provider-neutral. Adapters translate it to and from their wire format.
type Message struct {
	Role    Role
	Content string
	// ToolCalls is set on assistant messages that request tools.
	ToolCalls []ToolCall
	// ToolCallID is set on tool messages and names the call they answer.
	ToolCallID string
}

type ToolCall struct {
	ID   string
	Name string
	// Arguments is the JSON text exactly as the model produced it; it may be malformed.
	Arguments string
}

type ToolResult struct {
	CallID  string
	Content string
	IsError bool
}

// Message turns the result into the tool-role message that answers its call.
func (r ToolResult) Message() Message {
	return Message{Role: RoleTool, ToolCallID: r.CallID, Content: r.Content}
}

type ToolSpec struct {
	Name        string
	Description string
	// Parameters is the JSON Schema of the arguments object.
	Parameters json.RawMessage
}

type ChatRequest struct {
	Messages []Message
	Tools    []ToolSpec
}

type ChatResponse struct {
	Message Message
}

// Provider is one LLM backend. The model and credentials are adapter configuration.
type Provider interface {
	Chat(ctx context.Context, req ChatRequest) (ChatResponse, error)
}
