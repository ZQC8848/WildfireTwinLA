// 风场：把 core 的 WindField（单一风况或 W×H 采样）转成 GPU 纹理。
// 纹理存的是网格坐标系下的风速分量（m/s）：R = 向东，G = 向南（网格 y 由北向南）。
// 与 core 的 windAt 一致，插值在速度分量上进行，所以 shader 里做手动双线性插值。

import * as THREE from "three";
import type { Wind, WindField } from "@core";

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
