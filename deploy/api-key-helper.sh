#!/bin/sh
# Claude Code calls this (settings.apiKeyHelper) to get the API key; the key never sits in the session env.
exec /usr/bin/security find-generic-password -a "$(id -un)" -s "$1" -w
