// Package openai talks to any OpenAI-compatible chat-completions endpoint
// (OpenAI, OpenRouter, Ollama), non-streaming.
package openai

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/datshiro/audee/internal/agent"
)

const (
	DefaultTimeout  = 60 * time.Second
	maxResponseSize = 8 << 20
	maxErrorExcerpt = 512
)

type Client struct {
	endpoint string
	apiKey   string
	model    string
	http     *http.Client
}

// New builds a client for baseURL (for example https://api.openai.com/v1).
// A zero timeout means DefaultTimeout.
func New(baseURL, apiKey, model string, timeout time.Duration) *Client {
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	return &Client{
		endpoint: strings.TrimRight(baseURL, "/") + "/chat/completions",
		apiKey:   apiKey,
		model:    model,
		http:     &http.Client{Timeout: timeout},
	}
}

func (c *Client) Chat(ctx context.Context, req agent.ChatRequest) (agent.ChatResponse, error) {
	body, err := encodeRequest(c.model, req)
	if err != nil {
		return agent.ChatResponse{}, fmt.Errorf("openai: encode request: %w", err)
	}
	raw, err := c.post(ctx, body)
	if err != nil {
		return agent.ChatResponse{}, err
	}
	msg, err := decodeResponse(raw)
	if err != nil {
		return agent.ChatResponse{}, fmt.Errorf("openai: decode response: %w", err)
	}
	return agent.ChatResponse{Message: msg}, nil
}

// APIError is a non-2xx reply. It carries the status and a body excerpt, never request headers.
type APIError struct {
	StatusCode int
	Body       string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("openai: HTTP %d: %s", e.StatusCode, e.Body)
}

func (c *Client) post(ctx context.Context, body []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("openai: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.apiKey)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("openai: %w", err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseSize))
	if err != nil {
		return nil, fmt.Errorf("openai: read response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, &APIError{StatusCode: resp.StatusCode, Body: c.excerpt(raw)}
	}
	return raw, nil
}

// excerpt trims the body and scrubs the key: some providers echo it back in 401 bodies.
func (c *Client) excerpt(raw []byte) string {
	s := string(raw)
	if c.apiKey != "" {
		s = strings.ReplaceAll(s, c.apiKey, "[REDACTED]")
	}
	s = strings.TrimSpace(s)
	if len(s) > maxErrorExcerpt {
		s = strings.ToValidUTF8(s[:maxErrorExcerpt], "") + "…"
	}
	return s
}
