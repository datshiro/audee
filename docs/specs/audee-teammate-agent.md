---
title: audee teammate agent
status: in-progress
last_verified: 2026-10-20
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

## Cutover
- 2026-10-19 09:32: Ciel stopped (`com.ciel.agent` booted out, nothing left in `~/.ciel/processing`, no Ciel jobs or reruns) and audee switched to live mode (`shadow: false`). The shadow gate was not met: Ciel had been idle since 2026-10-16 19:03, so no message was compared on the 4.8 classifier; the owner chose to cut over anyway. Rollback drill not yet run.
- Same day: 8 teammates in `people` with `review`, `kb_query`, `code_mapping`; chat `19:46246f3b…@thread.v2` added (3 allowed chats).
- 2026-10-19 11:29: the Teams-triggered Power Automate flow stopped delivering. Saving a flow with the "When a new message is added to a chat or channel" trigger failed with `Forbidden ... has reached its limit of '5' 'CHATS/<chat>/MESSAGES' subscription`: Graph allows a user 5 subscriptions per chat, and every save or turn-on registers one, so repeated saves and toggles had used them up. Waiting about two hours did not free them. No messages arrived from 11:13 to 21:27.
- Replacement (live since 2026-10-19 21:27): the flow "Ciel Teams Inbox Poller" polls instead of subscribing, so the limit does not apply. Every minute it loops over the 3 allowed chats, calls the Teams action "Send a Microsoft Graph HTTP request" with `GET https://graph.microsoft.com/v1.0/me/chats/<chat>/messages?$top=50&$orderby=createdDateTime desc` (this connector accepts only paths starting with `teams`, `me` or `users`, so `/chats/...` is rejected), keeps the messages created from 2 minutes to 1 minute before the run's scheduled time, and writes each one to `/Ciel/inbox/<message id>-<sender id>.json` as `{version: 1, chatId, meId, message}`. Messages reach audee 1 to 2 minutes after they are posted. A message delivered twice is harmless (audee skips seen message ids). Adding an allowed chat now means adding its id to the flow's chat list as well as to `channels.teams.chats`. The old flows "Ciel Listen On BE Quick Chat" and "Inbox" stay off.
- Review that posts nothing (departure from Ciel, which told only the owner): with `post_findings: true` the session leaves one short comment on the MR saying why, and the requester gets a chat reply with the reason (hidden if it looks like a secret, links defanged, capped at 300 characters).

## kb_query answers
Departure from Ciel: the model writes the answer in Markdown and a `done` answer is sent as an HTML page through the
outbox file flow (`kb-answer-<message id>-<yyyymmdd-hhmmss>.html` in OneDrive `/Ciel/files`); the chat gets a one-line
notice and the share link. The page is rendered with markdown-it with raw HTML, links and images off, links in the
text defanged, and a CSP that allows only inline styles; the secret check reads both the Markdown and the rendered text. `need_input`,
withheld and failed answers, and mcp_read answers, stay chat replies.
Verified live 2026-10-19: the page opens from the OneDrive link and displays correctly. The outbox flow ("Send message
when ask for review code") had been saving only the file name as the file's content, likely since Ciel (the file path
was used only for oversized code mappings); its "Create file" step now writes `file.content`.
The chat notice also carries `Về: <topic>`, a summary of the question of at most 20 words that the session returns in
its `topic` field. When the topic is missing or too long, the notice falls back to the question clipped to 20 words.
The topic passes the same secret check as the answer.

## Review status and auto-approve
The review session ends with `REVIEW_STATUS: ready|blocked|unreviewable: <reason>` on the line right before the final
`REVIEW_POSTED` line. A status anywhere else, an unknown status, or `ready` with nothing posted counts as
`unreviewable`. `ready` means the apo-review-mr skill judged the MR clean (`clean: true`). The chat reply uses one of
four templates: `✅ MR sẵn sàng merge, mình đã approve`, `✅ MR sẵn sàng merge, chờ Đạt approve: <why>`,
`⛔ MR chưa merge được: <reason>`, and `⚠️ Chưa đánh giá được MR: <reason>`. The session never approves:
`mcp__gitlab__approve_mr` stays in the review fence.
With `review.auto_approve: true` (default false), audee itself approves a ready MR under the owner's GitLab account,
calling `get_mr`, `list_mr_discussions` and `approve_mr` through glab-mcp 1.6.0 or later over MCP stdio, so the token
stays in that process. It approves only when all of these hold:
- the head did not move between the fetches before and after the session, and the MR is still open;
- the owner's PASS acknowledgement for that head is on the MR;
- the requester has `people[].gitlab` and is not the author;
- the owner has `people[].gitlab` and is not the author;
- GitLab says the owner can approve and has not approved yet.
The approve call carries the reviewed head SHA, so GitLab refuses it if the MR moved. Any GitLab error means no
approval. This is an exception to the No-Self-Approval invariant, accepted by the owner: a review session judges the
MR and audee approves under the owner's name. A review already running keeps the config it started with, so turning
the flag off does not stop it.
Validation: unit tests only; live check pending.

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
