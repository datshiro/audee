package config

import (
	"log/slog"
	"strings"
	"testing"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func validEnv() map[string]string {
	return map[string]string{
		"TELEGRAM_BOT_TOKEN": "123:tg-secret",
		"LLM_API_KEY":        "sk-secret",
		"LLM_MODEL":          "gpt-test",
	}
}

func TestLoadDefaults(t *testing.T) {
	c, err := Load(env(validEnv()))
	if err != nil {
		t.Fatal(err)
	}
	if c.MaxRounds != 8 {
		t.Errorf("MaxRounds = %d, want 8", c.MaxRounds)
	}
	if c.LLMBaseURL != DefaultBaseURL {
		t.Errorf("LLMBaseURL = %q", c.LLMBaseURL)
	}
	if c.LogLevel != slog.LevelInfo {
		t.Errorf("LogLevel = %v", c.LogLevel)
	}
	if len(c.AllowedUserIDs) != 0 {
		t.Errorf("AllowedUserIDs = %v, want empty", c.AllowedUserIDs)
	}
}

func TestLoadOverrides(t *testing.T) {
	e := validEnv()
	e["AGENT_MAX_ROUNDS"] = "3"
	e["LOG_LEVEL"] = "debug"
	e["TELEGRAM_ALLOWED_USER_IDS"] = " 42, 7 ,"
	e["LLM_BASE_URL"] = "http://localhost:11434/v1"
	c, err := Load(env(e))
	if err != nil {
		t.Fatal(err)
	}
	if c.MaxRounds != 3 || c.LogLevel != slog.LevelDebug || c.LLMBaseURL != "http://localhost:11434/v1" {
		t.Errorf("got %+v", c)
	}
	if len(c.AllowedUserIDs) != 2 || c.AllowedUserIDs[0] != 42 || c.AllowedUserIDs[1] != 7 {
		t.Errorf("AllowedUserIDs = %v", c.AllowedUserIDs)
	}
}

func TestLoadFailsFast(t *testing.T) {
	tests := map[string]struct {
		env  map[string]string
		want []string
	}{
		"all required missing": {map[string]string{}, []string{"TELEGRAM_BOT_TOKEN", "LLM_API_KEY", "LLM_MODEL"}},
		"bad max rounds":       {with(validEnv(), "AGENT_MAX_ROUNDS", "0"), []string{"AGENT_MAX_ROUNDS"}},
		"bad user id":          {with(validEnv(), "TELEGRAM_ALLOWED_USER_IDS", "42,abc"), []string{"abc"}},
		"bad log level":        {with(validEnv(), "LOG_LEVEL", "loud"), []string{"LOG_LEVEL"}},
	}
	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			_, err := Load(env(tt.env))
			if err == nil {
				t.Fatal("want error")
			}
			for _, w := range tt.want {
				if !strings.Contains(err.Error(), w) {
					t.Errorf("error %q does not mention %s", err, w)
				}
			}
		})
	}
}

func TestStringHidesSecrets(t *testing.T) {
	c, err := Load(env(validEnv()))
	if err != nil {
		t.Fatal(err)
	}
	s := c.String()
	for _, secret := range c.Secrets() {
		if strings.Contains(s, secret) {
			t.Errorf("String() leaks %q: %s", secret, s)
		}
	}
}

func with(m map[string]string, k, v string) map[string]string {
	m[k] = v
	return m
}
