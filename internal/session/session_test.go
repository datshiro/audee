package session

import (
	"fmt"
	"reflect"
	"sync"
	"testing"

	"github.com/datshiro/audee/internal/agent"
)

func user(s string) agent.Message { return agent.Message{Role: agent.RoleUser, Content: s} }
func reply(s string) agent.Message {
	return agent.Message{Role: agent.RoleAssistant, Content: s}
}
func call(id string) agent.Message {
	return agent.Message{Role: agent.RoleAssistant, ToolCalls: []agent.ToolCall{{ID: id, Name: "current_time", Arguments: "{}"}}}
}
func result(id string) agent.Message {
	return agent.Message{Role: agent.RoleTool, ToolCallID: id, Content: "ok"}
}

func TestStore_AppendHistoryReset(t *testing.T) {
	s := NewStore(10)
	s.Append("telegram:1", user("hi"), reply("hello"))
	s.Append("telegram:2", user("other chat"))

	if got, want := s.History("telegram:1"), []agent.Message{user("hi"), reply("hello")}; !reflect.DeepEqual(got, want) {
		t.Errorf("History = %+v, want %+v", got, want)
	}

	h := s.History("telegram:1")
	h[0].Content = "mutated"
	if s.History("telegram:1")[0].Content != "hi" {
		t.Error("History must return a copy")
	}

	s.Reset("telegram:1")
	if got := s.History("telegram:1"); len(got) != 0 {
		t.Errorf("after Reset, History = %+v", got)
	}
	if got := s.History("telegram:2"); len(got) != 1 {
		t.Errorf("Reset touched another session: %+v", got)
	}
}

func TestTrim_KeepsWholeTurns(t *testing.T) {
	tests := []struct {
		name string
		in   []agent.Message
		max  int
		want []agent.Message
	}{
		{
			name: "under the limit is untouched",
			in:   []agent.Message{user("a"), reply("b")},
			max:  4,
			want: []agent.Message{user("a"), reply("b")},
		},
		{
			name: "drops the oldest turn",
			in:   []agent.Message{user("1"), reply("1"), user("2"), reply("2")},
			max:  2,
			want: []agent.Message{user("2"), reply("2")},
		},
		{
			name: "never starts on a tool result",
			// Keeping the last 4 would start at result("c1"), orphaned from its call.
			in:   []agent.Message{user("1"), call("c1"), result("c1"), reply("1"), user("2"), reply("2")},
			max:  4,
			want: []agent.Message{user("2"), reply("2")},
		},
		{
			name: "never starts on an assistant tool call",
			in:   []agent.Message{user("1"), call("c1"), result("c1"), call("c2"), result("c2"), reply("1"), user("2"), reply("2")},
			max:  6,
			want: []agent.Message{user("2"), reply("2")},
		},
		{
			name: "one turn larger than the limit is kept whole",
			in:   []agent.Message{user("0"), reply("0"), user("1"), call("c1"), result("c1"), reply("1")},
			max:  3,
			want: []agent.Message{user("1"), call("c1"), result("c1"), reply("1")},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := trim(tt.in, tt.max); !reflect.DeepEqual(got, tt.want) {
				t.Errorf("trim = %+v\nwant   %+v", got, tt.want)
			}
		})
	}
}

func TestStore_ConcurrentAppend(t *testing.T) {
	s := NewStore(1000)
	var wg sync.WaitGroup
	for i := range 50 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.Append("k", user(fmt.Sprint(i)))
		}()
	}
	wg.Wait()
	if got := len(s.History("k")); got != 50 {
		t.Errorf("len = %d, want 50", got)
	}
}
