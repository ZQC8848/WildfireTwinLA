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
  onForecast(): void;
  onShowAlerts(show: boolean): void;
  onShowMarkers(show: boolean): void;
  onShowContact(show: boolean): void;
  onCameraMode(mode: "orbit" | "fly"): void;
  onNorth(): void;
  /** 左栏的紧急联络入口：展开右侧面板 */
  onContactOpen(): void;
  onShowForecast(show: boolean): void;
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

// 工具条图标：16px，线条用 currentColor，按下时随文字变成 Retardant 粉红
const svg = (body: string) => `<svg class="tool-icon" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const TOOL_ICONS = {
  overview: svg(`<path d="M1.5 4.5 6 2.5l4 2 4.5-2v9L10 13.5l-4-2-4.5 2z"/><path d="M6 2.5v9M10 4.5v9"/>`),
  fire: svg(`<path d="M8.6 1.5c.4 2.2-1 3.3-2 4.5C5.6 7.1 4.8 8.2 4.8 9.9a3.2 3.2 0 0 0 6.4 0c0-1.3-.6-2.2-1.1-2.8.1 1-.3 1.8-.9 2.1.3-1.9-.2-3.2-.6-4.1.8-.8 1.1-2.1 0-3.6z"/>`),
  community: svg(`<path d="M2 7.5 8 2.5l6 5"/><path d="M3.5 6.5v7h9v-7"/><path d="M6.5 13.5v-4h3v4"/>`),
  wind: svg(`<path d="M1.5 5.5h8.5a2 2 0 1 0-2-2"/><path d="M1.5 8.5h11a2 2 0 1 1-2 2"/><path d="M1.5 11.5h5"/>`),
  smoke: svg(`<path d="M4.5 12.5h7a3 3 0 0 0 .3-6 4 4 0 0 0-7.6-.8 3.4 3.4 0 0 0 .3 6.8z"/>`),
  alerts: svg(`<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/><path d="M8 5.5v2.2"/><path d="M8 9.3v.01"/>`),
  markers: svg(`<path d="M4 14V6M8 14V2M12 14V8"/>`),
  phone: svg(`<path d="M5.2 2.5 3.4 3.1c-.9.4-1.3 1.4-1 2.3 1.4 4 4.2 6.8 8.2 8.2.9.3 1.9-.1 2.3-1l.6-1.8-2.8-1.6-1.3 1.2C7.9 9.6 6.4 8.1 5.6 6.6l1.2-1.3z"/>`),
  chevron: svg(`<path d="M4 6l4 4 4-4"/>`),
};

/** 每位访客自己的界面偏好（图例折叠等），读写失败时用默认值 */
function readPref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(`wildfiretwin.${key}`);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}
function writePref(key: string, value: boolean) {
  try {
    localStorage.setItem(`wildfiretwin.${key}`, value ? "1" : "0");
  } catch {
    /* 隐私模式等情况下忽略 */
  }
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
          <button data-feed="off" aria-pressed="true">Simulation</button><button data-feed="live" aria-pressed="false">Live feed</button><button data-feed="replay" aria-pressed="false">Norte replay</button>
        </div>
        <p class="tool-note" id="feed-status">Shows the test fire from Plan mode. Switch to the live feed for satellite hotspots, or replay the Norte Fire of Oct 16, 2026.</p>
        <dl class="metrics" id="feed-metrics"></dl>
        <p class="tool-note feed-legend" id="feed-legend" hidden><i class="sw sw-sat"></i>Satellite hotspot <i class="sw sw-miss"></i>Model had not reached it <i class="sw sw-report"></i>Reported ignition<span id="legend-damage" hidden> <i class="sw sw-damage"></i>Reported damage area (street level, not a per-home list)</span></p>
      </section>
      <section data-mode-only="respond">
        <div id="respond-empty"><h2>No active fire</h2><p>Start the Norte replay or the live feed above, or place a test fire in Plan mode. Distances, arrival estimates and affected homes update as the fire spreads.</p></div>
        <div id="respond-closest" hidden>
          <h2>Closest community</h2>
          <div class="closest-name" id="closest-name"></div>
          <div class="closest-figure" id="closest-figure"></div>
          <div class="closest-note" id="closest-note"></div>
        </div>
      </section>
      <section data-mode-only="respond">
        <button class="contact-entry" id="contact-entry" aria-controls="contact-dock">
          ${TOOL_ICONS.phone}
          <span class="ce-main"><span class="ce-title">Emergency contact</span><span class="ce-sub" id="contact-entry-sub"></span></span>
          <span class="dock-badge help" id="contact-entry-help" title="Needs help" hidden></span>
          <span class="ce-go" aria-hidden="true">›</span>
        </button>
      </section>
      <section data-mode-only="respond" id="forecast-section">
        <h2>Forecast, next 8 hours</h2>
        <button class="btn btn-block" id="forecast-run" disabled>Run 64-run forecast</button>
        <label class="map-card-row forecast-show"><input type="checkbox" id="forecast-show" checked /> Show on map</label>
        <p class="tool-note" id="forecast-status">64 fire simulations from the current fire, each with the wind direction varied up to ±15° and the speed up to ±20%.</p>
        <table class="compare" id="forecast-table" hidden></table>
        <p class="tool-note" id="forecast-legend" hidden>Shading: chance of burning. Lines: median arrival, one per hour. Chance is the share of runs in which the fire reaches the community.</p>
      </section>
      <section data-mode-only="respond">
        <h2>Communities</h2>
        <ul class="community-list" id="communities"></ul>
      </section>
      <section data-mode-only="respond">
        <h2>Homes in the fire area</h2>
        <dl class="metrics" id="homes"></dl>
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
        <input class="range" id="wind-speed" type="range" min="0" max="30" step="0.5" aria-label="Wind speed" />
        <span class="figure" id="wind-speed-label"></span>
      </div>
      <div class="bar-group">
        <div class="segmented" id="wind-model" aria-label="Wind model">
          <button data-model="terrain">Terrain wind</button><button data-model="uniform">Uniform wind</button>
        </div>
      </div>`;

    // ---- 地图浮层 ----
    const hover = el("div", { class: "hover-tag", id: "hover-tag", hidden: "" });
    // 右侧工具条（导航与显示开关，图标 + 文字）；右下角可折叠的图层与图例；左下角数据署名；底部居中的一次性提示
    const tools = el("div", { class: "map-tools", role: "toolbar", "aria-label": "Map controls" });
    tools.innerHTML = `
      <button class="compass" id="compass" title="Click to face north">
        <svg viewBox="-24 -24 48 48" aria-hidden="true">
          <g id="compass-dial">
            <circle r="21" fill="none" stroke="currentColor" stroke-opacity="0.25" />
            <path d="M0,-21 L0,-16 M21,0 L16,0 M0,21 L0,16 M-21,0 L-16,0" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.5" />
            <text y="-9" text-anchor="middle" font-size="9" font-weight="600" fill="currentColor">N</text>
          </g>
          <g id="compass-wind"><path d="M0,-14 L0,12 M-5,6 L0,13 L5,6" fill="none" stroke="#6F9DBF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></g>
        </svg>
        <span><span class="compass-label" id="compass-label"></span><span class="compass-sub">Face north</span></span>
      </button>
      <div class="tool-group" id="view-presets" role="group" aria-label="Camera view">
        <button class="tool-btn" data-view="overview">${TOOL_ICONS.overview}<span>Overview</span><kbd>1</kbd></button>
        <button class="tool-btn" data-view="fire">${TOOL_ICONS.fire}<span>Fire front</span><kbd>2</kbd></button>
        <button class="tool-btn" data-view="community">${TOOL_ICONS.community}<span>Community</span><kbd>3</kbd></button>
      </div>
      <div class="tool-group">
        <div class="segmented camera-mode" id="camera-mode" role="group" aria-label="Camera controls">
          <button data-cam="orbit" aria-pressed="true" title="Drag to orbit, scroll to zoom">Orbit</button><button data-cam="fly" aria-pressed="false" title="Right-drag to look, W A S D to move, Q / E down and up">Fly (WASD)</button>
        </div>
      </div>
      <div class="tool-group" role="group" aria-label="Show on map">
        <button class="tool-btn toggle" id="show-wind" aria-pressed="false">${TOOL_ICONS.wind}<span>Wind arrows</span></button>
        <button class="tool-btn toggle" id="show-smoke" aria-pressed="true">${TOOL_ICONS.smoke}<span>Smoke</span></button>
        <button class="tool-btn toggle" id="show-alerts" aria-pressed="true" title="Shortcut: H">${TOOL_ICONS.alerts}<span>Home alerts</span><span class="tool-badge" id="alerts-count" hidden></span><kbd>H</kbd></button>
        <button class="tool-btn toggle" id="show-markers" aria-pressed="true">${TOOL_ICONS.markers}<span>Satellite hotspots</span></button>
        <button class="tool-btn toggle" id="show-contact" aria-pressed="true">${TOOL_ICONS.phone}<span>Contact status</span></button>
      </div>`;
    const layerOptions = (Object.keys(LAYERS) as LayerId[]).map((id) => `<option value="${id}">${LAYERS[id].label}</option>`).join("");
    const corner = el("div", { class: "map-legend", id: "map-legend" });
    corner.innerHTML = `
      <div class="legend-head">
        <select class="select" id="layer" aria-label="Map layer">${layerOptions}</select>
        <span class="legend-static" id="legend-static" hidden>Natural</span>
        <button class="legend-toggle" id="legend-toggle" aria-expanded="true" aria-controls="legend" title="Collapse legend">${TOOL_ICONS.chevron}</button>
      </div>
      <div class="legend-body" id="legend"></div>`;
    const attribution = el("div", { class: "map-attrib", id: "map-attrib" });
    const toast = el("div", { class: "map-toast", id: "map-toast", role: "status", hidden: "" });
    toast.innerHTML = `<span id="map-toast-text"></span><button id="map-toast-close" aria-label="Dismiss">×</button>`;

    document.body.append(top, rail, bottom, hover, tools, corner, attribution, toast);

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
    // 显示开关：按钮的 aria-pressed 表示开 / 关
    const toggle = (id: string, fn: (on: boolean) => void) => {
      const b = this.q<HTMLButtonElement>(id);
      b.addEventListener("click", () => {
        const on = b.getAttribute("aria-pressed") !== "true";
        b.setAttribute("aria-pressed", String(on));
        fn(on);
      });
    };
    toggle("#show-wind", (on) => this.handlers.onShowWind(on));
    toggle("#show-smoke", (on) => this.handlers.onShowSmoke(on));
    toggle("#show-alerts", (on) => this.handlers.onShowAlerts(on));
    toggle("#show-markers", (on) => this.handlers.onShowMarkers(on));
    toggle("#show-contact", (on) => this.handlers.onShowContact(on));
    this.q<HTMLButtonElement>("#compass").addEventListener("click", () => this.handlers.onNorth());
    this.q<HTMLButtonElement>("#legend-toggle").addEventListener("click", () => this.setLegendOpen(!this.legendOpen, true));
    this.q<HTMLButtonElement>("#map-toast-close").addEventListener("click", () => (this.q<HTMLDivElement>("#map-toast").hidden = true));
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
      // H：开关房屋冒泡提示
      if (e.key === "h" || e.key === "H") this.q<HTMLButtonElement>("#show-alerts").click();
    });
    const timeline = this.q<HTMLInputElement>("#timeline");
    timeline.addEventListener("input", () => this.handlers.onScrub(Number(timeline.value)));
    this.q<HTMLButtonElement>("#now").addEventListener("click", () => this.handlers.onNow());
    this.setBrush(3);
    this.q<HTMLDivElement>("#camera-mode").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-cam]");
      if (!b) return;
      const mode = b.dataset.cam as "orbit" | "fly";
      this.setCameraMode(mode);
      this.handlers.onCameraMode(mode);
    });
    this.q<HTMLButtonElement>("#forecast-run").addEventListener("click", () => this.handlers.onForecast());
    this.q<HTMLButtonElement>("#contact-entry").addEventListener("click", () => this.handlers.onContactOpen());
    this.q<HTMLInputElement>("#forecast-show").addEventListener("change", (e) => this.handlers.onShowForecast((e.target as HTMLInputElement).checked));

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
    // 图层切换只属于规划工作；Respond 下固定显示自然色地表，图例只读、默认折叠
    const select = this.q<HTMLSelectElement>("#layer");
    select.hidden = mode === "respond";
    this.q<HTMLSpanElement>("#legend-static").hidden = mode !== "respond";
    this.showLegend(mode === "respond" ? "natural" : (select.value as LayerId));
    this.setLegendOpen(readPref(`legend.${mode}`, mode === "plan"), false);
  }

  // ---- 底栏 ----
  /** 没有火时禁用"火头"视角 */
  setViewAvailable(fire: boolean) {
    const b = this.q<HTMLButtonElement>('#view-presets [data-view="fire"]');
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
    this.windFrom = dirFromDeg;
    this.q<HTMLSpanElement>("#compass-label").textContent = `${compassName(dirFromDeg)} wind, ${speedMs} m/s`;
    this.drawCompass();
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
    this.q<HTMLDivElement>("#legend").innerHTML = body;
  }

  // ---- 悬停信息 ----
  showHover(x: number, y: number, title: string, rows: [string, string][]) {
    const tag = this.q<HTMLDivElement>("#hover-tag");
    tag.innerHTML = `<strong>${esc(title)}</strong><dl class="metrics">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
    tag.hidden = false;
    // 放在光标右下方，靠近地图右缘（右侧面板）或窗口底部时翻到另一侧
    const w = tag.offsetWidth;
    const h = tag.offsetHeight;
    const right = document.getElementById("app")?.getBoundingClientRect().right ?? innerWidth;
    tag.style.left = `${x + 16 + w > right ? x - w - 16 : x + 16}px`;
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

  setCameraMode(mode: "orbit" | "fly") {
    this.q<HTMLDivElement>("#camera-mode")
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.cam === mode)));
    if (mode === "fly")
      this.toast("Fly camera: right-drag to look, W A S D to move, Q / E down and up, Shift for speed. Scroll moves forward; right-drag and scroll changes speed.", 6000);
  }

  setFlySpeed(scale: number) {
    this.toast(`Fly speed ×${scale.toFixed(1)}`, 1200);
  }

  /** 冒泡数量达到上限时在按钮上显示"显示了多少 / 共多少" */
  setAlertCount(shown: number, total: number) {
    const el = this.q<HTMLSpanElement>("#alerts-count");
    el.hidden = total <= shown;
    el.textContent = `${shown}/${total}`;
    el.title = `Showing ${shown} of ${total} alert bubbles`;
  }

  // ---- 指南针：随相机朝向旋转，风箭头始终表示真实风向 ----
  private heading = 0;
  private windFrom = 0;

  /** 相机朝向（度，0 为正北，顺时针） */
  setHeading(deg: number) {
    if (Math.abs(((deg - this.heading + 540) % 360) - 180) < 0.5) return;
    this.heading = deg;
    this.drawCompass();
  }

  private drawCompass() {
    this.q<SVGGElement>("#compass-dial").setAttribute("transform", `rotate(${(-this.heading).toFixed(1)})`);
    // 箭头指向风的去向：真实风向减去相机朝向
    this.q<SVGGElement>("#compass-wind").setAttribute("transform", `rotate(${(this.windFrom - this.heading).toFixed(1)})`);
  }

  // ---- 图例折叠：两种模式各自记住上次的选择 ----
  private legendOpen = true;

  private setLegendOpen(open: boolean, remember: boolean) {
    this.legendOpen = open;
    const t = this.q<HTMLButtonElement>("#legend-toggle");
    t.setAttribute("aria-expanded", String(open));
    t.title = open ? "Collapse legend" : "Expand legend";
    this.q<HTMLDivElement>("#map-legend").classList.toggle("collapsed", !open);
    if (remember) writePref(`legend.${this.mode}`, open);
  }

  // ---- 地图左下角的数据署名 ----
  setAttribution(text: string) {
    const a = this.q<HTMLDivElement>("#map-attrib");
    a.textContent = text;
    a.title = text;
    a.hidden = !text;
  }

  // ---- 底部居中的一次性提示 ----
  private toastTimer = 0;

  toast(text: string, ms = 4000) {
    const t = this.q<HTMLDivElement>("#map-toast");
    this.q<HTMLSpanElement>("#map-toast-text").textContent = text;
    t.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (t.hidden = true), ms);
  }

  /** 有报告受损区域数据时在图例里加一项 */
  setDamageLegend(show: boolean) {
    this.q<HTMLSpanElement>("#legend-damage").hidden = !show;
  }

  // ---- 集合预报 ----
  setForecast(available: boolean, status: string | null, rows: { name: string; probability: number; medianMin: number | null; earlyMin: number | null }[] | null) {
    this.q<HTMLButtonElement>("#forecast-run").disabled = !available;
    if (status) this.q<HTMLParagraphElement>("#forecast-status").textContent = status;
    const table = this.q<HTMLTableElement>("#forecast-table");
    table.hidden = !rows;
    this.q<HTMLParagraphElement>("#forecast-legend").hidden = !rows;
    if (!rows) return;
    const t = (m: number | null) => (m === null ? "–" : formatMinutes(m));
    const pct = (p: number) => (p > 0 && p < 0.02 ? "< 2%" : `${Math.round(p * 100)}%`);
    table.innerHTML =
      `<thead><tr><th></th><th>Chance</th><th>Median</th><th>Earliest</th></tr></thead><tbody>` +
      [...rows]
        .sort((a, b) => b.probability - a.probability)
        .map((r) => `<tr><th>${esc(r.name)}</th><td class="${r.probability >= 0.5 ? "ember" : ""}">${pct(r.probability)}</td><td>${t(r.medianMin)}</td><td>${t(r.earlyMin)}</td></tr>`)
        .join("") +
      "</tbody>";
  }

  // ---- 数据源 ----
  setFeed(mode: "off" | "live" | "replay", status: string, rows: [string, string][], bundled = false) {
    document.querySelectorAll<HTMLButtonElement>("#feed-mode button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.feed === mode)));
    const notes: Record<typeof mode, string> = {
      off: "Shows the test fire from Plan mode. Switch to the live feed for satellite hotspots, or replay the Norte Fire of Oct 16, 2026.",
      live: status,
      replay:
        `${status} After-the-fact replay of the Norte Fire from public data (NIFC incident records, NASA FIRMS, NOAA HRRR wind). Not an official product.` +
        (bundled ? " Evacuation orders and the final perimeter are not in this replay yet." : ""),
    };
    this.q<HTMLParagraphElement>("#feed-status").textContent = notes[mode];
    this.q<HTMLParagraphElement>("#feed-legend").hidden = mode === "off";
    this.q<HTMLDListElement>("#feed-metrics").innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
    this.feedLabel = mode === "live" ? "Live feed" : mode === "replay" ? "Norte replay" : "";
  }

  private feedLabel = "";

  // ---- 紧急联络：左栏只保留一行入口，详情在右侧面板（contactDock.ts） ----
  setContactEntry(status: string, needsHelp: number) {
    this.q<HTMLSpanElement>("#contact-entry-sub").textContent = status;
    const help = this.q<HTMLSpanElement>("#contact-entry-help");
    help.hidden = !needsHelp;
    help.textContent = String(needsHelp);
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
