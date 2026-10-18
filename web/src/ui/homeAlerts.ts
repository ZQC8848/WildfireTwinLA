// 房屋冒泡提示（参考《城市天际线》）：着火、烧毁、受威胁的房屋上方显示图标气泡。
// - HTML 叠加层：与界面同一套字体和配色，文字清晰，悬停与点击容易处理
// - 在地面坐标里聚合（参照地图应用的缩放级别）：整个画面用同一个距离档，由相机离地高度决定，
//   每档的地面格子大小翻倍，在典型观察距离上投影到屏幕约 TARGET_PX 像素。平移、旋转相机时格子不动、
//   组的成员不变；只有推拉镜头跨档时才整体合并或拆开。换档带滞后（HYST）。
//   组的位置取成员锚点在地面上的中心，再投影到屏幕。透视让远处的组挤在一起时，靠下面的"重叠调淡"处理
// - 范围与数量上限按组到画面焦点（轨道中心，飞行模式下为视线前方的地面点）的水平距离计算：
//   绕焦点旋转时距离不变，显示哪些组也不变。两者都带滞后：已显示的组超出范围 10% 才移除，排序时距离按 85% 计
// - 每个气泡按组的固定标识（档 + 格子）复用 DOM 元素；新出现的淡入、消失的原地淡出
// - 屏幕上与更紧急的气泡重叠时调淡并不响应点击，不合并（合并正是闪烁的来源）
// - 聚合气泡只显示最紧急状态的图标与数量，分项计数在悬停卡片里；单栋气泡在状态变化时弹出，着火的持续脉动
// - 悬停显示详情卡片，点击时相机飞过去（聚合气泡拉近到该区域）
// - 距离上限：只显示离相机 range 以内的组，range = max(minRange, rangeFactor × 相机离地高度)，接近上限时淡出。
//   数量上限：最多 maxVisible 个，超出时按紧急程度、再按距离取前面的

import * as THREE from "three";
import type { HomeAlert, HomeState } from "../sim/homeStatus";

/** 组的地面格子投影到屏幕的目标尺寸（像素，按 900 像素高的参考画布计算，窗口尺寸变化不影响分组） */
const TARGET_PX = 56;
const REF_HEIGHT_PX = 900;
/** 第 0 档的距离（米）；更近的都算第 0 档 */
const BASE_DIST_M = 100;
/** 典型观察距离 = 相机离地高度 × 此值（斜视时视线比高度长，画面中部的地面通常在 2–3 倍高度处） */
const VIEW_DIST_PER_HEIGHT = 2.5;
/** 换档滞后（log2 单位，约 15%） */
const HYST = 0.2;
/** 与更紧急的气泡中心距离小于此值时调淡 */
const OVERLAP_PX = 30;
const MAX_BUBBLES = 160;
const POP_MS = 450;
const FADE_MS = 160;
// 需要帮助与外呼中的房屋很少，却是紧急联络的主角，排在最前，不会被数量上限挤掉
const PRIORITY: Record<HomeState, number> = { help: 0, calling: 1, burning: 2, threat: 3, burned: 4 };
const ORDER: HomeState[] = ["help", "calling", "burning", "threat", "burned"];

