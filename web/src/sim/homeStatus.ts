// 逐栋房屋的状态：着火、烧毁、受威胁。供房屋冒泡提示（ui/homeAlerts.ts）与屋顶火苗（scene/houseFlames.ts）使用。
// - 着火 / 烧毁：读房屋所在格的模拟状态；回看过去时按着火时刻判断，与房屋模型（propMaterial 的 stateAt）一致
// - 受威胁（只在当前时刻判断）：
//   有集合预报时，取预报中该格一半以上成员会烧到、且中位到达时间在 THREAT_WINDOW_MIN 之内的房屋；
//   没有预报时，取下风方向 THREAT_DISTANCE_M 内（或任意方向 CLOSE_DISTANCE_M 内）有燃烧格的房屋，到达时间按火线推进速度估算，
//   能估算时只保留 NEAR_WINDOW_MIN 内会到达的。范围取得较窄：长火线旁的房屋很多，太宽会让提示失去重点

import * as THREE from "three";
import type { Building, Community, Grid } from "@core";
import { ENSEMBLE_FACTOR, type EnsembleResult } from "./ensemble";

export type HomeState = "burning" | "burned" | "threat";

export interface HomeAlert {
  /** buildings 数组中的序号 */
  id: number;
  state: HomeState;
  /** 冒泡锚点（世界坐标，屋顶上方） */
  anchor: THREE.Vector3;
  /** 状态开始的墙钟时间（performance.now），用于弹出动画 */
  since: number;
  /** 着火时刻（模拟分钟） */
  ignitedMin?: number;
  /** 预计多少分钟后火到达（受威胁） */
  etaMin?: number;
  /** 未来 8 小时被烧到的概率（有预报时） */
  chance?: number;
  /** 最近燃烧格的距离（米，没有预报时的受威胁判断） */
  distanceM?: number;
  community?: string;
  hardened: boolean;
}

const THREAT_WINDOW_MIN = 120;
const THREAT_DISTANCE_M = 250;
const CLOSE_DISTANCE_M = 100;
const NEAR_WINDOW_MIN = 60;

export interface HomeStatusInput {
  state: Float32Array;
  /** 显示时刻；live 为 false 时表示在回看过去 */
  viewMinutes: number;
  live: boolean;
  nowMinutes: number;
  stepMinutes: number;
  forecast: EnsembleResult | null;
  /** 下风方向（网格坐标单位向量）；风很小时为 null */
  downwind: [number, number] | null;
  /** 火线推进速度（米 / 模拟分钟），用于没有预报时估算到达时间 */
  spreadRate: number;
  treatMask: Uint8Array;
}

export class HomeStatus {
  readonly alerts: HomeAlert[] = [];
  private prev = new Map<number, { state: HomeState; since: number }>();
  private communityOf: Int16Array;
  private nearest: Int32Array;
  private dist: Float32Array;

  constructor(
    private grid: Grid,
    private buildings: Building[],
    /** 每栋房屋冒泡的锚点（世界坐标，屋顶上方） */
    private anchors: THREE.Vector3[],
    private communities: Community[],
  ) {
    const n = grid.meta.width * grid.meta.height;
    this.communityOf = new Int16Array(n).fill(-1);
    communities.forEach((c, i) => c.cells.forEach((cell) => (this.communityOf[cell] = i)));
    this.nearest = new Int32Array(n);
    this.dist = new Float32Array(n);
  }

