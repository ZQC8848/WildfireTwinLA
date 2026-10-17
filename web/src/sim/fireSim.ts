// GPU 火势模拟：两张 RGBA32F 渲染目标来回交替（ping-pong），每步一次全屏绘制。
// 状态纹理供地形与模型 shader 直接读取（R 通道 0 / 1 / 2）。

import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { CellClass, GRID_CHANNELS, SpreadParams, type Grid, type WindField } from "@core";
import { fullscreenVertex, igniteFragment, resetFragment, stepFragment } from "./shaders";
import { WindTexture } from "./wind";

export interface FireStats {
  minutes: number;
  burningCells: number;
  burnedCells: number;
  burnedAreaHa: number;
  buildingCellsBurned: number;
}

export class FireSim {
  readonly width: number;
  readonly height: number;
  step = 0;
  seed = 1;
  spotting = true;
  private targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private cur = 0;
  private quad = new FullScreenQuad();
  private stepMat: THREE.ShaderMaterial;
  private igniteMat: THREE.ShaderMaterial;
  private resetMat: THREE.ShaderMaterial;
  private wind: WindTexture;
  private mask: Float32Array;
  private maskTex: THREE.DataTexture;
  private readBuf: Float32Array;
  private reading = false;
  private lastStats: FireStats;
  /** 最近一次读回时正在燃烧的格子（抽样，最多 SAMPLE_CAP 个），供烟雾等效果使用 */
  burningSample: number[] = [];
  /** 与 burningSample 一一对应的火势强度权重（燃料 × 干燥度 × 燃烧新鲜度） */
  burningWeight: number[] = [];
  /** burningSample 每更新一次加 1 */
  sampleVersion = 0;
  /** 最近一次读回的完整状态（RGBA，每格 4 个 float）；尚未读回时为 null */
  lastState: Float32Array | null = null;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private grid: Grid,
    gridTexture: THREE.DataTexture,
    wind: WindField,
  ) {
    const { width, height, cellSize } = grid.meta;
    this.width = width;
    this.height = height;
    const rt = () =>
      new THREE.WebGLRenderTarget(width, height, {
        type: THREE.FloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: false,
      });
    this.targets = [rt(), rt()];
    this.wind = new WindTexture(wind);
    this.mask = new Float32Array(width * height);
    this.maskTex = new THREE.DataTexture(this.mask, width, height, THREE.RedFormat, THREE.FloatType);
    this.maskTex.needsUpdate = true;
    this.readBuf = new Float32Array(width * height * 4);
    this.lastStats = { minutes: 0, burningCells: 0, burnedCells: 0, burnedAreaHa: 0, buildingCellsBurned: 0 };

    const mat = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: fullscreenVertex, fragmentShader, uniforms, depthTest: false, depthWrite: false });

    this.stepMat = mat(stepFragment, {
      uState: { value: null },
      uGrid: { value: gridTexture },
      uWind: { value: this.wind.texture },
      uWindSize: { value: new THREE.Vector2(this.wind.texture.image.width, this.wind.texture.image.height) },
      uSize: { value: new THREE.Vector2(width, height) },
      uCellSize: { value: cellSize },
      uStep: { value: 0 },
      uSeed: { value: this.seed },
      uStepMinutes: { value: SpreadParams.stepMinutes },
      uPh: { value: SpreadParams.ph },
      uC1: { value: SpreadParams.c1 },
      uC2: { value: SpreadParams.c2 },
      uA: { value: SpreadParams.a },
      uSpotting: { value: this.spotting },
      uSpotBase: { value: SpreadParams.spot.pBase },
      uSpotDistPerMs: { value: SpreadParams.spot.distMeanPerWindMs },
      uSpotSamples: { value: SpreadParams.spot.samples },
    });
    this.igniteMat = mat(igniteFragment, {
      uState: { value: null },
      uGrid: { value: gridTexture },
      uMask: { value: this.maskTex },
      uMinutes: { value: 0 },
    });
    this.resetMat = mat(resetFragment, {});
    this.reset();
  }

  /** 当前状态纹理（每步之后会换成另一张，所以每帧取一次） */
  get texture(): THREE.Texture {
    return this.targets[this.cur].texture;
  }

  /** 最近一次读回对应的模拟时间（分钟） */
  get lastStatsMinutes(): number {
    return this.lastStats.minutes;
  }

  get minutes(): number {
    return this.step * SpreadParams.stepMinutes;
  }

  setWind(field: WindField) {
    this.wind.set(field);
    this.stepMat.uniforms.uWind.value = this.wind.texture;
    this.stepMat.uniforms.uWindSize.value.set(this.wind.texture.image.width, this.wind.texture.image.height);
  }

  private render(material: THREE.ShaderMaterial) {
    const next = 1 - this.cur;
    if (material.uniforms.uState) material.uniforms.uState.value = this.targets[this.cur].texture;
    this.quad.material = material;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.targets[next]);
    this.quad.render(this.renderer);
    this.renderer.setRenderTarget(prev);
    this.cur = next;
  }

  reset() {
    this.step = 0;
    this.burningSample = [];
    this.burningWeight = [];
    this.lastState = null;
    this.sampleVersion++;
    this.render(this.resetMat);
    this.render(this.resetMat);
    this.lastStats = { minutes: 0, burningCells: 0, burnedCells: 0, burnedAreaHa: 0, buildingCellsBurned: 0 };
  }

  /** 在格子 (x, y) 周围半径 r（格）的圆内点火 */
  igniteDisc(x: number, y: number, r = 1.5) {
    const cells: number[] = [];
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++)
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (dx * dx + dy * dy <= r * r && xx >= 0 && yy >= 0 && xx < this.width && yy < this.height) cells.push(yy * this.width + xx);
      }
    this.ignite(cells);
  }

  /** 按格子索引点火（P5 中用于注入实时火点） */
  ignite(cells: number[]) {
    this.mask.fill(0);
    for (const c of cells) this.mask[c] = 1;
    this.maskTex.needsUpdate = true;
    this.igniteMat.uniforms.uMinutes.value = this.minutes;
    this.render(this.igniteMat);
  }

  advance(steps = 1) {
    const u = this.stepMat.uniforms;
    u.uSeed.value = this.seed;
    u.uSpotting.value = this.spotting;
    u.uStepMinutes.value = SpreadParams.stepMinutes;
    for (let i = 0; i < steps; i++) {
      u.uStep.value = this.step;
      this.render(this.stepMat);
      this.step++;
    }
  }

  /** 异步读回状态并统计；上一次读回未完成时直接返回上次结果 */
  stats(): FireStats {
    if (!this.reading) {
      this.reading = true;
      const minutes = this.minutes;
      this.renderer
        .readRenderTargetPixelsAsync(this.targets[this.cur], 0, 0, this.width, this.height, this.readBuf)
        .then(() => {
          this.lastStats = summarize(this.readBuf, this.grid, minutes, this.burningSample, this.burningWeight);
          this.lastState = this.readBuf;
          this.sampleVersion++;
        })
        .finally(() => (this.reading = false));
    }
    return this.lastStats;
  }

  /** 同步读回整张状态（CPU 对照、调试用） */
  readState(): Float32Array {
    const out = new Float32Array(this.width * this.height * 4);
    this.renderer.readRenderTargetPixels(this.targets[this.cur], 0, 0, this.width, this.height, out);
    return out;
  }

  /** 同步读回并统计，同时刷新燃烧格抽样 */
  statsSync(): FireStats {
    const state = this.readState();
    this.lastStats = summarize(state, this.grid, this.minutes, this.burningSample, this.burningWeight);
    this.lastState = state;
    this.sampleVersion++;
    return this.lastStats;
  }
}

