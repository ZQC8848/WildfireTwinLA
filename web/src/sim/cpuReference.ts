// CPU 参考实现：与 shaders.ts 的 stepFragment 完全相同的规则与随机数（PCG 整数哈希）。
// 用途：1) 验证 GPU 实现的正确性；2) P3 的 CPU / GPU 性能对比。
// GPU 用 float32、CPU 用 float64 计算概率，极少数临界格子会因舍入不同而分岔，所以对照看统计量而不是逐格相等。

import {
  SpreadParams,
  TreatmentEffect,
  type Grid,
  type WindField,
} from "../../../packages/core/src/index.ts";
import { windGrid } from "./wind.ts";

function pcg(v: number): number {
  const state = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

export function rand(x: number, y: number, step: number, seed: number, k: number): number {
  const h = pcg((x + pcg((y + pcg((step + pcg((seed + Math.imul(k, 0x9e3779b9)) >>> 0)) >>> 0)) >>> 0)) >>> 0);
  return (h >>> 8) / 16777216;
}

export interface CpuSimOptions {
  seed: number;
  spotting: boolean;
  /** 处理掩膜（0 无，1 防火带，2 计划烧除，3 疏伐，4 Zone 0），与 GPU 的 uTreat 一致 */
  mask?: Uint8Array;
}

/** 处理手段对蔓延概率的倍率，与 GPU shader 一致 */
export function treatmentMultipliers() {
  return {
    break: TreatmentEffect.break.fuelMul,
    burn: TreatmentEffect.burn.fuelMul,
    thin: TreatmentEffect.thin.rosMul,
    zone0: TreatmentEffect.zone0.emberMul,
  };
}

export class CpuFireSim {
  state: Float32Array;
  step = 0;
  private next: Float32Array;
  private wind: Float32Array; // 每格 (vx, vy)
  private W: number;
  private H: number;

  constructor(
    private grid: Grid,
    windField: WindField,
    private opts: CpuSimOptions,
  ) {
    this.W = grid.meta.width;
    this.H = grid.meta.height;
    this.state = new Float32Array(this.W * this.H * 4);
    this.next = new Float32Array(this.W * this.H * 4);
    for (let c = 0; c < this.W * this.H; c++) this.state[c * 4 + 2] = -1;
    this.wind = windGrid(windField, this.W, this.H);
  }

  ignite(cells: number[]) {
    for (const c of cells) {
      if (this.state[c * 4] < 0.5 && this.grid.data[c * 4 + 3] > 0.5) {
        this.state[c * 4] = 1;
        this.state[c * 4 + 1] = 0;
        this.state[c * 4 + 2] = this.step * SpreadParams.stepMinutes;
      }
    }
  }

  advance(steps = 1) {
    for (let i = 0; i < steps; i++) this.stepOnce();
  }

  private stepOnce() {
    const { W, H, state: s, next: o } = this;
    const g = this.grid.data;
    const cs = this.grid.meta.cellSize;
    const P = SpreadParams;
    const seed = this.opts.seed;
    o.set(s);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = y * W + x;
        const st = s[c * 4];
        if (st > 1.5) continue;
        const elev = g[c * 4];
        const fuel = g[c * 4 + 1];
        const dry = g[c * 4 + 2];
        const cls = g[c * 4 + 3];
        if (st > 0.5) {
          const dur = cls > 1.5 ? 8 : 2 + Math.floor(3 * fuel + 0.5);
          o[c * 4 + 1] = s[c * 4 + 1] + 1;
          if (o[c * 4 + 1] >= dur) o[c * 4] = 2;
          continue;
        }
        if (cls < 0.5) continue;
        const M = treatmentMultipliers();
        const mask = this.opts.mask;
        const treat = mask ? mask[c] : 0;
        const treatMul = treat === 1 ? M.break : treat === 2 ? M.burn : treat === 3 ? M.thin : 1;
        // 燃烧格剩下的燃料：防火带、计划烧除里的燃烧格向外蔓延和放出飞火都按剩余燃料打折
        const fuelLeft = (n: number) => (!mask ? 1 : mask[n] === 1 ? M.break : mask[n] === 2 ? M.burn : 1);
        const vx = this.wind[c * 2];
        const vy = this.wind[c * 2 + 1];
        const V = Math.hypot(vx, vy);
        const wx = V > 1e-4 ? vx / V : 0;
        const wy = V > 1e-4 ? vy / V : 0;
        let notIgnite = 1;
        if (cls < 1.5 && fuel > 0) {
          const base = P.ph * (1 + (-0.4 + 0.8 * fuel)) * (1 + (-0.4 + 0.7 * dry));
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
              const n = ny * W + nx;
              const ns = s[n * 4];
              if (ns < 0.5 || ns > 1.5) continue;
              const diag = dx !== 0 && dy !== 0;
              const len = Math.hypot(dx, dy);
              const cosT = (wx * -dx + wy * -dy) / len;
              const dist = cs * (diag ? Math.SQRT2 : 1);
              const pw = Math.exp(P.c1 * V) * Math.exp(P.c2 * V * (cosT - 1));
              const slope = (Math.atan2(elev - g[n * 4], dist) * 180) / Math.PI;
              const ps = Math.exp(P.a * slope);
              const p = Math.min(1, Math.max(0, base * pw * ps * (diag ? 0.83 : 1) * treatMul * fuelLeft(n)));
              notIgnite *= 1 - p;
            }
        }
        if (this.opts.spotting && V > 2) {
          const meanDist = P.spot.distMeanPerWindMs * V;
          const longShare = P.spot.longShare * Math.min(1, Math.max(0, (V - 5) / 5));
          const sus = (cls > 1.5 ? 2.5 * (0.5 + dry) * (treat === 4 ? M.zone0 : 1) : fuel * (0.5 + dry)) * treatMul;
          for (let k = 0; k < Math.min(8, P.spot.samples); k++) {
            const u1 = Math.max(rand(x, y, this.step, seed, 10 + k * 3), 1e-6);
            const u2 = rand(x, y, this.step, seed, 11 + k * 3);
            const u3 = rand(x, y, this.step, seed, 12 + k * 3);
            const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
            const lofted = rand(x, y, this.step, seed, 40 + k) < longShare;
            const d = lofted ? P.spot.longMeanPerWindMs * V * Math.exp(z - 0.5) : meanDist * Math.exp(0.6 * z - 0.18);
            if (!lofted && d > P.spot.distMaxPerWindMs * V) continue;
            const j = ((15 * Math.PI) / 180) * (u3 * 2 - 1);
            const bx = -(wx * Math.cos(j) - wy * Math.sin(j));
            const by = -(wx * Math.sin(j) + wy * Math.cos(j));
            // GLSL 的 round 对 .5 的取舍与 Math.round 不同，这里用远离零的取整与 GPU 常见实现一致
            const sx = x + Math.sign(bx * d / cs) * Math.round(Math.abs((bx * d) / cs));
            const sy = y + Math.sign(by * d / cs) * Math.round(Math.abs((by * d) / cs));
            if (sx < 0 || sy < 0 || sx >= W || sy >= H || (sx === x && sy === y)) continue;
            const src = sy * W + sx;
            const sr = s[src * 4];
            if (sr > 0.5 && sr < 1.5) notIgnite *= 1 - Math.min(1, Math.max(0, P.spot.pBase * sus * fuelLeft(src)));
          }
        }
        if (rand(x, y, this.step, seed, 0) < 1 - notIgnite) {
          o[c * 4] = 1;
          o[c * 4 + 1] = 0;
          o[c * 4 + 2] = (this.step + 1) * P.stepMinutes;
        }
      }
    }
    this.state = o;
    this.next = s;
    this.step++;
  }
}
