import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCore, downsample, remapCell, upsampleMask, treatmentMask, PlanningParams, SpreadParams } from '../packages/core/src/index.ts';
import type { Grid, Treatment, TreatmentType, Building } from '../packages/core/src/index.ts';
import { CpuFireSim } from '../web/src/sim/cpuReference.ts';
import { loadInputs, findRealGrid } from './norte-inputs.ts';

export const baselineOptions = { wind: { speedMs: 8.5, dirFromDeg: 75 }, factor: 4, steps: 96,
  seeds: [11, 23, 37, 41, 53], maxIterations: 8, stripLength: 5, wildlandDistanceM: 2500 };
const names: TreatmentType[] = ['break', 'burn', 'thin', 'zone0'];
export function wildlandSources(g: Grid, direction: [number, number], distanceM: number) {
  const { width: w, height: h, cellSize } = g.meta, n = w * h;
  const distances = new Int32Array(n).fill(-1), queue: number[] = [];
  let sx = 0, sy = 0;
  for (let c = 0; c < n; c++) if (g.data[c * 4 + 3] === 2) { distances[c] = 0; queue.push(c); sx += c % w; sy += Math.floor(c / w); }
  if (!queue.length) return [];
  const projection = (sx / queue.length) * direction[0] + (sy / queue.length) * direction[1];
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = c % w + dx, y = Math.floor(c / w) + dy;
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      const v = y * w + x;
      if (distances[v] < 0) { distances[v] = distances[c] + 1; queue.push(v); }
    }
  }
  return Array.from({ length: n }, (_, c) => c).filter(c => g.data[c * 4 + 3] === 1 && distances[c] >= Math.ceil(distanceM / cellSize)
    && (c % w) * direction[0] + Math.floor(c / w) * direction[1] < projection);
}
export function hectares(mask: Uint8Array, cellSize: number) {
  const out = { break: 0, burn: 0, thin: 0, zone0: 0 };
  for (const code of mask) if (code) out[names[code - 1]] += cellSize ** 2 / 10000;
  return out;
}
export function evaluateCpu(grid: Grid, buildings: Building[], mask: Uint8Array, ignition: number, groups: Record<string, Set<number>>) {
  const rows = baselineOptions.seeds.map(seed => {
    const ca = new CpuFireSim(grid, baselineOptions.wind, { seed, spotting: true, mask }); ca.ignite([ignition]); ca.advance(baselineOptions.steps);
    const hit = buildings.filter(b => ca.state[b.cell * 4] > .5);
    let area = 0; for (let c = 0; c < mask.length; c++) if (ca.state[c * 4] > .5) area += grid.meta.cellSize ** 2 / 10000;
    return { seed, homesReached: hit.length, burnedAreaHa: area,
      groups: Object.fromEntries(Object.entries(groups).map(([name, cells]) => [name, hit.filter(b => cells.has(b.cell)).length])) };
  });
  return { homesReached: rows.reduce((s, x) => s + x.homesReached, 0) / rows.length,
    burnedAreaHa: rows.reduce((s, x) => s + x.burnedAreaHa, 0) / rows.length, rows };
}
export function planNorte(directory?: string) {
  const input = loadInputs(directory), { grid, buildings, communities } = input, coarse = downsample(grid, baselineOptions.factor);
  const { factor } = baselineOptions, cw = coarse.meta.width;
  const coarseBuildings = buildings.map(b => ({ ...b, cell: remapCell(b.cell, grid.meta.width, cw, factor) }));
  const core = createCore(coarse, { buildings: coarseBuildings, maxIterations: baselineOptions.maxIterations, stripLength: baselineOptions.stripLength,
    cost: type => PlanningParams.costPerCell[type] * factor ** 2,
    spread: { referenceCellSize: grid.meta.cellSize, timeScale: PlanningParams.arrivalTimeScale, spotting: true } });
  const scenarios = [{ id: 'norte-baseline', probability: 1, wind: baselineOptions.wind, ignitions: [remapCell(input.ignition, grid.meta.width, cw, factor)], horizonMinutes: baselineOptions.steps * SpreadParams.stepMinutes }];
  const groups: Record<string, Set<number>> = {};
  for (const zone of ['SJC04', 'SJC05']) {
    const matches = communities.filter(c => `${c.id} ${c.name}`.toUpperCase().includes(zone));
    if (matches.length) groups[zone] = new Set(matches.flatMap(c => c.cells));
  }
  if (buildings.some(b => b.reportedDamageArea)) groups.reportedDamageArea = new Set(buildings.filter(b => b.reportedDamageArea).map(b => b.cell));
  const untreated = evaluateCpu(grid, buildings, new Uint8Array(grid.meta.width * grid.meta.height), input.ignition, groups);
  const theta = baselineOptions.wind.dirFromDeg * Math.PI / 180;
  const sources = wildlandSources(coarse, [-Math.sin(theta), Math.cos(theta)], baselineOptions.wildlandDistanceM);
  let mincut: Treatment[] | null = null, mincutError: string | null = null;
  try { mincut = core.planMinCut(sources); } catch (e) { mincutError = String(e); }
  const cache = new Map<string, ReturnType<typeof evaluateCpu>>();
  function assess(plan: Treatment[], budget: number, diagnostics?: ReturnType<typeof core.getPlannerDiagnostics>) {
    const mask = upsampleMask(treatmentMask(cw * coarse.meta.height, plan), cw, coarse.meta.height, factor);
    const key = Buffer.from(mask).toString('base64');
    const after = cache.get(key) ?? evaluateCpu(grid, buildings, mask, input.ignition, groups); cache.set(key, after);
    const cost = plan.reduce((sum, t) => sum + t.cost, 0);
    const perSeedSaved = after.rows.map((x, i) => untreated.rows[i].homesReached - x.homesReached);
    const mean = untreated.homesReached;
    const sd = Math.sqrt(untreated.rows.reduce((s, x) => s + (x.homesReached - mean) ** 2, 0) / Math.max(1, untreated.rows.length - 1));
    const noiseHomes = Math.max(5, 2 * sd / Math.sqrt(untreated.rows.length));
    return { noiseHomes, withinNoise: Math.abs(untreated.homesReached - after.homesReached) <= noiseHomes, cost, overBudget: cost > budget, treatedHectares: hectares(mask, grid.meta.cellSize), homesProtected: untreated.homesReached - after.homesReached,
      perSeedHomesProtected: perSeedSaved, after, diagnostics,
      protection: Object.fromEntries(['SJC04', 'SJC05', 'reportedDamageArea'].map(name => {
        if (!groups[name]) return [name, { status: 'unavailable', protected: null, reason: 'B2 approximate community/B6 damage annotation missing; do not infer from synthetic homes.' }];
        const count = buildings.filter(b => groups[name].has(b.cell)).length;
        if (!count) return [name, { status: 'unavailable', protected: null, reason: 'No mapped homes in this group' }];
        const beforeMean = untreated.rows.reduce((s, x) => s + x.groups[name], 0) / untreated.rows.length;
        const afterMean = after.rows.reduce((s, x) => s + x.groups[name], 0) / after.rows.length;
        return [name, { status: 'CPU-reference-estimate', mappedHomes: count, homesProtected: beforeMean - afterMean, homesReached: afterMean,
          protected: after.rows.every(x => x.groups[name] === 0), note: 'Protected means no reached mapped homes in these five runs; not a guarantee.' }];
      })) };
  }
  const budgets = [20000, 40000, 80000].map(budget => {
    const greedy = core.planTreatments({ budget, fixed: [], scenarios });
    return { budget, greedy: assess(greedy, budget, core.getPlannerDiagnostics()),
      mincut: mincut ? assess(mincut, budget) : { status: 'no-finite-cut', error: mincutError } };
  });
  return { status: directory ? 'provisional-CPU-reference-baseline; GPU UI comparison unverified' : 'blocked-missing-B1-B2; mock pipeline exercised',
    source: input.source, gridMeta: grid.meta, options: baselineOptions, spread: { referenceCellSize: grid.meta.cellSize, timeScale: PlanningParams.arrivalTimeScale, spotting: true },
    horizonMinutes: scenarios[0].horizonMinutes, untreated, budgets,
    limitations: ['Uses actual frontend CpuFireSim with the UI seeds/steps; GPU float32 can diverge, so these are not verified UI numbers.',
      'Min-cut ignores budget and embers by design; repeated baseline is marked overBudget when applicable.',
      'Mask hectares and coarse-cell costs follow frontend conventions, not per-house billing.',
      'Synthetic terrain/buildings are not B1/B2 or the reported damage area. No real protection claims without those inputs.'] };
}
if (process.argv[1] === import.meta.filename) {
  const report = planNorte(process.argv[2] ?? findRealGrid());
  writeFileSync(resolve(import.meta.dirname, 'norte-plan-baseline.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(report.status);
}
