// 按网格规则放置植被、建筑与电力设施。完全确定：同一份网格每次得到同样的布局。

import * as THREE from "three";
import { CellClass, GRID_CHANNELS, cellIndex, lonLatToUTM, type Building, type Community, type Grid } from "@core";
import { sampleElevation } from "../coords";
import type { AssetLibrary, AssetName } from "./assets";

export interface Placement {
  asset: AssetName;
  variant: number;
  /** 世界坐标（米），原点在网格中心，x 向东，z 向南 */
  x: number;
  z: number;
  /** 地面高程（米，未夸张），shader 中再换算成显示高度 */
  elev: number;
  rot: number;
  scale: number;
  cell: number;
}

export interface WireSpan {
  a: Placement;
  b: Placement;
  /** 两端的挂点（模型局部坐标，已按各自旋转与缩放换算，未加地面高度） */
  pointsA: THREE.Vector3[];
  pointsB: THREE.Vector3[];
}

export interface Layout {
  items: Placement[];
  spans: WireSpan[];
}

/** 整数哈希 → [0, 1) */
function hash(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

function pick<T extends string>(r: number, table: [T, number][]): T {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let acc = 0;
  for (const [k, w] of table) {
    acc += w / total;
    if (r < acc) return k;
  }
  return table[table.length - 1][0];
}

/** 半径 r 内是否存在满足条件的格子（方形邻域的膨胀） */
function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r) && !v; k++) v = mask[y * w + k];
      tmp[y * w + x] = v;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r) && !v; k++) v = tmp[k * w + x];
      out[y * w + x] = v;
    }
  return out;
}

const TOWN_TREES: [AssetName, number][] = [
  ["palm-mexican-fan", 0.25],
  ["palm-canary", 0.12],
  ["oak-coast-live-young", 0.3],
  ["eucalyptus", 0.15],
  ["oak-coast-live", 0.18],
];
const RIPARIAN: [AssetName, number][] = [
  ["oak-coast-live", 0.5],
  ["oak-coast-live-young", 0.3],
  ["shrub-scrub-oak", 0.2],
];
const HIGH_NORTH: [AssetName, number][] = [
  ["fir-bigcone-douglas", 0.45],
  ["pine-coulter", 0.3],
  ["shrub-chamise", 0.25],
];
const HIGH: [AssetName, number][] = [
  ["pine-coulter", 0.3],
  ["shrub-chamise", 0.45],
  ["shrub-manzanita", 0.25],
];
const SLOPE: [AssetName, number][] = [
  ["shrub-chamise", 0.45],
  ["shrub-scrub-oak", 0.25],
  ["shrub-manzanita", 0.2],
  ["oak-coast-live-young", 0.1],
];
const HOUSE_STYLES: [AssetName, number][] = [
  ["house-ranch", 0.35],
  ["house-craftsman", 0.25],
  ["house-spanish", 0.25],
  ["house-modern", 0.15],
];

