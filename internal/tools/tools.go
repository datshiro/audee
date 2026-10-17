package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
)

// Tool is a function the model may call. Call receives the raw JSON
// arguments the model produced, already checked to be valid JSON.
type Tool interface {
	Name() string
	Description() string
	// Parameters is the JSON Schema of the arguments object.
	Parameters() json.RawMessage
	Call(ctx context.Context, args json.RawMessage) (string, error)
}

type Registry struct {
	mu    sync.RWMutex
	tools map[string]Tool
}

func NewRegistry(tools ...Tool) (*Registry, error) {
	r := &Registry{tools: make(map[string]Tool)}
	for _, t := range tools {
		if err := r.Register(t); err != nil {
			return nil, err
		}
	}
	return r, nil
}

func (r *Registry) Register(t Tool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, dup := r.tools[t.Name()]; dup {
		return fmt.Errorf("tools: %q already registered", t.Name())
	}
	r.tools[t.Name()] = t
	return nil
}

func (r *Registry) Get(name string) (Tool, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	t, ok := r.tools[name]
	return t, ok
}

// List returns the tools sorted by name, so requests are deterministic.
func (r *Registry) List() []Tool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Tool, 0, len(r.tools))
	for _, t := range r.tools {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name() < out[j].Name() })
	return out
}
