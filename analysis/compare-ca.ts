/** CPU reference uses the actual shader's PCG/rules; no WebGL required.
 * Run from repo root after npm ci in web:
 * node --experimental-transform-types --import ./analysis/ca-loader.mjs analysis/compare-ca.ts [width=128] [seeds=3]
 * Synthetic diagnostic only. This does NOT claim Eaton calibration or GPU runtime QA.
 */
import { CpuFireSim } from '../web/src/sim/cpuReference.ts';
import { createMockGrid } from '../web/src/data/mockGrid.ts';
import { createCore, downsample, remapCell, PlanningParams } from '../packages/core/src/index.ts';
const width = Number(process.argv[2] ?? 128), seeds = Number(process.argv[3] ?? 3);
if (!Number.isInteger(width) || width < 32 || width % 4 || !Number.isInteger(seeds) || seeds < 1)
    throw Error('width must be >=32 and divisible by 4; seeds positive');
const { grid, buildings } = createMockGrid(width, width, 25);
let ignition = Math.floor(width * .15) * width + Math.floor(width * .75);
while (grid.data[ignition * 4 + 3] !== 1 && ignition > 0)
    ignition--;
const coarse = downsample(grid, 4), coarseIgnition = remapCell(ignition, width, width / 4, 4);
const reports = [];
const calibrationPairs: {
    seed: number;
    ca: number;
    predicted: number;
}[] = [];
for (const speedMs of [3, 6, 10]) {
    const wind = { speedMs, dirFromDeg: 30 }, mask = new Uint8Array(width * width);
    const fine = createCore(grid).computeArrival([ignition], wind, mask);
    const coarseCore = createCore(coarse, { buildings: buildings.map(b => ({ ...b, cell: remapCell(b.cell, width, width / 4, 4) })), maxIterations: 2, candidateLimit: 12, cost: t => ({ break: 100, burn: 30, thin: 60, zone0: 250 }[t]) * 16 });
    const coarseArrival = coarseCore.computeArrival([coarseIgnition], wind, new Uint8Array(coarse.meta.width * coarse.meta.height));
    const pairs: {
        ca: number;
        fine: number;
        coarse: number;
    }[] = [];
    for (let seed = 1; seed <= seeds; seed++) {
        const ca = new CpuFireSim(grid, wind, { seed, spotting: true });
        ca.ignite([ignition]);
        ca.advance(96);
        for (const b of buildings) {
            const t = ca.state[b.cell * 4 + 2];
            if (t > 0 && Number.isFinite(fine[b.cell])) {
                const predicted = coarseArrival[remapCell(b.cell, width, width / 4, 4)];
                pairs.push({ ca: t, fine: fine[b.cell], coarse: predicted });
                if (Number.isFinite(predicted) && predicted > 0)
                    calibrationPairs.push({ seed, ca: t, predicted });
            }
        }
    }
    const finite = pairs.filter(p => Number.isFinite(p.coarse));
    const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    const start = performance.now();
    const scenarios = [{ id: 'current', probability: 1, wind, ignitions: [coarseIgnition], horizonMinutes: 480 }];
    const plan = coarseCore.planTreatments({ budget: 150000, fixed: [], scenarios });
    reports.push({ speedMs, pairedHomes: pairs.length, coarsePairedHomes: finite.length, caMeanMinutes: mean(pairs.map(p => p.ca)), fineMeanMinutes: mean(pairs.map(p => p.fine)), coarseMeanMinutes: mean(finite.map(p => p.coarse)), coarseRatio: mean(finite.map(p => p.coarse / p.ca)), planMs: performance.now() - start, types: plan.map(t => t.type), diagnostics: coarseCore.getPlannerDiagnostics() });
}
const training = calibrationPairs.filter(p => p.seed === 1).map(p => p.ca / p.predicted).sort((a, b) => a - b);
const fit = training.length ? training[Math.floor(training.length / 2)] : null;
const heldOut = calibrationPairs.filter(p => p.seed > 1);
const calibration = { currentTimeScale: PlanningParams.arrivalTimeScale, suggestedTimeScale: fit ? fit * PlanningParams.arrivalTimeScale : null, trainingSeed: 1, samples: training.length, multiplierOnCurrentScale: fit, heldOutSamples: heldOut.length, heldOutMAEMinutes: fit && heldOut.length ? heldOut.reduce((a, p) => a + Math.abs(p.predicted * fit - p.ca), 0) / heldOut.length : null };
console.log(JSON.stringify({ calibration, label: 'SYNTHETIC CA REFERENCE — NOT EATON', width, seeds, reports }, null, 2));
