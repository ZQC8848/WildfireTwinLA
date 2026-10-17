// 界面骨架：顶栏（模式切换）、左侧简报侧栏、底部控制条、地图浮层（悬停信息、图层与图例、风玫瑰）。
// 只负责 DOM 与交互事件，业务逻辑由 main.ts 通过回调与 set* 方法接入。

import "./tokens.css";
import "./shell.css";
import { LAYERS, type LayerId } from "../scene/layers";
import { formatDistance, formatMinutes, type CommunityStatus, type FireEvent } from "../sim/fireMonitor";

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
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export const compassName = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (html) e.innerHTML = html;
  return e;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export class Shell {
  mode: Mode = "plan";
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
        <h2>Test a fire</h2>
        <p id="plan-fire-empty">Click a hillside to start a test fire. Set the wind in the bar below, then compare how it spreads with and without terrain.</p>
        <dl class="metrics" id="plan-fire" hidden></dl>
      </section>
      <section data-mode-only="respond" class="first">
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
        <span class="bar-label">Speed</span>
        <div class="segmented" id="speed">
          <button data-sps="8">Slow</button><button data-sps="20">Normal</button><button data-sps="40">Fast</button>
        </div>
      </div>
      <div class="bar-group"><span class="figure elapsed" id="elapsed">0 min</span></div>
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
        </div>
      </div>`;

    document.body.append(top, rail, bottom, hover, corner);

    // ---- 事件 ----
    this.q<HTMLButtonElement>("#run").addEventListener("click", () => this.handlers.onRunToggle());
    this.q<HTMLButtonElement>("#step").addEventListener("click", () => this.handlers.onStep());
    this.q<HTMLButtonElement>("#reset").addEventListener("click", () => this.handlers.onReset());
    this.q<HTMLDivElement>("#speed").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-sps]");
      if (!b) return;
      this.setSpeed(Number(b.dataset.sps));
      this.handlers.onSpeed(Number(b.dataset.sps));
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
  setRunning(running: boolean) {
    this.q<HTMLButtonElement>("#run").textContent = running ? "Pause" : "Run";
  }

  setSpeed(sps: number) {
    this.q<HTMLDivElement>("#speed")
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.sps) === sps)));
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

  setElapsed(minutes: number | null) {
    const text = minutes === null ? "" : `T + ${formatMinutes(minutes)}`;
    this.q<HTMLSpanElement>("#elapsed").textContent = minutes === null ? "Not started" : text;
    this.q<HTMLSpanElement>("#clock").textContent = this.mode === "respond" && minutes !== null ? `Simulation ${text}` : "";
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
