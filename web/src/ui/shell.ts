// 界面骨架：顶栏（模式切换）、左侧简报侧栏、底部控制条、地图浮层（悬停信息、图层与图例、风玫瑰）。
// 只负责 DOM 与交互事件，业务逻辑由 main.ts 通过回调与 set* 方法接入。

import "./tokens.css";
import "./shell.css";
import { LAYERS, type LayerId } from "../scene/layers";
import { formatDistance, formatMinutes, type CommunityStatus, type FireEvent } from "../sim/fireMonitor";
import { TREATMENT_LABELS, TREATMENT_NOTES, TREATMENT_TYPES, type Tool } from "../planner/treatments";

export type PlanKey = "none" | "yours" | "greedy" | "mincut";
export const PLAN_LABELS: Record<PlanKey, string> = { none: "None", yours: "Yours", greedy: "Greedy", mincut: "Min-cut" };

export interface PlanRow {
  homes: number;
  areaHa: number;
  cost: number;
  /** 每 10 万美元避免的受波及房屋；无成本时为 null */
  savedPer100k: number | null;
  /** 与无处理的差异在随机噪声以内 */
  withinNoise: boolean;
  overBudget: boolean;
}

export type Mode = "plan" | "respond";

export interface ShellHandlers {
  onMode(mode: Mode): void;
  onRunToggle(): void;
  onStep(): void;
  onReset(): void;
  onSpeed(stepsPerSecond: number): void;
  onWind(dirFromDeg: number, speedMs: number): void;
  onWindModel(model: "terrain" | "uniform"): void;
  onLayer(layer: LayerId): void;
  onShowWind(show: boolean): void;
  onShowSmoke(show: boolean): void;
  onTool(tool: Tool | null): void;
  onBrush(radiusCells: number): void;
  onClearPlan(): void;
  onBudget(dollars: number): void;
  onSuggest(): void;
  onShowPlan(key: PlanKey): void;
  onFeed(mode: "off" | "live" | "replay"): void;
  /** 拖动时间轴到某一时刻（分钟） */
  onScrub(minutes: number): void;
  /** 回到当前时刻 */
  onNow(): void;
  onView(view: ViewPreset): void;
}

export type ViewPreset = "overview" | "fire" | "community";

