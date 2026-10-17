package openai

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const testKey = "sk-test-SECRET-123"

func TestPost_SendsAuthAndBody(t *testing.T) {
	var gotPath, gotAuth, gotType, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotPath, gotAuth, gotType, gotBody = r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("Content-Type"), string(b)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	c := New(srv.URL+"/v1/", testKey, "m", 0)
	raw, err := c.post(t.Context(), []byte(`{"x":1}`))
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != `{"ok":true}` {
		t.Errorf("raw = %s", raw)
	}
	if gotPath != "/v1/chat/completions" || gotAuth != "Bearer "+testKey || gotType != "application/json" || gotBody != `{"x":1}` {
		t.Errorf("path=%q auth=%q type=%q body=%q", gotPath, gotAuth, gotType, gotBody)
	}
}

func TestPost_ErrorMapping(t *testing.T) {
	tests := []struct {
		name       string
		status     int
		body       string
		wantInErr  []string
		maxBodyLen int
	}{
		{
			name:      "401 echoing the key",
			status:    http.StatusUnauthorized,
			body:      `{"error":{"message":"Incorrect API key provided: ` + testKey + `"}}`,
			wantInErr: []string{"401", "Incorrect API key provided", "[REDACTED]"},
		},
		{
			name:      "400 unanswered tool call",
			status:    http.StatusBadRequest,
			body:      `{"error":{"message":"tool_call_ids did not have response messages: call_1"}}`,
			wantInErr: []string{"400", "call_1"},
		},
		{
			name:       "huge 500 body is truncated",
			status:     http.StatusInternalServerError,
			body:       strings.Repeat("x", 10_000),
			wantInErr:  []string{"500"},
			maxBodyLen: maxErrorExcerpt + len("…"),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("X-Echo-Auth", r.Header.Get("Authorization"))
				w.WriteHeader(tt.status)
				_, _ = w.Write([]byte(tt.body))
			}))
			defer srv.Close()

			_, err := New(srv.URL, testKey, "m", 0).post(t.Context(), []byte(`{}`))
			var apiErr *APIError
			if !errors.As(err, &apiErr) || apiErr.StatusCode != tt.status {
				t.Fatalf("err = %v, want *APIError with status %d", err, tt.status)
			}
			if strings.Contains(err.Error(), testKey) {
				t.Errorf("error leaks the API key: %v", err)
			}
			for _, w := range tt.wantInErr {
				if !strings.Contains(err.Error(), w) {
					t.Errorf("error %q does not contain %q", err, w)
				}
			}
			if tt.maxBodyLen > 0 && len(apiErr.Body) > tt.maxBodyLen {
				t.Errorf("body excerpt is %d bytes, want at most %d", len(apiErr.Body), tt.maxBodyLen)
			}
		})
	}
}

func TestPost_Timeout(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
	}))
	defer srv.Close()
	defer close(release)

	start := time.Now()
	_, err := New(srv.URL, testKey, "m", 50*time.Millisecond).post(t.Context(), []byte(`{}`))
	if err == nil {
		t.Fatal("want a timeout error")
	}
	if time.Since(start) > 2*time.Second {
		t.Errorf("timeout took %v", time.Since(start))
	}
	if strings.Contains(err.Error(), testKey) {
		t.Errorf("error leaks the API key: %v", err)
	}
}

func TestPost_NetworkErrorHasNoKey(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()

	_, err := New(url, testKey, "m", time.Second).post(t.Context(), []byte(`{}`))
	if err == nil {
		t.Fatal("want a connection error")
	}
	if strings.Contains(err.Error(), testKey) {
		t.Errorf("error leaks the API key: %v", err)
	}
}
