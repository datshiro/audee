# Agent notes

audee is a Teams agent daemon (`audee serve`) that runs Claude Agent SDK sessions behind permission fences, plus an
admin dashboard served by the same process.

- Source: `src/` (daemon, `src/admin/` for the dashboard API), `web/` (dashboard UI, its own Vite project), `tests/`.
- Checks: `pnpm check`; builds: `pnpm build` (daemon to `dist/`), `pnpm build:web` (UI to `web/dist/`).
- Behaviour and decisions: `docs/specs/audee-teammate-agent.md`. Review checklist: `REVIEW.md`. UI rules: `DESIGN.md`.
- The launchd daemon runs `dist/cli.js` from the main checkout: never delete `dist/` or switch branches there while it
  runs; develop in a worktree. Deploy is a deliberate rebuild plus `launchctl kickstart -k gui/$(id -u)/com.audee.agent`.
- Never put message text, reply text or secrets in events, logs or notifications.
