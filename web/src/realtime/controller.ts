// P5：把后端（或内置回放）推送的事件作用到场景与模拟上。
// - 火点：画标记，并在对应格子点火（同化）。回放时先把模拟推进到火点的观测时刻，再点火。
//   卫星火点在点火前先和模拟对照：模型是否已经烧到这个像元（命中），模拟火场有多少落在探测范围内
// - 报告起火点（source "REPORT"，如 NIFC 的 NORTE、MIRADA）：只点火，不参与对照
// - 风：更新来流风（地形风场随之重算）
// - 官方火界：画成对照轮廓，计算模拟火场与它的重合度（IoU）
// - 模型告警、官方疏散令、外呼状态：写入事件流与外呼统计

import { SpreadParams, type Community, type Grid, type Wind, type WindField } from "@core";
import type { FeedEvent, FeedHotspot } from "../net/messages";
import { FeedClient, type FeedMode, type FeedState } from "../net/feed";
import { REPLAY_MINUTES_PER_SECOND } from "../net/replayClock";
import type { HotspotMarkers } from "../scene/hotspots";
import type { FireMonitor } from "../sim/fireMonitor";
import type { FireSim } from "../sim/fireSim";

/** 回放时一次最多追赶的步数（24 小时），防止事件时间跳跃过大时卡住 */
const MAX_CATCH_UP_STEPS = 288;
/** 回放倍速：每秒墙钟 = 5 × 5 = 25 分钟事件时间（每秒 5 步） */
const REPLAY_SPEED = 5;
/** 卫星像元的对照半径（格）：VIIRS I 波段像元约 375 m，半宽约 190 m ≈ 8 格 */
const PIXEL_RADIUS = 8;

const DISK: [number, number][] = [];
for (let dy = -PIXEL_RADIUS; dy <= PIXEL_RADIUS; dy++)
  for (let dx = -PIXEL_RADIUS; dx <= PIXEL_RADIUS; dx++) if (dx * dx + dy * dy <= PIXEL_RADIUS * PIXEL_RADIUS) DISK.push([dx, dy]);

