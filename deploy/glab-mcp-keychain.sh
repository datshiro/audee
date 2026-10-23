#!/bin/sh
# audee's gitlab MCP server (mcp_servers.gitlab): reads the token from the Keychain item named by $1, so it lives
# only in this server's env and never on the claude process's argv.
GITLAB_PAT=$(/usr/bin/security find-generic-password -a "$(id -un)" -s "$1" -w) || exit 1
export GITLAB_PAT
exec /opt/homebrew/bin/glab-mcp
