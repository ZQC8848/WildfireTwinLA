// 前端内置的 Norte 回放：在 Tia 的 server/data/norte-replay.jsonl 就绪前，用仓库里存档的公开原始数据
// （data/norte/raw/）现场拼出同格式的事件序列。消息格式与后端回放文件一致，交给 normalize() 处理。
// - 起火：NIFC WFIGS 的 NORTE 与 MIRADA 两处报告点（source "REPORT"）
// - 火点：FIRMS VIIRS NRT，每次卫星过境一条 hotspots 事件；去掉起火前的数据与填埋场的固定热源
// - 风：HRRR 5×5 逐小时（由北向南、由西向东，与 core 的 WindField 一致）
// 没有官方疏散令的确切发布时间，也还没有官方火界，因此暂不生成这两类事件，避免编造。

import j1 from "../../../data/norte/raw/firms_viirs_J1_48h_2026-10-17.csv?raw";
import j2 from "../../../data/norte/raw/firms_viirs_J2_48h_2026-10-17.csv?raw";
import npp from "../../../data/norte/raw/firms_viirs_N_48h_2026-10-17.csv?raw";
import hrrr from "../../../data/norte/raw/hrrr_5x5_2026-10-15_17.json";
import { NORTE_BBOX, NORTE_IGNITIONS } from "../data/norte";
import { REPLAY_MINUTES_PER_SECOND } from "./replayClock";

/** 回放覆盖起火后 6.5 小时（到 10-16 18:00 PDT 左右），风在傍晚明显减弱 */
const WINDOW_MS = 6.5 * 3600 * 1000;
/** Prima Deshecha 填埋场：起火前的夜里也有弱火点，是固定热源 */
const LANDFILL = { lat: 33.4905, lon: -117.6185, radiusM: 750 };
const CONFIDENCE: Record<string, number> = { low: 0.3, nominal: 0.6, high: 0.9 };

const iso = (t: number) => new Date(t).toISOString();

function distanceM(lat1: number, lon1: number, lat2: number, lon2: number) {
  const k = Math.PI / 180;
  const x = (lon2 - lon1) * k * Math.cos(((lat1 + lat2) / 2) * k);
  const y = (lat2 - lat1) * k;
  return Math.hypot(x, y) * 6371000;
}

interface Pixel {
  lat: number;
  lon: number;
  time: number;
  frp: number;
  conf: number;
  satellite: string;
}

function parseFirms(csv: string): Pixel[] {
  const [head, ...rows] = csv.trim().split("\n");
  const col = Object.fromEntries(head.split(",").map((k, i) => [k, i]));
  return rows.map((line) => {
    const f = line.split(",");
    const hhmm = f[col.acq_time].padStart(4, "0");
    return {
      lat: Number(f[col.latitude]),
      lon: Number(f[col.longitude]),
      time: Date.parse(`${f[col.acq_date]}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`),
      frp: Number(f[col.frp]),
      conf: CONFIDENCE[f[col.confidence]] ?? 0.5,
      satellite: f[col.satellite],
    };
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildNorteReplay(): any[] {
  const t0 = NORTE_IGNITIONS[0]?.time;
  if (!t0) return [];
  const t1 = t0 + WINDOW_MS;
  const [west, south, east, north] = NORTE_BBOX;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const events: { t: number; msg: any }[] = [];
  const push = (t: number, msg: object) => events.push({ t, msg: { ...msg, emittedAt: iso(t) } });

  push(t0, { type: "snapshot", mode: "replay", event: "norte", dataset: "public-nrt-2026-10-16 (bundled)", incidents: [], wind: null });

  // 逐小时风：起火所在小时的风在起火时刻发出，其余按整点
  const times = hrrr.points[0].hourly.time.map((s: string) => Date.parse(`${s}:00Z`));
  for (let i = 0; i < times.length; i++) {
    const hourEnd = times[i] + 3600 * 1000;
    if (hourEnd <= t0 || times[i] > t1) continue;
    const t = Math.max(t0, times[i]);
    const samples = hrrr.points.map((p) => ({ speedMs: p.hourly.wind_speed_10m[i], dirFromDeg: p.hourly.wind_direction_10m[i] }));
    push(t, { type: "wind", t: iso(t), width: 5, height: 5, samples });
  }

  // 两处报告起火点
  for (const ig of NORTE_IGNITIONS) {
    const id = `report-${ig.name.toLowerCase()}`;
    push(ig.time, { type: "hotspots", items: [{ id, lon: ig.lon, lat: ig.lat, t: iso(ig.time), frp: 0, conf: 1, source: "REPORT" }] });
    push(ig.time, { type: "incident", id: `norte-${ig.name.toLowerCase()}`, hotspotIds: [id], centroid: [ig.lon, ig.lat], latestAt: iso(ig.time) });
  }

  // 卫星过境：同一颗卫星同一时刻的像元归为一次过境
  const passes = new Map<string, Pixel[]>();
  for (const p of [...parseFirms(npp), ...parseFirms(j1), ...parseFirms(j2)]) {
    if (p.time < t0 || p.time > t1) continue;
    if (p.lon < west || p.lon > east || p.lat < south || p.lat > north) continue;
    if (distanceM(p.lat, p.lon, LANDFILL.lat, LANDFILL.lon) < LANDFILL.radiusM) continue;
    const key = `${p.satellite}@${p.time}`;
    passes.set(key, [...(passes.get(key) ?? []), p]);
  }
  for (const [key, pixels] of passes) {
    const t = pixels[0].time;
    push(t, {
      type: "hotspots",
      items: pixels.map((p, i) => ({ id: `${key}#${i}`, lon: p.lon, lat: p.lat, t: iso(t), frp: p.frp, conf: p.conf, source: "VIIRS", satellite: p.satellite })),
    });
  }

  // 同一时刻保持插入顺序（快照 → 风 → 火点 → 事件）
  return events
    .map((e, i) => ({ ...e, i }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((e, sequence) => ({ ...e.msg, sequence, offsetSeconds: (e.t - t0) / 60000 / REPLAY_MINUTES_PER_SECOND }));
}
