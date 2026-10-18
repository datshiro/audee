# Dashboard design

The admin dashboard (`web/`) is a private operator console: calm, dense, trustworthy. Clarity beats decoration.

## Tokens
All colors are CSS variables in `web/src/styles.css`, defined three times: light (`:root`), dark by system preference
(`@media (prefers-color-scheme: dark)` unless `data-theme="light"`), and dark by choice (`[data-theme="dark"]`). Change
all three together.
- Surfaces: `--bg`, `--surface`, `--surface-sunken`, `--border`, `--border-strong`.
- Text: `--text`, `--text-muted`, `--text-subtle` (at least 4.5:1 on `--surface` in both themes).
- Meaning: `--accent` (actions), `--ok`, `--warn`, `--danger`, `--info`, each with a `-soft` background for chips.
- Charts: `--series-1` (runs), `--series-2` (classified), `--series-fail` (failures), `--grid`.
- Type: system sans for UI, `--font-mono` for ids, kinds, MR paths and numbers.
- Motion: `--dur` 160ms with `--ease-out`; dialogs pop, drawers slide. `prefers-reduced-motion` turns animation off.

## Layout
- Sidebar navigation from `md` (768px); below it a top bar with a menu sheet.
- Tables (`record-table.tsx`) show as tables from `lg` (1024px) and as cards below it.
- No horizontal page scroll at 320px and up.
- Touch (`pointer: coarse`): targets at least 44px, switches 44×28.

## Patterns
- Status chips: green done/posted/classified, amber cancelled/warnings, red failed, blue started.
- Destructive or costly actions (stop, remove, retry, save & reload) always confirm first and say what it costs.
- Config edits collect in the pending bar (Validate / Discard / Save & reload); server `problems` show inline.
- Every view has loading, empty and error states.
- The page is never indexed (`robots: noindex, nofollow`) and makes no request outside `127.0.0.1`.
