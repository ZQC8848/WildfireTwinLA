// 地表图层定义：shader 与图例共用同一份色带。

export type LayerId = "natural" | "elevation" | "fuel" | "dryness" | "class";

export interface LayerDef {
  label: string;
  /** shader 中的图层编号 */
  code: number;
  /** 4 段均匀色带，从低到高 */
  ramp?: [string, string, string, string];
  rampLabels?: [string, string];
  swatches?: { label: string; color: string }[];
}

export const CLASS_COLORS = {
  unburnable: "#59626b",
  vegetation: "#4f8a3c",
  building: "#e8e4da",
};

export const LAYERS: Record<LayerId, LayerDef> = {
  natural: {
    label: "Natural",
    code: 0,
    swatches: [
      { label: "Dense chaparral", color: "#3d5a2c" },
      { label: "Sparse / dry grass", color: "#a89a63" },
      { label: "Neighborhoods", color: "#9c9a84" },
      { label: "Streams", color: "#3f5f6a" },
      { label: "Roads", color: "#59626b" },
    ],
  },
  elevation: {
    label: "Elevation",
    code: 1,
    ramp: ["#4a7a4c", "#c8b77a", "#8a5a3c", "#f2efe9"],
    rampLabels: ["low", "high"],
  },
  fuel: {
    label: "Fuel load",
    code: 2,
    ramp: ["#f6f1d1", "#9cc36a", "#2e6b2f", "#0f3d1a"],
    rampLabels: ["0 (none)", "1 (heavy)"],
  },
  dryness: {
    label: "Dryness",
    code: 3,
    ramp: ["#2c6fb0", "#f2e6b0", "#d9822b", "#8c2d04"],
    rampLabels: ["0 (moist)", "1 (dry)"],
  },
  class: {
    label: "Land class",
    code: 4,
    swatches: [
      { label: "Vegetation", color: CLASS_COLORS.vegetation },
      { label: "Building", color: CLASS_COLORS.building },
      { label: "Unburnable", color: CLASS_COLORS.unburnable },
    ],
  },
};
