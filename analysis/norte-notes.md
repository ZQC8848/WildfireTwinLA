# Norte Fire analysis — issue #17

The scripts implement C1–C4 without changing shared production parameters, frozen types, raw inputs, or A/B-owned code. **Incident validation remains blocked on the B1 terrain/fuel grid, B2 approximate communities and B6 damage annotations.** Main at `06eeae8` has none of those generated files. The committed calibration and plan reports deliberately exercise a geographically relocated **synthetic** 128² grid covering 12.8 km; they are not measured Norte performance or verified UI results.

## Reproduce

Node >=22.18 and the frontend dependencies are required. From the repository root:

```sh
npm --prefix web ci
node --experimental-transform-types --import ./analysis/ca-loader.mjs --test analysis/norte.test.ts
node --experimental-transform-types --import ./analysis/ca-loader.mjs analysis/norte-validation.ts
node --experimental-transform-types --import ./analysis/ca-loader.mjs analysis/norte-spotting.ts
node --experimental-transform-types --import ./analysis/ca-loader.mjs analysis/norte-plan.ts
# Optional Chromium / production WebGL audit (run AFTER generating spotting JSON):
node analysis/run-norte-gpu.mjs
```

The GPU runner uses installed Chromium (`CHROMIUM_BIN` can override its path), Vite on local port 5178 and CDP on local port 9228. Those ports must be free. It creates an isolated temporary profile, polls for actual completed results, checks seed counts, and stops only its own browser/server. SwiftShader executes the real production GLSL in software; this is not physical GPU performance validation. Regenerating `norte-spotting.json` resets the GPU section to unrun until the GPU runner is rerun.

When B1/B2 land, rerun C1 and C3 with an explicit input directory containing `grid.json`, `grid.bin`, `buildings.json`, and `communities.json`:

```sh
node --experimental-transform-types --import ./analysis/ca-loader.mjs analysis/norte-validation.ts web/public/data
node --experimental-transform-types --import ./analysis/ca-loader.mjs analysis/norte-plan.ts web/public/data
```

Without an argument, the scripts use `web/public/data` only if generated inputs exist, otherwise label mock output as blocked. An explicit incomplete directory fails instead of silently falling back. Norte must map to a burnable cell; no ignition is relocated to force a result.

## C1: chronological calibration

`norte-validation.json` contains all 60 selected VIIRS observations, per-pixel coordinates and arrival/error values, exclusion counts, training candidates and held-out metrics. No held-out detections or MIRADA ignition are assimilated. Train: 20:08 and 20:44 UTC (13:08 and 13:44 PDT); test: 21:04 and 21:48 UTC. The archived discovery time is used exactly: **18:32:56 UTC**. Earlier static/night detections and other passes are excluded; the 750 m landfill filter and out-of-grid counts are explicit.

Hourly centre-point HRRR drives an analysis-only FIFO graph: each edge accumulates expected progress across hourly boundaries rather than using the ignition-hour wind for the whole event. The archived 25 points have irregular snapped coordinates and duplicates, so the centre point is safer than treating them as a regular lattice. This graph remains a deterministic proxy with persistent reachable sources, not the stochastic CA. Coarse resolution and the fine reference cell size are recorded.

Scale selection sees **training losses only** and refuses candidates that hide difficult observations as unreachable. Detection times are delayed proxies, so matching them is not ground-truth arrival calibration. The mock fit selects 0.75 and has about 66 min held-out proxy error; **do not deploy that value**. Keep production `arrivalTimeScale=0.35` and `stepMinutes=5` until real-grid/independent validation. Those two parameters multiply one another and cannot both be uniquely estimated from this arrival fit.

## C2: MIRADA and spotting

The reports use the actual reported separation (about 2.48 km) and 46.97-minute delay. A 375 m neighbourhood around MIRADA is tested at 50 min under 8.7 m/s from 75°.

