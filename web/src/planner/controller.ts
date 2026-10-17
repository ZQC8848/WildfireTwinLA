// P4 防控交互：笔刷涂抹处理区、在 Worker 中生成算法方案、用 GPU 模拟对比各方案、在地图上切换显示的方案。
// 显示中的方案同时就是火势模拟使用的处理掩膜，所以选中某一列后点火，看到的就是该方案下的火。

import * as THREE from "three";
import { CellClass, GRID_CHANNELS, SpreadParams, type Building, type Grid, type Wind, type WindField } from "@core";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { TerrainPicker } from "../interact/picking";
import type { FireSim } from "../sim/fireSim";
import { windToGrid } from "../sim/wind";
import type { PlanKey, PlanRow, Shell } from "../ui/shell";
import { PlanEvaluator, type PlanMetrics } from "./evaluate";
import type { PlanJob, PlanResult } from "./planner.worker";
import { TreatmentPlan, maskCost, maskSummary, type Tool } from "./treatments";

const fmt = (v: number) => (v >= 1e3 ? `$${Math.round(v / 1e3)}k` : `$${Math.round(v)}`);
const EVAL_STEPS = 96; // 8 小时（每步 5 分钟）
const EVAL_SEEDS = [11, 23, 37, 41, 53];
const PLANNER_FACTOR = 4; // 512² → 128²
// 规划器的到达时间已与 GPU 模拟对齐（core 的 arrivalTimeScale），预测时长与 GPU 评估相同
const PLANNER_HORIZON_MIN = EVAL_STEPS * SpreadParams.stepMinutes;

export interface PlannerDeps {
  grid: Grid;
  buildings: Building[];
  sim: FireSim;
  renderer: THREE.WebGLRenderer;
  gridTexture: THREE.DataTexture;
  terrainUniforms: Record<string, THREE.IUniform>;
  propUniforms: Record<string, THREE.IUniform>;
  controls: OrbitControls;
  picker: TerrainPicker;
  canvas: HTMLCanvasElement;
  shell: Shell;
  inflow(): Wind;
  windField(): WindField;
  ignitions(): number[];
  /** 默认情景的点火格（没有测试火时使用），如 Norte Fire 的报告起火点 */
  scenario?(): { cells: number[]; label: string };
}

export class PlannerController {
  readonly yours: TreatmentPlan;
  budget = 150000;
  private brush = 3;
  private active: PlanKey = "yours";
  private plans: Partial<Record<PlanKey, Uint8Array>> = {};
  private rows: Partial<Record<PlanKey, PlanRow>> = {};
  private staleYours = false;
  /** 受波及房屋数的随机噪声幅度（房屋数），小于它的差异视为没有差别 */
  private noise = 0;
  private evaluator: PlanEvaluator;
  private worker: Worker;
  private jobId = 0;
  private painting = false;
  private last: [number, number] | null = null;