const fmtMoney = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}k` : `$${Math.round(v)}`);

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export const compassName = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (html) e.innerHTML = html;
  return e;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** 10 档速度对应的每秒步数 */
export const SPEED_LEVELS = [1, 2, 3, 5, 8, 12, 16, 20, 30, 40];

export class Shell {
  mode: Mode = "plan";
  /** 每步对应的模拟分钟数，用于速度标签 */
  stepMinutes = 5;
  private q = <T extends Element>(sel: string) => document.querySelector<T>(sel)!;
  private elevRange: [number, number] = [0, 1];

  constructor(
    private handlers: ShellHandlers,
    opts: { areaLabel: string; windDir: number; windSpeed: number; stepsPerSecond: number; layer: LayerId; elevRange: [number, number] },
  ) {
    document.body.dataset.mode = "plan";
    this.elevRange = opts.elevRange;

    // ---- 顶栏 ----
    const top = el("header", { class: "topbar" });
    top.innerHTML = `
      <div class="brand">WildfireTwinLA</div>
      <div class="mode-switch" role="tablist" aria-label="Mode">
        <button role="tab" aria-selected="true" data-mode="plan">Plan</button>
        <button role="tab" aria-selected="false" data-mode="respond">Respond</button>
      </div>
      <div class="topbar-meta"><span>${esc(opts.areaLabel)}</span><span class="clock" id="clock"></span></div>`;
    top.querySelectorAll<HTMLButtonElement>(".mode-switch button").forEach((b) =>
      b.addEventListener("click", () => this.handlers.onMode(b.dataset.mode as Mode)),
    );

    // ---- 侧栏 ----
    const rail = el("aside", { class: "rail", "aria-label": "Briefing" });
    rail.innerHTML = `
      <section data-mode-only="plan" class="first">
        <h2>This area</h2>
        <dl class="metrics" id="overview"></dl>
      </section>
      <section data-mode-only="plan">
        <h2>Treatments</h2>
        <div class="tool-grid" id="tools" role="toolbar" aria-label="Treatment tools">
          ${TREATMENT_TYPES.map((t) => `<button class="tool" data-tool="${t}" aria-pressed="false"><i class="swatch-${t}"></i>${TREATMENT_LABELS[t]}</button>`).join("")}
          <button class="tool" data-tool="erase" aria-pressed="false"><i class="swatch-erase"></i>Erase</button>
        </div>
        <p class="tool-note" id="tool-note">Pick a treatment, then drag on the map to paint it. Clicking the map without a treatment starts a test fire.</p>
        <div class="row-control"><label for="brush">Brush</label><input class="range" id="brush" type="range" min="1" max="8" step="1" value="3" /><span class="figure" id="brush-label"></span></div>
        <dl class="metrics" id="plan-summary"></dl>
        <button class="btn btn-quiet" id="clear-plan">Clear my plan</button>
      </section>
      <section data-mode-only="plan">
        <h2>Compare plans</h2>
        <div class="row-control"><label for="budget">Budget</label><input class="range" id="budget" type="range" min="10000" max="500000" step="10000" /><span class="figure" id="budget-label"></span></div>
        <button class="btn btn-primary btn-block" id="suggest">Suggest plans and compare</button>
        <table class="compare" id="compare" hidden>
          <thead><tr><th></th>${(["none", "yours", "greedy", "mincut"] as PlanKey[]).map((k) => `<th><button data-plan="${k}" aria-pressed="false">${PLAN_LABELS[k]}</button></th>`).join("")}</tr></thead>
          <tbody id="compare-body"></tbody>
        </table>
        <p class="tool-note" id="compare-status">Compares your plan with two algorithm plans under the current wind and test-fire ignition. Every plan runs the same fire simulation five times.</p>
      </section>
      <section data-mode-only="plan">
        <h2>Test a fire</h2>
        <p id="plan-fire-empty">Click a hillside to start a test fire. Set the wind in the bar below, then compare how it spreads with and without terrain.</p>
        <dl class="metrics" id="plan-fire" hidden></dl>
      </section>
      <section data-mode-only="respond" class="first">
        <h2>Data source</h2>
        <div class="segmented feed-modes" id="feed-mode" role="group" aria-label="Data source">
          <button data-feed="off" aria-pressed="true">Simulation</button><button data-feed="live" aria-pressed="false">Live feed</button><button data-feed="replay" aria-pressed="false">Eaton replay</button>
        </div>
        <p class="tool-note" id="feed-status">Test fires you place on the map. Switch to the live feed for satellite hotspots, or replay the Eaton Fire.</p>
        <dl class="metrics" id="feed-metrics"></dl>
      </section>
      <section data-mode-only="respond">
        <div id="respond-empty"><h2>No active fire</h2><p>Click the map to place an ignition. Distances, arrival estimates and affected homes update as the fire spreads.</p></div>
        <div id="respond-closest" hidden>
          <h2>Closest community</h2>
          <div class="closest-name" id="closest-name"></div>
          <div class="closest-figure" id="closest-figure"></div>
          <div class="closest-note" id="closest-note"></div>
        </div>
      </section>
      <section data-mode-only="respond">
        <h2>Communities</h2>
        <ul class="community-list" id="communities"></ul>
      </section>
      <section data-mode-only="respond">
        <h2>Homes in the fire area</h2>
        <dl class="metrics" id="homes"></dl>
      </section>
      <section data-mode-only="respond" id="calls-section" hidden>
        <h2>Calls to residents</h2>
        <dl class="metrics" id="calls"></dl>
      </section>
      <section data-mode-only="respond">
        <h2>Feed</h2>
        <ul class="feed" id="feed"></ul>
      </section>`;

    // ---- 底栏 ----
    const bottom = el("footer", { class: "bottombar" });
    const dirOptions = COMPASS.map((n, i) => `<option value="${i * 22.5}">${n}</option>`).join("");
    bottom.innerHTML = `
      <div class="bar-group">
        <button class="btn btn-primary" id="run">Run</button>
        <button class="btn" id="step">Step</button>
        <button class="btn" id="reset">Reset</button>
      </div>
      <div class="bar-group">
        <label class="bar-label" for="speed">Speed</label>
        <input class="range speed-range" id="speed" type="range" min="1" max="10" step="1" aria-describedby="speed-label" />
        <span class="figure speed-label" id="speed-label"></span>
      </div>
      <div class="timeline">
        <span class="figure elapsed" id="elapsed">Not started</span>
        <div class="timeline-track">
          <div class="timeline-ticks" id="timeline-ticks" aria-hidden="true"></div>
          <input class="timeline-range" id="timeline" type="range" min="0" max="0" step="5" value="0" aria-label="Simulation time" disabled />
        </div>
        <button class="btn btn-small" id="now" hidden>Now</button>
      </div>
      <div class="bar-spacer"></div>
      <div class="bar-group">
        <label for="wind-dir">Wind from</label>
        <select class="select" id="wind-dir">${dirOptions}</select>
        <input class="range" id="wind-speed" type="range" min="0" max="30" step="1" aria-label="Wind speed" />
        <span class="figure" id="wind-speed-label"></span>
      </div>
      <div class="bar-group">
        <div class="segmented" id="wind-model" aria-label="Wind model">
          <button data-model="terrain">Terrain wind</button><button data-model="uniform">Uniform wind</button>
        </div>
      </div>`;

    // ---- 地图浮层 ----
    const hover = el("div", { class: "hover-tag", id: "hover-tag", hidden: "" });
    const corner = el("div", { class: "map-corner" });
    const layerOptions = (Object.keys(LAYERS) as LayerId[]).map((id) => `<option value="${id}">${LAYERS[id].label}</option>`).join("");
    corner.innerHTML = `
      <div class="map-card view-card">
        <div class="segmented view-presets" id="view-presets" role="group" aria-label="Camera view">
          <button data-view="overview" title="Overview (1)">Overview</button><button data-view="fire" title="Fire front (2)">Fire front</button><button data-view="community" title="Closest community (3)">Community</button>
        </div>
      </div>
      <div class="map-card" id="layer-card">
        <div class="map-card-row"><label for="layer">Map layer</label><select class="select" id="layer">${layerOptions}</select></div>
      </div>
      <div class="map-card" id="legend"></div>
      <div class="map-card wind-rose">
        <svg viewBox="-24 -24 48 48" aria-hidden="true">
          <circle r="21" fill="none" stroke="currentColor" stroke-opacity="0.25" />
          <text y="-13" text-anchor="middle" font-size="8" fill="currentColor" fill-opacity="0.7">N</text>
          <g id="rose-arrow"><path d="M0,-14 L0,12 M-5,6 L0,13 L5,6" fill="none" stroke="#6F9DBF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></g>
        </svg>
        <div>
          <div id="rose-label" class="figure"></div>
          <label class="map-card-row"><input type="checkbox" id="show-wind" /> Show wind arrows</label>
          <label class="map-card-row"><input type="checkbox" id="show-smoke" checked /> Show smoke</label>
        </div>
      </div>`;

    document.body.append(top, rail, bottom, hover, corner);

    // ---- 事件 ----
    this.q<HTMLButtonElement>("#run").addEventListener("click", () => this.handlers.onRunToggle());
    this.q<HTMLButtonElement>("#step").addEventListener("click", () => this.handlers.onStep());
    this.q<HTMLButtonElement>("#reset").addEventListener("click", () => this.handlers.onReset());
    this.q<HTMLInputElement>("#speed").addEventListener("input", (e) => {
      const sps = SPEED_LEVELS[Number((e.target as HTMLInputElement).value) - 1];
      this.setSpeed(sps);
      this.handlers.onSpeed(sps);
    });
    const dir = this.q<HTMLSelectElement>("#wind-dir");
    const speed = this.q<HTMLInputElement>("#wind-speed");
    const emitWind = () => this.handlers.onWind(Number(dir.value), Number(speed.value));
    dir.addEventListener("change", emitWind);
    speed.addEventListener("input", emitWind);
    this.q<HTMLDivElement>("#wind-model").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-model]");
      if (!b) return;
      this.setWindModel(b.dataset.model as "terrain" | "uniform");
      this.handlers.onWindModel(b.dataset.model as "terrain" | "uniform");
    });
    const layer = this.q<HTMLSelectElement>("#layer");
    layer.addEventListener("change", () => {
      this.showLegend(layer.value as LayerId);
      this.handlers.onLayer(layer.value as LayerId);
    });
    this.q<HTMLInputElement>("#show-wind").addEventListener("change", (e) => this.handlers.onShowWind((e.target as HTMLInputElement).checked));
    this.q<HTMLDivElement>("#tools").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-tool]");
      if (!b) return;
      const tool = b.getAttribute("aria-pressed") === "true" ? null : (b.dataset.tool as Tool);
      this.setTool(tool);
      this.handlers.onTool(tool);
    });
    const brush = this.q<HTMLInputElement>("#brush");
    brush.addEventListener("input", () => {
      this.setBrush(Number(brush.value));
      this.handlers.onBrush(Number(brush.value));
    });
    this.q<HTMLButtonElement>("#clear-plan").addEventListener("click", () => this.handlers.onClearPlan());
    const budget = this.q<HTMLInputElement>("#budget");
    budget.addEventListener("input", () => {
      this.setBudget(Number(budget.value));
      this.handlers.onBudget(Number(budget.value));
    });
    this.q<HTMLButtonElement>("#suggest").addEventListener("click", () => this.handlers.onSuggest());
    this.q<HTMLTableElement>("#compare").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-plan]");
      if (b) this.handlers.onShowPlan(b.dataset.plan as PlanKey);
    });
    this.q<HTMLDivElement>("#feed-mode").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-feed]");
      if (b) this.handlers.onFeed(b.dataset.feed as "off" | "live" | "replay");
    });
    this.q<HTMLDivElement>("#view-presets").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-view]");
      if (b) this.handlers.onView(b.dataset.view as ViewPreset);
    });
    // 快捷键 1 / 2 / 3：在输入框里打字时不触发
    addEventListener("keydown", (e) => {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || e.metaKey || e.ctrlKey || e.altKey) return;
      const view = ({ "1": "overview", "2": "fire", "3": "community" } as Record<string, ViewPreset>)[e.key];
      if (view) this.handlers.onView(view);
    });
    const timeline = this.q<HTMLInputElement>("#timeline");
    timeline.addEventListener("input", () => this.handlers.onScrub(Number(timeline.value)));
    this.q<HTMLButtonElement>("#now").addEventListener("click", () => this.handlers.onNow());
    this.setBrush(3);
    this.q<HTMLInputElement>("#show-smoke").addEventListener("change", (e) => this.handlers.onShowSmoke((e.target as HTMLInputElement).checked));

    this.setSpeed(opts.stepsPerSecond);
    this.setWind(opts.windDir, opts.windSpeed);
    this.setWindModel("terrain");
    layer.value = opts.layer;
    this.showLegend(opts.layer);
  }

  // ---- 模式 ----
  setMode(mode: Mode) {
    this.mode = mode;
    document.body.dataset.mode = mode;
    document.querySelectorAll<HTMLButtonElement>(".mode-switch button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === mode)));
    // 图层切换只属于规划工作；Respond 下固定显示自然色地表
    this.q<HTMLDivElement>("#layer-card").hidden = mode === "respond";
    this.q<HTMLDivElement>("#legend").hidden = mode === "respond";
  }

  // ---- 底栏 ----
  /** 没有火时禁用"火头"视角 */
  setViewAvailable(fire: boolean) {
    const b = this.q<HTMLButtonElement>('#view-presets button[data-view="fire"]');
    b.disabled = !fire;
  }

  setRunning(running: boolean) {
    this.q<HTMLButtonElement>("#run").textContent = running ? "Pause" : "Run";
  }

  setSpeed(sps: number) {
    // 取最接近的档位
    let level = 0;
    SPEED_LEVELS.forEach((v, i) => {
      if (Math.abs(v - sps) < Math.abs(SPEED_LEVELS[level] - sps)) level = i;
    });
    this.q<HTMLInputElement>("#speed").value = String(level + 1);
    // 每秒真实时间相当于多少模拟时间
    const simMinPerSec = SPEED_LEVELS[level] * this.stepMinutes;
    const rate = simMinPerSec >= 60 ? `${(simMinPerSec / 60).toFixed(simMinPerSec % 60 ? 1 : 0)} h/s` : `${simMinPerSec} min/s`;
    this.q<HTMLSpanElement>("#speed-label").textContent = `${level + 1} (${rate})`;
  }

  setWind(dirFromDeg: number, speedMs: number) {
    const dir = this.q<HTMLSelectElement>("#wind-dir");
    dir.value = String(Math.round((((dirFromDeg % 360) + 360) % 360) / 22.5) * 22.5 % 360);
    this.q<HTMLInputElement>("#wind-speed").value = String(speedMs);
    this.q<HTMLSpanElement>("#wind-speed-label").textContent = `${speedMs} m/s`;
    // 风玫瑰的箭头指向风的去向
    this.q<SVGGElement>("#rose-arrow").setAttribute("transform", `rotate(${dirFromDeg})`);
    this.q<HTMLDivElement>("#rose-label").textContent = `${compassName(dirFromDeg)} wind, ${speedMs} m/s`;
  }

  setWindModel(model: "terrain" | "uniform") {
    this.q<HTMLDivElement>("#wind-model")
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.model === model)));
  }

  /** 时间轴：max 为当前模拟时间，view 为显示时刻；ticks 为事件刻度 */
  setTimeline(max: number | null, view: number, live: boolean, ticks: { minutes: number; level: string }[]) {
    const range = this.q<HTMLInputElement>("#timeline");
    range.disabled = !max;
    range.max = String(max ?? 0);
    if (document.activeElement !== range) range.value = String(live ? (max ?? 0) : view);
    this.q<HTMLButtonElement>("#now").hidden = live;
    const el = this.q<HTMLSpanElement>("#elapsed");
    el.classList.toggle("viewing", !live);
    if (max) el.textContent = `T + ${formatMinutes(live ? max : view)}`;
    this.q<HTMLDivElement>("#timeline-ticks").innerHTML = max
      ? ticks
          .filter((t) => t.minutes <= max)
          .map((t) => `<i data-level="${t.level}" style="left:${(t.minutes / max) * 100}%"></i>`)
          .join("")
      : "";
  }

  setElapsed(minutes: number | null) {
    const text = minutes === null ? "" : `T + ${formatMinutes(minutes)}`;
    this.q<HTMLSpanElement>("#elapsed").textContent = minutes === null ? "Not started" : text;
    const source = this.feedLabel ? `${this.feedLabel}, ` : "";
    this.q<HTMLSpanElement>("#clock").textContent = this.mode === "respond" && (minutes !== null || source) ? `${source}${minutes !== null ? `simulation ${text}` : "waiting"}` : "";
  }

  // ---- 图例 ----
  private showLegend(id: LayerId) {
    const def = LAYERS[id];
    let body = "";
    if (def.ramp) {
      const labels = id === "elevation" ? [`${Math.round(this.elevRange[0])} m`, `${Math.round(this.elevRange[1])} m`] : def.rampLabels!;
      body = `<div class="ramp" style="background:linear-gradient(90deg,${def.ramp.join(",")})"></div>
        <div class="ramp-labels"><span>${labels[0]}</span><span>${labels[1]}</span></div>`;
    } else if (def.swatches) {
      body = def.swatches.map((s) => `<div class="swatch"><i style="background:${s.color}"></i>${s.label}</div>`).join("");
    }
    this.q<HTMLDivElement>("#legend").innerHTML = `<div class="legend-title">${def.label}</div>${body}`;
  }

  // ---- 悬停信息 ----
  showHover(x: number, y: number, title: string, rows: [string, string][]) {
    const tag = this.q<HTMLDivElement>("#hover-tag");
    tag.innerHTML = `<strong>${esc(title)}</strong><dl class="metrics">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
    tag.hidden = false;
    // 放在光标右下方，靠近窗口边缘时翻到另一侧
    const w = tag.offsetWidth;
    const h = tag.offsetHeight;
    tag.style.left = `${x + 16 + w > innerWidth ? x - w - 16 : x + 16}px`;
    tag.style.top = `${y + 16 + h > innerHeight ? y - h - 16 : y + 16}px`;
  }

  hideHover() {
    this.q<HTMLDivElement>("#hover-tag").hidden = true;
  }

  // ---- 处理方案 ----
  tool: Tool | null = null;

  setTool(tool: Tool | null) {
    this.tool = tool;
    document.querySelectorAll<HTMLButtonElement>("#tools button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tool === tool)));
    document.body.classList.toggle("painting", !!tool);
    this.q<HTMLParagraphElement>("#tool-note").textContent = !tool
      ? "Pick a treatment, then drag on the map to paint it. Clicking the map without a treatment starts a test fire."
      : tool === "erase"
        ? "Drag on the map to remove treatments. Press Esc to stop painting."
        : `${TREATMENT_NOTES[tool]}. ${tool === "zone0" ? "Applies to homes only." : "Applies to wildland vegetation only."} Press Esc to stop painting.`;
  }

  setBrush(r: number) {
    this.q<HTMLInputElement>("#brush").value = String(r);
    this.q<HTMLSpanElement>("#brush-label").textContent = `${Math.round(r * 2 * 25)} m`;
  }

  setBudget(v: number) {
    this.q<HTMLInputElement>("#budget").value = String(v);
    this.q<HTMLSpanElement>("#budget-label").textContent = fmtMoney(v);
  }

  setPlanSummary(byType: Record<string, number>, cost: number) {
    const rows = TREATMENT_TYPES.filter((t) => byType[t] > 0).map((t) => `<dt>${TREATMENT_LABELS[t]}</dt><dd>${byType[t].toFixed(1)} ha</dd>`);
    this.q<HTMLDListElement>("#plan-summary").innerHTML = rows.length ? `${rows.join("")}<dt>Cost</dt><dd>${fmtMoney(cost)}</dd>` : "";
    this.q<HTMLButtonElement>("#clear-plan").hidden = !rows.length;
  }

  setCompareStatus(text: string, busy = false) {
    this.q<HTMLParagraphElement>("#compare-status").textContent = text;
    const b = this.q<HTMLButtonElement>("#suggest");
    b.disabled = busy;
    b.textContent = busy ? "Working…" : "Suggest plans and compare";
  }

  setCompare(rows: Partial<Record<PlanKey, PlanRow>>, active: PlanKey | null, staleYours = false) {
    const table = this.q<HTMLTableElement>("#compare");
    const keys: PlanKey[] = ["none", "yours", "greedy", "mincut"];
    table.hidden = !keys.some((k) => rows[k]);
    table.querySelectorAll<HTMLButtonElement>("thead button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.plan === active)));
    const cell = (k: PlanKey, f: (r: PlanRow) => string) => {
      const r = rows[k];
      const stale = k === "yours" && staleYours;
      return `<td class="${stale ? "stale" : ""}${k === active ? " active" : ""}">${r ? f(r) : "–"}</td>`;
    };
    // 每一行里最好的那一格加粗
    const best = (f: (r: PlanRow) => number, lower: boolean) => {
      let bk: PlanKey | null = null;
      for (const k of keys) {
        const r = rows[k];
        if (!r || k === "none" || r.withinNoise) continue;
        if (bk === null || (lower ? f(r) < f(rows[bk]!) : f(r) > f(rows[bk]!))) bk = k;
      }
      return bk;
    };
    const bestHomes = best((r) => r.homes, true);
    const mark = (k: PlanKey, b: PlanKey | null, text: string) => (k === b ? `<strong>${text}</strong>` : text);
    this.q<HTMLTableSectionElement>("#compare-body").innerHTML = [
      `<tr><th>Homes reached</th>${keys.map((k) => cell(k, (r) => mark(k, bestHomes, Math.round(r.homes).toLocaleString("en-US")))).join("")}</tr>`,
      `<tr><th>Area burned, ha</th>${keys.map((k) => cell(k, (r) => Math.round(r.areaHa).toLocaleString("en-US"))).join("")}</tr>`,
      `<tr><th>Cost</th>${keys.map((k) => cell(k, (r) => (r.cost ? fmtMoney(r.cost) + (r.overBudget ? "*" : "") : "–"))).join("")}</tr>`,
      `<tr><th>Homes saved per $100k</th>${keys.map((k) => cell(k, (r) => (r.withinNoise ? "≈ 0" : r.savedPer100k === null ? "–" : r.savedPer100k.toFixed(1)))).join("")}</tr>`,
    ].join("");
  }

  // ---- 数据源 ----
  setFeed(mode: "off" | "live" | "replay", status: string, rows: [string, string][]) {
    document.querySelectorAll<HTMLButtonElement>("#feed-mode button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.feed === mode)));
    this.q<HTMLParagraphElement>("#feed-status").textContent =
      mode === "off" ? "Test fires you place on the map. Switch to the live feed for satellite hotspots, or replay the Eaton Fire." : status;
    this.q<HTMLDListElement>("#feed-metrics").innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
    this.feedLabel = mode === "live" ? "Live feed" : mode === "replay" ? "Eaton replay" : "";
  }

  private feedLabel = "";

  setCalls(t: { confirmed: number; noAnswer: number; needsHelp: number; other: number } | null) {
    const total = t ? t.confirmed + t.noAnswer + t.needsHelp + t.other : 0;
    this.q<HTMLElement>("#calls-section").hidden = !total;
    if (!t || !total) return;
    this.q<HTMLDListElement>("#calls").innerHTML =
      `<dt>Confirmed</dt><dd>${t.confirmed}</dd><dt>No answer</dt><dd>${t.noAnswer}</dd>` +
      `<dt>Needs help</dt><dd class="${t.needsHelp ? "ember" : ""}">${t.needsHelp}</dd>` +
      (t.other ? `<dt>In progress</dt><dd>${t.other}</dd>` : "");
  }

  // ---- 侧栏内容 ----
  setOverview(rows: [string, string][]) {
    this.q<HTMLDListElement>("#overview").innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  }

  setPlanFire(rows: [string, string][] | null) {
    this.q<HTMLParagraphElement>("#plan-fire-empty").hidden = !!rows;
    const dl = this.q<HTMLDListElement>("#plan-fire");
    dl.hidden = !rows;
    if (rows) dl.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  }

  setRespond(closest: CommunityStatus | null, communities: CommunityStatus[], homes: { affected: number; total: number }, events: FireEvent[]) {
    this.q<HTMLDivElement>("#respond-empty").hidden = !!closest;
    this.q<HTMLDivElement>("#respond-closest").hidden = !closest;
    if (closest) {
      this.q<HTMLDivElement>("#closest-name").textContent = closest.name;
      let figure: string;
      let note: string;
      if (closest.level === "reached") {
        figure = closest.homesAffected.toLocaleString("en-US");
        note = `homes in the fire area, out of ${closest.homes.toLocaleString("en-US")}`;
      } else if (closest.etaMin !== null) {
        figure = formatMinutes(closest.etaMin);
        note = `until the fire front arrives at the current spread rate, ${formatDistance(closest.distanceM)} away`;
      } else {
        figure = formatDistance(closest.distanceM);
        note = "to the fire front; not approaching at the moment";
      }
      this.q<HTMLDivElement>("#closest-figure").textContent = figure;
      this.q<HTMLDivElement>("#closest-note").textContent = note;
    }
    const sorted = [...communities].sort((a, b) => a.distanceM - b.distanceM);
    this.q<HTMLUListElement>("#communities").innerHTML = sorted
      .map((c) => {
        const figure = c.level === "reached" ? `${c.homesAffected.toLocaleString("en-US")} homes` : c.etaMin !== null ? formatMinutes(c.etaMin) : formatDistance(c.distanceM);
        const label = { clear: "No threat", watch: "Watch", warning: "Warning", reached: "Fire in community" }[c.level];
        return `<li><span class="level" data-level="${c.level}" title="${label}" aria-label="${label}"></span><span>${esc(c.name)}</span><span class="figure">${figure}</span></li>`;
      })
      .join("");
    this.q<HTMLDListElement>("#homes").innerHTML = `<dt>In the fire area</dt><dd>${homes.affected.toLocaleString("en-US")}</dd><dt>All homes in this area</dt><dd>${homes.total.toLocaleString("en-US")}</dd>`;
    this.q<HTMLUListElement>("#feed").innerHTML = events.length
      ? events.map((e) => `<li data-level="${e.level}"><time>T+${formatMinutes(e.minutes)}</time><span>${esc(e.text)}</span></li>`).join("")
      : `<li><time></time><span>Events appear here as the fire spreads.</span></li>`;
  }
}