  update(input: HomeStatusInput): HomeAlert[] {
    const { state, viewMinutes: T, live, stepMinutes } = input;
    const now = performance.now();
    const threats = live ? this.threats(input) : null;
    this.alerts.length = 0;
    const seen = new Set<number>();
    this.buildings.forEach((b, i) => {
      const r = state[b.cell * 4];
      const arrival = state[b.cell * 4 + 2];
      let s: HomeState | null = null;
      if (r > 0.5 && arrival <= T + 1e-3) {
        s = live ? (r > 1.5 ? "burned" : "burning") : T - arrival < 3 * stepMinutes ? "burning" : "burned";
      } else if (threats?.has(i)) {
        s = "threat";
      }
      if (!s) return;
      seen.add(i);
      const p = this.prev.get(i);
      const since = p && p.state === s ? p.since : now;
      this.prev.set(i, { state: s, since });
      const comm = this.communityOf[b.cell];
      const t = threats?.get(i);
      this.alerts.push({
        id: i,
        state: s,
        anchor: this.anchors[i],
        since,
        ignitedMin: s !== "threat" ? arrival : undefined,
        etaMin: t?.eta,
        chance: t?.chance,
        distanceM: t?.distance,
        community: comm >= 0 ? this.communities[comm].name : undefined,
        hardened: input.treatMask[b.cell] === 4,
      });
    });
    for (const id of [...this.prev.keys()]) if (!seen.has(id)) this.prev.delete(id);
    return this.alerts;
  }

  reset() {
    this.prev.clear();
    this.alerts.length = 0;
  }

  private threats(input: HomeStatusInput): Map<number, { eta?: number; chance?: number; distance?: number }> {
    const out = new Map<number, { eta?: number; chance?: number; distance?: number }>();
    const { state, forecast, nowMinutes } = input;
    const { width: W } = this.grid.meta;
    if (forecast && forecast.startMinutes <= nowMinutes) {
      const size = Math.floor(W / ENSEMBLE_FACTOR);
      this.buildings.forEach((b, i) => {
        if (state[b.cell * 4] > 0.5) return;
        const x = Math.floor((b.cell % W) / ENSEMBLE_FACTOR);
        const y = Math.floor(Math.floor(b.cell / W) / ENSEMBLE_FACTOR);
        const o = (y * size + x) * 4;
        const chance = forecast.data[o];
        const median = forecast.data[o + 2];
        if (chance < 0.5 || median < 0) return;
        const eta = forecast.startMinutes + median - nowMinutes;
        if (eta <= THREAT_WINDOW_MIN) out.set(i, { eta: Math.max(0, eta), chance });
      });
      return out;
    }
    this.nearestFire(state);
    const S = this.grid.meta.cellSize;
    this.buildings.forEach((b, i) => {
      if (state[b.cell * 4] > 0.5) return;
      const d = this.dist[b.cell] * S;
      if (!Number.isFinite(d) || d > THREAT_DISTANCE_M) return;
      const src = this.nearest[b.cell];
      let downwind = d <= CLOSE_DISTANCE_M;
      if (!downwind && input.downwind) {
        const dx = (b.cell % W) - (src % W);
        const dy = Math.floor(b.cell / W) - Math.floor(src / W);
        const len = Math.hypot(dx, dy) || 1;
        downwind = (dx * input.downwind[0] + dy * input.downwind[1]) / len > 0.3;
      }
      if (!downwind) return;
      const eta = input.spreadRate > 0.5 ? d / input.spreadRate : undefined;
      if (eta !== undefined && eta > NEAR_WINDOW_MIN) return;
      out.set(i, { distance: d, eta });
    });
    return out;
  }

  /** 从燃烧格出发的多源广度优先搜索（8 邻域，按欧氏步长），只扩展到 THREAT_DISTANCE_M */
  private nearestFire(state: Float32Array) {
    const { width: W, height: H, cellSize: S } = this.grid.meta;
    const maxSteps = THREAT_DISTANCE_M / S;
    this.dist.fill(Infinity);
    let frontier: number[] = [];
    for (let c = 0; c < W * H; c++) {
      const r = state[c * 4];
      if (r > 0.5 && r < 1.5) {
        this.dist[c] = 0;
        this.nearest[c] = c;
        frontier.push(c);
      }
    }
    const steps: [number, number, number][] = [
      [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
      [1, 1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, -1, Math.SQRT2],
    ];
    while (frontier.length) {
      const next: number[] = [];
      for (const c of frontier) {
        const x = c % W;
        const y = Math.floor(c / W);
        for (const [dx, dy, w] of steps) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const n = yy * W + xx;
          const d = this.dist[c] + w;
          if (d < this.dist[n] && d <= maxSteps) {
            this.dist[n] = d;
            this.nearest[n] = this.nearest[c];
            next.push(n);
          }
        }
      }
      frontier = next;
    }
  }
}
