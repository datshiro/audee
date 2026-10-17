// Package fake is a scripted agent.Provider for tests. It never touches the network.
package fake

import (
	"context"
	"fmt"
	"slices"
	"sync"

	"github.com/datshiro/audee/internal/agent"
)

// Func answers the call-th request (0-based).
type Func func(call int, req agent.ChatRequest) (agent.Message, error)

type Provider struct {
	fn       Func
	mu       sync.Mutex
	requests []agent.ChatRequest
}

func New(fn Func) *Provider {
	return &Provider{fn: fn}
}

// Script replies with steps in order and fails if called more often.
func Script(steps ...agent.Message) *Provider {
	return New(func(call int, _ agent.ChatRequest) (agent.Message, error) {
		if call >= len(steps) {
			return agent.Message{}, fmt.Errorf("fake: unexpected call %d, script has %d steps", call+1, len(steps))
		}
		return steps[call], nil
	})
}

func (p *Provider) Chat(ctx context.Context, req agent.ChatRequest) (agent.ChatResponse, error) {
	if err := ctx.Err(); err != nil {
		return agent.ChatResponse{}, err
	}
	p.mu.Lock()
	call := len(p.requests)
	p.requests = append(p.requests, clone(req))
	p.mu.Unlock()

	msg, err := p.fn(call, req)
	if err != nil {
		return agent.ChatResponse{}, err
	}
	return agent.ChatResponse{Message: msg}, nil
}

// Requests returns a snapshot of every request received so far.
func (p *Provider) Requests() []agent.ChatRequest {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.requests)
}

// clone deep-copies req so later mutation by the caller cannot rewrite what was recorded.
func clone(req agent.ChatRequest) agent.ChatRequest {
	out := agent.ChatRequest{
		Messages: make([]agent.Message, len(req.Messages)),
		Tools:    slices.Clone(req.Tools),
	}
	for i, m := range req.Messages {
		m.ToolCalls = slices.Clone(m.ToolCalls)
		out.Messages[i] = m
	}
	return out
}
