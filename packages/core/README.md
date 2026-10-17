# Planner handoff — issue #8

This pure TypeScript library now uses the GPU CA's probability coefficients and step duration for planning, considers ember exposure and Zone 0, and searches beyond the former top-24 short strips. The API remains `createCore(...).computeArrival / planTreatments / evaluate / planMinCut`.

## Time scale and spread approximation

`surfaceProbability` matches the CA's fuel/dryness mapping, wind exponent, degree-based slope exponent, diagonal factor, and multiplicative treatment effects (including clamping **after** treatment). Buildings receive embers; they do not receive vegetation surface spread. Diagonal connections now follow the CA rather than an extra CPU corner-blocking rule.

A surface edge costs `stepMinutes / probability × cellSize / referenceCellSize × timeScale`. Thus a 100 m planning cell represents four 25 m CA transitions, not one 5-minute CA transition. `referenceCellSize` defaults to 25 m; change it if A changes the actual GPU resolution. `baseRosMPerMinute` remains as a deprecated compatibility export but no longer controls arrival speed.

The shortest-path graph also samples 12 representative upwind rays in the CA's ±15° ember cone, with lognormal distance quantiles and the CA's wind threshold, sample count and susceptibility. Ember distance remains in **meters** on coarse grids. This restores long-distance downwind paths missing from the old surface-only ROS model. Surface and ember edge costs are cached once per scenario across candidate solves.

These are deterministic planning proxies, not a reproduction of the random CA: shortest-path ember travel assumes an occupied upwind fire band, and it ignores failed/extinguished propagation along a chosen path. Building loss uses a separate quadrature-weighted exposure calculation, with source burning lifetimes, rather than assuming every ray is burning. Zone 0 reduces the per-sample ember susceptibility by the shared `emberMul`. Building risk is a model estimate, not an alert-grade probability.

`PlanningParams.arrivalTimeScale = 0.35` is a **synthetic CA alignment**, not an Eaton fit. The benchmark below fitted a median reference-arrival / proxy-arrival multiplier of 0.3469 using seed 1 only, then evaluated seeds 2–3 separately. All three wind cases use one rounded multiplier. The GPU's `stepMinutes` remains 5; the planner's multiplier maps geometric shortest-path waits to the faster CA front formed by many competing paths. Set `spread: {timeScale:1}` to inspect the raw geometric approximation.

Run from repo root (Node >=22.18; install `web` dependencies first):

```sh
cd web
npm ci
cd ..
node --experimental-transform-types --import ./analysis/ca-loader.mjs analysis/compare-ca.ts 128 3
```

The harness imports A's **actual CPU reference** of the CA, including PCG/ember rules. It compares identical synthetic grid, wind and ignition inputs at fine and 4× coarse resolutions, and emits a suggested global multiplier. It does not run WebGL. Snapshot: `analysis/planner-ca-comparison.json`.

| Wind from 30° | Reference CA mean arrival (min) | Coarse planner mean arrival (min) |
|---|---:|---:|
| 3 m/s | 309.9 | 371.6 |
| 6 m/s | 231.6 | 193.5 |
| 10 m/s | 200.5 | 137.2 |

Held-out error after fitting is about 66.3 minutes on 1,054 paired home detections. Statistics condition on homes reached within the 8-hour CA run; unreached homes are not evidence of accurate timing. Detections are correlated and fine/coarse representations differ. Re-fit and validate against actual full-resolution incident inputs before claiming timing accuracy. Keep GPU ensemble evaluation as the final plan comparison.

## Greedy search and stopping

