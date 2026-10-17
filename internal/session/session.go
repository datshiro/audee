package session

import (
	"slices"
	"sync"

	"github.com/datshiro/audee/internal/agent"
)

const DefaultMaxMessages = 40

// Store keeps conversation history in memory, keyed by session key
// (for example "telegram:<chat_id>").
type Store struct {
	mu          sync.Mutex
	maxMessages int
	history     map[string][]agent.Message
}

func NewStore(maxMessages int) *Store {
	if maxMessages <= 0 {
		maxMessages = DefaultMaxMessages
	}
	return &Store{maxMessages: maxMessages, history: make(map[string][]agent.Message)}
}

// History returns a copy of the session's messages, oldest first.
func (s *Store) History(key string) []agent.Message {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.history[key])
}

// Append adds messages and trims the oldest ones beyond the limit.
func (s *Store) Append(key string, msgs ...agent.Message) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.history[key] = trim(append(s.history[key], msgs...), s.maxMessages)
}

func (s *Store) Reset(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.history, key)
}

// trim drops whole turns from the front: the kept history always starts at a
// user message, so no tool result is left without the call that requested it.
// A single turn longer than max is kept whole rather than lost.
func trim(msgs []agent.Message, max int) []agent.Message {
	if len(msgs) <= max {
		return msgs
	}
	cut := len(msgs) - max
	for cut < len(msgs) && msgs[cut].Role != agent.RoleUser {
		cut++
	}
	if cut == len(msgs) {
		cut = lastUser(msgs)
	}
	return slices.Clone(msgs[cut:])
}

func lastUser(msgs []agent.Message) int {
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role == agent.RoleUser {
			return i
		}
	}
	return len(msgs)
}
