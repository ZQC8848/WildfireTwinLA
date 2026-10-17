// 风场：把 core 的 WindField（单一风况或 W×H 采样）转成 GPU 纹理。
// 纹理存的是网格坐标系下的风速分量（m/s）：R = 向东，G = 向南（网格 y 由北向南）。
// 与 core 的 windAt 一致，插值在速度分量上进行，所以 shader 里做手动双线性插值。

import * as THREE from "three";
import type { Wind, WindField } from "../../../packages/core/src/index.ts";

/** 气象惯例的"来向"角 → 网格坐标下的速度分量 [向东, 向南] */
export function windToGrid(w: Wind): [number, number] {
  const d = (w.dirFromDeg * Math.PI) / 180;
  const east = -w.speedMs * Math.sin(d);
  const north = -w.speedMs * Math.cos(d);
  return [east, -north];
}

export function windFieldSamples(field: WindField): { width: number; height: number; samples: Wind[] } {
  return "speedMs" in field ? { width: 1, height: 1, samples: [field] } : field;
}

/** 每个格子的风速分量 (向东, 向南)，插值方式与 shader 和 core.windAt 相同 */
export function windGrid(field: WindField, W: number, H: number): Float32Array {
  const { width: ww, height: wh, samples } = windFieldSamples(field);
  const comps = samples.map(windToGrid);
  const out = new Float32Array(W * H * 2);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const px = (x / Math.max(1, W - 1)) * (ww - 1);
      const py = (y / Math.max(1, H - 1)) * (wh - 1);
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const x1 = Math.min(x0 + 1, ww - 1);
      const y1 = Math.min(y0 + 1, wh - 1);
      const fx = px - x0;
      const fy = py - y0;
      for (let k = 0; k < 2; k++) {
        const a = comps[y0 * ww + x0][k] * (1 - fx) + comps[y0 * ww + x1][k] * fx;
        const b = comps[y1 * ww + x0][k] * (1 - fx) + comps[y1 * ww + x1][k] * fx;
        out[(y * W + x) * 2 + k] = a * (1 - fy) + b * fy;
      }
    }
  return out;
}

export class WindTexture {
  texture: THREE.DataTexture;

  constructor(field: WindField) {
    this.texture = this.build(field);
  }

  set(field: WindField) {
    this.texture.dispose();
    this.texture = this.build(field);
  }

  private build(field: WindField): THREE.DataTexture {
    const { width, height, samples } = windFieldSamples(field);
    if (samples.length !== width * height) throw new Error("Wind field sample count does not match its size");
    const data = new Float32Array(width * height * 4);
    samples.forEach((s, i) => {
      const [vx, vy] = windToGrid(s);
      data[i * 4] = vx;
      data[i * 4 + 1] = vy;
    });
    const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return tex;
  }
}
