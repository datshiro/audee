#!/bin/sh
# Records argv (NUL-separated, then a marker line) and the first stdin line (the SDK initialize message), then fails.
{ printf '%s\0' "$@"; printf '\n--END--\n'; } >> "$FAKE_CLAUDE_ARGV_OUT"
if [ -n "$FAKE_CLAUDE_STDIN_OUT" ]; then
  IFS= read -r line && printf '%s\n' "$line" >> "$FAKE_CLAUDE_STDIN_OUT"
fi
exit 1
