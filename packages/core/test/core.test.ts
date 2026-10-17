import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCore, shortestPaths, pathFlow, readGrid, treatmentMask, cellToLonLat, lonLatToCell, minCutBaseline, downsample, upsampleMask, edgeMinutes } from '../src/index.ts';
import type { Grid, WindScenario } from '../src/types.ts';
function fixture(w = 5, h = 3): Grid {
    const data = new Float32Array(w * h * 4);
    for (let c = 0; c < w * h; c++)
        data.set([0, 1, 1, 1], c * 4);
    return { meta: { width: w, height: h, cellSize: 25, crs: 'EPSG:32611', originUTM: [390000, 3790000], bboxLonLat: [-118.2, 34.17, -118.06, 34.27] }, data };
}
const wind = { speedMs: 0, dirFromDeg: 0 };
test('flat uniform grid uses CA geometric wait times and multisource minimum', () => { const g = fixture(), a = createCore(g).computeArrival([0], wind, new Uint8Array(15)); assert.ok(Math.abs(a[14] - (2 * edgeMinutes(g, 0, 6, wind, new Uint8Array(15)) + 2 * edgeMinutes(g, 0, 1, wind, new Uint8Array(15)))) < 1e-5); assert.equal(createCore(g).computeArrival([0, 14], wind, new Uint8Array(15))[14], 0); });
test('nonburnable wall disconnects and diagonal cannot cut corners', () => {
    const g = fixture(3, 3);
    for (const c of [1, 4, 7])
        g.data[c * 4 + 3] = 0;
    assert.equal(createCore(g).computeArrival([0], wind, new Uint8Array(9))[2], Infinity);
});
test('treatment delays arrival, flow accumulates targets, cut finds corridor', () => { const g = fixture(5, 1), m = new Uint8Array(5); m[2] = 1; const core = createCore(g); assert.ok(core.computeArrival([0], wind, m)[4] > core.computeArrival([0], wind, new Uint8Array(5))[4]); const p = shortestPaths(g, [0], wind, m); assert.equal(pathFlow(p.parent, p.order, [{ cell: 4, weight: 7 }])[0], 7); const cut = minCutBaseline(g, [0], [4], c => c === 2 ? 1 : 10); assert.deepEqual([...cut[0].cells], [2]); });
test('coordinate center roundtrip and binary validation', () => {
    const g = fixture();
    for (let c = 0; c < 15; c++) {
        const [lon, lat] = cellToLonLat(g.meta, c);
        assert.equal(lonLatToCell(g.meta, lon, lat), c);
    }
    assert.equal(readGrid(g.meta, g.data.buffer).data.length, 60);
    assert.throws(() => readGrid(g.meta, new ArrayBuffer(4)));
});
test('planner respects budget, evaluates deterministic benefit, rejects overlap', () => {
    const g = fixture(9, 1); // Asset target in vegetation: no ember requirement in this surface regression.
    const core = createCore(g, { buildings: [{ id: 'a', cell: 8, weight: 10 }] });
    const scenarios: WindScenario[] = [{ id: 's', probability: 1, wind, ignitions: [0], horizonMinutes: 45 }];
    const plan = core.planTreatments({ budget: 100, fixed: [], scenarios }), mask = treatmentMask(9, plan);
    assert.ok(plan.length);
    assert.ok(core.evaluate(mask, scenarios).cost <= 100);
    assert.equal(core.evaluate(mask, scenarios).buildingsThreatened, 0);
    assert.throws(() => treatmentMask(9, [...plan, { ...plan[0], type: 'thin' }]));
    assert.throws(() => core.planTreatments({ budget: -1, fixed: [], scenarios }));
});
test('resampling preserves extent and replicates masks', () => { const g = fixture(4, 4), d = downsample(g, 2); assert.equal(d.meta.cellSize, 50); assert.equal(d.data.length, 16); assert.deepEqual([...upsampleMask(Uint8Array.of(1), 1, 1, 2)], [1, 1, 1, 1]); });
test('meteorological east wind propagates west faster', () => { const g = fixture(5, 1), a = createCore(g).computeArrival([2], { speedMs: 10, dirFromDeg: 90 }, new Uint8Array(5)); assert.ok(a[0] < a[4]); });