const ICONS: Record<HomeState, string> = {
  burning: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8.6 1.2c.4 2.3-1 3.4-2 4.6C5.5 7 4.6 8.2 4.6 10a3.4 3.4 0 0 0 6.8 0c0-1.4-.6-2.3-1.2-3 .1 1.1-.3 1.9-1 2.2.3-2-.2-3.4-.6-4.3.9-.8 1.2-2.2 0-3.7z" fill="currentColor"/></svg>`,
  burned: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 7.5 8 3l5.5 4.5V13h-11z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M6.2 13l1.6-2.6-1.2-1.4L8.4 7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  threat: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2 14.5 13.5h-13z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6.3v3.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.6" r=".9" fill="currentColor"/></svg>`,
  calling: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.2 2.5 3.4 3.1c-.9.4-1.3 1.4-1 2.3 1.4 4 4.2 6.8 8.2 8.2.9.3 1.9-.1 2.3-1l.6-1.8-2.8-1.6-1.3 1.2C7.9 9.6 6.4 8.1 5.6 6.6l1.2-1.3z" fill="currentColor"/><path d="M10 2.5a4 4 0 0 1 3.5 3.5M10 4.7a1.8 1.8 0 0 1 1.3 1.3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  help: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 4.6v4.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="11.3" r="1" fill="currentColor"/></svg>`,
};

interface Cluster {
  key: string;
  /** 成员锚点的平均（世界坐标） */
  anchor: THREE.Vector3;
  n: number;
  /** 组中心到画面焦点的水平距离（米） */
  dist: number;
  counts: Record<HomeState, number>;
  top: HomeAlert;
  members: HomeAlert[];
  newest: number;
  minEta?: number;
}

interface Bubble {
  el: HTMLButtonElement;
  cluster: Cluster | null;
  /** 最近一次的锚点；淡出期间仍按它定位 */
  anchor: THREE.Vector3;
  bornAt: number;
  dyingAt: number | null;
}

export interface HomeAlertHandlers {
  onHover(title: string, rows: [string, string][], x: number, y: number): void;
  onLeave(): void;
  onFly(target: THREE.Vector3, distance: number): void;
}

export class HomeAlerts {
  readonly root: HTMLDivElement;
  private items: HomeAlert[] = [];
  private visible = true;
  private v = new THREE.Vector3();
  private bubbles = new Map<string, Bubble>();
  private free: HTMLButtonElement[] = [];
  /** 当前的距离档（带滞后） */
  private level = -1;
  private reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  /** 同时显示的气泡上限 */
  maxVisible = 12;
  /** 距离上限 = max(minRange, rangeFactor × 相机离地高度)，单位米 */
  rangeFactor = 3;
  minRange = 1500;
  private lastCount = "";

  constructor(
    private camera: THREE.PerspectiveCamera,
    private canvas: HTMLCanvasElement,
    private handlers: HomeAlertHandlers,
    private describe: (a: HomeAlert) => { title: string; rows: [string, string][] },
    /** 世界坐标 (x, z) 处的地面高度（显示坐标） */
    private groundAt: (x: number, z: number) => number,
    /** 画面焦点（世界坐标）：范围与排序以它为中心 */
    private focus: () => THREE.Vector3,
    /** 显示数量变化时回调：显示了多少、超出上限前共有多少 */
    private onCount?: (shown: number, total: number) => void,
  ) {
    this.root = document.createElement("div");
    this.root.className = "home-alerts";
    document.body.appendChild(this.root);
  }

  setItems(items: HomeAlert[]) {
    this.items = items;
  }

  setVisible(show: boolean) {
    this.visible = show;
    this.root.hidden = !show;
    if (!show) this.handlers.onLeave();
  }

  setNight(night: boolean) {
    this.root.classList.toggle("night", night);
  }

  /** 地面格子大小（米）：第 level 档的格子投影到屏幕约 TARGET_PX 像素 */
  private cellSize(level: number): number {
    const focal = REF_HEIGHT_PX / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    return (TARGET_PX * BASE_DIST_M * 2 ** (level + 0.5)) / focal;
  }

  /** 按地面格子分组；整个画面同一个距离档（由相机离地高度决定，带滞后），平移旋转不会改变分组 */
  private cluster(focus: THREE.Vector3, height: number): Map<string, Cluster> {
    const l = Math.log2(Math.max(height * VIEW_DIST_PER_HEIGHT, BASE_DIST_M) / BASE_DIST_M);
    if (this.level < 0 || l < this.level - HYST || l >= this.level + 1 + HYST) this.level = Math.floor(l);
    const level = this.level;
    const size = this.cellSize(level);
    const map = new Map<string, Cluster>();
    for (const a of this.items) {
      const key = `${level}:${Math.floor(a.anchor.x / size)}:${Math.floor(a.anchor.z / size)}`;
      let c = map.get(key);
      if (!c) {
        c = { key, anchor: new THREE.Vector3(), n: 0, dist: 0, counts: { burning: 0, burned: 0, threat: 0, calling: 0, help: 0 }, top: a, members: [], newest: 0 };
        map.set(key, c);
      }
      c.anchor.add(a.anchor);
      c.n++;
      c.counts[a.state]++;
      c.members.push(a);
      c.newest = Math.max(c.newest, a.since);
      if (PRIORITY[a.state] < PRIORITY[c.top.state]) c.top = a;
      if (a.etaMin !== undefined) c.minEta = Math.min(c.minEta ?? Infinity, a.etaMin);
    }
    for (const c of map.values()) {
      c.anchor.divideScalar(c.n);
      c.dist = Math.hypot(c.anchor.x - focus.x, c.anchor.z - focus.z);
    }
    return map;
  }

  /** 每帧调用：分组、筛选、更新气泡 */
  update() {
    if (!this.visible) return;
    const rect = this.canvas.getBoundingClientRect();
    const s = this.root.style;
    s.left = `${rect.left}px`;
    s.top = `${rect.top}px`;
    s.width = `${rect.width}px`;
    s.height = `${rect.height}px`;

    const cam = this.camera.position;
    const focus = this.focus();
    // 高度取相机相对焦点处地面：绕焦点旋转时不随相机下方的地形起伏变化
    const height = Math.max(0, cam.y - this.groundAt(focus.x, focus.z));
    const range = Math.max(this.minRange, this.rangeFactor * height);
    // 已在显示的组：范围放宽 10%，排序距离按 85% 计（滞后）
    const showing = (c: Cluster) => {
      const b = this.bubbles.get(c.key);
      return !!b && b.dyingAt === null;
    };
    const rank = (c: Cluster) => (showing(c) ? c.dist * 0.85 : c.dist);
    const inRange = [...this.cluster(focus, height).values()]
      .filter((c) => c.dist <= (showing(c) ? range * 1.1 : range))
      .sort((a, b) => PRIORITY[a.top.state] - PRIORITY[b.top.state] || rank(a) - rank(b));
    const shown = inRange.slice(0, Math.min(this.maxVisible, MAX_BUBBLES));
    const count = `${shown.length}/${inRange.length}`;
    if (count !== this.lastCount) {
      this.lastCount = count;
      this.onCount?.(shown.length, inRange.length);
    }

    const now = performance.now();
    const placed: [number, number][] = [];
    const live = new Set<string>();
    shown.forEach((c, i) => {
      live.add(c.key);
      const b = this.bubbles.get(c.key) ?? this.acquire(c.key, now);
      b.cluster = c;
      b.anchor.copy(c.anchor);
      if (b.dyingAt !== null) {
        b.dyingAt = null;
        b.el.style.pointerEvents = "";
      }
      const p = this.toScreen(c.anchor, rect);
      if (!p) {
        b.el.hidden = true;
        return;
      }
      b.el.hidden = false;
      // 与已放置的更紧急气泡重叠时调淡（排序保证先放的更紧急或更近）
      const covered = placed.some(([x, y]) => Math.hypot(x - p[0], y - p[1]) < OVERLAP_PX);
      placed.push(p);
      const t = (now - c.newest) / POP_MS;
      const pop = this.reduced || t >= 1 ? 1 : popCurve(t);
      b.el.style.transform = `translate(${p[0].toFixed(1)}px, ${p[1].toFixed(1)}px) translate(-50%, -100%) scale(${pop.toFixed(3)})`;
      b.el.style.zIndex = String(MAX_BUBBLES - i);
      b.el.classList.toggle("covered", covered);
      // 新元素第一帧保持透明，下一帧才设目标透明度，CSS 过渡才会淡入
      const fade = 1 - 0.85 * smoothstep(range * 0.75, range, c.dist);
      b.el.style.opacity = now === b.bornAt ? "0" : String(covered ? fade * 0.2 : fade);
      const sig = `${c.top.state}|${c.n}|${c.counts.burning}|${c.counts.threat}|${c.counts.burned}|${c.minEta === undefined ? "" : Math.round(c.minEta / 5)}`;
      if (b.el.dataset.sig !== sig) {
        b.el.dataset.sig = sig;
        b.el.className = `alert-bubble ${c.top.state}${c.n > 1 ? " cluster" : ""}${covered ? " covered" : ""}`;
        b.el.innerHTML = this.content(c);
        b.el.setAttribute("aria-label", this.label(c));
      }
    });

    // 不再显示的组：原地淡出后回收
    for (const [key, b] of this.bubbles) {
      if (live.has(key)) continue;
      if (b.dyingAt === null) {
        b.dyingAt = now;
        b.el.style.opacity = "0";
        b.el.style.pointerEvents = "none";
      }
      const p = this.toScreen(b.anchor, rect);
      if (p) b.el.style.transform = `translate(${p[0].toFixed(1)}px, ${p[1].toFixed(1)}px) translate(-50%, -100%)`;
      if (this.reduced || now - b.dyingAt > FADE_MS + 40) this.release(key, b);
    }
  }

  private toScreen(anchor: THREE.Vector3, rect: DOMRect): [number, number] | null {
    this.v.copy(anchor).project(this.camera);
    if (this.v.z > 1 || this.v.z < -1) return null;
    const x = ((this.v.x + 1) / 2) * rect.width;
    const y = ((1 - this.v.y) / 2) * rect.height;
    if (x < -40 || y < -40 || x > rect.width + 40 || y > rect.height + 40) return null;
    return [x, y];
  }

  private acquire(key: string, now: number): Bubble {
    const el = this.free.pop() ?? this.createElement();
    el.hidden = false;
    el.dataset.sig = "";
    el.style.opacity = "0";
    el.style.pointerEvents = "";
    const b: Bubble = { el, cluster: null, anchor: new THREE.Vector3(), bornAt: now, dyingAt: null };
    (el as HTMLButtonElement & { bubble?: Bubble }).bubble = b;
    this.bubbles.set(key, b);
    return b;
  }

  private release(key: string, b: Bubble) {
    b.el.hidden = true;
    b.cluster = null;
    this.bubbles.delete(key);
    this.free.push(b.el);
  }

  private createElement(): HTMLButtonElement {
    const el = document.createElement("button") as HTMLButtonElement & { bubble?: Bubble };
    el.type = "button";
    el.className = "alert-bubble";
    el.addEventListener("pointerenter", () => {
      const c = el.bubble?.cluster;
      if (!c) return;
      const r = el.getBoundingClientRect();
      const { title, rows } = c.n === 1 ? this.describe(c.top) : this.clusterCard(c);
      this.handlers.onHover(title, rows, r.right + 6, r.top);
    });
    el.addEventListener("pointerleave", () => this.handlers.onLeave());
    el.addEventListener("click", () => {
      const c = el.bubble?.cluster;
      if (!c) return;
      const spread = Math.max(...c.members.map((m) => m.anchor.distanceTo(c.anchor)));
      this.handlers.onFly(c.anchor.clone(), c.n === 1 ? 260 : Math.max(450, spread * 2.6));
    });
    this.root.appendChild(el);
    return el;
  }

  private content(c: Cluster): string {
    const icon = `<span class="alert-icon">${ICONS[c.top.state]}</span>`;
    if (c.n === 1) {
      const eta = c.top.state === "threat" && c.top.etaMin !== undefined ? `<span class="alert-eta">${fmtEta(c.top.etaMin)}</span>` : "";
      return icon + eta;
    }
    // 聚合：主状态图标与数量；其余状态在悬停卡片里
    return `${icon}<span class="alert-count">${c.counts[c.top.state]}</span>`;
  }

  private label(c: Cluster): string {
    const names: Record<HomeState, string> = { burning: "on fire", burned: "destroyed", threat: "threatened", calling: "being called", help: "asking for help" };
    return ORDER
      .filter((s) => c.counts[s] > 0)
      .map((s) => `${c.counts[s]} ${c.counts[s] === 1 ? "home" : "homes"} ${names[s]}`)
      .join(", ");
  }

  private clusterCard(c: Cluster): { title: string; rows: [string, string][] } {
    const rows: [string, string][] = [];
    if (c.counts.burning) rows.push(["On fire", String(c.counts.burning)]);
    if (c.counts.help) rows.push(["Needs help", String(c.counts.help)]);
    if (c.counts.calling) rows.push(["Being called", String(c.counts.calling)]);
    if (c.counts.threat) rows.push(["Threatened", c.minEta !== undefined ? `${c.counts.threat}, first in ${fmtEta(c.minEta)}` : String(c.counts.threat)]);
    if (c.counts.burned) rows.push(["Destroyed", String(c.counts.burned)]);
    rows.push(["", "Click to zoom in"]);
    return { title: `${c.n} homes`, rows };
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** 弹出：先放大越过 1 再回落（easeOutBack） */
function popCurve(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}

function fmtEta(min: number): string {
  const m = Math.round(min / 5) * 5;
  if (m < 5) return "now";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}
