---
title: audee teammate agent
status: in-progress
last_verified: 2026-10-18
claude_code_version: 2.1.302
---
# audee teammate agent
## Fence baseline
Ciel TestLiveKBQueryFence on 2.1.302: PASS. Team-seat headless run: PASS (on both `~/.claude` and `~/.claude-hack`).
SDK probe on 2.1.302 (Agent SDK 0.3.302): PASS. Auth source: `apiKeySource: none` (Team-seat OAuth). The session env must carry `USER`; with only `PATH` and `HOME` the bundled CLI cannot find its Keychain login ("Not logged in"). PreToolUse hook saw `Read`, `StructuredOutput`; the structured-output tool is named `StructuredOutput`.
Bundled Claude Code (SDK `manifest.json`): 2.1.302. `claude --version` (Homebrew): 2.1.302. Production uses the bundled binary.
Live fence tests on bundled Claude Code 2.1.302 (Agent SDK 0.3.302), 2026-10-17:
- kb_query fence: PASS (four planted secret files denied, outside path refused by `--restricted`, wiki inbox/people denied, `kb_search` unavailable, `config.go` readable; no planted value in the chat output or in any denied-path tool result).
- kb_query answer: PASS (structured output through the PreToolUse gate).
- review fence: PASS (merge/approve/ship never offered; `git push`, `printenv`, `security`, `sh -c` refused; `~/.claude.json` and `~/.ssh` reads refused) on the real gitlab and kb servers.
- code_mapping fence: PASS (`cat /etc/hosts`, a non-pinned probe `--ref`, `~/.ssh/config` refused).
- mcp_read (Grafana) fence: PASS; `search_dashboards`, `get_dashboard_by_uid`, `query_prometheus`, `query_loki_logs` exist on the live server; no write or built-in tool used.
- API key guard: SKIP (no `audee-anthropic` Keychain item). `apiKeyGuard` stays unset, so `doctor` keeps Bash-capable teammates disabled.
## Shadow run
Started 2026-10-17 under launchd (`com.audee.agent`, shadow mode, owner only, one allowed chat), beside Ciel. `audee doctor` passed in the launchd environment; `audee doctor --probe` passed (owner session on the Team seat, $0.016). First shadow classify event recorded; Ciel's handled files untouched (131 before and after). The daemon runs `~/personal/audee/dist/cli.js` from this checkout: never delete `dist/` or switch branches here while it runs (KeepAlive would relaunch it into a failure every few seconds); after a deliberate rebuild run `launchctl kickstart -k gui/$(id -u)/com.audee.agent`. Daily `audee shadow-report` output is appended below until day 5 (target: agreement at least 95% over at least 30 compared messages).
- Day 1 (2026-10-17): compared 2, agreement 2/2 (100.0%), would be denied 2 (colleagues not yet in `people`).
- 2026-10-17: second chat `19:842a44d4…@thread.v2` added to the allowlist (daemon restarted); it is compared from new messages on.
- 2026-10-17, after reprocessing that chat's 106 kept messages (shadow-seen marks cleared; state backed up to `~/.audee/state.json.bak-261017`): compared 16, agreement 16/16 (100.0%), would be denied 16 (colleagues not yet in `people`).
- 2026-10-18: classifier moved to `claude-opus-4-8` on the LiteLLM gateway (`classifier.auth: api_key`, `auth.base_url`); capability work stays on the owner's login, and teammates will use it too (`auth.teammates: subscription`, reversing plan decision 5). Comparisons from here on measure the 4.8 classifier.
- Day 2 (2026-10-18, 09:09): compared 21, agreement 21/21 (100.0%), would be denied 21. All 21 were classified before the gateway switch (Opus 5.5 on the owner's login); no message has been classified on the gateway yet.

## kb_query answers
Departure from Ciel: the model writes the answer in Markdown and a `done` answer is sent as an HTML page through the
outbox file flow (`kb-answer-<message id>-<yyyymmdd-hhmmss>.html` in OneDrive `/Ciel/files`); the chat gets a one-line
notice and the share link. The page is rendered with markdown-it with raw HTML, links and images off, links in the
text defanged, and a CSP that allows only inline styles; the secret check runs before rendering. `need_input`,
withheld and failed answers, and mcp_read answers, stay chat replies.

## Dashboard
`audee serve` also serves an admin web UI and API on `127.0.0.1:<admin.port>` (default 7420); `audee dashboard` prints the
sign-in link (the token, kept in `<data_dir>/admin-token`, rides in the URL fragment). Build the UI with `pnpm build:web`
(output `web/dist`, not committed). Every API call needs the bearer token and a `127.0.0.1`/`localhost` Host header.
- Monitor: overview (mode, queue, cost, failures, 14-day activity, per capability and per person), event history and the message trail, with filters and search.
- Control: stop a running job or remove a queued one (the requester gets the failure reply; a `cancelled` event is written), retry a recorded request (not in shadow mode), pause/resume the queue (persisted in state.json).
- Configure: capabilities (on/off via `enabled`, model, budget, timeout, lane, MCP tools limited to the read-only list), people and grants, classifier, auth, concurrency, Teams settings. An edit is applied to config.yaml with its comments kept, must pass the schema, the fence rules and doctor, is backed up as `config.yaml.bak-<yymmdd-hhmmss>`, and then reloads the daemon in place: running sessions are interrupted and resume from the start. A reload that fails keeps the previous config and shows the error. `data_dir` changes need a restart.
- Verified 2026-10-18 against a sandbox copy of the data dir (port 7421): overview, retry/remove with a paused queue, capability toggle saved and reloaded, phone width, dark theme. Independent review: no critical findings and the security boundary held. The four medium findings were fixed (cancelling a queued job, the checks a reload runs, the restart-cost wording, protecting saved jobs). Still open: a shutdown that races an in-flight reload resets the connection; a cancelled job's Teams reply says "failed"; config backups are never pruned; nothing detects two tabs editing at once.

## Architecture
(written in phase 14)
