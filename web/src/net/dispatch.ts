// 紧急联络（后端 server/app/dispatch.py）的前端客户端：
// - start / stop 调度；pushFire 上报燃烧格与模型到达时间（后端据此排优先级）
// - 订阅 /ws/dispatch：快照 + 每条任务的状态变化 + 汇总计数
// - 维护每栋房屋的联络状态，供侧栏列表、地图状态点与房屋冒泡使用
// 后端只发打码后的住户信息（姓名、电话、门牌号），前端不接触完整数据。

import { API } from "./feed";

export type CallStatus = "queued" | "ringing" | "talking" | "confirmed" | "needs_help" | "no_answer" | "failed";
export type TextStatus = "queued" | "sending" | "sent" | "delivered" | "failed";

export interface PublicHousehold {
  id: string;
  buildingId: string;
  cell: number;
  owner: string;
  phone: string;
  address: string;
  language: string;
  vulnerable: boolean;
  communityId: string | null;
}

export interface ContactTask {
  id: string;
  channel: "call" | "text";
  status: CallStatus | TextStatus;
  attempt: number;
  /** 外呼线路（从 1 开始）；通话结束后保留，线路面板据此显示结果 */
  line: number | null;
  etaMin: number;
  distanceM: number;
  provider: string;
  updatedAt: number;
  household: PublicHousehold;
}

export interface DispatchSummary {
  active: boolean;
  demoSpeed: number;
  callLines: number;
  households: number;
  calling: number;
  callQueued: number;
  confirmed: number;
  needsHelp: number;
  noAnswer: number;
  callFailed: number;
  textQueued: number;
  texting: number;
  texted: number;
  textFailed: number;
}

/** 地图状态点的编码（与地形 shader 的 uContact 一致） */
export const enum ContactCode {
  None = 0,
  TextQueued = 1,
  Texted = 2,
  CallQueued = 3,
  Calling = 4,
  Confirmed = 5,
  NoAnswer = 6,
  NeedsHelp = 7,
}

export type DispatchState = "off" | "starting" | "active" | "offline";

export class DispatchClient {
  state: DispatchState = "off";
  summary: DispatchSummary | null = null;
  readonly tasks = new Map<string, ContactTask>();
  /** buildingId → 当前最能代表该房屋的联络状态编码（外呼优先于短信） */
  readonly codes = new Map<string, ContactCode>();
  /** 线路号 → 最近占用该线路的外呼任务 id */
  private lineTasks = new Map<number, string>();
  /** 状态变化后递增，供地图图层判断是否需要重建贴图 */
  version = 0;
  private ws: WebSocket | null = null;
  private retry = 0;

  constructor(private onChange: () => void) {}

