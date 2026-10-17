// 房屋冒泡提示（参考《城市天际线》）：着火、烧毁、受威胁的房屋上方显示图标气泡。
// - HTML 叠加层：与界面同一套字体和配色，文字清晰，悬停与点击容易处理
// - 每帧把锚点投影到屏幕，按 CELL_PX 的屏幕网格聚合，再按紧急程度依次放置、过近的并入已放置的（避免重叠）；
//   聚合气泡只显示最紧急状态的图标与数量，分项计数在悬停卡片里；拉近后自动拆成单栋
// - 单栋气泡在状态变化时弹出；着火的气泡持续脉动（系统"减少动态效果"时关闭，见 shell.css）
// - 悬停显示详情卡片，点击时相机飞过去（聚合气泡拉近到该区域）
// - 距离上限：只显示离相机 range 以内的房屋，range = max(minRange, rangeFactor × 相机离地高度)，
//   随镜头远近自动调整；接近上限时淡出。数量上限：最多 maxVisible 个气泡，超出时按紧急程度、再按距离取前面的

import * as THREE from "three";
import type { HomeAlert, HomeState } from "../sim/homeStatus";

const CELL_PX = 54;
/** 两个气泡中心距离小于此值时合并 */
const MERGE_PX = 46;
const MAX_BUBBLES = 160;
const POP_MS = 450;
const PRIORITY: Record<HomeState, number> = { burning: 0, threat: 1, burned: 2 };

const ICONS: Record<HomeState, string> = {
  burning: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8.6 1.2c.4 2.3-1 3.4-2 4.6C5.5 7 4.6 8.2 4.6 10a3.4 3.4 0 0 0 6.8 0c0-1.4-.6-2.3-1.2-3 .1 1.1-.3 1.9-1 2.2.3-2-.2-3.4-.6-4.3.9-.8 1.2-2.2 0-3.7z" fill="currentColor"/></svg>`,
  burned: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 7.5 8 3l5.5 4.5V13h-11z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M6.2 13l1.6-2.6-1.2-1.4L8.4 7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  threat: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2 14.5 13.5h-13z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6.3v3.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.6" r=".9" fill="currentColor"/></svg>`,
};

interface Cluster {
  key: string;
  x: number;
  y: number;
  n: number;
  /** 成员中离相机最近的距离（米） */
  dist: number;
  counts: Record<HomeState, number>;
  top: HomeAlert;
  members: HomeAlert[];
  newest: number;
  minEta?: number;
}

export interface HomeAlertHandlers {
  onHover(title: string, rows: [string, string][], x: number, y: number): void;
  onLeave(): void;
  onFly(target: THREE.Vector3, distance: number): void;
}

export class HomeAlerts {
  readonly root: HTMLDivElement;
  private pool: HTMLButtonElement[] = [];
  private items: HomeAlert[] = [];
  private visible = true;
  private v = new THREE.Vector3();
  private clusters: Cluster[] = [];
  private reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  /** 同时显示的气泡上限 */
  maxVisible = 40;
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

