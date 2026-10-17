package logging

import (
	"bytes"
	"io"
	"log/slog"
)

const Redacted = "[REDACTED]"

// New returns a JSON logger that replaces every secret value with [REDACTED].
// Redaction runs on the encoded record, so it also covers error strings,
// nested groups, and URLs that embed a secret (such as /bot<token>/).
func New(w io.Writer, level slog.Leveler, secrets ...string) *slog.Logger {
	return slog.New(slog.NewJSONHandler(NewRedactingWriter(w, secrets...), &slog.HandlerOptions{Level: level}))
}

type redactingWriter struct {
	w       io.Writer
	secrets [][]byte
}

// NewRedactingWriter wraps w so every Write has the secrets replaced.
// It relies on each Write carrying a whole record, which slog handlers do.
func NewRedactingWriter(w io.Writer, secrets ...string) io.Writer {
	rw := &redactingWriter{w: w}
	for _, s := range secrets {
		if s != "" {
			rw.secrets = append(rw.secrets, []byte(s))
		}
	}
	return rw
}

func (rw *redactingWriter) Write(p []byte) (int, error) {
	out := p
	for _, s := range rw.secrets {
		out = bytes.ReplaceAll(out, s, []byte(Redacted))
	}
	if _, err := rw.w.Write(out); err != nil {
		return 0, err
	}
	return len(p), nil
}
