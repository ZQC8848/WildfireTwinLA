// P3 集合预报：从当前火场出发，64 个成员同时向前推进，得到燃烧概率与到达时间分布。
//
// - 网格按 2×2 降采样到 256²（50 m），64 个成员拼成 8×8 的图集（2048²，RGBA16F，每张约 32 MB）。
//   单次高清模拟仍是 512²。格子变成 50 m，每步改为 10 分钟，蔓延速度（米 / 分钟）与单次模拟一致。
// - 与单次模拟用同一个 CA shader（见 shaders.ts 的图集说明）：每个成员有自己的随机种子，
//   风向扰动 ±15°、风速 ±20%；第 0 个成员不加扰动，作为对照。
// - 统计 pass 把 64 块归约成 256² 的 RGBA32F：燃烧概率与第 10、50、90 百分位的着火时刻。

import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { CellClass, GRID_CHANNELS, SpreadParams, type Grid, type WindField } from "@core";
import { treatmentMultipliers } from "./cpuReference";
import { ensembleInitFragment, ensembleReduceFragment, fullscreenVertex, stepFragment } from "./shaders";
import { WindTexture } from "./wind";

export const ENSEMBLE_FACTOR = 2;
export const ENSEMBLE_TILES = 8;
export const ENSEMBLE_MEMBERS = ENSEMBLE_TILES * ENSEMBLE_TILES;
/** 预报时长（分钟） */
export const ENSEMBLE_HORIZON_MIN = 8 * 60;
const DIR_JITTER_DEG = 15;
const SPEED_JITTER = 0.2;

export interface EnsembleResult {
  /** 预报起点的模拟时刻（分钟） */
  startMinutes: number;
  /** 每格 RGBA：燃烧概率、P10、P50、P90 着火时刻（距起点的分钟数，-1 表示该分位上未着火） */
  data: Float32Array;
  /** 显示用的统计纹理（256²，到达时间已平滑），地形 shader 直接采样 */
  texture: THREE.Texture;
  /** 推进、统计与读回的总耗时（毫秒） */
  ms: number;
  steps: number;
}

/** 按 factor × factor 降采样网格：高程、燃料、干燥度取平均；类别按多数，建筑与不可燃各占一半以上才算 */
export function downsampleGrid(grid: Grid, factor = ENSEMBLE_FACTOR): Grid {
  const { width: W, height: H, cellSize } = grid.meta;
  const w = Math.floor(W / factor);
  const h = Math.floor(H / factor);
  const data = new Float32Array(w * h * GRID_CHANNELS);
  const k = factor * factor;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let elev = 0;
      let fuel = 0;
      let dry = 0;
      let building = 0;
      let unburnable = 0;
      for (let j = 0; j < factor; j++)
        for (let i = 0; i < factor; i++) {
          const g = ((y * factor + j) * W + x * factor + i) * GRID_CHANNELS;
          elev += grid.data[g];
          fuel += grid.data[g + 1];
          dry += grid.data[g + 2];
          if (grid.data[g + 3] === CellClass.Building) building++;
          else if (grid.data[g + 3] === CellClass.Unburnable) unburnable++;
        }
      const o = (y * w + x) * GRID_CHANNELS;
      const cls = building * 2 >= k ? CellClass.Building : unburnable * 2 >= k ? CellClass.Unburnable : CellClass.Vegetation;
      data[o] = elev / k;
      data[o + 1] = cls === CellClass.Vegetation ? fuel / Math.max(1, k - building - unburnable) : 0;
      data[o + 2] = cls === CellClass.Unburnable ? 0 : dry / k;
      data[o + 3] = cls;
    }
  return { meta: { ...grid.meta, width: w, height: h, cellSize: cellSize * factor }, data };
}

/** 处理掩膜降采样：块内有防火带就算防火带，其次计划烧除、疏伐、Zone 0 */
function downsampleTreat(mask: Uint8Array, W: number, out: Uint8Array, w: number, factor: number) {
  const order = [1, 2, 3, 4];
  for (let y = 0; y < out.length / w; y++)
    for (let x = 0; x < w; x++) {
      let best = 0;
      for (let j = 0; j < factor; j++)
        for (let i = 0; i < factor; i++) {
          const v = mask[(y * factor + j) * W + x * factor + i];
          if (v && (!best || order.indexOf(v) < order.indexOf(best))) best = v;
        }
      out[y * w + x] = best;
    }
}

