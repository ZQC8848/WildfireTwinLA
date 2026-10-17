import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCore, SpreadParams, lonLatToUTM } from '../packages/core/src/index.ts';
import { buildArrivalGraph, buildingExposure } from '../packages/core/src/arrivalGraph.ts';
import { CpuFireSim } from '../web/src/sim/cpuReference.ts';
import { norte, mirada } from './norte-inputs.ts';
import type { Grid } from '../packages/core/src/index.ts';

export function rng(seed: number) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export function wilson(hits: number, n: number) {
  const z = 1.96, p = hits / n, d = 1 + z * z / n;
  const a = (p + z * z / (2 * n)) / d, b = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, a - b), Math.min(1, a + b)];
}
// Analysis-only proposal, deliberately not installed in params.ts or either CA.
export function longRangeWeight(speed: number) { return .02 * Math.max(0, Math.min(1, (speed - 5) / 5)); }
export function kernelAudit(speed: number, samples = 200000, proposal = false) {
  const random = rng(1701), [e0, n0] = lonLatToUTM(norte.InitialLongitude, norte.InitialLatitude),
    [e1, n1] = lonLatToUTM(mirada.InitialLongitude, mirada.InitialLatitude);
  const dx = e1 - e0, dy = n0 - n1, theta = 75 * Math.PI / 180;
  let near = 0, over1km = 0, over2400m = 0, over5km = 0;
  for (let i = 0; i < samples; i++) {
    const mixture = random() < (proposal ? longRangeWeight(speed) : 0);
    const z = Math.sqrt(-2 * Math.log(Math.max(1e-12, random()))) * Math.cos(2 * Math.PI * random());
    const sigma = mixture ? 1 : .6, mean = 40 * speed * (mixture ? 4 : 1);
    const distance = mean * Math.exp(sigma * z - sigma ** 2 / 2), angle = theta + (random() * 2 - 1) * Math.PI / 12;
    const x = -Math.sin(angle) * distance, y = Math.cos(angle) * distance;
    if (Math.hypot(x - dx, y - dy) <= 375) near++;
    if (distance >= 1000) over1km++;
    if (distance >= 2400) over2400m++;
    if (distance >= 5000) over5km++;
  }
  const perSample = near / samples;
  return { speedMs: speed, proposal, samples, nearHits: near, nearMiradaKernelProbability: perSample,
    kernelWilson95: wilson(near, samples), probabilityDistanceAtLeast: { '1000m': over1km / samples, '2400m': over2400m / samples, '5000m': over5km / samples },
    singleContinuouslyBurningSource50minUpperModel: 1 - (1 - perSample * SpreadParams.spot.pBase * 1.04) ** (4 * 10),
    singleFuel08Source20minLifetime: 1 - (1 - perSample * SpreadParams.spot.pBase * 1.04) ** (4 * 4) };
}
export function spottingReport(seeds = 32) {
  const [e0, n0] = lonLatToUTM(norte.InitialLongitude, norte.InitialLatitude), [e1, n1] = lonLatToUTM(mirada.InitialLongitude, mirada.InitialLatitude);
  const width = 128, cellSize = 25, ignition = 48 * width + 112;
  const data = new Float32Array(width * width * 4);
  for (let c = 0; c < width * width; c++) data.set([0, .8, .8, 1], c * 4);
  const grid: Grid = { meta: { width, height: width, cellSize, crs: 'EPSG:32611', originUTM: [e0 - 112.5 * cellSize, n0 + 48.5 * cellSize], bboxLonLat: [-117.7, 33.45, -117.6, 33.5] }, data };
  const targetX = 112 + (e1 - e0) / cellSize, targetY = 48 + (n0 - n1) / cellSize;
  const target = Math.round(targetY) * width + Math.round(targetX), near: number[] = [];
  for (let c = 0; c < width * width; c++) if (Math.hypot(c % width - targetX, Math.floor(c / width) - targetY) * cellSize <= 375) near.push(c);
  const wind = { speedMs: 8.7, dirFromDeg: 75 };
  const arrivals = createCore(grid).computeArrival([ignition], wind, new Uint8Array(width * width));
  // Separate diagnostic: one hypothetical building cell at MIRADA.
  const buildingGrid = { ...grid, data: grid.data.slice() }; buildingGrid.data[target * 4 + 3] = 2;
  const graph = buildArrivalGraph(buildingGrid, wind), bArrival = createCore(buildingGrid).computeArrival([ignition], wind, new Uint8Array(width * width));
  let hit = 0;
  const seedResults = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const ca = new CpuFireSim(grid, wind, { seed, spotting: true }); ca.ignite([ignition]); ca.advance(10);
    const reached = near.some(c => ca.state[c * 4 + 2] >= 0 && ca.state[c * 4 + 2] <= 50);
    if (reached) hit++;
    seedResults.push({ seed, nearMiradaBy50min: reached });
  }
  return { status: 'controlled-synthetic-experiment; real B1 fuel/terrain pending',
    observedSeparationM: Math.hypot(e1 - e0, n1 - n0), observedDelayMinutes: (mirada.FireDiscoveryDateTime - norte.FireDiscoveryDateTime) / 60000,
    geometry: { radiusM: 375, cellSize, wind, target, targetX, targetY },
    graph: { nearMiradaEarliestMinutes: Math.min(...near.map(c => arrivals[c])),
      probabilityOfAnyIgnition: null, reason: 'Dijkstra returns deterministic expected-path ETAs, not event probabilities.',
      hypotheticalBuildingExposureProxy50min: buildingExposure(buildingGrid, target, Float64Array.from(bArrival), new Uint8Array(width * width), graph, 50, new Set([ignition])) },
    cpuCa: { engine: 'actual CpuFireSim reference of GPU rules; float64 differs from WebGL', seeds, hits: hit, probabilityEstimate: hit / seeds, wilson95: wilson(hit, seeds), seedResults },
    gpuCa: { status: 'not-run', reason: 'No headless WebGL runner is provided; ca-loader.mjs only resolves Node imports, it does not supply GPU execution.' },
    kernels: [3, 6, 8.7, 10].flatMap(v => [kernelAudit(v), kernelAudit(v, 200000, true)]),
    proposal: { description: 'Analysis-only mixture: above 5 m/s, ramp long-range mass to 2% by 10 m/s; long component mean=4×40V m, sigma=1.0; original component unchanged.',
      deployed: false, validation: 'Not fitted to MIRADA. 3/6/10 m/s and 1/2.4/5 km controls audit side effects, not independent wildfire validation. Independent incident/ember observations required before deployment.' },
    limitations: ['Uniform flat fuel, not the incident grid; this cannot establish MIRADA cause.',
      'Kernel audit samples single-source ember transport; near-source trial calculation assumes susceptibility=1.04 and independence. The CA run includes front growth.',
      'Zero hits is not zero probability; use the confidence interval. No claim of operational calibration.'] };
}
if (process.argv[1] === import.meta.filename) {
  const report = spottingReport(); writeFileSync(resolve(import.meta.dirname, 'norte-spotting.json'), JSON.stringify(report, (_k, v) => typeof v === 'number' && !Number.isFinite(v) ? null : v, 2) + '\n');
  console.log('Spotting report:', report.cpuCa.hits, '/', report.cpuCa.seeds);
}
