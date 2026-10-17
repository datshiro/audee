package clock

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestCurrentTime(t *testing.T) {
	fixed := time.Date(2026, 9, 26, 3, 4, 5, 0, time.UTC)
	tool := New(func() time.Time { return fixed })

	tests := []struct {
		name    string
		args    string
		want    string
		wantErr string
	}{
		{"tokyo", `{"timezone":"Asia/Tokyo"}`, "2026-09-26T12:04:05+09:00 (Saturday, Asia/Tokyo)", ""},
		{"ho chi minh", `{"timezone":"Asia/Ho_Chi_Minh"}`, "2026-09-26T10:04:05+07:00 (Saturday, Asia/Ho_Chi_Minh)", ""},
		{"london bst", `{"timezone":"Europe/London"}`, "2026-09-26T04:04:05+01:00 (Saturday, Europe/London)", ""},
		{"utc", `{"timezone":"UTC"}`, "2026-09-26T03:04:05Z (Saturday, UTC)", ""},
		{"hanoi is not a zone", `{"timezone":"Asia/Hanoi"}`, "", `unknown time zone "Asia/Hanoi"`},
		{"missing zone", `{}`, "", "timezone is required"},
		{"wrong type", `{"timezone":7}`, "", "invalid arguments"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := tool.Call(context.Background(), json.RawMessage(tt.args))
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want containing %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestParametersIsValidJSON(t *testing.T) {
	if !json.Valid(New(nil).Parameters()) {
		t.Fatal("Parameters() is not valid JSON")
	}
}
