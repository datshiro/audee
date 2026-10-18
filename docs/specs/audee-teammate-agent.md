---
title: audee teammate agent
status: in-progress
last_verified: 2026-10-17
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
## Architecture
(written in phase 14)
