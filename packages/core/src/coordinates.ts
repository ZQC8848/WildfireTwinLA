import type { GridMeta } from "./types.ts";

// WGS84 transverse Mercator, fixed UTM zone 11 north, central meridian -117°.
const A = 6378137;
const E2 = 0.0066943799901413165;
const K0 = 0.9996;
const EP2 = E2 / (1 - E2);
const RAD = Math.PI / 180;

export function lonLatToUTM(lon: number, lat: number): [number, number] {
  const phi = lat * RAD;
  const longitudeDelta = (lon + 117) * RAD;
  const sin = Math.sin(phi);
  const cos = Math.cos(phi);
  const tan = Math.tan(phi);
  const n = A / Math.sqrt(1 - E2 * sin ** 2);
  const t = tan ** 2;
  const c = EP2 * cos ** 2;
  const projected = cos * longitudeDelta;
  const meridian =
    A *
    ((1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256) * phi -
      (3 * E2 / 8 + (3 * E2 ** 2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * phi) +
      ((15 * E2 ** 2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * phi) -
      ((35 * E2 ** 3) / 3072) * Math.sin(6 * phi));
  return [
    500000 +
      K0 *
        n *
        (projected +
          ((1 - t + c) * projected ** 3) / 6 +
          ((5 - 18 * t + t ** 2 + 72 * c - 58 * EP2) * projected ** 5) / 120),
    K0 *
      (meridian +
        n *
          tan *
          (projected ** 2 / 2 +
            ((5 - t + 9 * c + 4 * c ** 2) * projected ** 4) / 24 +
            ((61 - 58 * t + t ** 2 + 600 * c - 330 * EP2) * projected ** 6) / 720)),
  ];
}

export function utmToLonLat(easting: number, northing: number): [number, number] {
  const x = easting - 500000;
  const meridian = northing / K0;
  const mu = meridian / (A * (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi =
    mu +
    (3 * e1 / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    (21 * e1 ** 2 / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    (151 * e1 ** 3 / 96) * Math.sin(6 * mu) +
    (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const sin = Math.sin(phi);
  const cos = Math.cos(phi);
  const tan = Math.tan(phi);
  const c = EP2 * cos ** 2;
  const t = tan ** 2;
  const n = A / Math.sqrt(1 - E2 * sin ** 2);
  const radius = (A * (1 - E2)) / (1 - E2 * sin ** 2) ** 1.5;
  const d = x / (n * K0);
  const lat =
    phi -
    (n * tan) /
      radius *
      (d ** 2 / 2 -
        ((5 + 3 * t + 10 * c - 4 * c ** 2 - 9 * EP2) * d ** 4) / 24 +
        ((61 + 90 * t + 298 * c + 45 * t ** 2 - 252 * EP2 - 3 * c ** 2) * d ** 6) / 720);
  const lon =
    -117 * RAD +
    (d -
      ((1 + 2 * t + c) * d ** 3) / 6 +
      ((5 - 2 * c + 28 * t - 3 * c ** 2 + 8 * EP2 + 24 * t ** 2) * d ** 5) / 120) /
      cos;
  return [lon / RAD, lat / RAD];
}

export function lonLatToCell(meta: GridMeta, lon: number, lat: number): number {
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -120 || lon > -114 || lat < 0 || lat > 84) {
    throw Error("Outside UTM 11N");
  }
  const [easting, northing] = lonLatToUTM(lon, lat);
  const x = Math.floor((easting - meta.originUTM[0]) / meta.cellSize);
  const y = Math.floor((meta.originUTM[1] - northing) / meta.cellSize);
  return x < 0 || y < 0 || x >= meta.width || y >= meta.height ? -1 : y * meta.width + x;
}

export function cellToLonLat(meta: GridMeta, cell: number): [number, number] {
  if (!Number.isInteger(cell) || cell < 0 || cell >= meta.width * meta.height) {
    throw Error("Invalid cell");
  }
  const easting = meta.originUTM[0] + ((cell % meta.width) + 0.5) * meta.cellSize;
  const northing = meta.originUTM[1] - (Math.floor(cell / meta.width) + 0.5) * meta.cellSize;
  return utmToLonLat(easting, northing);
}
