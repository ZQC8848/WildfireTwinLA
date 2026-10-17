// 合成网格：在 Tia 的真实数据就绪前使用，格式与约定 1 完全一致。
// 地理位置放在 Norte Fire 的范围（docs/norte-fire.md），回放的火点按经纬度落到这张网格上；
// 地形本身是合成的（北侧山地、南侧有建筑的平原），不代表 San Juan Capistrano 的真实地形。

import { NORTE_BBOX } from "./norte.ts";
import {
  CellClass,
  GRID_CHANNELS,
  cellIndex,
  lonLatToUTM,
  utmToLonLat,
  type Building,
  type Community,
  type Grid,
  type GridMeta,
} from "../../../packages/core/src/index.ts";

export interface GridBundle {
  grid: Grid;
  buildings: Building[];
  communities: Community[];
  source: "real" | "mock";
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 平滑插值的格点值噪声 */
function makeValueNoise(rand: () => number, size = 256) {
  const table = new Float32Array(size * size);
  for (let i = 0; i < table.length; i++) table[i] = rand();
  const at = (x: number, y: number) => table[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const noise = (x: number, y: number) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = smooth(x - x0);
    const fy = smooth(y - y0);
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
    return a + (b - a) * fy;
  };
  return (x: number, y: number, octaves = 5) => {
    let sum = 0;
    let amp = 0.5;
    let freq = 1;
    for (let o = 0; o < octaves; o++) {
      sum += amp * noise(x * freq, y * freq);
      amp *= 0.5;
      freq *= 2;
    }
    return sum;
  };
}

export function createMockGrid(width = 512, height = 512, cellSize = 25, seed = 7): GridBundle {
  const rand = mulberry32(seed);
  const fbm = makeValueNoise(rand);

  const originUTM = lonLatToUTM(NORTE_BBOX[0], NORTE_BBOX[3]);
  const [west, north] = utmToLonLat(originUTM[0], originUTM[1]);
  const [east, south] = utmToLonLat(originUTM[0] + width * cellSize, originUTM[1] - height * cellSize);
  const meta: GridMeta = {
    width,
    height,
    cellSize,
    crs: "EPSG:32611",
    originUTM,
    bboxLonLat: [west, south, east, north],
  };

  const peaks = Array.from({ length: 6 }, () => ({
    x: 0.1 + rand() * 0.8,
    y: 0.05 + rand() * 0.35,
    r: 0.08 + rand() * 0.12,
    h: 300 + rand() * 500,
  }));

  const data = new Float32Array(width * height * GRID_CHANNELS);
  const roadRows = [Math.floor(height * 0.78), Math.floor(height * 0.9)];
  const roadCols = [Math.floor(width * 0.3), Math.floor(width * 0.62)];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = y / height;
      // 北高南低的山前斜坡，山麓线附近坡度变陡
      const ramp = 1 / (1 + Math.exp((v - 0.6) * 9));
      let elev = 330 + 900 * ramp;
      for (const p of peaks) {
        const d2 = ((u - p.x) ** 2 + (v - p.y) ** 2) / (p.r * p.r);
        elev += p.h * Math.exp(-d2);
      }
      // 山脊与沟谷细节，只在山地明显
      elev += (fbm(u * 8, v * 8) - 0.5) * 420 * ramp;
      // 一条南北向峡谷（模仿 Eaton Canyon）
      const canyonX = 0.55 + 0.04 * Math.sin(v * 9);
      const canyon = Math.exp(-(((u - canyonX) / 0.012) ** 2));
      elev -= canyon * 120 * ramp;

      const i = cellIndex(meta, x, y) * GRID_CHANNELS;
      data[i] = elev;

      const isTown = v > 0.68 + (fbm(u * 3 + 10, 2) - 0.5) * 0.08;
      const isRoad = roadRows.some((r) => Math.abs(y - r) <= 1) || (v > 0.66 && roadCols.some((c) => Math.abs(x - c) <= 1));
      const isStream = canyon > 0.7 && v < 0.66;

      let cls: number = CellClass.Vegetation;
      if (isRoad || isStream) cls = CellClass.Unburnable;
      else if (isTown) cls = rand() < 0.55 ? CellClass.Building : CellClass.Vegetation;

      const vegNoise = fbm(u * 12 + 3, v * 12 + 7);
      const fuel = cls === CellClass.Vegetation ? Math.min(1, Math.max(0, (isTown ? 0.25 : 0.45) + (vegNoise - 0.5) * 0.9)) : 0;
      const dryness = Math.min(1, Math.max(0, 0.55 + (fbm(u * 5 + 20, v * 5 + 20) - 0.5) * 0.8 + (1 - v) * 0.1));

      data[i + 1] = fuel;
      data[i + 2] = cls === CellClass.Unburnable ? 0 : dryness;
      data[i + 3] = cls;
    }
  }

  // 社区：建筑区按东西方向分为三段
  const names = ["West neighborhood", "Central neighborhood", "East neighborhood"];
  const communities: Community[] = names.map((name, k) => ({ id: `c${k}`, name, cells: [] }));
  const buildings: Building[] = [];
  const half = cellSize / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = cellIndex(meta, x, y);
      if (data[cell * GRID_CHANNELS + 3] !== CellClass.Building) continue;
      communities[Math.min(2, Math.floor((x / width) * 3))].cells.push(cell);
      // 每 2×2 格一栋，间距约 50 m，接近 Altadena 的独栋住宅密度
      if (x % 2 !== 0 || y % 2 !== 0) continue;
      const e = originUTM[0] + (x + 0.5) * cellSize;
      const n = originUTM[1] - (y + 0.5) * cellSize;
      buildings.push({
        id: `b${buildings.length}`,
        cell,
        weight: 1,
        polygonLonLat: [
          utmToLonLat(e - half * 0.6, n - half * 0.6),
          utmToLonLat(e + half * 0.6, n - half * 0.6),
          utmToLonLat(e + half * 0.6, n + half * 0.6),
          utmToLonLat(e - half * 0.6, n + half * 0.6),
        ],
      });
    }
  }

  return { grid: { meta, data }, buildings, communities, source: "mock" };
}