export function layoutProps(grid: Grid, buildings: Building[], communities: Community[], lib: AssetLibrary): Layout {
  const { meta, data } = grid;
  const { width: W, height: H, cellSize: S } = meta;
  const items: Placement[] = [];
  const spans: WireSpan[] = [];
  const cls = (c: number) => data[c * GRID_CHANNELS + 3];
  const elevAt = (c: number) => data[c * GRID_CHANNELS];

  let minE = Infinity;
  let maxE = -Infinity;
  const building = new Uint8Array(W * H);
  const unburnable = new Uint8Array(W * H);
  for (let c = 0; c < W * H; c++) {
    const e = elevAt(c);
    minE = Math.min(minE, e);
    maxE = Math.max(maxE, e);
    building[c] = cls(c) === CellClass.Building ? 1 : 0;
    unburnable[c] = cls(c) === CellClass.Unburnable ? 1 : 0;
  }
  const town = dilate(building, W, H, 3);
  const nearWater = dilate(unburnable, W, H, 2);
  const eHigh = minE + 0.62 * (maxE - minE);

  const toWorld = (gx: number, gy: number): [number, number] => [(gx - (W - 1) / 2) * S, (gy - (H - 1) / 2) * S];
  const place = (asset: AssetName, gx: number, gy: number, r: number, rot: number, scale: number): Placement => {
    const [x, z] = toWorld(gx, gy);
    const variant = Math.floor(r * lib[asset].length) % lib[asset].length;
    const cell = cellIndex(meta, Math.min(W - 1, Math.max(0, Math.round(gx))), Math.min(H - 1, Math.max(0, Math.round(gy))));
    // 略微下沉，盖住双线性高程与三角形插值之间的细小差异
    const p = { asset, variant, x, z, elev: sampleElevation(grid, gx, gy) - 0.4, rot, scale, cell };
    items.push(p);
    return p;
  };

  // ---- 植被 ----
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const c = cellIndex(meta, x, y);
      if (cls(c) !== CellClass.Vegetation) continue;
      const fuel = data[c * GRID_CHANNELS + 1];
      const r0 = hash(c, 0);
      if (town[c]) {
        // 院落与街道树：稀疏
        if (r0 < 0.16) place(pick(hash(c, 1), TOWN_TREES), x + hash(c, 2) - 0.5, y + hash(c, 3) - 0.5, hash(c, 4), hash(c, 5) * Math.PI * 2, 0.85 + 0.3 * hash(c, 6));
        continue;
      }
      const e = elevAt(c);
      // 坡向：高程沿 +y（向南）增加 = 朝北的坡
      const northFacing = elevAt(c + W) - elevAt(c - W) > 0;
      const table = nearWater[c] ? RIPARIAN : e > eHigh ? (northFacing ? HIGH_NORTH : HIGH) : SLOPE;
      // chaparral 是连成一片的灌丛：每格最多 5 株，灌木在沙盘尺度下放大约 2 倍；连片的覆盖感主要由地表颜色表现，读起来才像覆盖而不是零星小点
      const n = Math.min(5, Math.floor(fuel * 4.2 + r0));
      for (let k = 0; k < n; k++) {
        const asset = pick(hash(c, 10 + k), table);
        const boost = asset.startsWith("shrub") ? 2.1 : 1;
        place(asset, x + hash(c, 20 + k) - 0.5, y + hash(c, 30 + k) - 0.5, hash(c, 40 + k), hash(c, 50 + k) * Math.PI * 2, boost * (0.8 + 0.4 * hash(c, 60 + k)));
      }
    }
  }

  // ---- 建筑 ----
  const [oE, oN] = meta.originUTM;
  const central = communities[Math.floor(communities.length / 2)];
  let fireIdx = -1;
  if (central?.cells.length) {
    let sx = 0;
    let sy = 0;
    for (const c of central.cells) {
      sx += c % W;
      sy += Math.floor(c / W);
    }
    const cx = sx / central.cells.length;
    const cy = sy / central.cells.length;
    let best = Infinity;
    buildings.forEach((b, i) => {
      const d = (b.cell % W - cx) ** 2 + (Math.floor(b.cell / W) - cy) ** 2;
      if (d < best) {
        best = d;
        fireIdx = i;
      }
    });
  }
  buildings.forEach((b, i) => {
    // 轮廓 → 连续格子坐标。轮廓是可选字段：缺失时以所在格子为中心，按典型独栋住宅尺寸（14 × 10 m）、随机 90° 朝向放置
    const pts = b.polygonLonLat?.length
      ? b.polygonLonLat.map(([lon, lat]) => {
          const [e, n] = lonLatToUTM(lon, lat);
          return new THREE.Vector2((e - oE) / S - 0.5, (oN - n) / S - 0.5);
        })
      : defaultFootprint(b.cell % W, Math.floor(b.cell / W), S, hash(b.cell, 11));
    const center = pts.reduce((a, p) => a.add(p), new THREE.Vector2()).divideScalar(pts.length);
    let longest = 0;
    let theta = 0;
    for (let k = 0; k < pts.length; k++) {
      const d = pts[(k + 1) % pts.length].clone().sub(pts[k]);
      if (d.length() > longest) {
        longest = d.length();
        theta = Math.atan2(d.y, d.x);
      }
    }
    const dir = new THREE.Vector2(Math.cos(theta), Math.sin(theta));
    const perp = new THREE.Vector2(-dir.y, dir.x);
    const ext = (v: THREE.Vector2) => {
      const ds = pts.map((p) => p.clone().sub(center).dot(v));
      return (Math.max(...ds) - Math.min(...ds)) * S;
    };
    const L = ext(dir);
    const Wd = ext(perp);
    const asset: AssetName = i === fireIdx ? "fire-station" : L * Wd > 500 ? "apartment-small" : pick(hash(b.cell, 7), HOUSE_STYLES);
    const variant = Math.floor(hash(b.cell, 8) * lib[asset].length);
    const box = lib[asset][variant].box;
    const mx = box.max.x - box.min.x;
    const mz = box.max.z - box.min.z;
    // 模型长边对齐轮廓长边；缩放限制在合理范围内，避免拉伸变形
    const modelLongIsX = mx >= mz;
    const s = asset === "fire-station" ? 1 : Math.min(1.3, Math.max(0.7, Math.min(L / Math.max(mx, mz), Wd / Math.min(mx, mz))));
    // 世界坐标中格子 y 对应 +z；绕 Y 轴旋转角 = -theta
    let rot = -theta + (modelLongIsX ? 0 : Math.PI / 2);
    if (hash(b.cell, 9) < 0.5) rot += Math.PI;
    place(asset, center.x, center.y, hash(b.cell, 10), rot, s);
  });

  // ---- 电力：沿山地的一条输电线 ----
  const towerAt = (gx: number, gy: number): Placement => place("transmission-tower", gx, gy, 0, Math.PI / 2, 1);
  const ty = Math.round(H * 0.42);
  let prev: Placement | null = null;
  for (let gx = 10; gx < W - 10; gx += 14) {
    const gy = ty + Math.round(5 * Math.sin(gx * 0.04));
    const t = towerAt(gx, gy);
    if (prev) spans.push(spanBetween(prev, t, lib));
    prev = t;
  }

  // ---- 电力：沿社区道路的配电杆 ----
  const roadRun = (len: number, at: (i: number) => number, fixed: number, horizontal: boolean) => {
    let start = -1;
    for (let i = 0; i <= len; i++) {
      const c = i < len ? at(i) : -1;
      const isRoad = c >= 0 && unburnable[c] && town[c];
      if (isRoad && start < 0) start = i;
      if ((!isRoad || i === len) && start >= 0) {
        if (i - start >= 16) {
          let last: Placement | null = null;
          for (let k = start + 1; k < i - 1; k += 4) {
            const gx = horizontal ? k : fixed + 1.4;
            const gy = horizontal ? fixed + 1.4 : k;
            // 横担要垂直于线路方向：模型横担沿 X，线路沿 X 时转 90°
            const p = place("utility-pole", gx, gy, 0, horizontal ? Math.PI / 2 : 0, 1);
            if (last) spans.push(spanBetween(last, p, lib));
            last = p;
          }
        }
        start = -1;
      }
    }
  };
  for (let y = 0; y < H; y++) {
    // 只取道路中心行：上一行也是道路、下一行不是道路时跳过，避免一条 3 格宽的路放三排杆
    const centerRow = (x: number) => unburnable[y * W + x] && (y + 1 >= H || unburnable[(y + 1) * W + x]) && (y === 0 || unburnable[(y - 1) * W + x]);
    roadRun(W, (x) => (centerRow(x) ? y * W + x : -1), y, true);
  }
  for (let x = 0; x < W; x++) {
    const centerCol = (y: number) => unburnable[y * W + x] && x + 1 < W && unburnable[y * W + x + 1] && x > 0 && unburnable[y * W + x - 1];
    roadRun(H, (y) => (centerCol(y) ? y * W + x : -1), x, false);
  }

  return { items, spans };
}

