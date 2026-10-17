package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/datshiro/audee/internal/tools"
)

const DefaultMaxRounds = 8

// ErrNotImplemented marks the hand-written parts that are still stubs.
var ErrNotImplemented = errors.New("not implemented")

type Loop struct {
	Provider Provider
	Tools    *tools.Registry
	// MaxRounds caps provider calls per run; zero or less means DefaultMaxRounds.
	MaxRounds int
}

type Result struct {
	// Messages holds only what this run added after the input history:
	// assistant turns, tool results, and the final assistant reply.
	Messages []Message
	// Reply is the user-facing text, equal to the last message's Content.
	Reply string
	// Rounds is the number of provider calls made.
	Rounds int
}

// Run drives think → act → observe until the model answers without tool
// calls or the round cap is reached. history must end with the user turn.
//
// The contract is pinned by loop_test.go:
//   - every tool call gets exactly one tool message with its ToolCallID, in call order;
//   - unknown tools, malformed JSON arguments, and tool errors become tool
//     messages the model sees next round, never a Run error;
//   - at the cap, return a non-empty user-facing Reply as a final assistant message;
//   - provider errors and context cancellation return an error that wraps the cause.
func (l *Loop) Run(ctx context.Context, history []Message) (Result, error) {
	maxRounds := l.MaxRounds
	if maxRounds <= 0 {
		maxRounds = DefaultMaxRounds
	}
	specs := toolSpecs(l.Tools.List())

	// Copy so appends never touch the caller's backing array.
	conversation := append([]Message(nil), history...)
	var added []Message

	for round := 1; round <= maxRounds; round++ {
		if err := ctx.Err(); err != nil {
			return Result{Rounds: round}, fmt.Errorf("agent: run canceled: %w", err)
		}

		resp, err := l.Provider.Chat(ctx, ChatRequest{Messages: conversation, Tools: specs})
		if err != nil {
			return Result{Rounds: round}, fmt.Errorf("agent: provider call: %w", err)
		}

		assistant := resp.Message
		conversation = append(conversation, assistant)
		added = append(added, assistant)

		if len(assistant.ToolCalls) == 0 {
			return Result{Messages: added, Reply: assistant.Content, Rounds: round}, nil
		}

		for _, call := range assistant.ToolCalls {
			obs := l.executeToolCall(ctx, call)
			conversation = append(conversation, obs)
			added = append(added, obs)
		}

		if round == maxRounds {
			// The cap check also lives here: cancellation during the last
			// round's tool calls must still surface as an error, not a reply.
			if err := ctx.Err(); err != nil {
				return Result{Rounds: round}, fmt.Errorf("agent: run canceled: %w", err)
			}
			reply := fmt.Sprintf("Stopped after %d rounds without a final answer.", round)
			added = append(added, Message{Role: RoleAssistant, Content: reply})
			return Result{Messages: added, Reply: reply, Rounds: round}, nil
		}
	}

	// Unreachable: maxRounds is always >= 1, so the loop above always returns.
	return Result{Rounds: maxRounds}, fmt.Errorf("agent: exceeded max rounds without stopping")
}

// executeToolCall runs one tool call and turns the outcome into the tool
// message that answers it. It never returns an error: an unknown tool,
// malformed arguments, and a tool failure all become observation text for
// the model to see on the next round.
func (l *Loop) executeToolCall(ctx context.Context, call ToolCall) Message {
	tool, ok := l.Tools.Get(call.Name)
	if !ok {
		return ToolResult{CallID: call.ID, Content: fmt.Sprintf("unknown tool %q", call.Name), IsError: true}.Message()
	}

	args := call.Arguments
	if args == "" {
		args = "{}"
	}
	if !json.Valid([]byte(args)) {
		return ToolResult{
			CallID:  call.ID,
			Content: fmt.Sprintf("invalid arguments for %q: not valid JSON", call.Name),
			IsError: true,
		}.Message()
	}

	out, err := safeCall(ctx, tool, json.RawMessage(args))
	if err != nil {
		return ToolResult{CallID: call.ID, Content: fmt.Sprintf("%s: %v", call.Name, err), IsError: true}.Message()
	}
	return ToolResult{CallID: call.ID, Content: out}.Message()
}

// safeCall runs a tool call and recovers a panic into an error so one bad
// tool can never take down the process running the loop.
func safeCall(ctx context.Context, tool tools.Tool, args json.RawMessage) (out string, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("panicked: %v", r)
		}
	}()
	return tool.Call(ctx, args)
}

func toolSpecs(list []tools.Tool) []ToolSpec {
	specs := make([]ToolSpec, len(list))
	for i, t := range list {
		specs[i] = ToolSpec{Name: t.Name(), Description: t.Description(), Parameters: t.Parameters()}
	}
	return specs
}
