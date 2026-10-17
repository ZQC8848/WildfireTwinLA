// Norte Fire（2026-10-16，南橙县）：演示区域、两处报告起火点与 Plan 的默认情景。见 docs/norte-fire.md。

import { lonLatToCell, type GridMeta } from "@core";
import incidents from "../../../data/norte/raw/wfigs_incidents_2026-10-17.json";

/** 目标范围（WGS84）：以 33.485, −117.645 为中心的 12.8 km 方框 */
export const NORTE_BBOX: [number, number, number, number] = [-117.714, 33.427, -117.576, 33.543];

export interface ReportedIgnition {
  name: string;
  lon: number;
  lat: number;
  /** 发现时刻（毫秒时间戳） */
  time: number;
}

/** NIFC WFIGS 记录的两处起火点，按时间排序：NORTE（11:32 PDT）与下风 2.4 km 的 MIRADA（12:20 PDT） */
export const NORTE_IGNITIONS: ReportedIgnition[] = incidents
  .map((r) => ({ name: r.IncidentName, lon: r.InitialLongitude, lat: r.InitialLatitude, time: r.FireDiscoveryDateTime }))
  .sort((a, b) => a.time - b.time);

/** Plan 默认情景：NORTE 起火点，10-16 中午 HRRR 平均风（ENE 75°，8.5 m/s） */
export const NORTE_SCENARIO = {
  label: "the Norte Fire ignition point",
  windFrom: 75,
  windSpeed: 8.5,
};

/** 起火点所在格（不在网格内时为空） */
export function norteIgnitionCells(meta: GridMeta): number[] {
  const first = NORTE_IGNITIONS[0];
  if (!first) return [];
  const c = lonLatToCell(meta, first.lon, first.lat);
  return c < 0 ? [] : [c];
}
