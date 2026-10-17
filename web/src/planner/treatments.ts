// 处理方案：全分辨率（与模拟同网格）的掩膜，0 无，1 防火带，2 计划烧除，3 疏伐，4 Zone 0 房屋硬化。
// 笔刷在地形上涂抹；规则与 core 的 createCore.allowed 一致：防火带、烧除、疏伐只能用在植被格，Zone 0 只能用在建筑格。

import { CellClass, GRID_CHANNELS, PlanningParams, TreatmentCode, type Grid, type TreatmentType } from "@core";

export type Tool = TreatmentType | "erase";

export const TREATMENT_TYPES: TreatmentType[] = ["break", "burn", "thin", "zone0"];

export const TREATMENT_LABELS: Record<TreatmentType, string> = {
  break: "Fuel break",
  burn: "Prescribed burn",
  thin: "Thinning",
  zone0: "Home hardening",
};

export const TREATMENT_NOTES: Record<TreatmentType, string> = {
  break: "Clear vegetation to bare ground",
  burn: "Burn surface fuel in mild weather",
  thin: "Remove brush and lower branches",
  zone0: "Ember-resistant vents and a clear 5 ft zone",
};

const CODE_TO_TYPE: TreatmentType[] = ["break", "burn", "thin", "zone0"];

/** 每格成本（美元），来自 core 的 PlanningParams */
export function cellCost(code: number): number {
  return code ? PlanningParams.costPerCell[CODE_TO_TYPE[code - 1]] : 0;
}

export function maskCost(mask: Uint8Array): number {
  let total = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) total += cellCost(mask[i]);
  return total;
}

export function maskSummary(mask: Uint8Array, cellSize: number): Record<TreatmentType, number> {
  const ha = (cellSize * cellSize) / 1e4;
  const out = { break: 0, burn: 0, thin: 0, zone0: 0 };
  for (let i = 0; i < mask.length; i++) if (mask[i]) out[CODE_TO_TYPE[mask[i] - 1]] += ha;
  return out;
}

export class TreatmentPlan {
  readonly mask: Uint8Array;
  private W: number;
  private H: number;

  constructor(private grid: Grid) {
    this.W = grid.meta.width;
    this.H = grid.meta.height;
    this.mask = new Uint8Array(this.W * this.H);
  }

  allowed(type: TreatmentType, cell: number): boolean {
    const cls = this.grid.data[cell * GRID_CHANNELS + 3];
    return type === "zone0" ? cls === CellClass.Building : cls === CellClass.Vegetation;
  }

  /** 在格子 (x, y) 处按半径 r（格）涂抹；返回是否有变化 */
  paint(x: number, y: number, r: number, tool: Tool): boolean {
    let changed = false;
    const R = Math.ceil(r);
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= this.W || yy >= this.H) continue;
        const c = yy * this.W + xx;
        const next = tool === "erase" ? 0 : this.allowed(tool, c) ? TreatmentCode[tool] : this.mask[c];
        if (next !== this.mask[c]) {
          this.mask[c] = next;
          changed = true;
        }
      }
    return changed;
  }

  /** 沿线段 a→b 连续涂抹，鼠标拖得快时不会断开 */
  stroke(ax: number, ay: number, bx: number, by: number, r: number, tool: Tool): boolean {
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / Math.max(0.5, r * 0.5)));
    let changed = false;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      changed = this.paint(Math.round(ax + (bx - ax) * t), Math.round(ay + (by - ay) * t), r, tool) || changed;
    }
    return changed;
  }

  clear() {
    this.mask.fill(0);
  }

  get cost(): number {
    return maskCost(this.mask);
  }
}
