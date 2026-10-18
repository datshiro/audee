#!/bin/sh
# A CLI that prints its own argv (MCP config included) to stderr, then fails.
echo "fatal: bad args: $*" >&2
exit 2