  async start(): Promise<void> {
    if (this.state === "starting" || this.state === "active") return;
    this.state = "starting";
    this.onChange();
    try {
      const res = await fetch(`${API}/api/v1/dispatch/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.summary = (await res.json()) as DispatchSummary;
      this.state = "active";
      this.connect();
    } catch {
      this.state = "offline";
    }
    this.onChange();
  }

  async stop(): Promise<void> {
    const wasActive = this.state === "active";
    this.state = "off";
    this.ws?.close();
    this.ws = null;
    this.tasks.clear();
    this.codes.clear();
    this.lineTasks.clear();
    this.summary = null;
    this.version++;
    this.onChange();
    if (wasActive) await fetch(`${API}/api/v1/dispatch/stop`, { method: "POST" }).catch(() => undefined);
  }

  /** 上报燃烧格（网格索引）与模型到达时间（buildingId → 分钟） */
  async pushFire(cells: number[], etas: Record<string, number>, windFromDeg: number, windSpeedMs: number): Promise<void> {
    if (this.state !== "active" || !cells.length) return;
    await fetch(`${API}/api/v1/dispatch/fire`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cells, etas, wind_from_deg: windFromDeg, wind_speed_ms: windSpeedMs }),
    }).catch(() => undefined);
  }

  private connect() {
    const ws = new WebSocket(`${API.replace(/^http/, "ws")}/ws/dispatch`);
    this.ws = ws;
    ws.onmessage = (m) => {
      if (typeof m.data !== "string" || m.data === "pong") return;
      try {
        this.handle(JSON.parse(m.data));
      } catch {
        /* 忽略无法解析的消息 */
      }
    };
    ws.onopen = () => (this.retry = 0);
    ws.onclose = () => {
      if (this.ws !== ws || this.state !== "active") return;
      // 断线重连，最长 10 秒
      const delay = Math.min(10000, 1000 * 2 ** this.retry++);
      setTimeout(() => this.state === "active" && this.connect(), delay);
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handle(msg: any) {
    if (msg.type === "dispatch_snapshot") {
      this.tasks.clear();
      this.lineTasks.clear();
      for (const t of msg.tasks ?? []) {
        this.tasks.set(t.id, t);
        this.trackLine(t);
      }
      this.summary = msg.summary ?? this.summary;
      this.rebuildCodes();
    } else if (msg.type === "contact" && msg.task) {
      this.tasks.set(msg.task.id, msg.task);
      this.trackLine(msg.task);
      this.updateCode(msg.task.household.buildingId);
    } else if (msg.type === "dispatch_summary") {
      const { type: _t, sequence: _s, emittedAt: _e, ...summary } = msg;
      this.summary = summary as DispatchSummary;
    } else {
      return;
    }
    this.version++;
    this.onChange();
  }

  /** 同一条线路上更新时间最晚的任务就是线路当前的任务 */
  private trackLine(t: ContactTask) {
    if (t.channel !== "call" || !t.line) return;
    const current = this.tasks.get(this.lineTasks.get(t.line) ?? "");
    if (!current || current.id === t.id || current.updatedAt <= t.updatedAt) this.lineTasks.set(t.line, t.id);
  }

  private rebuildCodes() {
    this.codes.clear();
    for (const t of this.tasks.values()) this.updateCode(t.household.buildingId);
  }

  private updateCode(buildingId: string) {
    const call = this.tasks.get(`call-hh-${buildingId}`);
    const text = this.tasks.get(`text-hh-${buildingId}`);
    let code = ContactCode.None;
    if (call) {
      code = (
        {
          queued: ContactCode.CallQueued,
          ringing: ContactCode.Calling,
          talking: ContactCode.Calling,
          confirmed: ContactCode.Confirmed,
          needs_help: ContactCode.NeedsHelp,
          no_answer: ContactCode.NoAnswer,
          failed: ContactCode.NoAnswer,
        } as Record<string, ContactCode>
      )[call.status];
    } else if (text) {
      code = text.status === "queued" || text.status === "sending" ? ContactCode.TextQueued : ContactCode.Texted;
    }
    if (code === ContactCode.None) this.codes.delete(buildingId);
    else this.codes.set(buildingId, code);
  }

  /** 每条线路当前的任务（通话中，或刚结束的结果）；空闲为 null */
  lines(): (ContactTask | null)[] {
    const n = Math.max(this.summary?.callLines ?? 0, ...this.lineTasks.keys(), 0);
    return Array.from({ length: n }, (_, i) => {
      const t = this.tasks.get(this.lineTasks.get(i + 1) ?? "");
      // 重拨的任务会换到别的线路，旧线路不再显示它
      return t && t.line === i + 1 ? t : null;
    });
  }

  /** 正在外呼的任务（最早开始的在前） */
  calling(): ContactTask[] {
    return [...this.tasks.values()].filter((t) => t.channel === "call" && (t.status === "ringing" || t.status === "talking")).sort((a, b) => a.updatedAt - b.updatedAt);
  }

  needsHelp(): ContactTask[] {
    return [...this.tasks.values()].filter((t) => t.channel === "call" && t.status === "needs_help").sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 等待中的任务，按调度顺序（预计到达早的在前，弱势住户提前 5 分钟） */
  queue(channel: "call" | "text"): ContactTask[] {
    const key = (t: ContactTask) => t.etaMin - (t.household.vulnerable ? 5 : 0);
    return [...this.tasks.values()].filter((t) => t.channel === channel && t.status === "queued").sort((a, b) => key(a) - key(b));
  }
}
