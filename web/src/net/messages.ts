// 后端推送消息的规范化。后端的消息格式仍在演进（见 issue #6），这里统一转换成前端使用的形式：
// - 风：兼容旧格式 grid5x5（后端当前按由南向北排列，需要翻转）与 core 的新格式 { width, height, samples }（由北向南）
// - 火点：不用后端算的格子号，按经纬度用前端自己的网格重新换算，避免两边网格不一致
// - 时间统一为毫秒时间戳

import { lonLatToCell, type GridMeta, type Wind, type WindField } from "@core";

export type FeedLevel = "watch" | "warning" | "imminent";

export interface FeedHotspot {
  id: string;
  cell: number;
  lon: number;
  lat: number;
  time: number;
  frp: number;
  conf: number;
  source: string;
  /** 卫星（FIRMS 的 N、N20、N21 等），报告起火点没有 */
  satellite?: string;
}

export type FeedEvent =
  | { kind: "snapshot"; time: number; mode: string; dataset?: string }
  | { kind: "wind"; time: number; field: WindField; mean: Wind }
  | { kind: "hotspots"; time: number; items: FeedHotspot[] }
  | { kind: "incident"; time: number; id: string; perimeterCells: number[] | null; perimeterLabel?: string; perimeterOfficial?: boolean }
  | { kind: "alert"; time: number; communityId: string; level: FeedLevel; etaMin: number }
  | { kind: "official"; time: number; communityId: string; level: string; headline: string }
  | { kind: "call"; time: number; buildingId: string; status: string }
  | { kind: "error"; time: number; detail: string };

const ts = (v: unknown, fallback: number) => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : fallback;
};

/** 速度分量上的平均风，作为地形风场的来流 */
function meanWind(samples: Wind[]): Wind {
  let east = 0;
  let north = 0;
  for (const s of samples) {
    const d = (s.dirFromDeg * Math.PI) / 180;
    east -= s.speedMs * Math.sin(d);
    north -= s.speedMs * Math.cos(d);
  }
  east /= samples.length;
  north /= samples.length;
  return { speedMs: Math.hypot(east, north), dirFromDeg: ((Math.atan2(-east, -north) * 180) / Math.PI + 360) % 360 };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalize(raw: any, meta: GridMeta, now = Date.now()): FeedEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const time = ts(raw.t ?? raw.emittedAt, now);
  switch (raw.type) {
    case "snapshot":
      return { kind: "snapshot", time, mode: String(raw.mode ?? ""), dataset: raw.dataset };
    case "wind": {
      let field: { width: number; height: number; samples: Wind[] };
      if (Array.isArray(raw.samples) && raw.width && raw.height) {
        field = { width: raw.width, height: raw.height, samples: raw.samples };
      } else if (Array.isArray(raw.grid5x5) && raw.grid5x5.length === 25) {
        // 旧格式：后端 sampling_grid 第 0 行在最南边，翻转成 core 约定的由北向南
        const rows: Wind[][] = [];
        for (let r = 0; r < 5; r++) rows.push(raw.grid5x5.slice(r * 5, r * 5 + 5).map(([s, d]: [number, number]) => ({ speedMs: s, dirFromDeg: d })));
        field = { width: 5, height: 5, samples: rows.reverse().flat() };
      } else return null;
      return { kind: "wind", time, field, mean: meanWind(field.samples) };
    }
    case "hotspots": {
      const items: FeedHotspot[] = [];
      for (const h of raw.items ?? []) {
        const cell = lonLatToCell(meta, h.lon, h.lat);
        if (cell < 0) continue; // 不在本区域内
        items.push({ id: String(h.id), cell, lon: h.lon, lat: h.lat, time: ts(h.t, time), frp: Number(h.frp) || 0, conf: Number(h.conf) || 0, source: String(h.source ?? ""), satellite: h.satellite ? String(h.satellite) : undefined });
      }
      return { kind: "hotspots", time, items };
    }
    case "incident":
      return {
        kind: "incident",
        time,
        id: String(raw.id),
        perimeterCells: Array.isArray(raw.perimeterCells) ? raw.perimeterCells : null,
        // 火界来源：官方火界、卫星烧痕或卫星检测范围；没有说明时按官方处理（旧格式）
        perimeterLabel: typeof raw.perimeterLabel === "string" ? raw.perimeterLabel : undefined,
        perimeterOfficial: typeof raw.perimeterOfficial === "boolean" ? raw.perimeterOfficial : undefined,
      };
    case "alert":
      return { kind: "alert", time, communityId: String(raw.communityId), level: raw.level, etaMin: Number(raw.etaMin) };
    case "official_order":
      return { kind: "official", time, communityId: String(raw.communityId), level: String(raw.level), headline: String(raw.headline ?? "") };
    case "call_status":
      return { kind: "call", time, buildingId: String(raw.buildingId ?? ""), status: String(raw.status) };
    case "error":
      return { kind: "error", time, detail: String(raw.detail ?? "error") };
    default:
      return null;
  }
}
