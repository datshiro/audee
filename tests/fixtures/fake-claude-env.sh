#!/bin/sh
# Records argv (one per line) and the environment it was spawned with, then fails: for runner tests.
printf '%s\n' "$@" > "$FAKE_CLAUDE_ARGV_OUT"
env > "$FAKE_CLAUDE_ENV_OUT"
exit 1
