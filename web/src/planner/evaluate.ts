// 用 GPU 火势模拟评估处理方案：与地图上看到的火是同一套物理，所以各方案的数字可以直接比较。
// 独立的 FireSim 实例，不影响用户正在看的测试火。每个方案用同一组随机种子跑若干次取平均。

import * as THREE from "three";
import type { Building, Grid, WindField } from "@core";
import { FireSim } from "../sim/fireSim";

export interface PlanMetrics {
  homesReached: number;
  burnedAreaHa: number;
  /** 每次运行的受波及房屋数，用来估计随机噪声 */
  homesBySeed: number[];
}

export class PlanEvaluator {
  private sim: FireSim;

  constructor(
    renderer: THREE.WebGLRenderer,
    private grid: Grid,
    gridTexture: THREE.DataTexture,
    private buildings: Building[],
  ) {
    this.sim = new FireSim(renderer, grid, gridTexture, { speedMs: 0, dirFromDeg: 0 });
  }

  run(mask: Uint8Array, ignitions: number[], wind: WindField, steps: number, seeds: number[]): PlanMetrics {
    const { cellSize, width, height } = this.grid.meta;
    const cellHa = (cellSize * cellSize) / 1e4;
    this.sim.setWind(wind);
    this.sim.setTreatments(mask);
    this.sim.spotting = true;
    let homes = 0;
    let area = 0;
    const homesBySeed: number[] = [];
    for (const seed of seeds) {
      this.sim.reset();
      this.sim.seed = seed;
      this.sim.ignite(ignitions);
      this.sim.advance(steps);
      const state = this.sim.readState();
      let h = 0;
      for (const b of this.buildings) if (state[b.cell * 4] > 0.5) h++;
      homes += h;
      homesBySeed.push(h);
      let burned = 0;
      for (let c = 0; c < width * height; c++) if (state[c * 4] > 0.5) burned++;
      area += burned * cellHa;
    }
    return { homesReached: homes / seeds.length, burnedAreaHa: area / seeds.length, homesBySeed };
  }
}