- Ranks risk-weighted path flow across every scenario; screens at least 96 centers, mixing high-flow centers with spatial coverage.
- Tries short and longer perpendicular strips (default 5, 11 and 21 coarse cells), each scenario's path direction, plus individual and bundled Zone 0 building cells.
- Reserves exact evaluations for both land treatment and hardening. The first diverse batch defaults to 24 candidates; if none helps, searches up to 72 additional candidates before stopping. Adjust `candidateLimit` for responsiveness/coverage.
- Recomputes path flow after every accepted plan addition. Scenario graphs/edge costs are reused; homes sharing a coarse cell are aggregated for scoring.
- Minimizes weighted expected building exposure. A 5% arrival-delay tie-breaker allows useful progress on a binary-loss plateau. A candidate is rejected if primary expected building loss increases. It does **not** fill the budget with zero-gain treatments.
- Zone 0 bundles allow an iteration to harden several cells; duplicate buildings in a cell retain their individual count/weight, but a treatment cell is charged once. Fixed cells and their returned costs are canonicalized the same way.

```ts
const core = createCore(grid, {
  buildings,
  maxIterations: 20,
  candidateLimit: 24,
  spread: { referenceCellSize: 25, timeScale: 0.35, spotting: true },
  cost: (type, cell) => /* your authoritative per-cell cost */ 100,
  allowed: (type, cell) => /* eligibility, protected areas, burn window */ true,
});
const treatments = core.planTreatments(request);
console.log(core.getPlannerDiagnostics());
// {iterations, spent, evaluatedCandidates,
//  stopReason: 'budget-exhausted' | 'iteration-limit' | 'no-beneficial-candidate'}
```

An iteration cap is a computation limit, not a claim that no useful plan remains. Budget is an upper bound. A safe/unreached community or exhausted admissible candidates should leave money unspent. This remains a bounded heuristic without an optimality guarantee. A large synthetic 128² planning run with 10,398 homes took approximately 15 s for eight iterations in this environment before the final search-diversity refinement; measure on the demo machine and tune limits.

`evaluate().buildingsThreatened` now sums **expected ember-exposed homes** (fractional) across scenarios; non-building asset targets retain deterministic reachability. `lossPerDollar` uses their configured weights. `burnedAreaHa` still counts cells reached by the deterministic graph and is not expected GPU burned area. Arrival maps are approximate minutes and use Infinity for unreachable cells. Treat these as planning diagnostics, not evacuation probabilities.

## P4 frontend handoff

Verified against `a/p4-treatments` at `920077d`. This fix includes two small integration changes in its controller/Worker, alongside C's core/analysis code.

1. **Included:** removed the temporary 96-hour workaround in `web/src/planner/controller.ts`: uses `EVAL_STEPS * SpreadParams.stepMinutes` (currently **480 min**) for the planner horizon, matching the GPU evaluator. Re-fit after any change to CA resolution or rules.
2. **Included:** the custom Worker returns `core.getPlannerDiagnostics()` and the UI displays the actual stop reason instead of assuming every low-cost plan stopped for lack of benefit. The Worker also passes the fine GPU grid cell size as `referenceCellSize`.
3. The current Worker supplies `maxIterations:8`. Increase/tune that if diagnostics reports `iteration-limit`; spending the entire budget is not otherwise guaranteed.
4. Current Zone 0 costs remain per **cell**, including the Worker's ×16 coarse-area factor. That preserves the present mask/cost contract. If billing per household, agree on a new costing/mapping contract; upsampled masks harden every fine building cell in that coarse cell.
5. Keep the 5-seed GPU comparison and its noise indicator. The planner's expected-risk score is approximate and should not replace that table. Use paired seeds to compare plans.

The min-cut implementation is unchanged: it remains a surface/topological perfect-barrier baseline and does not model ember containment. Real Eaton calibration and full live-data/alert integration remain separate tasks.

## Verification

```sh
cd packages/core
npm test
npm run demo
```

Tests cover CA-formula travel costs and step scaling, fine/coarse units, diagonal behavior, ember transport over gaps, Zone 0 effects and selection, hardening bundles/eligibility, delayed-arrival plateaus, candidate locations beyond the former top 24, fixed-cost deduplication, multiple winds and no forced useless spending, alongside existing grid/coordinate/budget/min-cut checks.
