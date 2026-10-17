// 规划 Worker：在降采样网格上运行 Lucia 的 core 规划器（贪心、最小割），不阻塞界面。
// 用自己的 Worker 而不是 core/src/worker.ts，是因为成本与可用性函数无法跨 Worker 传递，
// 这里需要按降采样倍率换算成本（一个粗格 = factor² 个细格）。

import { createCore, downsample, remapCell, upsampleMask, treatmentMask, PlanningParams } from "@core";
import type { Building, Grid, Treatment, WindField } from "@core";

export interface PlanJob {
  id: number;
  grid: Grid;
  factor: number;
  buildings: Building[];
  ignitions: number[];
  wind: WindField;
  budget: number;
  horizonMinutes: number;
  maxIterations: number;
  /** 来流的下风方向（网格坐标单位向量），用来确定最小割的"上风野地"火源 */
  downwind: [number, number];
  /** 野地火源离最近房屋的最小距离（米） */
  wildlandDistanceM: number;
}

export interface PlanResult {
  id: number;
  /** 全分辨率掩膜 */
  greedy: Uint8Array;
  mincut: Uint8Array;
  greedyCost: number;
  mincutCost: number;
  ms: number;
  error?: string;
}

function toFine(treatments: Treatment[], coarseN: number, cw: number, ch: number, factor: number): Uint8Array {
  return upsampleMask(treatmentMask(coarseN, treatments), cw, ch, factor);
}

/** 粗网格上：离最近建筑格超过 distM、且位于社区上风一侧的植被格 */
function wildlandSources(g: Grid, downwind: [number, number], distM: number): number[] {
  const { width: W, height: H, cellSize: S } = g.meta;
  const n = W * H;
  const dist = new Int32Array(n).fill(-1);
  const queue: number[] = [];
  let sx = 0;
  let sy = 0;
  for (let c = 0; c < n; c++)
    if (g.data[c * 4 + 3] === 2) {
      dist[c] = 0;
      queue.push(c);
      sx += c % W;
      sy += Math.floor(c / W);
    }
  if (!queue.length) return [];
  const cProj = ((sx / queue.length) * downwind[0] + (sy / queue.length) * downwind[1]);
  for (let h = 0; h < queue.length; h++) {
    const c = queue[h];
    const x = c % W;
    const y = Math.floor(c / W);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const v = yy * W + xx;
        if (dist[v] < 0) {
          dist[v] = dist[c] + 1;
          queue.push(v);
        }
      }
  }
  const minCells = Math.ceil(distM / S);
  const out: number[] = [];
  for (let c = 0; c < n; c++) {
    if (g.data[c * 4 + 3] !== 1 || dist[c] < minCells) continue;
    const proj = (c % W) * downwind[0] + Math.floor(c / W) * downwind[1];
    if (proj < cProj) out.push(c);
  }
  return out;
}

self.onmessage = (e: MessageEvent<PlanJob>) => {
  const job = e.data;
  const t0 = performance.now();
  try {
    const { width: W } = job.grid.meta;
    const coarse = downsample(job.grid, job.factor);
    const cw = coarse.meta.width;
    const ch = coarse.meta.height;
    const f2 = job.factor * job.factor;
    const buildings = job.buildings.map((b) => ({ ...b, cell: remapCell(b.cell, W, cw, job.factor) }));
    const core = createCore(coarse, {
      buildings,
      maxIterations: job.maxIterations,
      stripLength: 5,
      cost: (type) => PlanningParams.costPerCell[type] * f2,
    });
    const ignitions = [...new Set(job.ignitions.map((c) => remapCell(c, W, cw, job.factor)))];
    const scenarios = [{ id: "current", probability: 1, wind: job.wind, ignitions, horizonMinutes: job.horizonMinutes }];
    const greedy = core.planTreatments({ budget: job.budget, fixed: [], scenarios });
    // 最小割的火源不用具体点火点（那样最便宜的解只是绕点火点围一圈），
    // 而用"上风方向、离社区足够远的整片野地"，求出把野地和社区隔开的最便宜防火线
    const mincut = core.planMinCut(wildlandSources(coarse, job.downwind, job.wildlandDistanceM));
    const result: PlanResult = {
      id: job.id,
      greedy: toFine(greedy, cw * ch, cw, ch, job.factor),
      mincut: toFine(mincut, cw * ch, cw, ch, job.factor),
      greedyCost: greedy.reduce((s, t) => s + t.cost, 0),
      mincutCost: mincut.reduce((s, t) => s + t.cost, 0),
      ms: performance.now() - t0,
    };
    (self as unknown as Worker).postMessage(result, [result.greedy.buffer, result.mincut.buffer]);
  } catch (err) {
    const empty = new Uint8Array(0);
    (self as unknown as Worker).postMessage({ id: job.id, greedy: empty, mincut: empty, greedyCost: 0, mincutCost: 0, ms: performance.now() - t0, error: (err as Error).message } satisfies PlanResult);
  }
};
