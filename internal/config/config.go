package config

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"

	"github.com/datshiro/audee/internal/agent"
)

const DefaultBaseURL = "https://api.openai.com/v1"

type Config struct {
	TelegramBotToken string
	AllowedUserIDs   []int64
	LLMBaseURL       string
	LLMAPIKey        string
	LLMModel         string
	MaxRounds        int
	LogLevel         slog.Level
}

// FromEnv reads the configuration from the process environment.
func FromEnv() (Config, error) {
	return Load(os.Getenv)
}

// Load reads the configuration through getenv and reports every problem at once.
func Load(getenv func(string) string) (Config, error) {
	var errs []error
	required := func(name string) string {
		v := strings.TrimSpace(getenv(name))
		if v == "" {
			errs = append(errs, fmt.Errorf("%s is required", name))
		}
		return v
	}

	c := Config{
		TelegramBotToken: required("TELEGRAM_BOT_TOKEN"),
		LLMBaseURL:       strings.TrimSpace(getenv("LLM_BASE_URL")),
		LLMAPIKey:        required("LLM_API_KEY"),
		LLMModel:         required("LLM_MODEL"),
		MaxRounds:        agent.DefaultMaxRounds,
	}
	if c.LLMBaseURL == "" {
		c.LLMBaseURL = DefaultBaseURL
	}

	for _, s := range strings.Split(getenv("TELEGRAM_ALLOWED_USER_IDS"), ",") {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		id, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			errs = append(errs, fmt.Errorf("TELEGRAM_ALLOWED_USER_IDS: %q is not a numeric user ID", s))
			continue
		}
		c.AllowedUserIDs = append(c.AllowedUserIDs, id)
	}

	if v := strings.TrimSpace(getenv("AGENT_MAX_ROUNDS")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			errs = append(errs, fmt.Errorf("AGENT_MAX_ROUNDS: %q must be a positive integer", v))
		} else {
			c.MaxRounds = n
		}
	}

	if v := strings.TrimSpace(getenv("LOG_LEVEL")); v != "" {
		if err := c.LogLevel.UnmarshalText([]byte(v)); err != nil {
			errs = append(errs, fmt.Errorf("LOG_LEVEL: %q must be debug, info, warn or error", v))
		}
	}

	return c, errors.Join(errs...)
}

// Secrets returns the values that must never reach a log line.
func (c Config) Secrets() []string {
	return []string{c.TelegramBotToken, c.LLMAPIKey}
}

// String is safe to log: it never includes secret values.
func (c Config) String() string {
	return fmt.Sprintf("llm_base_url=%s llm_model=%s max_rounds=%d allowed_users=%d log_level=%s telegram_bot_token=%s llm_api_key=%s",
		c.LLMBaseURL, c.LLMModel, c.MaxRounds, len(c.AllowedUserIDs), c.LogLevel, mask(c.TelegramBotToken), mask(c.LLMAPIKey))
}

func mask(secret string) string {
	if secret == "" {
		return "unset"
	}
	return "set"
}
