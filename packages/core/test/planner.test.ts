import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCore, downsample, edgeMinutes, SpreadParams, treatmentMask, TreatmentEffect } from '../src/index.ts';
import type { Grid, WindScenario, Treatment } from '../src/types.ts';
function grid(w = 21, h = 5, cellSize = 25): Grid {
    const data = new Float32Array(w * h * 4);
    for (let c = 0; c < w * h; c++)
        data.set([0, .5, .8, 1], c * 4);
    return { meta: { width: w, height: h, cellSize, crs: 'EPSG:32611', originUTM: [390000, 3790000], bboxLonLat: [-118.2, 34.17, -118.06, 34.27] }, data };
}
const calm = { speedMs: 0, dirFromDeg: 0 };
const eastward = { speedMs: 10, dirFromDeg: 270 };
function scenario(ignitions: number[], wind = eastward, horizonMinutes = 480): WindScenario[] { return [{ id: 'test', probability: 1, wind, ignitions, horizonMinutes }]; }
test('surface travel uses the CA probability, treatments and shared step duration', () => {
    const g = grid(4, 1), mask = new Uint8Array(4), p = SpreadParams.ph * (.6 + .8 * .5) * (.6 + .7 * g.data[2]);
    assert.ok(Math.abs(edgeMinutes(g, 0, 1, calm, mask, { timeScale: 1 }) - SpreadParams.stepMinutes / p) < 1e-6);
    mask[1] = 1;
    assert.ok(Math.abs(edgeMinutes(g, 0, 1, calm, mask, { timeScale: 1 }) - SpreadParams.stepMinutes / (p * TreatmentEffect.break.fuelMul)) < 1e-5);
    const old = SpreadParams.stepMinutes;
    try {
        SpreadParams.stepMinutes = 10;
        assert.ok(Math.abs(edgeMinutes(g, 0, 1, calm, mask, { timeScale: 1 }) - 2 * old / (p * TreatmentEffect.break.fuelMul)) < 1e-5);
    }
    finally {
        SpreadParams.stepMinutes = old;
    }
});
test('coarse edges preserve the fine-grid physical surface time scale', () => {
    const fine = grid(16, 4), coarse = downsample(fine, 4);
    const a = edgeMinutes(fine, 0, 1, calm, new Uint8Array(64), { timeScale: 1 });
    const b = edgeMinutes(coarse, 0, 1, calm, new Uint8Array(4), { timeScale: 1 });
    assert.ok(Math.abs(b / a - 4) < 1e-6);
    const core = createCore(coarse, { spread: { spotting: false, timeScale: 2 } });
    assert.ok(Math.abs(core.computeArrival([0], calm, new Uint8Array(4))[1] - 2 * b) < 1e-4);
});
test('CA permits diagonal ignition past two orthogonal unburnable cells', () => {
    const g = grid(2, 2);
    g.data[4 + 3] = 0;
    g.data[8 + 3] = 0;
    assert.ok(Number.isFinite(createCore(g).computeArrival([0], calm, new Uint8Array(4))[3]));
});
function islands(rows = 1) {
    const g = grid(21, rows + 4);
    for (let c = 0; c < g.meta.width * g.meta.height; c++)
        g.data[c * 4 + 3] = 0;
    const ignitions: number[] = [], buildings: {
        id: string;
        cell: number;
        weight: number;
    }[] = [];
    for (let y = 2; y < rows + 2; y++) {
        const source = y * 21, cell = source + 16;
        g.data.set([0, 1, 1, 1], source * 4);
        g.data.set([0, 1, 1, 2], cell * 4);
        ignitions.push(source);
        buildings.push({ id: 'home-' + y, cell, weight: 1 });
    }
    return { g, ignitions, buildings };
}
test('ember transport reaches homes over a nonburnable gap; calm and spotting-off do not', () => {
    const { g, ignitions, buildings } = islands(), cell = buildings[0].cell, n = g.meta.width * g.meta.height;
    assert.ok(Number.isFinite(createCore(g).computeArrival(ignitions, eastward, new Uint8Array(n))[cell]));
    assert.equal(createCore(g).computeArrival(ignitions, calm, new Uint8Array(n))[cell], Infinity);
    assert.equal(createCore(g, { spread: { spotting: false } }).computeArrival(ignitions, eastward, new Uint8Array(n))[cell], Infinity);
});
test('Zone 0 lowers expected ember exposure and is selected without land strip candidates', () => {
    const { g, ignitions, buildings } = islands(), n = g.meta.width * g.meta.height;
    const core = createCore(g, { buildings }), ss = scenario(ignitions), baseline = core.evaluate(new Uint8Array(n), ss);
    const plan = core.planTreatments({ budget: 250, fixed: [], scenarios: ss }), mask = treatmentMask(n, plan), after = core.evaluate(mask, ss);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].type, 'zone0');
    assert.equal(after.cost, 250);
    assert.ok(baseline.buildingsThreatened > 0);
    assert.ok(after.buildingsThreatened > 0);
    assert.ok(after.buildingsThreatened < baseline.buildingsThreatened);
    assert.ok(after.lossPerDollar > 0);
    assert.equal(core.getPlannerDiagnostics().stopReason, 'budget-exhausted');
});
test('hardening bundles handle more homes than the iteration cap and obey eligibility', () => {
    const { g, ignitions, buildings } = islands(12), n = g.meta.width * g.meta.height;
    const core = createCore(g, { buildings, maxIterations: 1, allowed: (type, c) => type === 'zone0' && c !== buildings[0].cell });
    const plan = core.planTreatments({ budget: 2750, fixed: [], scenarios: scenario(ignitions) }), mask = treatmentMask(n, plan);
    assert.equal(mask[buildings[0].cell], 0);
    const spent = plan.reduce((s, t) => s + t.cost, 0);
    assert.ok(spent > 250 && spent <= 2750);
    assert.ok(plan[0].cells.length > 1);
    assert.equal(core.getPlannerDiagnostics().stopReason, 'iteration-limit');
});
test('delay tie-breaker crosses a binary-loss plateau without increasing threatened assets', () => {
    const g = grid(40, 1), n = 40, ss = scenario([0], calm, 10000), buildings = [{ id: 'target', cell: 39, weight: 1 }];
    const core = createCore(g, { buildings, maxIterations: 3, stripLengths: [11], cost: () => 10 });
    const plan = core.planTreatments({ budget: 30, fixed: [], scenarios: ss });
    assert.equal(plan.reduce((s, t) => s + t.cost, 0), 30);
    assert.equal(core.evaluate(treatmentMask(n, plan), ss).buildingsThreatened, 1);
    assert.ok(core.computeArrival([0], calm, treatmentMask(n, plan))[39] > core.computeArrival([0], calm, new Uint8Array(n))[39]);
});
test('do not spend budget on unreachable targets or forced zero-gain candidates', () => {
    const { g, ignitions, buildings } = islands();
    const core = createCore(g, { buildings });
    assert.deepEqual(core.planTreatments({ budget: 150000, fixed: [], scenarios: scenario(ignitions, calm) }), []);
    assert.equal(core.getPlannerDiagnostics().stopReason, 'no-beneficial-candidate');
});
test('fixed overlapping copies are charged once; output costs equal evaluated mask cost', () => {
    const { g, ignitions, buildings } = islands();
    const fixed: Treatment = { type: 'zone0', cells: Uint32Array.of(buildings[0].cell), cost: 99999, source: 'user' };
    const core = createCore(g, { buildings }), ss = scenario(ignitions);
    const plan = core.planTreatments({ budget: 250, fixed: [fixed, fixed], scenarios: ss });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].cost, 250);
    assert.equal(core.evaluate(treatmentMask(g.meta.width * g.meta.height, plan), ss).cost, 250);
});
test('multiple wind scenarios, repeated homes per cell and reversed wind give bounded risk', () => {
    const { g, ignitions, buildings } = islands();
    const repeated = [...buildings, { ...buildings[0], id: 'second' }];
    const core = createCore(g, { buildings: repeated });
    const ss = [...scenario(ignitions), { ...scenario(ignitions, { speedMs: 10, dirFromDeg: 90 })[0], id: 'reverse' }];
    const risk = core.evaluate(new Uint8Array(g.meta.width * g.meta.height), ss).buildingsThreatened;
    assert.ok(risk > 0 && risk < 1);
    const plan = core.planTreatments({ budget: 250, fixed: [], scenarios: ss });
    assert.equal(plan[0].cost, 250);
});
test('candidate search reaches an admissible corridor beyond the former top 24 cells', () => {
    const g = grid(100, 1);
    const core = createCore(g, { buildings: [{ id: 'asset', cell: 99, weight: 1 }], allowed: (type, c) => type === 'break' && c === 70, cost: () => 1 });
    const plan = core.planTreatments({ budget: 1, fixed: [], scenarios: scenario([0], calm, 10000) });
    assert.equal(plan.length, 1);
    assert.deepEqual([...plan[0].cells], [70]);
});