  /** 每帧调用：投影、聚合、更新气泡 */
  update() {
    if (!this.visible) return;
    const rect = this.canvas.getBoundingClientRect();
    const s = this.root.style;
    s.left = `${rect.left}px`;
    s.top = `${rect.top}px`;
    s.width = `${rect.width}px`;
    s.height = `${rect.height}px`;

    const cam = this.camera.position;
    const range = Math.max(this.minRange, this.rangeFactor * Math.max(0, cam.y - this.groundAt(cam.x, cam.z)));
    const map = new Map<string, Cluster>();
    for (const a of this.items) {
      const dist = a.anchor.distanceTo(cam);
      if (dist > range) continue;
      this.v.copy(a.anchor).project(this.camera);
      if (this.v.z > 1 || this.v.z < -1) continue;
      const x = ((this.v.x + 1) / 2) * rect.width;
      const y = ((1 - this.v.y) / 2) * rect.height;
      if (x < -20 || y < -20 || x > rect.width + 20 || y > rect.height + 20) continue;
      const key = `${Math.floor(x / CELL_PX)},${Math.floor(y / CELL_PX)}`;
      let c = map.get(key);
      if (!c) {
        c = { key, x: 0, y: 0, n: 0, dist, counts: { burning: 0, burned: 0, threat: 0 }, top: a, members: [], newest: 0 };
        map.set(key, c);
      }
      c.x += x;
      c.y += y;
      c.n++;
      c.dist = Math.min(c.dist, dist);
      c.counts[a.state]++;
      c.members.push(a);
      c.newest = Math.max(c.newest, a.since);
      if (PRIORITY[a.state] < PRIORITY[c.top.state]) c.top = a;
      if (a.etaMin !== undefined) c.minEta = Math.min(c.minEta ?? Infinity, a.etaMin);
    }
    // 最紧急的先放；与已放置的气泡过近时并入它，避免重叠。超过上限时舍弃最不紧急的
    const placed: Cluster[] = [];
    for (const c of [...map.values()].sort((a, b) => PRIORITY[a.top.state] - PRIORITY[b.top.state] || b.n - a.n)) {
      c.x /= c.n;
      c.y /= c.n;
      const host = placed.find((p) => Math.hypot(p.x - c.x, p.y - c.y) < MERGE_PX);
      if (!host) {
        placed.push(c);
        continue;
      }
      host.n += c.n;
      host.dist = Math.min(host.dist, c.dist);
      for (const s of ["burning", "burned", "threat"] as HomeState[]) host.counts[s] += c.counts[s];
      host.members.push(...c.members);
      host.newest = Math.max(host.newest, c.newest);
      if (c.minEta !== undefined) host.minEta = Math.min(host.minEta ?? Infinity, c.minEta);
    }
    // 数量上限：按紧急程度、再按离相机的距离排序，只取前 maxVisible 个
    placed.sort((a, b) => PRIORITY[a.top.state] - PRIORITY[b.top.state] || a.dist - b.dist);
    this.clusters = placed.slice(0, Math.min(this.maxVisible, MAX_BUBBLES));
    const count = `${this.clusters.length}/${placed.length}`;
    if (count !== this.lastCount) {
      this.lastCount = count;
      this.onCount?.(this.clusters.length, placed.length);
    }

    const now = performance.now();
    this.clusters.forEach((c, i) => {
      const el = this.pool[i] ?? this.create(i);
      el.hidden = false;
      const { x, y } = c;
      const t = (now - c.newest) / POP_MS;
      const pop = this.reduced || t >= 1 ? 1 : popCurve(t);
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%) scale(${pop.toFixed(3)})`;
      el.style.zIndex = String(MAX_BUBBLES - i);
      // 接近距离上限时淡出
      el.style.opacity = String(1 - 0.85 * smoothstep(range * 0.75, range, c.dist));
      const sig = `${c.top.state}|${c.n}|${c.counts.burning}|${c.counts.threat}|${c.counts.burned}|${c.minEta === undefined ? "" : Math.round(c.minEta / 5)}`;
      if (el.dataset.sig !== sig) {
        el.dataset.sig = sig;
        el.className = `alert-bubble ${c.top.state}${c.n > 1 ? " cluster" : ""}`;
        el.innerHTML = this.content(c);
        el.setAttribute("aria-label", this.label(c));
      }
    });
    for (let i = this.clusters.length; i < this.pool.length; i++) this.pool[i].hidden = true;
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
    const names: Record<HomeState, string> = { burning: "on fire", burned: "destroyed", threat: "threatened" };
    return (["burning", "threat", "burned"] as HomeState[])
      .filter((s) => c.counts[s] > 0)
      .map((s) => `${c.counts[s]} ${c.counts[s] === 1 ? "home" : "homes"} ${names[s]}`)
      .join(", ");
  }

  private create(i: number): HTMLButtonElement {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "alert-bubble";
    el.addEventListener("pointerenter", () => {
      const c = this.clusters[i];
      if (!c) return;
      const r = el.getBoundingClientRect();
      const { title, rows } = c.n === 1 ? this.describe(c.top) : this.clusterCard(c);
      this.handlers.onHover(title, rows, r.right + 6, r.top);
    });
    el.addEventListener("pointerleave", () => this.handlers.onLeave());
    el.addEventListener("click", () => {
      const c = this.clusters[i];
      if (!c) return;
      const center = c.members.reduce((acc, m) => acc.add(m.anchor), new THREE.Vector3()).divideScalar(c.members.length);
      const spread = Math.max(...c.members.map((m) => m.anchor.distanceTo(center)));
      this.handlers.onFly(center, c.n === 1 ? 260 : Math.max(450, spread * 2.6));
    });
    this.root.appendChild(el);
    this.pool[i] = el;
    return el;
  }

  private clusterCard(c: Cluster): { title: string; rows: [string, string][] } {
    const rows: [string, string][] = [];
    if (c.counts.burning) rows.push(["On fire", String(c.counts.burning)]);
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
