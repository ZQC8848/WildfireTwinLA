# WildfireTwinLA pitch: evidence and source checklist

Every claim on the slides, with its status and where it comes from.

**Status values:**
- **working**: runs in the current app.
- **replay**: public data from Oct 16, 2026, played back.
- **simulated**: the demo dispatcher's mock outcomes.
- **modelled**: GPU fire simulation output.
- **planned**: not built.
- **external**: a third-party source.

App screenshots are in `assets/app/`; web screenshots are in `assets/web/`.

**Capture conditions:**
- App: repository main `0bcd533`, Vite on localhost:5173, backend on localhost:8010.
- Respond-mode shots: headless Chrome with software rendering, contact dispatcher at demo speed ×4 (its line header reads "demo ×4").
- Plan comparison: run on the Mac's GPU (Apple M5 Max, Metal).
- All times are PDT, Oct 17, 2026.

| Slide | Claim on slide | Status | Evidence |
|---|---|---|---|
| 1 | Cards: "Confirmed safe", "No answer, retry later", "Asked for help" | simulated | `P1-confirmed.png`, `P1-missed.png`, `P1-help.png`; mock outcomes in `server/app/dispatch.py` (`_run_call`) |
| 1 | Voice lines matter (notes only) | external | CAL FIRE Norte page lists a "Public Information Hotline" (W1, read 19:11) |
| 2 | Norte replay screenshot, T + 2 h 15 m | replay | `P2a-replay-overview.png`; data in `server/data/norte-replay.jsonl` (NIFC ignition, FIRMS VIIRS, HRRR) |
| 2 | Norte 570 ac, 25% contained; Bryson 146 ac, 61%; Peak 43 ac, 41% | external | CAL FIRE incident pages, read 19:10–19:19 (`W1`–`W3`). Last updated: Norte 7:11 PM, Bryson 6:23 PM, Peak 8:55 AM. All three pages say "Not a CAL FIRE Incident" (lead agencies: OCFA, LA County Fire, USFS) |
| 2 | News clipping | external | CBS Los Angeles, "Norte Fire burning near San Juan Capistrano prompts evacuation orders as flames threaten homes", updated Oct 16, 2026, 9:32 PM PDT (`W4-news-norte-1.png`). Backup: KTLA (`W4-news-norte-2.png`) |
| 2 | Bryson and Peak are not shown in the app | working (verified) | `web/src/data/norte.ts` holds only the NORTE and MIRADA ignitions |
| 3 | Counts "23 of 6,219 calls done" etc. | simulated | `P3-progress.png` |
| 3 | Retell voice delivery | planned | Code path exists in `server/app/retell.py`, but it is gated by `WILDFIRE_DISPATCH_REAL_CALLS` plus a consented resident, and has never been configured or run |
| 4 | Queue ranked by estimated fire arrival; access needs move up 5 min | simulated (logic working) | `server/app/dispatch.py` `update_fire` and `priority`; `P3-queue-top5.png` |
| 4 | Distance reference: nearest simulated burning cell; the simulation is seeded from reported ignitions and VIIRS hotspots | working | `web/src/main.ts` (posts `sim.burningSample` every 1.5 s); `web/src/realtime/controller.ts` (`igniteDisc`) |
| 4 | Roof markers per home | working | `P4-calling-closeup.png`; `web/src/scene/contactMarkers.ts` |
| 5 | Plan mode with a drawn fuel break (15.6 ha, $25k) | working | `P6-plan-break.png`; `?paint=265,267,275,306,break,3` |
| 6 | 419 vs 422 buildings reached; greedy 389 ($52k); noise ±58; "≈ 0" | modelled | `P7c-compare-table.png`, `P7-full.png`. 5 GPU runs per plan, 8 h, ENE 8.5 m/s |
| 6 | Test fire at the Norte ignition point | modelled | A small disc of burnable cells around grid cell (294, 280), seeded through `planner.d.ignitions()`. The default Plan scenario ignites a single unburnable cell and returns 0 for every plan (app bug, see below) |
| 7 | 50,408 OSM buildings; USGS 3DEP; LANDFIRE FBFM40; Sentinel-2 imagery from Oct 14, 2026 | working | `web/public/data/` (grid.json, buildings.json); Plan "This area" panel |
| 7 | Live FIRMS/GOES pollers built, not configured | working code / not configured | `server/app/config.py` (`enable_pollers=False`); no `WILDFIRE_FIRMS_MAP_KEY` |
| 7 | Archived HRRR wind; WindNinja library | replay / working | `data/norte/raw/hrrr_5x5_2026-10-15_17.json`; `web/public/data/wind/index.json` |
| 7 | Fictional contacts, (949) 555-01xx | working | `server/app/households.py` (NANP fiction range; masking in `public()`) |
| 7 | Community areas approximate; replay orders "as reported by CBS LA and KTLA", times approximate | replay | `data/norte/communities-approx.geojson`; `norte-replay.jsonl` (`timeApproximate`) |
| 8 | Twist 1: USDA Forest Service Community Wildfire Defense Grant (CWDG) funds CWPPs (up to $250k) and projects | external | fs.usda.gov/managing-land/fire/grants/cwdg and /how-to-apply (read 19:14–19:15). Round 4 not yet posted (Grants.gov, 19:18) |
| 8 | Twist 1: NSF SBIR/STTR reauthorized through Sept 30, 2031; pitches accepted anytime | external | SBA release of Apr 13, 2026; seedfund.nsf.gov (read 19:13–19:18) |
| 8 | Twist 2: FIRMS, Sentinel-2 and Copernicus GLO-30 are global; LANDFIRE and HRRR are US-only; OSM is sparse in many regions; Retell supports zh-CN | external | firms.modaps.eosdis.nasa.gov; sentiwiki.copernicus.eu; dataspace.copernicus.eu; landfire.gov; nco.ncep.noaa.gov (HRRR covers CONUS and Alaska); Herfort et al., Nature Communications 2023; docs.retellai.com/build/language-support (read 19:18–19:21) |
| 9 | Retry once after 3 min; the household's text then moves up the queue | simulated | `dispatch.py` `_no_answer` (`RETRY_AFTER_S = 180`); `P1-missed.png`, `P10-retry-row.png` |
| 9 | Reply/acknowledgement capture | planned | No SMS reply handling exists; SMS is mock only |
| 9 | Data-age indicator | planned | No age or staleness display in the UI |
| 10 | Repository QR code | working | https://github.com/ZQC8848/WildfireTwinLA (public) |

## Gaps against the brief

- **Slide 4:** the queue shows estimated arrival, not distance. This is option A, chosen by the team; no app code was changed.
- **Slide 6:** the brief wanted side-by-side outcome maps. The deck shows the measured comparison table and the Plan-mode screen instead.
- **No embedded backup video.** Record one with QuickTime on a real GPU, then insert it from Drive after the Google Slides import.
- **Bug for the live demo:** with no test fire placed, Plan's "Suggest plans and compare" returns 0 homes and 0 ha, because the default Norte scenario ignites a single unburnable cell. Before demoing, click a hillside to place a test fire, or fix the code (not done; this deck task did not authorize code changes).
