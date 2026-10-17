// P5：把后端（或内置回放）推送的事件作用到场景与模拟上。
// - 火点：画标记，并在对应格子点火（同化）。回放时先把模拟推进到火点的观测时刻，再点火
// - 风：更新来流风（地形风场随之重算）
// - 官方火界：画成对照轮廓，计算模拟火场与它的重合度（IoU）
// - 模型告警、官方疏散令、外呼状态：写入事件流与外呼统计

import { SpreadParams, type Community, type Grid, type Wind, type WindField } from "@core";
import type { FeedEvent } from "../net/messages";
import { FeedClient, type FeedMode, type FeedState } from "../net/feed";
import type { HotspotMarkers } from "../scene/hotspots";
import type { FireMonitor } from "../sim/fireMonitor";
import type { FireSim } from "../sim/fireSim";

/** 回放时一次最多追赶的步数（24 小时），防止事件时间跳跃过大时卡住 */
const MAX_CATCH_UP_STEPS = 288;

export interface RealtimeDeps {
  grid: Grid;
  communities: Community[];
  sim: FireSim;
  monitor: FireMonitor;
  markers: HotspotMarkers;
  setPerimeter(cells: number[] | null): void;
  activateSim(): void;
  resetSim(): void;
  setRunning(running: boolean): void;
  setFeedWind(mean: Wind, field: WindField): void;
  addIgnitions(cells: number[]): void;
  onChange(): void;
}

export interface CallTally {
  confirmed: number;
  noAnswer: number;
  needsHelp: number;
  other: number;
}

export class RealtimeController {
  readonly client: FeedClient;
  status = "";
  dataset = "";
  hotspotsReceived = 0;
  perimeter: Uint8Array | null = null;
  perimeterHa = 0;
  private t0: number | null = null;
  private calls = new Map<string, string>();

  constructor(private d: RealtimeDeps) {
    this.client = new FeedClient(
      d.grid.meta,
      (e) => this.onEvent(e),
      (state, detail) => this.onState(state, detail),
      2,
    );
  }

  get mode(): FeedMode {
    return this.client.mode;
  }

  start(mode: FeedMode) {
    this.client.stop();
    this.t0 = null;
    this.hotspotsReceived = 0;
    this.calls.clear();
    this.dataset = "";
    if (mode !== "off") {
      // 每次接入都从干净的状态开始：清掉测试火、火点标记与火界
      this.d.resetSim();
      this.d.markers.clear();
      this.setPerimeter(null);
    }
    this.client.start(mode);
    this.d.onChange();
  }

  private onState(state: FeedState, detail: string) {
    const label: Record<FeedState, string> = {
      idle: "",
      connecting: `Connecting to ${detail}…`,
      connected: this.client.mode === "live" ? "Connected. Waiting for new hotspots and wind updates." : "Connected. Playing the Eaton replay.",
      local: detail,
      retrying: detail,
      ended: "Replay finished. The simulation keeps running from the last update.",
    };
    this.status = label[state];
    this.d.onChange();
  }

  callTally(): CallTally {
    const t = { confirmed: 0, noAnswer: 0, needsHelp: 0, other: 0 };
    for (const s of this.calls.values()) {
      if (s === "confirmed") t.confirmed++;
      else if (s === "no_answer") t.noAnswer++;
      else if (s === "needs_help") t.needsHelp++;
      else t.other++;
    }
    return t;
  }

  /** 模拟火场与官方火界的重合度（IoU）；没有火界或模拟尚未读回时为 null */
  perimeterMatch(state: Float32Array | null): number | null {
    if (!this.perimeter || !state) return null;
    let a = 0;
    let b = 0;
    let both = 0;
    for (let c = 0; c < this.perimeter.length; c++) {
      const sim = state[c * 4] > 0.5;
      const real = this.perimeter[c] > 0;
      if (sim) a++;
      if (real) b++;
      if (sim && real) both++;
    }
    return both / Math.max(1, a + b - both);
  }

  private setPerimeter(cells: number[] | null) {
    this.d.setPerimeter(cells);
    if (!cells) {
      this.perimeter = null;
      this.perimeterHa = 0;
      return;
    }
    const n = this.d.grid.meta.width * this.d.grid.meta.height;
    this.perimeter = new Uint8Array(n);
    for (const c of cells) if (c >= 0 && c < n) this.perimeter[c] = 1;
    this.perimeterHa = (cells.length * this.d.grid.meta.cellSize ** 2) / 1e4;
  }

  /** 回放：把模拟推进到事件的观测时刻 */
  private catchUp(time: number) {
    if (this.client.mode !== "replay" || this.t0 === null) return;
    const target = (time - this.t0) / 60000;
    const steps = Math.min(MAX_CATCH_UP_STEPS, Math.floor((target - this.d.sim.minutes) / SpreadParams.stepMinutes));
    if (steps > 0) this.d.sim.advance(steps);
  }

  private communityName(id: string): string {
    return this.d.communities.find((c) => c.id === id)?.name ?? id;
  }

  private onEvent(e: FeedEvent) {
    const { monitor, sim } = this.d;
    if (this.t0 === null && e.kind !== "error") this.t0 = e.time;
    const now = sim.minutes;
    switch (e.kind) {
      case "snapshot":
        this.dataset = e.dataset ?? "";
        if (this.client.mode === "replay") monitor.log(now, `Replay started${e.dataset ? ` (${e.dataset})` : ""}`, "watch");
        break;
      case "wind":
        this.catchUp(e.time);
        this.d.setFeedWind(e.mean, e.field);
        monitor.log(sim.minutes, `Wind update: ${Math.round(e.mean.speedMs)} m/s from ${Math.round(e.mean.dirFromDeg)}°`, "watch");
        break;
      case "hotspots": {
        if (!e.items.length) break;
        this.catchUp(e.time);
        this.d.activateSim();
        const cells: number[] = [];
        for (const h of e.items) {
          // 火点像元比格子大（VIIRS 375 m ≈ 15 格），在中心点一个半径约 2 格的小火团
          sim.igniteDisc(h.cell % this.d.grid.meta.width, Math.floor(h.cell / this.d.grid.meta.width), 2);
          cells.push(h.cell);
        }
        this.d.addIgnitions(cells);
        this.d.markers.add(e.items);
        this.hotspotsReceived += e.items.length;
        const sources = [...new Set(e.items.map((h) => h.source))].join(", ");
        monitor.log(sim.minutes, `${e.items.length} new satellite hotspot${e.items.length > 1 ? "s" : ""} (${sources})`, "warning");
        this.d.setRunning(true);
        break;
      }
      case "incident":
        if (e.perimeterCells?.length) {
          this.setPerimeter(e.perimeterCells);
          monitor.log(now, `Official perimeter received: ${Math.round(this.perimeterHa).toLocaleString("en-US")} ha`, "warning");
        } else {
          monitor.log(now, `Incident ${e.id} grouped from satellite hotspots`, "watch");
        }
        break;
      case "alert": {
        const eta = Number.isFinite(e.etaMin) ? `, about ${Math.round(e.etaMin)} min` : "";
        monitor.log(now, `Model alert (not official): ${e.level} for ${this.communityName(e.communityId)}${eta}`, e.level === "imminent" ? "reached" : e.level);
        break;
      }
      case "official":
        monitor.log(now, `Official ${e.level} for ${this.communityName(e.communityId)}: ${e.headline}`, "reached");
        break;
      case "call":
        if (e.buildingId) this.calls.set(e.buildingId, e.status);
        break;
      case "error":
        this.status = `Server error: ${e.detail}`;
        break;
    }
    this.d.onChange();
  }
}
