package clock

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
	// Embeds the IANA database so zones resolve in distroless images.
	_ "time/tzdata"
)

type Tool struct {
	now func() time.Time
}

// New returns the current_time tool. A nil now uses time.Now.
func New(now func() time.Time) *Tool {
	if now == nil {
		now = time.Now
	}
	return &Tool{now: now}
}

func (*Tool) Name() string { return "current_time" }

func (*Tool) Description() string {
	return "Returns the current date and time in an IANA time zone, for example " +
		"Asia/Tokyo, Europe/London, America/New_York, or Asia/Ho_Chi_Minh (use this for Hanoi; there is no Asia/Hanoi). " +
		"Call it once per zone."
}

func (*Tool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"timezone":{"type":"string","description":"IANA time zone name, e.g. Asia/Tokyo"}},"required":["timezone"],"additionalProperties":false}`)
}

func (t *Tool) Call(_ context.Context, args json.RawMessage) (string, error) {
	var in struct {
		Timezone string `json:"timezone"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}
	if in.Timezone == "" {
		return "", errors.New("timezone is required")
	}
	loc, err := time.LoadLocation(in.Timezone)
	if err != nil {
		return "", fmt.Errorf("unknown time zone %q: use an IANA name such as Asia/Ho_Chi_Minh", in.Timezone)
	}
	now := t.now().In(loc)
	return fmt.Sprintf("%s (%s, %s)", now.Format(time.RFC3339), now.Weekday(), loc), nil
}
