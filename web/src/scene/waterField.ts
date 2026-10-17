// 河流与道路的有向距离场（SDF），用于在 shader 中画出平滑的岸线与路缘，代替 25 m 格子的方形台阶。
//
// 网格只有"不可燃"一个类别，水体、道路与城区铺装混在一起。这里按连通区域区分：
// - 高程不超过 SEA_LEVEL_M 的格子逐格判为海（真实数据的西南角是太平洋；海与沿岸城区的不可燃格常连成一片，不能按整片判断）
// - 合成网格（inferStreams）：大部分格子位于社区之外的区域视为河流（模仿峡谷溪流）
// - 真实数据：其余都视为道路与铺装。真实城区里大片的不可燃格是道路、停车场和硬化地面，按河流画会满屏水面
// 真实数据若提供单独的水体图层，可直接替换 classify。
//
// 输出 RGBA32F 纹理，每格：
//   R 到河岸的有向距离（米，水内为负）
//   G 到路缘的有向距离（米，路面内为负）
//   B, A 水流方向（网格坐标下的单位向量，沿下坡方向），只在河流附近有意义

import * as THREE from "three";
import { CellClass, GRID_CHANNELS, type Grid } from "@core";

const INF = 1e20;

/** Felzenszwalb & Huttenlocher 一维平方距离变换 */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) ** 2 + f[v[k]];
  }
}

/** 到 mask 为真的最近格子中心的欧氏距离（格） */
function distanceTo(mask: Uint8Array, W: number, H: number): Float64Array {
  const g = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = mask[i] ? 0 : INF;
  const n = Math.max(W, H);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = g[y * W + x];
    edt1d(f, H, d, v, z);
    for (let y = 0; y < H; y++) g[y * W + x] = d[y];
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = g[y * W + x];
    edt1d(f, W, d, v, z);
    for (let x = 0; x < W; x++) g[y * W + x] = Math.sqrt(d[x]);
  }
  return g;
}

/** 有向距离（米）：区域内为负，以格子边界（而不是格子中心）为零点 */
function signedDistance(mask: Uint8Array, W: number, H: number, cellSize: number): Float32Array {
  const inv = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) inv[i] = mask[i] ? 0 : 1;
  const out = distanceTo(mask, W, H);
  const inside = distanceTo(inv, W, H);
  const sdf = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) sdf[i] = (mask[i] ? -(inside[i] - 0.5) : out[i] - 0.5) * cellSize;
  return sdf;
}

function blur3(src: Float32Array, W: number, H: number, passes: number): Float32Array {
  let a = src;
  for (let p = 0; p < passes; p++) {
    const b = new Float32Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let s = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            s += a[yy * W + xx];
            n++;
          }
        b[y * W + x] = s / n;
      }
    a = b;
  }
  return a;
}

/** 把不可燃格子分成河流与道路 */
const SEA_LEVEL_M = 1;

export function classify(grid: Grid, inferStreams = true): { water: Uint8Array; road: Uint8Array } {
  const { width: W, height: H } = grid.meta;
  const cls = (i: number) => grid.data[i * GRID_CHANNELS + 3];
  // 社区范围：建筑格向外扩 3 格
  const building = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) building[i] = cls(i) === CellClass.Building ? 1 : 0;
  const town = new Uint8Array(W * H);
  const r = 3;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!building[y * W + x]) continue;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < W && yy < H) town[yy * W + xx] = 1;
        }
    }
  const water = new Uint8Array(W * H);
  const road = new Uint8Array(W * H);
  const seen = new Uint8Array(W * H);
  const stack: number[] = [];
  for (let s = 0; s < W * H; s++) {
    if (seen[s] || cls(s) !== CellClass.Unburnable) continue;
    // 4 连通的不可燃区域
    const comp: number[] = [];
    let inTown = 0;

    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      comp.push(c);
      inTown += town[c];

      const x = c % W;
      const y = Math.floor(c / W);
      for (const [nx, ny] of [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ]) {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (!seen[n] && cls(n) === CellClass.Unburnable) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    const isStream = inferStreams && inTown / comp.length < 0.5;
    for (const c of comp) (isStream || grid.data[c * GRID_CHANNELS] <= SEA_LEVEL_M ? water : road)[c] = 1;
  }
  return { water, road };
}

export function buildWaterTexture(grid: Grid, inferStreams = true): THREE.DataTexture {
  const { width: W, height: H, cellSize: S } = grid.meta;
  const { water, road } = classify(grid, inferStreams);
  // 两遍 3×3 平滑：等值线在格子角点处不再有尖角
  const sdfWater = blur3(signedDistance(water, W, H, S), W, H, 2);
  const sdfRoad = blur3(signedDistance(road, W, H, S), W, H, 1);

  // 水流方向：平滑高程的下坡方向
  const elev = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) elev[i] = grid.data[i * GRID_CHANNELS];
  const smooth = blur3(elev, W, H, 4);
  const data = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      data[i * 4] = sdfWater[i];
      data[i * 4 + 1] = sdfRoad[i];
      if (sdfWater[i] < 4 * S) {
        const gx = smooth[y * W + Math.min(W - 1, x + 1)] - smooth[y * W + Math.max(0, x - 1)];
        const gy = smooth[Math.min(H - 1, y + 1) * W + x] - smooth[Math.max(0, y - 1) * W + x];
        const len = Math.hypot(gx, gy) || 1;
        data[i * 4 + 2] = -gx / len;
        data[i * 4 + 3] = -gy / len;
      }
    }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}
