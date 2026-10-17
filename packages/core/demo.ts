import { createCore, treatmentMask } from './src/index.ts';
import type { Grid, WindScenario } from './src/types.ts';
const width = 24, height = 16, data = new Float32Array(width * height * 4);
for (let c = 0; c < width * height; c++)
    data.set([0, 1, 1, 1], c * 4);
data[(8 * width + 21) * 4 + 3] = 2;
const grid: Grid = { meta: { width, height, cellSize: 25, crs: 'EPSG:32611', originUTM: [390000, 3790000], bboxLonLat: [-118.2, 34.17, -118.06, 34.27] }, data };
const core = createCore(grid, { buildings: [{ id: 'demo-house', cell: 8 * width + 21, weight: 100 }], maxIterations: 4 });
const scenarios: WindScenario[] = [{ id: 'synthetic', probability: 1, wind: { speedMs: 6, dirFromDeg: 270 }, ignitions: [8 * width + 2], horizonMinutes: 240 }];
const plan = core.planTreatments({ budget: 1000, fixed: [], scenarios });
console.log(JSON.stringify({ label: 'SYNTHETIC / UNCALIBRATED', baseline: core.evaluate(new Uint8Array(width * height), scenarios), plan: plan.map(t => ({ ...t, cells: [...t.cells] })), after: core.evaluate(treatmentMask(width * height, plan), scenarios) }, null, 2));
