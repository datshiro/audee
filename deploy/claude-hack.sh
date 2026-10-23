#!/bin/sh
# Subscription sessions run Claude Code on the claude-hack config dir (its login and settings).
CLAUDE_CONFIG_DIR="$HOME/.claude-hack" exec claude "$@"