/** 没有建筑轮廓时的替代：以格子 (x, y) 为中心的 14 × 10 m 矩形（格子坐标），朝向取 0° 或 90° */
function defaultFootprint(x: number, y: number, cellSize: number, r: number): THREE.Vector2[] {
  const hl = 7 / cellSize;
  const hw = 5 / cellSize;
  const corners = [
    [-hl, -hw],
    [hl, -hw],
    [hl, hw],
    [-hl, hw],
  ];
  return corners.map(([dx, dy]) => (r < 0.5 ? new THREE.Vector2(x + dx, y + dy) : new THREE.Vector2(x + dy, y + dx)));
}

function attach(p: Placement, lib: AssetLibrary): THREE.Vector3[] {
  const pts = lib[p.asset][p.variant].wirePoints ?? [];
  const c = Math.cos(p.rot);
  const s = Math.sin(p.rot);
  // 与 shader 中的旋转一致：绕 Y 轴旋转 rot
  return pts.map((q) => new THREE.Vector3((q.x * c + q.z * s) * p.scale, q.y * p.scale, (-q.x * s + q.z * c) * p.scale));
}

function spanBetween(a: Placement, b: Placement, lib: AssetLibrary): WireSpan {
  return { a, b, pointsA: attach(a, lib), pointsB: attach(b, lib) };
}
