# Notes for coding agents (Codex, Claude Code)

- **Current focus: the Norte Fire (south Orange County, 2026-10-16).** Read `docs/norte-fire.md` before starting any task. It defines the area of interest, the data sources and the module each person owns. The earlier Eaton setup is kept for compatibility but is no longer the demo.
- Ownership: A Qinchuan owns `web/`, B Tia owns `server/` and `data-pipeline/`, and C Lucia owns `packages/core/` and `analysis/`. The frozen interface contracts are in `docs/team-plan.md`; change them only by agreement.
- Grid convention: 512 × 512, 25 m, EPSG:32611, `cell = row * width + col`, row 0 north. Wind fields are row-major from north to south.
- Raw public data for Norte is archived in `data/norte/raw/`. Do not edit those files; write derived data elsewhere.
- Never commit keys (`.env` only) or resident personal data. Model alerts are not official evacuation orders.
