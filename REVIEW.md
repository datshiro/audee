# Review checklist

## Every change
- `pnpm check` passes (typecheck and unit tests).
- Fences: no change widens what a session may do (`src/fence/`, config RULES in `src/config/load.ts`). A new config key
  defaults so existing `config.yaml` files still load (the root schema is strict).
- No message text, reply text or secret goes into `events.jsonl`, logs, notifications or API responses.

## Admin API (`src/admin/`)
- Every `/api/*` route stays behind the bearer token and the Host check; static files stay inside `web/dist`.
- A config write goes through `checkCandidate` (schema, fence rules, doctor, restart-only keys, saved jobs) before it touches the file.
- `api-types.ts` changes are matched in `web/` (it imports the types, so `pnpm build:web` catches drift).

## Dashboard UI (`web/`)
- `pnpm build:web` passes.
- Screenshots at 1440, 768, 375 and 320px wide, light and dark, for each page touched: no horizontal scroll, nothing clipped.
- Touch targets at least 44px under `pointer: coarse`; visible keyboard focus; dialogs labelled.
- New colors are tokens in all three theme blocks (see `DESIGN.md`).
- `index.html` keeps `robots: noindex, nofollow`; no external fonts, scripts or requests.