  constructor(private d: PlannerDeps) {
    this.yours = new TreatmentPlan(d.grid);
    this.evaluator = new PlanEvaluator(d.renderer, d.grid, d.gridTexture, d.buildings);
    this.worker = new Worker(new URL("./planner.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<PlanResult>) => this.onResult(e.data);
    d.terrainUniforms.uTreat.value = d.sim.treatTex;
    d.propUniforms.uTreat.value = d.sim.treatTex;
    d.shell.setBudget(this.budget);
    this.refreshSummary();
    this.bindPainting();
    addEventListener("keydown", (e) => {
      if (e.key === "Escape" && d.shell.tool) this.setTool(null);
    });
  }

  /** 正在涂抹时，地图点击不应点火 */
  get isPainting(): boolean {
    return !!this.d.shell.tool;
  }

  setTool(tool: Tool | null) {
    this.d.shell.setTool(tool);
    if (tool) this.show("yours");
  }

  setBrush(r: number) {
    this.brush = r;
  }

  setBudget(v: number) {
    this.budget = v;
  }

  clear() {
    this.yours.clear();
    this.afterEdit();
  }

  // ---- 涂抹 ----
  private bindPainting() {
    const { canvas, picker, controls } = this.d;
    canvas.addEventListener("pointerdown", (e) => {
      const tool = this.d.shell.tool;
      if (!tool || e.button !== 0) return;
      const hit = picker.pick(e.clientX, e.clientY);
      if (!hit) return;
      this.painting = true;
      controls.enabled = false;
      canvas.setPointerCapture(e.pointerId);
      this.last = [hit.x, hit.y];
      if (this.yours.paint(hit.x, hit.y, this.brush, tool)) this.upload();
    });
    canvas.addEventListener("pointermove", (e) => {
      const tool = this.d.shell.tool;
      if (!this.painting || !tool) return;
      const hit = picker.pick(e.clientX, e.clientY);
      if (!hit || !this.last) return;
      if (this.yours.stroke(this.last[0], this.last[1], hit.x, hit.y, this.brush, tool)) this.upload();
      this.last = [hit.x, hit.y];
    });
    const end = () => {
      if (!this.painting) return;
      this.painting = false;
      controls.enabled = true;
      this.last = null;
      this.afterEdit();
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
  }

  private upload() {
    this.d.sim.setTreatments(this.yours.mask);
    this.setHasTreat(this.yours.mask);
  }

  /** 代码直接修改 yours.mask 后调用（调试、导入方案） */
  commitEdit() {
    this.upload();
    this.afterEdit();
  }

  private afterEdit() {
    this.show("yours");
    this.refreshSummary();
    if (this.rows.none) {
      // 已经对比过：重新评估"你的方案"这一列（只跑这一列，很快）
      this.staleYours = true;
      this.d.shell.setCompare(this.rows, this.active, true);
      requestAnimationFrame(() => {
        this.rows.yours = this.evaluate("yours", this.yours.mask);
        this.staleYours = false;
        this.d.shell.setCompare(this.rows, this.active);
      });
    }
  }

  private refreshSummary() {
    this.d.shell.setPlanSummary(maskSummary(this.yours.mask, this.d.grid.meta.cellSize), this.yours.cost);
  }

  private setHasTreat(mask: Uint8Array) {
    const has = mask.some((v) => v > 0);
    this.d.terrainUniforms.uHasTreat.value = has;
    this.d.propUniforms.uHasTreat.value = has;
  }

  /** 在地图与火势模拟中使用某个方案 */
  show(key: PlanKey) {
    this.active = key;
    const mask = key === "yours" ? this.yours.mask : this.plans[key] ?? new Uint8Array(this.yours.mask.length);
    this.d.sim.setTreatments(mask);
    this.setHasTreat(mask);
    if (this.rows.none) this.d.shell.setCompare(this.rows, key, this.staleYours);
  }

  // ---- 方案生成与对比 ----
  suggest() {
    const { grid, buildings, shell } = this.d;
    const ignitions = this.scenarioIgnitions();
    if (!ignitions.length) {
      shell.setCompareStatus("No wildland fuel found upwind of the communities for this wind. Click the map to place a test fire, then try again.");
      return;
    }
    shell.setCompareStatus("Finding algorithm plans…", true);
    const job: PlanJob = {
      id: ++this.jobId,
      grid,
      factor: PLANNER_FACTOR,
      buildings,
      ignitions,
      wind: this.d.windField(),
      budget: this.budget,
      horizonMinutes: PLANNER_HORIZON_MIN,
      maxIterations: 16,
      downwind: this.downwind(),
      wildlandDistanceM: 2500,
    };
    this.lastIgnitions = ignitions;
    this.worker.postMessage(job);
  }

  private lastIgnitions: number[] = [];

  private onResult(r: PlanResult) {
    const { shell } = this.d;
    if (r.id !== this.jobId) return;
    if (r.error) {
      shell.setCompareStatus(`The planner stopped: ${r.error}`);
      return;
    }
    shell.setCompareStatus("Running the fire simulation for each plan…", true);
    // 让界面先刷新状态文字，再做同步的 GPU 评估
    requestAnimationFrame(() => {
      const n = this.yours.mask.length;
      this.plans = { none: new Uint8Array(n), greedy: r.greedy, mincut: r.mincut };
      this.rows = {};
      this.rows.none = this.evaluate("none", this.plans.none!);
      for (const k of ["greedy", "mincut"] as PlanKey[]) this.rows[k] = this.evaluate(k, this.plans[k]!);
      this.rows.yours = this.evaluate("yours", this.yours.mask);
      shell.setCompareStatus(
        `Same fire for every plan: ${this.ignitionLabel()}, current wind, 8 hours, averaged over ${EVAL_SEEDS.length} runs. Planner took ${(r.ms / 1000).toFixed(1)} s.` +
          ` Differences under ${Math.round(this.noise)} homes are within run-to-run noise.` +
          greedyNote(r, this.budget) +
          (this.rows.mincut?.overBudget ? " * Over budget: the min-cut line ignores the budget." : ""),
      );
      // 默认展示贪心方案（你还没画时），否则保持你的方案
      this.show(this.yours.mask.some((v) => v) ? "yours" : "greedy");
      // 表格在 show() 里才显示出来，之后再把它滚到侧栏可见处
      const rail = document.querySelector<HTMLElement>(".rail");
      const table = document.getElementById("compare");
      if (rail && table) rail.scrollTop = Math.max(0, table.getBoundingClientRect().top - rail.getBoundingClientRect().top + rail.scrollTop - 140);
    });
  }

  private evaluate(key: PlanKey, mask: Uint8Array): PlanRow {
    const m: PlanMetrics = this.evaluator.run(mask, this.lastIgnitions, this.d.windField(), EVAL_STEPS, EVAL_SEEDS);
    const cost = maskCost(mask);
    if (key === "none") {
      // 噪声：无处理方案各次运行的标准误的 2 倍，至少 5 栋
      const n = m.homesBySeed.length;
      const mean = m.homesReached;
      const sd = Math.sqrt(m.homesBySeed.reduce((s, h) => s + (h - mean) ** 2, 0) / Math.max(1, n - 1));
      this.noise = Math.max(5, (2 * sd) / Math.sqrt(n));
    }
    const base = key === "none" ? m : this.rowsMetrics("none");
    const saved = base ? base.homesReached - m.homesReached : 0;
    const significant = Math.abs(saved) > this.noise;
    return {
      homes: m.homesReached,
      areaHa: m.burnedAreaHa,
      cost,
      savedPer100k: cost > 0 && significant ? (saved / cost) * 1e5 : null,
      withinNoise: key !== "none" && !significant,
      overBudget: cost > this.budget,
    };
  }

  private rowsMetrics(key: PlanKey): PlanMetrics | null {
    const r = this.rows[key];
    return r ? { homesReached: r.homes, burnedAreaHa: r.areaHa, homesBySeed: [] } : null;
  }

  /** 来流下风方向（网格坐标单位向量）；无风时假定北风 */
  private downwind(): [number, number] {
    const [vx, vy] = windToGrid(this.d.inflow());
    const len = Math.hypot(vx, vy);
    return len > 1e-3 ? [vx / len, vy / len] : [0, 1];
  }

  private ignitionLabel(): string {
    if (this.d.ignitions().length) return "your test-fire ignition";
    const sc = this.d.scenario?.();
    return sc?.cells.length ? sc.label : "a likely ignition upwind of the communities";
  }

  /** 情景点火点：有测试火就用测试火的点火点；其次用默认情景；否则在社区上风方向约 4 km 处取三个高燃料点 */
  private scenarioIgnitions(): number[] {
    const user = this.d.ignitions();
    if (user.length) return user;
    const sc = this.d.scenario?.();
    if (sc?.cells.length) return sc.cells;
    const { grid, buildings } = this.d;
    const { width: W, cellSize: S } = grid.meta;
    if (!buildings.length) return [];
    let cx = 0;
    let cy = 0;
    for (const b of buildings) {
      cx += b.cell % W;
      cy += Math.floor(b.cell / W);
    }
    cx /= buildings.length;
    cy /= buildings.length;
    const [vx, vy] = windToGrid(this.d.inflow());
    const len = Math.hypot(vx, vy) || 1;
    // 风为 0 时假定北风（Santa Ana 季的主导方向）
    const dx = len > 1e-3 ? vx / len : 0;
    const dy = len > 1e-3 ? vy / len : 1;
    const dist = 4000 / S;
    const out: number[] = [];
    for (const lateral of [-1200 / S, 0, 1200 / S]) {
      const px = Math.round(cx - dx * dist - dy * lateral);
      const py = Math.round(cy - dy * dist + dx * lateral);
      const c = nearestFuel(grid, px, py, 30);
      if (c >= 0) out.push(c);
    }
    return out;
  }
}

/** 贪心规划器为什么停下：使用 core 返回的诊断信息 */
function greedyNote(r: PlanResult, budget: number): string {
  const reason = r.diagnostics?.stopReason;
  if (reason === "budget-exhausted") return ` The greedy planner used ${fmt(r.greedyCost)} of the ${fmt(budget)} budget.`;
  if (reason === "iteration-limit") return ` The greedy planner hit its iteration limit at ${fmt(r.greedyCost)}.`;
  return ` The greedy planner stopped at ${fmt(r.greedyCost)}: no further treatment showed a benefit in its spread model.`;
}

/** 半径 r 格内燃料最高的植被格 */
function nearestFuel(grid: Grid, x: number, y: number, r: number): number {
  const { width: W, height: H } = grid.meta;
  let best = -1;
  let bestFuel = 0.3;
  for (let dy = -r; dy <= r; dy += 2)
    for (let dx = -r; dx <= r; dx += 2) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const c = yy * W + xx;
      const fuel = grid.data[c * GRID_CHANNELS + 1] - Math.hypot(dx, dy) * 0.004;
      if (grid.data[c * GRID_CHANNELS + 3] === CellClass.Vegetation && fuel > bestFuel) {
        bestFuel = fuel;
        best = c;
      }
    }
  return best;
}
