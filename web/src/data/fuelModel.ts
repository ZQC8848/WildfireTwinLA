// LANDFIRE FBFM40 燃料模型（可选文件 fuel-model.bin，每格 1 字节）。数据管线见 data-pipeline/wildfire_grid/fuels.py。
// 前端只用它做显示：地表配色、悬停标签、区域概况，以及判断水面；蔓延仍只读 grid.bin 的 fuel 与类别。

export enum FuelGroup {
  None = 0,
  Grass = 1,
  GrassShrub = 2,
  Shrub = 3,
  Timber = 4,
  Developed = 5,
  Water = 6,
  OtherNonburnable = 7,
}

export function fuelGroup(code: number): FuelGroup {
  if (code >= 101 && code <= 109) return FuelGroup.Grass;
  if (code >= 121 && code <= 124) return FuelGroup.GrassShrub;
  if (code >= 141 && code <= 149) return FuelGroup.Shrub;
  if ((code >= 161 && code <= 165) || (code >= 181 && code <= 189) || (code >= 201 && code <= 204)) return FuelGroup.Timber;
  if (code === 91) return FuelGroup.Developed;
  if (code === 98) return FuelGroup.Water;
  if (code >= 92 && code <= 99) return FuelGroup.OtherNonburnable;
  return FuelGroup.None;
}

const PREFIX: [number, number, string][] = [
  [101, 109, "GR"],
  [121, 124, "GS"],
  [141, 149, "SH"],
  [161, 165, "TU"],
  [181, 189, "TL"],
  [201, 204, "SB"],
];

/** 悬停标签，如 "Cured grass (GR3)" */
export function fuelModelName(code: number): string | null {
  const group = fuelGroup(code);
  const p = PREFIX.find(([a, b]) => code >= a && code <= b);
  const tag = p ? ` (${p[2]}${code - p[0] + 1})` : "";
  switch (group) {
    case FuelGroup.Grass:
      return `Cured grass${tag}`;
    case FuelGroup.GrassShrub:
      return `Grass and sage scrub${tag}`;
    case FuelGroup.Shrub:
      return `Chaparral${tag}`;
    case FuelGroup.Timber:
      return `Woodland${tag}`;
    case FuelGroup.Developed:
      return "Developed land";
    case FuelGroup.Water:
      return "Water";
    case FuelGroup.OtherNonburnable:
      return code === 93 ? "Agriculture" : "Barren";
    default:
      return null;
  }
}

/** 每格的燃料类别（FuelGroup），供地形 shader 采样 */
export function fuelGroups(model: Uint8Array): Uint8Array {
  const out = new Uint8Array(model.length);
  const lut = new Uint8Array(256);
  for (let c = 0; c < 256; c++) lut[c] = fuelGroup(c);
  for (let i = 0; i < model.length; i++) out[i] = lut[model[i]];
  return out;
}

/** 地表配色（Natural 图层），与图例共用 */
export const FUEL_GROUP_COLORS: Partial<Record<FuelGroup, string>> = {
  [FuelGroup.Grass]: "#c2a96a",
  [FuelGroup.GrassShrub]: "#8f8a58",
  [FuelGroup.Shrub]: "#4a5c36",
  [FuelGroup.Timber]: "#3d5034",
};
