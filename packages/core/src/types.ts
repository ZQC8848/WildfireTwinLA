export interface GridMeta {
  width: number;
  height: number;
  cellSize: number;
  crs: "EPSG:32611";
  originUTM: [number, number];
  bboxLonLat: [number, number, number, number];
}

export const GRID_CHANNELS = 4;

export const CellClass = {
  Unburnable: 0,
  Vegetation: 1,
  Building: 2,
} as const;
export type CellClass = (typeof CellClass)[keyof typeof CellClass];

export interface Grid {
  meta: GridMeta;
  data: Float32Array;
}

export interface Building {
  id: string;
  cell: number;
  weight: number;
  polygonLonLat?: [number, number][];
}

export interface Community {
  id: string;
  name: string;
  cells: number[];
}

export interface Wind {
  speedMs: number;
  dirFromDeg: number;
}

// Row-major samples, north to south. Interpolation uses velocity components.
export type WindField = Wind | { width: number; height: number; samples: Wind[] };

export interface WindScenario {
  id: string;
  probability: number;
  wind: WindField;
  ignitions: number[];
  horizonMinutes: number;
}

export type TreatmentType = "break" | "burn" | "thin" | "zone0";

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

export interface Metrics {
  /** Expected ember-exposed home count; synthetic planning proxy, not alert probability. */
  buildingsThreatened: number;
  burnedAreaHa: number;
  cost: number;
  lossPerDollar: number;
}

export interface PlanRequest {
  budget: number;
  fixed: Treatment[];
  scenarios: WindScenario[];
}

export interface ArrivalOptions {
  /** Resolution of the GPU CA being approximated, even on a coarser planning grid. */
  referenceCellSize?: number;
  /** Dimensionless fit to paired CA arrivals. 1 is uncalibrated. */
  timeScale?: number;
  spotting?: boolean;
}

export interface PlannerDiagnostics {
  iterations: number;
  spent: number;
  stopReason: "no-beneficial-candidate" | "budget-exhausted" | "iteration-limit";
  evaluatedCandidates: number;
}

export interface CoreOptions {
  buildings?: Building[];
  spread?: ArrivalOptions;
  /** Initial exact candidate solves per iteration (24); no-gain fallback can add 3×. */
  candidateLimit?: number;
  /** Additional odd strip lengths; defaults include 5, 11 and 21 cells. */
  stripLengths?: number[];
  allowed?: (type: TreatmentType, cell: number) => boolean;
  cost?: (type: TreatmentType, cell: number) => number;
  stripLength?: number;
  maxIterations?: number;
}

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
