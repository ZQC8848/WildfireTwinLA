// 数据源客户端：
// - live：连接后端 WS /ws?mode=live，断线后按指数退避重连，定时发送 ping
// - replay：连接 /ws?mode=replay&event=norte；后端连不上时，改为在浏览器内按同样的时间间隔播放。
//   本地回放优先用后端的 server/data/norte-replay.jsonl（与后端读取的是同一份文件）；
//   该文件还没生成时，用 data/norte/raw/ 的存档数据现场拼出（norteSeed.ts），演示不依赖后端

import type { GridMeta } from "@core";
import { normalize, type FeedEvent } from "./messages";
import { buildNorteReplay } from "./norteSeed";

// 文件不存在时 glob 为空，不会让构建失败
const replayFiles = import.meta.glob<string>("../../../server/data/norte-replay.jsonl", { query: "?raw", import: "default", eager: true });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function localReplay(): { events: any[]; bundled: boolean } {
  const text = Object.values(replayFiles)[0];
  if (text) return { events: text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)), bundled: false };
  return { events: buildNorteReplay(), bundled: true };
}

export type FeedMode = "off" | "live" | "replay";
export type FeedState = "idle" | "connecting" | "connected" | "local" | "retrying" | "ended";

// 后端地址：URL 参数 ?api= 优先（调试），其次构建时的 VITE_API_URL；开发时默认本地 8010。
// 正式构建没有配置后端时为 null：不发任何后端请求，回放在浏览器内播放，紧急联络在 Web Worker 里模拟
// （公开网站若去连访客自己电脑上的 localhost，会失败，新版 Chrome 还可能弹出本地网络权限提示）
export const API: string | null =
  new URLSearchParams(location.search).get("api") || (import.meta.env.VITE_API_URL as string | undefined) || (import.meta.env.DEV ? "http://localhost:8010" : null);

export class FeedClient {
  mode: FeedMode = "off";
  state: FeedState = "idle";
  private ws: WebSocket | null = null;
  private timers: number[] = [];
  private retry = 0;
  private generation = 0;
  /** 本次回放是否在浏览器内播放，以及是否由存档原始数据拼出 */
  local: { bundled: boolean } | null = null;
  /** 浏览器内回放的事件（按 offsetSeconds 排序），改速度时用来重新排定时器 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private localEvents: any[] = [];
  /** 后端回放从这个 offset 之后开始发送（改速度时重连用） */
  private startOffset = 0;

  constructor(
    private meta: GridMeta,
    private onEvent: (e: FeedEvent) => void,
    private onState: (state: FeedState, detail: string) => void,
    /** 回放倍速（后端的 speed 参数，事件间隔 ÷ speed） */
    public replaySpeed = 1,
  ) {}

  start(mode: FeedMode) {
    this.stop();
    this.mode = mode;
    this.local = null;
    this.startOffset = 0;
    if (mode === "off") return this.setState("idle", "");
    this.open();
  }

  stop() {
    this.generation++;
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.retry = 0;
  }

  private setState(state: FeedState, detail: string) {
    this.state = state;
    this.onState(state, detail);
  }

  private wsUrl(): string {
    const base = (API ?? "").replace(/^http/, "ws");
    return this.mode === "live"
      ? `${base}/ws?mode=live`
      : `${base}/ws?mode=replay&event=norte&speed=${this.replaySpeed}&start=${this.startOffset.toFixed(3)}`;
  }