export class Ensemble {
  readonly grid: Grid;
  readonly size: number;
  /** 火势已被扑救压住时，所有成员都不再蔓延（与 FireSim.held 一致） */
  held = false;
  private targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private stats: THREE.WebGLRenderTarget;
  private cur = 0;
  private quad = new FullScreenQuad();
  private stepMat: THREE.ShaderMaterial;
  private initMat: THREE.ShaderMaterial;
  private reduceMat: THREE.ShaderMaterial;
  private wind: WindTexture;
  private treat: Uint8Array;
  private treatTex: THREE.DataTexture;
  private fullW: number;
  private display: THREE.DataTexture;
  private displayData: Float32Array;

  constructor(
    private renderer: THREE.WebGLRenderer,
    fullGrid: Grid,
  ) {
    this.fullW = fullGrid.meta.width;
    this.grid = downsampleGrid(fullGrid);
    const { width: n, cellSize } = this.grid.meta;
    this.size = n;
    const atlas = n * ENSEMBLE_TILES;
    const rt = (size: number, type: THREE.TextureDataType) =>
      new THREE.WebGLRenderTarget(size, size, { type, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
    this.targets = [rt(atlas, THREE.HalfFloatType), rt(atlas, THREE.HalfFloatType)];
    this.stats = rt(n, THREE.FloatType);
    this.displayData = new Float32Array(n * n * 4);
    this.display = new THREE.DataTexture(this.displayData, n, n, THREE.RGBAFormat, THREE.FloatType);

    const gridTex = new THREE.DataTexture(this.grid.data, n, n, THREE.RGBAFormat, THREE.FloatType);
    gridTex.needsUpdate = true;
    this.treat = new Uint8Array(n * n);
    this.treatTex = new THREE.DataTexture(this.treat, n, n, THREE.RedFormat, THREE.UnsignedByteType);
    this.treatTex.needsUpdate = true;
    this.wind = new WindTexture({ speedMs: 0, dirFromDeg: 0 });

    const mat = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: fullscreenVertex, fragmentShader, uniforms, depthTest: false, depthWrite: false });
    const m = treatmentMultipliers();
    this.stepMat = mat(stepFragment, {
      uState: { value: null },
      uGrid: { value: gridTex },
      uWind: { value: this.wind.texture },
      uWindSize: { value: new THREE.Vector2(1, 1) },
      uSize: { value: new THREE.Vector2(n, n) },
      uCellSize: { value: cellSize },
      uStep: { value: 0 },
      uSeed: { value: 101 },
      uStepMinutes: { value: SpreadParams.stepMinutes * ENSEMBLE_FACTOR },
      uPh: { value: SpreadParams.ph },
      uC1: { value: SpreadParams.c1 },
      uC2: { value: SpreadParams.c2 },
      uA: { value: SpreadParams.a },
      uSpotting: { value: true },
      uSpotBase: { value: SpreadParams.spot.pBase },
      uSpotDistPerMs: { value: SpreadParams.spot.distMeanPerWindMs },
      uSpotSamples: { value: SpreadParams.spot.samples },
      uSpotMaxPerMs: { value: SpreadParams.spot.distMaxPerWindMs },
      uSpotLongShare: { value: SpreadParams.spot.longShare },
      uSpotLongPerMs: { value: SpreadParams.spot.longMeanPerWindMs },
      uHold: { value: false },
      uTreat: { value: this.treatTex },
      uBreakMul: { value: m.break },
      uBurnMul: { value: m.burn },
      uThinMul: { value: m.thin },
      uZone0Mul: { value: m.zone0 },
      uTiles: { value: new THREE.Vector2(ENSEMBLE_TILES, ENSEMBLE_TILES) },
      uDirJitter: { value: THREE.MathUtils.degToRad(DIR_JITTER_DEG) },
      uSpeedJitter: { value: SPEED_JITTER },
    });
    this.initMat = mat(ensembleInitFragment, {
      uSrc: { value: null },
      uSize: { value: new THREE.Vector2(n, n) },
      uFactor: { value: ENSEMBLE_FACTOR },
    });
    this.reduceMat = mat(ensembleReduceFragment(ENSEMBLE_MEMBERS), {
      uAtlas: { value: null },
      uSize: { value: new THREE.Vector2(n, n) },
      uTiles: { value: new THREE.Vector2(ENSEMBLE_TILES, ENSEMBLE_TILES) },
    });
  }

  get stepMinutes(): number {
    return SpreadParams.stepMinutes * ENSEMBLE_FACTOR;
  }

  private draw(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget) {
    this.quad.material = material;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(target);
    this.quad.render(this.renderer);
    this.renderer.setRenderTarget(prev);
  }