const SAMPLE_CAP = 4096;

export function summarize(state: Float32Array, grid: Grid, minutes: number, burningOut?: number[], weightOut?: number[]): FireStats {
  let burning = 0;
  let burned = 0;
  let buildings = 0;
  const n = grid.meta.width * grid.meta.height;
  for (let c = 0; c < n; c++) {
    const s = state[c * 4];
    if (s > 0.5 && s < 1.5) burning++;
    if (s > 0.5) {
      burned++;
      if (grid.data[c * GRID_CHANNELS + 3] === CellClass.Building) buildings++;
    }
  }
  if (burningOut) {
    // 等间隔抽样，火线很长时也只取 SAMPLE_CAP 个；同时给出火势强度权重：
    // 燃料 ×（0.5 + 干燥度）× 新鲜度。新鲜度按燃烧进度（G 通道已燃步数 / 该格燃烧时长，与 CA 规则一致）
    // 从 1 降到 0.1，所以刚被点燃、燃料最重的火线权重最大，快燃尽的燃烧带后部权重最小
    burningOut.length = 0;
    if (weightOut) weightOut.length = 0;
    const stride = Math.max(1, Math.ceil(burning / SAMPLE_CAP));
    let k = 0;
    for (let c = 0; c < n; c++) {
      const s = state[c * 4];
      if (!(s > 0.5 && s < 1.5) || k++ % stride !== 0) continue;
      burningOut.push(c);
      if (weightOut) {
        const g = c * GRID_CHANNELS;
        const fuel = grid.data[g + 1];
        const dry = grid.data[g + 2];
        const isBuilding = grid.data[g + 3] === CellClass.Building;
        const dur = isBuilding ? 8 : 2 + Math.floor(3 * fuel + 0.5);
        const fresh = 1 - 0.9 * Math.min(1, state[c * 4 + 1] / dur);
        weightOut.push((isBuilding ? 1.2 : Math.max(0.05, fuel)) * (0.5 + dry) * fresh);
      }
    }
  }
  const cellHa = (grid.meta.cellSize * grid.meta.cellSize) / 1e4;
  return { minutes, burningCells: burning, burnedCells: burned - burning, burnedAreaHa: burned * cellHa, buildingCellsBurned: buildings };
}
