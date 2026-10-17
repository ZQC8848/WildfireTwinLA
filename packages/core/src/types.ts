// 跨模块接口类型，见 docs/team-plan.md 第三节。改动需三人同意。

/** 约定 1：网格元数据（public/data/grid.json） */
export interface GridMeta {
  width: number;
  height: number;
  /** 每格边长（米） */
  cellSize: number;
  crs: "EPSG:32611";
  /** 网格左上角（西北角）的 UTM 坐标 [easting, northing] */
  originUTM: [number, number];
  /** [west, south, east, north] */
  bboxLonLat: [number, number, number, number];
}

/** 每格 4 个 Float32：[elevation, fuel, dryness, class] */
export const GRID_CHANNELS = 4;

export const CellClass = {
  Unburnable: 0,
  Vegetation: 1,
  Building: 2,
} as const;
export type CellClass = (typeof CellClass)[keyof typeof CellClass];

export interface Grid {
  meta: GridMeta;
  /** Float32Array(width * height * 4)；cell = y * width + x，y 由北向南 */
  data: Float32Array;
}

export interface Building {
  id: string;
  cell: number;
  weight: number;
  polygonLonLat: [number, number][];
}

export interface Community {
  id: string;
  name: string;
  cells: number[];
}

/** 约定 3：处理方案 */
export type TreatmentType = "break" | "burn" | "thin" | "zone0";

/** 处理掩膜中的编码：0 表示无处理 */
export const TreatmentCode: Record<TreatmentType, number> = {
  break: 1,
  burn: 2,
  thin: 3,
  zone0: 4,
};

export interface Treatment {
  type: TreatmentType;
  cells: Uint32Array;
  cost: number;
  source: "user" | "greedy" | "mincut";
}

/** 5×5 风场采样，按行优先、由北向南 */
export interface WindField {
  /** 每个采样点 [风速 m/s, 风的来向（度，气象惯例，0 为北风）] */
  grid5x5: [speedMs: number, dirFromDeg: number][];
}

export interface WindScenario {
  name: string;
  weight: number;
  wind: WindField;
}

export interface Metrics {
  buildingsThreatened: number;
  burnedAreaHa: number;
  cost: number;
  lossPerDollar: number;
}

/** 约定 4：后端推送消息 */
export interface Hotspot {
  id: string;
  cell: number;
  lon: number;
  lat: number;
  t: string;
  frp: number;
  conf: number;
  source: "VIIRS" | "MODIS" | "GOES";
}

export type AlertLevel = "watch" | "warning" | "imminent";
export type CallStatus = "confirmed" | "no_answer" | "needs_help";

export type ServerMsg =
  | { type: "hotspots"; items: Hotspot[] }
  | { type: "incident"; id: string; hotspotIds: string[]; perimeterCells?: number[] }
  | { type: "wind"; t: string; grid5x5: [speedMs: number, dirFromDeg: number][] }
  | { type: "alert"; communityId: string; level: AlertLevel; etaMin: number }
  | { type: "call_status"; buildingId: string; status: CallStatus };
