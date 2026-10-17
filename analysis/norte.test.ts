import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { integrateEdge, hourlyArrivalSolver } from './norte-arrival.ts';
import { loadInputs, detections, hourlyWinds, cellAt, norte, mirada, minutesSinceIgnition } from './norte-inputs.ts';
import { score, selectFit, validateNorte } from './norte-validation.ts';
import { kernelAudit, longRangeWeight, wilson } from './norte-spotting.ts';
import { hectares, wildlandSources, baselineOptions } from './norte-plan.ts';

test('archived passes have the required chronological holdout with no pre-ignition pixels', () => {
  const input = loadInputs(); const samples = detections(input.grid).kept;
  assert.equal(samples.filter(x => x.split === 'train').length, 31);
  assert.equal(samples.filter(x => x.split === 'test').length, 29);
  assert.ok(Math.max(...samples.filter(x => x.split === 'train').map(x => x.minutes)) < Math.min(...samples.filter(x => x.split === 'test').map(x => x.minutes)));
  assert.equal(minutesSinceIgnition('2026-10-16T20:08:00Z'), (95 * 60 + 4) / 60);
  assert.ok(samples.every(x => x.minutes > 0));
});
test('Norte mock is geographically relocated and both reported ignitions are inside it', () => {
  const { grid, source } = loadInputs();
  assert.match(source, /MOCK/);
  assert.notEqual(cellAt(grid, norte.InitialLongitude, norte.InitialLatitude), null);
  assert.notEqual(cellAt(grid, mirada.InitialLongitude, mirada.InitialLatitude), null);
  assert.equal(cellAt(grid, -118.2, 34.27), null);
  const hours = hourlyWinds(); assert.ok(hours[0].minute <= 0);
  assert.ok(hours.every(x => 'speedMs' in x.wind && Number.isFinite(x.wind.speedMs)));
});
test('hourly integration crosses wind boundaries, supports a missing edge and remains FIFO', () => {
  assert.equal(integrateEdge(0, [120, 30], [0, 60], 1), 75);
  assert.equal(integrateEdge(0, [Infinity, 30], [0, 60], 1), 90);
  assert.equal(integrateEdge(0, [30, 30], [0, 60], 2), 60);
  let previous = -Infinity;
  for (let t = 0; t < 100; t++) { const next = integrateEdge(t, [120, 30], [0, 60], 1); assert.ok(next >= previous); previous = next; }
});
test('hourly arrival solver reduces to static expected travel on a one-edge grid', () => {
  const grid = loadInputs(undefined, 32).grid;
  grid.meta = { ...grid.meta, width: 2, height: 1, cellSize: 25 };
  grid.data = Float32Array.from([0, .8, .8, 1, 0, .8, .8, 1]);
  const solve = hourlyArrivalSolver(grid, [{ minute: -1, wind: { speedMs: 0, dirFromDeg: 0 } }]);
  const a = solve(0, 1), b = solve(0, .5);
  assert.equal(a[0], 0); assert.ok(a[1] > 0); assert.equal(b[1], a[1] / 2);
});
test('fit refuses unreachable-sample cherry picking and has no access to held-out loss', () => {
  const candidates = [{ scale: .2, training: score([{ minutes: 20, predicted: 20 }, { minutes: 40, predicted: Infinity }]) },
    { scale: .4, training: score([{ minutes: 20, predicted: 25 }, { minutes: 40, predicted: 45 }]) }];
  assert.equal(selectFit(candidates)?.scale, .4);
  assert.equal(selectFit([{ scale: 1, training: score([]) }]), null);
});
test('analysis proposal leaves 3 m/s distribution exactly unchanged, with independent distance controls', () => {
  assert.equal(longRangeWeight(3), 0);
  const original = kernelAudit(3, 2000), proposal = kernelAudit(3, 2000, true);
  assert.equal(original.nearHits, proposal.nearHits);
  assert.deepEqual(original.probabilityDistanceAtLeast, proposal.probabilityDistanceAtLeast);
  const strong = kernelAudit(10, 20000, true), current = kernelAudit(10, 20000);
  assert.ok(strong.probabilityDistanceAtLeast['2400m'] > current.probabilityDistanceAtLeast['2400m']);
  assert.ok(wilson(0, 32)[1] > 0);
});
test('baseline hectares/cost conventions and upwind wildland agree with the frontend setup', () => {
  assert.deepEqual(hectares(Uint8Array.from([1, 2, 3, 4, 0]), 100), { break: 1, burn: 1, thin: 1, zone0: 1 });
  assert.equal(baselineOptions.steps, 96); assert.equal(baselineOptions.maxIterations, 8);
  const { grid } = loadInputs(undefined, 32);
  const sources = wildlandSources(grid, [-1, 0], 2500);
  assert.ok(sources.length > 0);
  assert.ok(sources.every(c => grid.data[c * 4 + 3] === 1));
});

test('perimeter scoring requires the matching grid and a timestamp within wind coverage', () => {
  const directory = mkdtempSync(join(tmpdir(), 'norte-perimeter-test-'));
  try {
    const { grid, buildings, communities } = loadInputs(undefined, 32);
    writeFileSync(join(directory, 'grid.json'), JSON.stringify(grid.meta));
    writeFileSync(join(directory, 'grid.bin'), Buffer.from(grid.data.buffer));
    writeFileSync(join(directory, 'buildings.json'), JSON.stringify(buildings));
    writeFileSync(join(directory, 'communities.json'), JSON.stringify(communities));
    const path = join(directory, 'perimeter.json');
    const perimeter = { gridMeta: grid.meta, source: 'synthetic test only', t: '2026-10-16T21:48:00Z', cells: [0, 1] };
    writeFileSync(path, JSON.stringify(perimeter));
    const report = validateNorte(directory, path);
    assert.equal(report.finalPerimeter.status, 'scored');
    assert.ok(report.finalPerimeter.iou >= 0 && report.finalPerimeter.iou <= 1);
    writeFileSync(path, JSON.stringify({ ...perimeter, gridMeta: { ...grid.meta, cellSize: 25 } }));
    assert.throws(() => validateNorte(directory, path), /identical gridMeta/);
    writeFileSync(path, JSON.stringify({ ...perimeter, t: '2026-11-01T00:00:00Z' }));
    assert.throws(() => validateNorte(directory, path), /beyond archived HRRR/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
