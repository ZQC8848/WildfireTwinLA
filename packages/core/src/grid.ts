// 网格索引与坐标换算。所有模块统一调用这里，不各自实现。

import type { GridMeta } from "./types";

export function cellIndex(meta: GridMeta, x: number, y: number): number {
  return y * meta.width + x;
}

export function cellXY(meta: GridMeta, cell: number): [number, number] {
  return [cell % meta.width, Math.floor(cell / meta.width)];
}

// UTM 正反算（WGS84，Snyder 1987 级数展开），网格固定为 11N 区。
const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);
const K0 = 0.9996;
const ZONE = 11;
const LON0 = ((ZONE - 1) * 6 - 180 + 3) * (Math.PI / 180);
const DEG = Math.PI / 180;

function meridianArc(phi: number): number {
  const e4 = E2 * E2;
  const e6 = e4 * E2;
  return (
    A *
    ((1 - E2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi -
      ((3 * E2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi) +
      ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi) -
      ((35 * e6) / 3072) * Math.sin(6 * phi))
  );
}

export function lonLatToUTM(lon: number, lat: number): [number, number] {
  const phi = lat * DEG;
  const sin = Math.sin(phi);
  const cos = Math.cos(phi);
  const tan = Math.tan(phi);
  const n = A / Math.sqrt(1 - E2 * sin * sin);
  const t = tan * tan;
  const c = EP2 * cos * cos;
  const a = cos * (lon * DEG - LON0);
  const m = meridianArc(phi);
  const easting =
    K0 * n * (a + ((1 - t + c) * a ** 3) / 6 + ((5 - 18 * t + t * t + 72 * c - 58 * EP2) * a ** 5) / 120) + 500000;
  const northing =
    K0 *
    (m +
      n *
        tan *
        ((a * a) / 2 +
          ((5 - t + 9 * c + 4 * c * c) * a ** 4) / 24 +
          ((61 - 58 * t + t * t + 600 * c - 330 * EP2) * a ** 6) / 720));
  return [easting, northing];
}

export function utmToLonLat(easting: number, northing: number): [number, number] {
  const x = easting - 500000;
  const m = northing / K0;
  const mu = m / (A * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const sin = Math.sin(phi1);
  const cos = Math.cos(phi1);
  const tan = Math.tan(phi1);
  const c1 = EP2 * cos * cos;
  const t1 = tan * tan;
  const n1 = A / Math.sqrt(1 - E2 * sin * sin);
  const r1 = (A * (1 - E2)) / (1 - E2 * sin * sin) ** 1.5;
  const d = x / (n1 * K0);
  const lat =
    phi1 -
    ((n1 * tan) / r1) *
      ((d * d) / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * EP2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * EP2 - 3 * c1 * c1) * d ** 6) / 720);
  const lon =
    LON0 +
    (d - ((1 + 2 * t1 + c1) * d ** 3) / 6 + ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * EP2 + 24 * t1 * t1) * d ** 5) / 120) /
      cos;
  return [lon / DEG, lat / DEG];
}

/** 经纬度 → 格子索引；落在网格外返回 -1 */
export function lonLatToCell(meta: GridMeta, lon: number, lat: number): number {
  const [e, n] = lonLatToUTM(lon, lat);
  const x = Math.floor((e - meta.originUTM[0]) / meta.cellSize);
  const y = Math.floor((meta.originUTM[1] - n) / meta.cellSize);
  if (x < 0 || y < 0 || x >= meta.width || y >= meta.height) return -1;
  return cellIndex(meta, x, y);
}

/** 格子索引 → 格子中心经纬度 */
export function cellToLonLat(meta: GridMeta, cell: number): [number, number] {
  const [x, y] = cellXY(meta, cell);
  return utmToLonLat(meta.originUTM[0] + (x + 0.5) * meta.cellSize, meta.originUTM[1] - (y + 0.5) * meta.cellSize);
}