export interface SatellitePass {
  minutes: number;
  satellite: string;
  pixels: number;
  /** 点火同化前，模型已经烧到的像元数 */
  reached: number;
  /** 模拟火场中落在已有探测范围内的比例 */
  confirmedShare: number;
}

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
  passes: SatellitePass[] = [];
  reports: { minutes: number; name: string }[] = [];
  private t0: number | null = null;
  private calls = new Map<string, string>();
  /** 累计的卫星探测范围（每个像元按半径 PIXEL_RADIUS 的圆盘） */
  private coverage: Uint8Array;
  /** 回放时钟：最近一个事件的事件时间与对应的墙钟时间 */
  private clockEvent = 0;
  private clockWall = 0;

  constructor(private d: RealtimeDeps) {
    this.client = new FeedClient(
      d.grid.meta,
      (e) => this.onEvent(e),
      (state, detail) => this.onState(state, detail),
      REPLAY_SPEED,
    );
    this.coverage = new Uint8Array(d.grid.meta.width * d.grid.meta.height);
  }

  /** 回放进行中时，模拟应当所在的时刻（分钟）；不在回放或回放结束后为 null，模拟按自己的速度运行 */
  replayMinutes(now = performance.now()): number | null {
    if (this.client.mode !== "replay" || this.t0 === null || this.client.state === "ended") return null;
    return (this.clockEvent - this.t0) / 60000 + ((now - this.clockWall) / 1000) * REPLAY_MINUTES_PER_SECOND * REPLAY_SPEED;
  }

  /** 回放是否由存档原始数据现场拼出（还没有后端的回放文件） */
  get bundledReplay(): boolean {
    return this.client.mode === "replay" && !!this.client.local?.bundled;
  }

  /** 时间轴刻度：卫星过境与报告起火点 */
  ticks(): { minutes: number; level: string }[] {
    return [...this.passes.map((p) => ({ minutes: p.minutes, level: "satellite" })), ...this.reports.map((r) => ({ minutes: r.minutes, level: "report" }))];
  }

  /** 全部过境合计：像元数、命中数，以及最近一次过境时模拟火场落在探测范围内的比例 */
  agreement(): { pixels: number; reached: number; confirmedShare: number } | null {
    if (!this.passes.length) return null;
    return {
      pixels: this.passes.reduce((a, p) => a + p.pixels, 0),
      reached: this.passes.reduce((a, p) => a + p.reached, 0),
      confirmedShare: this.passes[this.passes.length - 1].confirmedShare,
    };
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
    this.passes = [];
    this.reports = [];
    this.coverage.fill(0);
    this.clockEvent = 0;
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
      connected: this.client.mode === "live" ? "Connected. Waiting for new hotspots and wind updates." : "Connected. Playing the Norte Fire replay.",
      local: detail,
      retrying: detail,
      ended: "Replay finished and paused at the last update. Press Run to keep simulating from here.",
    };
    this.status = label[state];
    // 回放结束时停在最后一个事件的时刻，而不是让模拟一路跑下去
    if (state === "ended" && this.client.mode === "replay" && this.t0 !== null) {
      this.catchUp(this.clockEvent);
      this.d.setRunning(false);
    }
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

  /** 一次过境与当前模拟的对照；missed 收集模型没烧到的像元 id */
  private compare(pixels: FeedHotspot[], missed: Set<string>): SatellitePass {
    const { sim, grid } = this.d;
    const { width: W, height: H } = grid.meta;
    sim.statsSync();
    const state = sim.lastState!;
    let reached = 0;
    for (const h of pixels) {
      const x = h.cell % W;
      const y = Math.floor(h.cell / W);
      let hit = false;
      for (const [dx, dy] of DISK) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        if (state[(yy * W + xx) * 4] > 0.5) {
          hit = true;
          break;
        }
      }
      if (hit) reached++;
      else missed.add(h.id);
      for (const [dx, dy] of DISK) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < W && yy < H) this.coverage[yy * W + xx] = 1;
      }
    }
    let fire = 0;
    let seen = 0;
    for (let c = 0; c < this.coverage.length; c++) {
      if (state[c * 4] <= 0.5) continue;
      fire++;
      if (this.coverage[c]) seen++;
    }
    return { minutes: sim.minutes, satellite: pixels[0].satellite ?? pixels[0].source, pixels: pixels.length, reached, confirmedShare: fire ? seen / fire : 0 };
  }

  private communityName(id: string): string {
    return this.d.communities.find((c) => c.id === id)?.name ?? id;
  }

  private onEvent(e: FeedEvent) {
    const { monitor, sim } = this.d;
    if (this.t0 === null && e.kind !== "error") this.t0 = e.time;
    if (e.kind !== "error") {
      this.clockEvent = Math.max(this.clockEvent, e.time);
      this.clockWall = performance.now();
    }
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
        const W = this.d.grid.meta.width;
        const reports = e.items.filter((h) => h.source === "REPORT");
        const pixels = e.items.filter((h) => h.source !== "REPORT");
        // 先对照再点火，否则同化会让每个像元都"命中"
        const missed = new Set<string>();
        if (pixels.length) {
          const pass = this.compare(pixels, missed);
          this.passes.push(pass);
          const name = pixels[0].satellite ? `${pixels[0].source} ${pixels[0].satellite}` : pixels[0].source;
          monitor.log(sim.minutes, `Satellite pass (${name}): ${pass.pixels} hotspot pixel${pass.pixels > 1 ? "s" : ""}, the model had reached ${pass.reached}`, "warning");
        }
        for (const h of reports) {
          sim.igniteDisc(h.cell % W, Math.floor(h.cell / W), 1.5);
          // 兼容 "report-norte"（前端内置回放）与 "norte-report"（后端回放）两种 id
          const name = h.id.replace(/^report-|-report$/g, "").toUpperCase();
          this.reports.push({ minutes: sim.minutes, name });
          monitor.log(sim.minutes, `Reported ignition: ${name} (NIFC incident record)`, "warning");
        }
        // 火点像元比格子大（VIIRS 375 m ≈ 15 格），在中心点一个半径约 2 格的小火团
        for (const h of pixels) sim.igniteDisc(h.cell % W, Math.floor(h.cell / W), 2);
        this.d.addIgnitions(e.items.map((h) => h.cell));
        this.d.markers.add(e.items, missed);
        this.hotspotsReceived += pixels.length;
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
