// Optional headless WebGL check: actual production shaders, controlled flat fuel.
import * as THREE from 'three';
import { FireSim } from '../web/src/sim/fireSim';
import type { Grid } from '../packages/core/src/index.ts';
async function run() {
  const report = await (await fetch('./norte-spotting.json')).json();
  const width = 128, ignition = 48 * width + 112, data = new Float32Array(width * width * 4);
  for (let c = 0; c < width * width; c++) data.set([0, .8, .8, 1], c * 4);
  const grid: Grid = { meta: { width, height: width, cellSize: 25, crs: 'EPSG:32611', originUTM: [0, 0], bboxLonLat: [0, 0, 0, 0] }, data };
  const renderer = new THREE.WebGLRenderer();
  if (!renderer.extensions.has('EXT_color_buffer_float')) throw Error('Float color buffers unavailable');
  const texture = new THREE.DataTexture(data, width, width, THREE.RGBAFormat, THREE.FloatType); texture.needsUpdate = true;
  const sim = new FireSim(renderer, grid, texture, report.geometry.wind);
  const tx = report.geometry.targetX, ty = report.geometry.targetY;
  const near = Array.from({ length: width * width }, (_, c) => c).filter(c => Math.hypot(c % width - tx, Math.floor(c / width) - ty) * 25 <= 375);
  const rows = [];
  for (let seed = 1; seed <= report.cpuCa.seeds; seed++) {
    sim.reset(); sim.seed = seed; sim.spotting = true; sim.ignite([ignition]); sim.advance(10);
    const state = sim.readState();
    if (![...state].every(Number.isFinite) || state[ignition * 4] <= .5) throw Error('Invalid/uninitialized GPU state');
    rows.push({ seed, nearMiradaBy50min: near.some(c => state[c * 4 + 2] >= 0 && state[c * 4 + 2] <= 50) });
  }
  const hits = rows.filter(x => x.nearMiradaBy50min).length;
  renderer.dispose(); texture.dispose();
  return { status: 'passed', engine: 'production FireSim WebGL shaders (headless Chromium / SwiftShader)', seeds: rows.length,
    hits, probabilityEstimate: hits / rows.length, seedResults: rows, scope: 'controlled flat synthetic fixture, not real incident fuel/terrain' };
}
run().then(result => { document.getElementById('result')!.textContent = JSON.stringify(result); })
  .catch(error => { document.getElementById('result')!.textContent = JSON.stringify({ status: 'failed', error: String(error) }); });