- The current transport kernel gives about **0.00017 per sample** of sampling that neighbourhood, and about **0.000225 per sample** of exceeding 2.4 km, in 200,000 deterministic Monte Carlo samples. These are transport probabilities; ignition additionally requires susceptibility, a burning source, and successful ignition.
- The deterministic graph's earliest nearby arrival is about **86.8 min**; its hypothetical MIRADA building exposure proxy at 50 min is zero. The graph samples only 12 representative rays (largest lognormal normal-quantile representative 1.150349), so its per-edge support truncates the rare long tail that the stochastic CA can sample. The graph does not define a probability of any nearby ignition, so that field is null with an explanation rather than an invented probability.
- On controlled flat vegetation, the actual frontend CPU reference reaches the neighbourhood in **6/32 seeds** by 50 min. Headless Chromium with the production `FireSim` GLSL also reaches it in **6/32 seeds**. The 95% Wilson interval is about **8.9–35.3%**; this small experiment is not incident calibration. The expanding burning front creates many possible sources, unlike the single-source kernel audit. This shows a rare single-sample jump need not imply an impossible event.

The analysis-only proposal ramps a long-range mixture from zero at 5 m/s to 2% at 10 m/s, with a 4× mean and sigma=1.0 for that component. The 3 m/s distribution is exactly unchanged. Reports audit 3/6/8.7/10 m/s and tails beyond 1/2.4/5 km; this also exposes the increased unwanted long-distance tail. These are controls, **not independent wildfire validation**. Nothing was fitted to MIRADA and nothing is deployed. Since the current stochastic CA can produce this event on the controlled fixture, real fuel/terrain and independent incidents are needed before recommending a heavier tail. Shared `params.ts`/`types.ts` remain unchanged; no team notification or merge was performed.

## C3: planning baseline

`norte-plan-baseline.json` uses NORTE alone, 8.5 m/s from 75°, 480 minutes, factor 4, eight greedy iterations, strip length 5, the shared scale/spotting options, and the UI's five seeds (11,23,37,41,53). Masks are evaluated with the actual CPU reference on the input fine grid; float64 versus WebGL float32 can diverge, so exact UI agreement is **not** claimed. Costs and treatment hectares preserve the UI's coarse area/mask conventions.

The mock run is a pipeline smoke test:

| Budget | Greedy cost | Mean homes protected | Min-cut cost | Min-cut over budget |
|---|---:|---:|---:|---|
| $20k | $19,680 | 2.4 | $51,200 | yes |
| $40k | $32,000 | 0.8 | $51,200 | yes |
| $80k | $32,000 | 0.8 | $51,200 | no |

All greedy differences are within the UI-style noise threshold. The larger budgets do not guarantee a better bounded heuristic plan. Per-seed results, damage area, hectares per treatment, noise, and stopping diagnostics are included. Min-cut is the same unconstrained upwind-wildland baseline as the Worker, not a budget-constrained or ember-proof barrier. SJC04/05 and reported damage protection are explicitly unavailable until B2/B6 metadata arrives; synthetic community names are never substituted for real zones.

## C4: perimeter and error map

Per-observation arrival errors are already included in C1. Final IoU remains pending because no timestamped perimeter/burn scar exists in this checkout. A later B3 export can be passed as the second argument:

```sh
node --experimental-transform-types --import ./analysis/ca-loader.mjs analysis/norte-validation.ts web/public/data /path/to/perimeter.json
```

Perimeter schema: `{ "gridMeta": <exact grid.json metadata>, "source": "WFIGS or identified dNBR product", "t": "ISO UTC timestamp", "cells": [<fine-grid indices>] }`. The script rejects mismatched grids, invalid timestamps/cells and timestamps outside archived wind coverage. It scores the coarse arrival footprint upsampled to the fine grid at that timestamp and labels it as such; it does not call that GPU replay IoU. A final operational/CA replay error map still requires the corresponding real B1/B3 data and runtime validation.
