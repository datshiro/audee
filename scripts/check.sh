#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== go vet"
go vet ./...

echo "== go test"
go test ./...

echo "== license grep"
status=0
git grep -n "Anthropic, PBC" -- . ':!docs/' ':!scripts/check.sh' || status=$?
case $status in
  0) echo "license check failed: Anthropic-copyrighted text found" >&2; exit 1 ;;
  1) echo "ok" ;;
  *) echo "license check could not run (is this a git repo?)" >&2; exit 1 ;;
esac
