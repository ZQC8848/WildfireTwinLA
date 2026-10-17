// 格子与世界坐标的换算。顶点位于格子中心：x 向东，z 向南，原点在网格中心。

import * as THREE from "three";
import { GRID_CHANNELS, cellIndex, type Grid, type GridMeta } from "@core";

export function cellToWorld(meta: GridMeta, x: number, y: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set((x - (meta.width - 1) / 2) * meta.cellSize, 0, (y - (meta.height - 1) / 2) * meta.cellSize);
}

/** 世界坐标 → 连续格子坐标（未取整） */
export function worldToGrid(meta: GridMeta, wx: number, wz: number): [number, number] {
  return [wx / meta.cellSize + (meta.width - 1) / 2, wz / meta.cellSize + (meta.height - 1) / 2];
}

/** 世界坐标 → 格子索引；落在网格外返回 -1 */
export function worldToCell(meta: GridMeta, wx: number, wz: number): number {
  const [gx, gy] = worldToGrid(meta, wx, wz);
  const x = Math.round(gx);
  const y = Math.round(gy);
  if (x < 0 || y < 0 || x >= meta.width || y >= meta.height) return -1;
  return cellIndex(meta, x, y);
}

/** 双线性插值高程（米） */
export function sampleElevation(grid: Grid, gx: number, gy: number): number {
  const { width, height } = grid.meta;
  const x = Math.min(Math.max(gx, 0), width - 1);
  const y = Math.min(Math.max(gy, 0), height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const e = (xx: number, yy: number) => grid.data[(yy * width + xx) * GRID_CHANNELS];
  const a = e(x0, y0) + (e(x1, y0) - e(x0, y0)) * fx;
  const b = e(x0, y1) + (e(x1, y1) - e(x0, y1)) * fx;
  return a + (b - a) * fy;
}