  /** 从全分辨率状态纹理出发运行一次集合预报（同步，包含读回） */
  run(state: THREE.Texture, startMinutes: number, wind: WindField, treatMask: Uint8Array, horizonMin = ENSEMBLE_HORIZON_MIN, seed = 101): EnsembleResult {
    const t0 = performance.now();
    this.wind.set(wind);
    const u = this.stepMat.uniforms;
    u.uWind.value = this.wind.texture;
    u.uWindSize.value.set(this.wind.texture.image.width, this.wind.texture.image.height);
    u.uSeed.value = seed;
    u.uStepMinutes.value = this.stepMinutes;
    u.uHold.value = this.held;
    downsampleTreat(treatMask, this.fullW, this.treat, this.size, ENSEMBLE_FACTOR);
    this.treatTex.needsUpdate = true;

    this.initMat.uniforms.uSrc.value = state;
    this.cur = 0;
    this.draw(this.initMat, this.targets[0]);
    const steps = Math.round(horizonMin / this.stepMinutes);
    for (let i = 0; i < steps; i++) {
      u.uStep.value = i;
      u.uState.value = this.targets[this.cur].texture;
      this.draw(this.stepMat, this.targets[1 - this.cur]);
      this.cur = 1 - this.cur;
    }
    this.reduceMat.uniforms.uAtlas.value = this.targets[this.cur].texture;
    this.draw(this.reduceMat, this.stats);
    const data = new Float32Array(this.size * this.size * 4);
    this.renderer.readRenderTargetPixels(this.stats, 0, 0, this.size, this.size, data);
    smoothForDisplay(data, this.displayData, this.size);
    this.display.needsUpdate = true;
    return { startMinutes, data, texture: this.display, ms: performance.now() - t0, steps };
  }
}

/** 显示用的平滑：到达时间按 10 分钟一步量化、又有随机性，直接画等时线会碎成许多小圈。
 *  5×5 二项式核，只在有效格（该分位上着火）之间平均，有效范围不扩张；概率用同一个核平滑 */
const KERNEL = [1, 4, 6, 4, 1];
function smoothForDisplay(src: Float32Array, out: Float32Array, n: number) {
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const o = (y * n + x) * 4;
      const sum = [0, 0, 0, 0];
      const wsum = [0, 0, 0, 0];
      for (let j = -2; j <= 2; j++) {
        const yy = Math.min(n - 1, Math.max(0, y + j));
        for (let i = -2; i <= 2; i++) {
          const xx = Math.min(n - 1, Math.max(0, x + i));
          const k = KERNEL[i + 2] * KERNEL[j + 2];
          const q = (yy * n + xx) * 4;
          sum[0] += k * src[q];
          wsum[0] += k;
          for (let ch = 1; ch < 4; ch++) {
            if (src[q + ch] < 0) continue;
            sum[ch] += k * src[q + ch];
            wsum[ch] += k;
          }
        }
      }
      out[o] = sum[0] / wsum[0];
      for (let ch = 1; ch < 4; ch++) out[o + ch] = src[o + ch] < 0 ? -1 : sum[ch] / wsum[ch];
    }
}

export interface CommunityOutlook {
  id: string;
  name: string;
  /** 预报时长内火到达该社区任一格的概率（取社区内最大值） */
  probability: number;
  /** 中位数到达时间（距预报起点的分钟数）；不到一半成员到达时为 null */
  medianMin: number | null;
  /** 最早的可能到达时间（第 10 百分位） */
  earlyMin: number | null;
}

/** 社区层面的预报摘要；communities 的格子是全分辨率索引 */
export function communityOutlook(result: EnsembleResult, communities: { id: string; name: string; cells: number[] }[], fullWidth: number, size: number): CommunityOutlook[] {
  return communities.map((c) => {
    let p = 0;
    let med = Infinity;
    let early = Infinity;
    for (const cell of c.cells) {
      const x = Math.floor((cell % fullWidth) / ENSEMBLE_FACTOR);
      const y = Math.floor(Math.floor(cell / fullWidth) / ENSEMBLE_FACTOR);
      if (x >= size || y >= size) continue;
      const o = (y * size + x) * 4;
      p = Math.max(p, result.data[o]);
      if (result.data[o + 1] >= 0) early = Math.min(early, result.data[o + 1]);
      if (result.data[o + 2] >= 0) med = Math.min(med, result.data[o + 2]);
    }
    return { id: c.id, name: c.name, probability: p, medianMin: Number.isFinite(med) ? med : null, earlyMin: Number.isFinite(early) ? early : null };
  });
}
