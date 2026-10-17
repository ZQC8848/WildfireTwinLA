import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMockGrid } from '../web/src/data/mockGrid.ts';
import { lonLatToUTM, utmToLonLat, readGrid } from '../packages/core/src/index.ts';
import type { Grid, Building, Community, WindField } from '../packages/core/src/index.ts';

export const raw = resolve(import.meta.dirname, '../data/norte/raw');
export const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
export const incidents = json(resolve(raw, 'wfigs_incidents_2026-10-17.json'));
export const norte = incidents.find((x: any) => x.IncidentName === 'NORTE');
export const mirada = incidents.find((x: any) => x.IncidentName === 'MIRADA');
export const ignitionMs: number = norte.FireDiscoveryDateTime;
export const trainingPasses = ['2026-10-16T20:08:00Z', '2026-10-16T20:44:00Z'];
export const testPasses = ['2026-10-16T21:04:00Z', '2026-10-16T21:48:00Z'];
export const minutesSinceIgnition = (t: string) => (Date.parse(t) - ignitionMs) / 60000;
export function cellAt(grid: Grid, lon: number, lat: number): number | null {
  const [e, n] = lonLatToUTM(lon, lat), [oe, on] = grid.meta.originUTM;
  const x = Math.floor((e - oe) / grid.meta.cellSize), y = Math.floor((on - n) / grid.meta.cellSize);
  return x < 0 || y < 0 || x >= grid.meta.width || y >= grid.meta.height ? null : y * grid.meta.width + x;
}
export function loadInputs(directory?: string, mockSize = 128) {
  let grid: Grid, buildings: (Building & { reportedDamageArea?: boolean })[], communities: (Community & { approx?: boolean })[];
  if (directory) {
    grid = readGrid(json(resolve(directory, 'grid.json')), Uint8Array.from(readFileSync(resolve(directory, 'grid.bin'))).buffer);
    buildings = json(resolve(directory, 'buildings.json'));
    communities = json(resolve(directory, 'communities.json'));
    if (cellAt(grid, norte.InitialLongitude, norte.InitialLatitude) === null || cellAt(grid, mirada.InitialLongitude, mirada.InitialLatitude) === null)
      throw Error('Input grid must contain both Norte and Mirada');
  } else {
    const mock = createMockGrid(mockSize, mockSize, 12800 / mockSize);
    grid = mock.grid; buildings = mock.buildings; communities = mock.communities;
    const [e, n] = lonLatToUTM(-117.645, 33.485);
    grid.meta.originUTM = [Math.floor((e - 6400) / 25) * 25, Math.ceil((n + 6400) / 25) * 25];
    const [w, north] = utmToLonLat(...grid.meta.originUTM);
    const [east, s] = utmToLonLat(grid.meta.originUTM[0] + 12800, grid.meta.originUTM[1] - 12800);
    grid.meta.bboxLonLat = [w, s, east, north];
    buildings = buildings.map(({ polygonLonLat: _polygon, ...b }) => b);
    communities = communities.map(c => ({ ...c, name: `${c.id} synthetic (not a Norte community)`, approx: true }));
  }
  const ignition = cellAt(grid, norte.InitialLongitude, norte.InitialLatitude)!;
  if (grid.data[ignition * 4 + 3] === 0) throw Error('NORTE maps to an unburnable cell; inspect B1 input, do not relocate ignition silently');
  return { grid, buildings, communities, ignition, source: directory ? 'B1-external-grid' : 'MOCK — NOT INCIDENT VALIDATION', directory: directory ?? null };
}
export function detections(grid: Grid) {
  const kept: { id: string; t: string; minutes: number; cell: number; lon: number; lat: number; split: 'train' | 'test' }[] = [];
  const excluded = { outsidePasses: 0, outsideGrid: 0, staticHeatSource: 0 };
  for (const satellite of ['N', 'J1', 'J2']) {
    const lines = readFileSync(resolve(raw, `firms_viirs_${satellite}_48h_2026-10-17.csv`), 'utf8').trim().split(/\r?\n/);
    const keys = lines.shift()!.split(',');
    for (const [index, line] of lines.entries()) {
      const row = Object.fromEntries(line.split(',').map((v, i) => [keys[i], v]));
      const time = row.acq_time.padStart(4, '0'), t = `${row.acq_date}T${time.slice(0, 2)}:${time.slice(2)}:00Z`;
      const split = trainingPasses.includes(t) ? 'train' : testPasses.includes(t) ? 'test' : null;
      if (!split) { excluded.outsidePasses++; continue; }
      const lon = Number(row.longitude), lat = Number(row.latitude);
      const [e, n] = lonLatToUTM(lon, lat), [le, ln] = lonLatToUTM(-117.6185, 33.4905);
      if (Math.hypot(e - le, n - ln) < 750) { excluded.staticHeatSource++; continue; }
      const cell = cellAt(grid, lon, lat);
      if (cell === null) { excluded.outsideGrid++; continue; }
      kept.push({ id: `${satellite}:${index}`, t, minutes: minutesSinceIgnition(t), cell, lon, lat, split });
    }
  }
  return { kept: kept.sort((a, b) => a.minutes - b.minutes), excluded };
}
// Use centre HRRR point: archived API points are snapped irregularly and even
// duplicated; interpreting them as evenly spaced grid nodes would misplace wind.
export function hourlyWinds(maxMinutes = 540): { minute: number; wind: WindField }[] {
  const p = json(resolve(raw, 'hrrr_5x5_2026-10-15_17.json')).points[12].hourly;
  return p.time.map((t: string, i: number) => ({ minute: minutesSinceIgnition(t + ':00Z'),
    wind: { speedMs: p.wind_speed_10m[i], dirFromDeg: p.wind_direction_10m[i] } }))
    .filter((x: { minute: number }) => x.minute >= -60 && x.minute <= maxMinutes);
}
export function findRealGrid() {
  const directory = resolve(import.meta.dirname, '../web/public/data');
  return existsSync(resolve(directory, 'grid.bin')) && existsSync(resolve(directory, 'communities.json')) ? directory : undefined;
}
