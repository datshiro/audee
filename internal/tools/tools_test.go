package tools_test

import (
	"testing"

	"github.com/datshiro/audee/internal/tools"
	"github.com/datshiro/audee/internal/tools/clock"
)

func TestRegistry(t *testing.T) {
	r, err := tools.NewRegistry(clock.New(nil))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := r.Get("current_time"); !ok {
		t.Error("current_time not found")
	}
	if _, ok := r.Get("nope"); ok {
		t.Error("unknown tool found")
	}
	if err := r.Register(clock.New(nil)); err == nil {
		t.Error("duplicate registration accepted")
	}
	if got := r.List(); len(got) != 1 || got[0].Name() != "current_time" {
		t.Errorf("List = %v", got)
	}
}