  private open() {
    const gen = this.generation;
    if (!API) {
      // 没有后端：回放直接在浏览器内播放；实时数据不可用（界面上按钮已禁用）
      if (this.mode === "replay") return this.playLocal(gen);
      return this.setState("ended", "The live feed needs a backend; this public demo replays recorded public data.");
    }
    this.setState("connecting", API);
    let opened = false;
    let received = 0;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl());
    } catch {
      return this.fail(gen, false);
    }
    this.ws = ws;
    ws.onopen = () => {
      if (gen !== this.generation) return;
      opened = true;
      this.retry = 0;
      this.setState("connected", API ?? "");
      if (this.mode === "live") this.ping(gen);
    };
    ws.onmessage = (m) => {
      if (gen !== this.generation || typeof m.data !== "string" || m.data === "pong") return;
      try {
        const e = normalize(JSON.parse(m.data), this.meta);
        if (e) {
          received++;
          this.onEvent(e);
        }
      } catch {
        /* 忽略无法解析的消息 */
      }
    };
    ws.onclose = () => {
      if (gen !== this.generation) return;
      this.ws = null;
      // 后端接受了连接却没有发任何事件（例如还没有这份回放）：改为本地播放
      if (this.mode === "replay" && opened && received > 0) return this.setState("ended", "Replay finished");
      if (this.mode === "replay") return this.playLocal(gen);
      this.fail(gen, opened);
    };
  }

  private fail(gen: number, wasOpen: boolean) {
    if (gen !== this.generation) return;
    if (this.mode === "replay") return this.playLocal(gen);
    // live：指数退避重连，最长 30 秒
    const delay = Math.min(30000, 1000 * 2 ** this.retry++);
    this.setState("retrying", `${wasOpen ? "Connection lost" : "Cannot reach the server"}; retrying in ${Math.round(delay / 1000)} s`);
    this.timers.push(window.setTimeout(() => gen === this.generation && this.open(), delay));
  }

  private ping(gen: number) {
    this.timers.push(
      window.setTimeout(() => {
        if (gen !== this.generation || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send("ping");
        this.ping(gen);
      }, 20000),
    );
  }

  /** 后端不可用时在浏览器内播放回放文件 */
  private playLocal(gen: number) {
    const { events, bundled } = localReplay();
    this.local = { bundled };
    const where = API ? (bundled ? "Playing the replay built from archived public data (backend replay not available)." : "Server unavailable; playing the bundled replay.") : "Playing the replay in your browser from archived public data.";
    this.setState("local", where);
    this.localEvents = [...events].sort((a, b) => (a.offsetSeconds ?? 0) - (b.offsetSeconds ?? 0));
    this.scheduleLocal(gen, 0, -1);
  }

  /** 排定浏览器内回放：offset 大于 after 的事件，按 (offset − now) / 倍速 的延迟发出 */
  private scheduleLocal(gen: number, now: number, after: number) {
    let last = 0;
    for (const raw of this.localEvents) {
      const offset = raw.offsetSeconds ?? 0;
      if (offset <= after + 0.0005) continue;
      const at = (Math.max(0, offset - now) * 1000) / Math.max(0.1, this.replaySpeed);
      last = Math.max(last, at);
      this.timers.push(
        window.setTimeout(() => {
          if (gen !== this.generation) return;
          const e = normalize(raw, this.meta);
          if (e) this.onEvent(e);
        }, at),
      );
    }
    this.timers.push(window.setTimeout(() => gen === this.generation && this.setState("ended", "Replay finished"), last + 500));
  }

  /**
   * 回放进行中改变倍速（例如起火时减速，把舞台交给紧急外呼）。
   * lastOffset 是最后收到的事件的 offset，now 是当前回放位置；
   * 浏览器内回放从当前位置重新排定时器，后端回放带着 lastOffset 重连，后端跳过已发过的事件。
   */
  setReplaySpeed(speed: number, lastOffset: number, now: number) {
    if (this.mode !== "replay" || speed === this.replaySpeed || this.state === "ended") return;
    this.replaySpeed = speed;
    if (this.state === "local") {
      const gen = ++this.generation;
      this.timers.forEach((t) => clearTimeout(t));
      this.timers = [];
      this.scheduleLocal(gen, now, lastOffset);
    } else if (this.state === "connected") {
      this.generation++;
      if (this.ws) {
        this.ws.onclose = null;
        this.ws.close();
        this.ws = null;
      }
      this.startOffset = lastOffset;
      this.open();
    }
  }
}
