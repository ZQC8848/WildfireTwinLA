// 火情监测：从模拟状态推出每个社区离火线多远、按当前推进速度何时到达、有多少房屋受影响，并生成事件流。
// 全部来自模拟本身，不是假数据。到达时间只是"按当前推进速度"的外推，P3 的集合预报会给出更可靠的到达时间分布。

import type { Building, Community, Grid } from "@core";

export type Level = "clear" | "watch" | "warning" | "reached";

export interface CommunityStatus {
  id: string;
  name: string;
  /** 离最近燃烧格的距离（米）；没有火时为 Infinity */
  distanceM: number;
  /** 按当前推进速度外推的到达时间（分钟）；火在远离或推进太慢时为 null */
  etaMin: number | null;
  homes: number;
  homesAffected: number;
  level: Level;
}

export interface FireEvent {
  minutes: number;
  text: string;
  level: Level;
}

const WATCH_M = 3000;
const WARNING_M = 1000;
const LEVEL_ORDER: Level[] = ["clear", "watch", "warning", "reached"];

export class FireMonitor {
  communities: CommunityStatus[];
  events: FireEvent[] = [];
  totalHomes = 0;
  homesAffected = 0;
  private samples: number[][];
  private homeCells: number[][];
  private history: { minutes: number; distance: number; rate: number }[];

  constructor(
    private grid: Grid,
    communities: Community[],
    buildings: Building[],
  ) {
    const owner = new Map<number, number>();
    communities.forEach((c, i) => c.cells.forEach((cell) => owner.set(cell, i)));
    this.homeCells = communities.map(() => []);
    for (const b of buildings) {
      const i = owner.get(b.cell);
      if (i !== undefined) this.homeCells[i].push(b.cell);
    }
    // 每个社区抽样最多 300 个格子用于距离计算
    this.samples = communities.map((c) => {
      const stride = Math.max(1, Math.floor(c.cells.length / 300));
      return c.cells.filter((_, k) => k % stride === 0);
    });
    this.communities = communities.map((c, i) => ({
      id: c.id,
      name: c.name,
      distanceM: Infinity,
      etaMin: null,
      homes: this.homeCells[i].length,
      homesAffected: 0,
      level: "clear",
    }));
    this.totalHomes = this.homeCells.reduce((s, h) => s + h.length, 0);
    this.history = communities.map(() => ({ minutes: 0, distance: Infinity, rate: 0 }));
  }

  reset() {
    this.events = [];
    this.homesAffected = 0;
    this.communities.forEach((c, i) => {
      c.distanceM = Infinity;
      c.etaMin = null;
      c.homesAffected = 0;
      c.level = "clear";
      this.history[i] = { minutes: 0, distance: Infinity, rate: 0 };
    });
  }

  log(minutes: number, text: string, level: Level = "watch") {
    this.events.unshift({ minutes, text, level });
    if (this.events.length > 40) this.events.length = 40;
  }

  /** state：模拟读回的 RGBA 状态；burning：燃烧格抽样 */
  update(state: Float32Array, burning: number[], minutes: number) {
    const { width: W, cellSize: S } = this.grid.meta;
    // 燃烧格再抽样到最多 1024 个，距离计算量控制在 O(300 × 1024)
    const stride = Math.max(1, Math.ceil(burning.length / 1024));
    const bx: number[] = [];
    const by: number[] = [];
    for (let k = 0; k < burning.length; k += stride) {
      bx.push(burning[k] % W);
      by.push(Math.floor(burning[k] / W));
    }

    let affectedTotal = 0;
    this.communities.forEach((c, i) => {
      let best = Infinity;
      for (const cell of this.samples[i]) {
        const x = cell % W;
        const y = Math.floor(cell / W);
        for (let k = 0; k < bx.length; k++) {
          const d = (bx[k] - x) ** 2 + (by[k] - y) ** 2;
          if (d < best) best = d;
        }
      }
      const distance = bx.length ? Math.sqrt(best) * S : Infinity;
      const affected = this.homeCells[i].reduce((n, cell) => n + (state[cell * 4] > 0.5 ? 1 : 0), 0);
      affectedTotal += affected;

      // 推进速度：距离随模拟时间的变化率（米 / 分钟），指数平滑
      const h = this.history[i];
      if (Number.isFinite(distance) && Number.isFinite(h.distance) && minutes > h.minutes) {
        const r = (h.distance - distance) / (minutes - h.minutes);
        h.rate = h.rate ? 0.6 * h.rate + 0.4 * r : r;
      }
      h.minutes = minutes;
      h.distance = distance;

      const reached = affected > 0 || distance < S;
      const level: Level = reached ? "reached" : distance < WARNING_M ? "warning" : distance < WATCH_M ? "watch" : "clear";
      const before = c.level;
      c.distanceM = distance;
      c.homesAffected = affected;
      c.etaMin = !reached && h.rate > 1 ? distance / h.rate : null;
      c.level = level;

      if (LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(before)) {
        if (level === "watch") this.log(minutes, `Fire within 3 km of ${c.name}`, "watch");
        if (level === "warning") this.log(minutes, `Fire within 1 km of ${c.name}`, "warning");
        if (level === "reached") this.log(minutes, `Fire reached ${c.name}`, "reached");
      }
    });

    // 受影响房屋数跨过整百时记一条
    const prevHundreds = Math.floor(this.homesAffected / 100);
    const nowHundreds = Math.floor(affectedTotal / 100);
    if (nowHundreds > prevHundreds) this.log(minutes, `${nowHundreds * 100}+ homes in the fire area`, "reached");
    this.homesAffected = affectedTotal;
  }

  /** 最紧迫的社区：已到达优先，其次距离最近 */
  closest(): CommunityStatus | null {
    const active = this.communities.filter((c) => Number.isFinite(c.distanceM));
    if (!active.length) return null;
    return active.sort((a, b) => LEVEL_ORDER.indexOf(b.level) - LEVEL_ORDER.indexOf(a.level) || a.distanceM - b.distanceM)[0];
  }
}

export function formatMinutes(min: number): string {
  // 先取整再拆分，避免 59.6 分钟显示成 "60 min"
  const total = Math.round(min);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} h ${String(m).padStart(2, "0")} m` : `${m} min`;
}

export function formatDistance(m: number): string {
  if (!Number.isFinite(m)) return "No fire";
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`;
}
