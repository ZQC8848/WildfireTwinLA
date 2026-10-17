// 地形修正风场。
//
// 优先使用 WindNinja 预算的风场库（web/public/data/wind/，格式见 docs/wind-field.md）：
// 按来流风向（环形）与风速在库中双线性插值。风场库不存在时，退回下面的地形启发式。
//
// 启发式只是近似，用于在没有 WindNinja 数据时演示地形对风的影响，系数未经验证：
//   - 地形暴露度（TPI = 高程 − 周围 800 m 平均高程）：山脊加速、山谷减速
//   - 顺风方向的坡度：背风下坡加速（下坡风），迎风上坡略减速
//   - 峡谷导流：山谷中风向被扭向等高线方向（峡谷走向）
// 输出都是 core 的 WindField 网格（行优先，由北向南），与 GPU 模拟、CPU 参考实现、规划器共用。

import { GRID_CHANNELS, type Grid, type Wind, type WindField } from "@core";
import { windToGrid } from "./wind";

export const FIELD_SIZE = 128;

type GridWind = { width: number; height: number; samples: Wind[] };

/** 网格坐标下的速度分量 [向东, 向南] → 气象惯例的风速与来向 */
function fromGrid(vx: number, vy: number): Wind {
  const east = vx;
  const north = -vy;
  const speedMs = Math.hypot(east, north);
  const dirFromDeg = ((Math.atan2(-east, -north) * 180) / Math.PI + 360) % 360;
  return { speedMs, dirFromDeg };
}

/** 把网格高程降采样到 n×n（格子中心对齐），用于风场计算 */
function sampleElevation(grid: Grid, n: number): Float32Array {
  const { width: W, height: H } = grid.meta;
  const out = new Float32Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      // 与 WindField 的约定一致：采样点 (0,0) 对齐网格 (0,0)，(n-1,n-1) 对齐 (W-1,H-1)
      const x = Math.round((i / (n - 1)) * (W - 1));
      const y = Math.round((j / (n - 1)) * (H - 1));
      out[j * n + i] = grid.data[(y * W + x) * GRID_CHANNELS];
    }
  return out;
}

function boxBlur(src: Float32Array, n: number, r: number): Float32Array {
  const tmp = new Float32Array(n * n);
  const out = new Float32Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      let s = 0;
      let c = 0;
      for (let k = Math.max(0, i - r); k <= Math.min(n - 1, i + r); k++, c++) s += src[j * n + k];
      tmp[j * n + i] = s / c;
    }
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      let s = 0;
      let c = 0;
      for (let k = Math.max(0, j - r); k <= Math.min(n - 1, j + r); k++, c++) s += tmp[k * n + i];
      out[j * n + i] = s / c;
    }
  return out;
}

export interface TerrainWindParams {
  /** TPI 每 100 m 对应的风速增减比例 */
  exposure: number;
  /** 背风下坡加速的最大增幅 */
  downslope: number;
  /** 山谷中风向扭向峡谷走向的最大比例 */
  channeling: number;
}

export const DEFAULT_TERRAIN_WIND: TerrainWindParams = { exposure: 0.3, downslope: 0.9, channeling: 0.6 };

/** 预计算的地形量（与来流风无关，只算一次） */
export class TerrainWindModel {
  readonly n = FIELD_SIZE;
  private tpi: Float32Array;
  private gx: Float32Array; // 平滑高程沿网格 x（向东）的坡度，m/m
  private gy: Float32Array; // 沿网格 y（向南）的坡度，m/m

  constructor(grid: Grid) {
    const n = this.n;
    const step = ((grid.meta.width - 1) * grid.meta.cellSize) / (n - 1); // 采样间距（米）
    const elev = sampleElevation(grid, n);
    const smooth = boxBlur(elev, n, Math.max(1, Math.round(300 / step)));
    const broad = boxBlur(elev, n, Math.max(2, Math.round(800 / step)));
    this.tpi = new Float32Array(n * n);
    this.gx = new Float32Array(n * n);
    this.gy = new Float32Array(n * n);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        this.tpi[k] = smooth[k] - broad[k];
        const xl = smooth[j * n + Math.max(0, i - 1)];
        const xr = smooth[j * n + Math.min(n - 1, i + 1)];
        const yu = smooth[Math.max(0, j - 1) * n + i];
        const yd = smooth[Math.min(n - 1, j + 1) * n + i];
        this.gx[k] = (xr - xl) / (step * (Math.min(n - 1, i + 1) - Math.max(0, i - 1)));
        this.gy[k] = (yd - yu) / (step * (Math.min(n - 1, j + 1) - Math.max(0, j - 1)));
      }
  }

  field(inflow: Wind, p: TerrainWindParams = DEFAULT_TERRAIN_WIND): GridWind {
    const n = this.n;
    const [ux0, uy0] = windToGrid(inflow);
    const V = inflow.speedMs;
    const ux = V > 1e-6 ? ux0 / V : 0;
    const uy = V > 1e-6 ? uy0 / V : 0;
    const samples: Wind[] = new Array(n * n);
    for (let k = 0; k < n * n; k++) {
      const gx = this.gx[k];
      const gy = this.gy[k];
      const slope = Math.hypot(gx, gy);
      // 1) 暴露度：山脊加速、山谷减速
      const fExp = 1 + p.exposure * Math.max(-1.5, Math.min(1.5, this.tpi[k] / 100));
      // 2) 顺风方向的坡度：s < 0 表示风往下坡吹（背风坡）
      const s = ux * gx + uy * gy;
      const fDown = 1 + p.downslope * Math.min(1, Math.max(0, -s / 0.35));
      const fUp = 1 - 0.25 * Math.min(1, Math.max(0, s / 0.35));
      // 3) 峡谷导流：山谷里把风向扭向等高线方向（取与来流同侧的那个方向）
      let dx = ux;
      let dy = uy;
      if (slope > 1e-4) {
        let tx = -gy / slope;
        let ty = gx / slope;
        if (tx * ux + ty * uy < 0) {
          tx = -tx;
          ty = -ty;
        }
        const valley = Math.min(1, Math.max(0, -this.tpi[k] / 120));
        const steep = Math.min(1, slope / 0.25);
        const w = p.channeling * valley * steep;
        dx = ux * (1 - w) + tx * w;
        dy = uy * (1 - w) + ty * w;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len;
        dy /= len;
      }
      const speed = V * Math.min(2.2, Math.max(0.3, fExp * fDown * fUp));
      samples[k] = fromGrid(dx * speed, dy * speed);
    }
    return { width: n, height: n, samples };
  }
}

