#!/bin/sh
echo $$ > "$FAKE_CLAUDE_PID_OUT"
exec sleep 30