// ---------------------------------------------------------------- WindNinja 风场库

export interface WindLibraryIndex {
  width: number;
  height: number;
  /** 来流风向（度，气象惯例），升序 */
  directions: number[];
  /** 来流风速（m/s），升序 */
  speeds: number[];
  /** 二进制文件名，相对于 index.json */
  file: string;
  source?: string;
}

export class WindLibrary {
  private constructor(
    readonly index: WindLibraryIndex,
    private data: Float32Array,
  ) {}

  /** 读取 data/wind/index.json 与二进制文件；不存在时返回 null */
  static async load(): Promise<WindLibrary | null> {
    const base = `${import.meta.env.BASE_URL}data/wind/`;
    try {
      const res = await fetch(base + "index.json");
      if (!res.ok || !res.headers.get("content-type")?.includes("json")) return null;
      const index = (await res.json()) as WindLibraryIndex;
      const bin = await fetch(base + index.file);
      if (!bin.ok) return null;
      const data = new Float32Array(await bin.arrayBuffer());
      const expected = index.directions.length * index.speeds.length * index.width * index.height * 2;
      if (data.length !== expected) throw new Error(`wind library: ${data.length} floats, expected ${expected}`);
      return new WindLibrary(index, data);
    } catch (err) {
      console.info("[wind] No WindNinja library; using terrain heuristic:", (err as Error).message);
      return null;
    }
  }

  /** 按来流风向（环形）与风速在库中插值，返回网格风场 */
  field(inflow: Wind): GridWind {
    const { width: w, height: h, directions: D, speeds: S } = this.index;
    const nd = D.length;
    const dir = ((inflow.dirFromDeg % 360) + 360) % 360;
    let d1 = D.findIndex((d) => d > dir);
    if (d1 < 0) d1 = 0;
    const d0 = (d1 - 1 + nd) % nd;
    const span = (D[d1] - D[d0] + 360) % 360 || 360;
    const fd = ((dir - D[d0] + 360) % 360) / span;
    const v = Math.min(Math.max(inflow.speedMs, S[0]), S[S.length - 1]);
    let s1 = S.findIndex((s) => s >= v);
    if (s1 <= 0) s1 = Math.min(1, S.length - 1);
    const s0 = Math.max(0, s1 - 1);
    const fs = S[s1] === S[s0] ? 0 : (v - S[s0]) / (S[s1] - S[s0]);
    // 风速超出库的范围时按比例缩放
    const scale = inflow.speedMs / v || 0;
    const at = (di: number, si: number, k: number) => (di * S.length + si) * w * h * 2 + k * 2;
    const samples: Wind[] = new Array(w * h);
    for (let k = 0; k < w * h; k++) {
      let east = 0;
      let north = 0;
      for (const [di, wd] of [
        [d0, 1 - fd],
        [d1, fd],
      ] as const)
        for (const [si, ws] of [
          [s0, 1 - fs],
          [s1, fs],
        ] as const) {
          const o = at(di, si, k);
          east += wd * ws * this.data[o];
          north += wd * ws * this.data[o + 1];
        }
      samples[k] = fromGrid(east * scale, -north * scale);
    }
    return { width: w, height: h, samples };
  }
}

export type WindMode = "uniform" | "terrain";

/** 按当前模式生成风场：uniform 为单一风；terrain 优先用风场库，没有则用启发式 */
export function buildWindField(mode: WindMode, inflow: Wind, model: TerrainWindModel, library: WindLibrary | null): WindField {
  if (mode === "uniform") return inflow;
  return library ? library.field(inflow) : model.field(inflow);
}
