// 高度场射线拾取：地形位移在 GPU 上完成，几何体本身是平的，所以在 CPU 上沿射线步进求交。

import * as THREE from "three";
import { cellIndex, type Grid } from "@core";
import { sampleElevation, worldToGrid } from "../scene/coords";

export interface TerrainHit {
  cell: number;
  x: number;
  y: number;
  point: THREE.Vector3;
}

export class TerrainPicker {
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

  constructor(
    private grid: Grid,
    private camera: THREE.Camera,
    private dom: HTMLElement,
    private surface: { minElev: number; verticalScale: number },
  ) {}

  private heightAt(wx: number, wz: number): number | null {
    const [gx, gy] = worldToGrid(this.grid.meta, wx, wz);
    const { width, height } = this.grid.meta;
    if (gx < 0 || gy < 0 || gx > width - 1 || gy > height - 1) return null;
    return (sampleElevation(this.grid, gx, gy) - this.surface.minElev) * this.surface.verticalScale;
  }

  pick(clientX: number, clientY: number): TerrainHit | null {
    const rect = this.dom.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const { origin, direction } = this.raycaster.ray;

    const step = this.grid.meta.cellSize * 0.5;
    const maxDist = 100000;
    const p = new THREE.Vector3();
    let prevT = 0;
    let prevAbove = true;
    for (let t = 0; t < maxDist; t += step) {
      p.copy(direction).multiplyScalar(t).add(origin);
      const h = this.heightAt(p.x, p.z);
      if (h === null) {
        prevAbove = true;
        prevT = t;
        continue;
      }
      const above = p.y > h;
      if (!above && prevAbove && t > 0) {
        // 二分细化交点
        let lo = prevT;
        let hi = t;
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) / 2;
          p.copy(direction).multiplyScalar(mid).add(origin);
          const hm = this.heightAt(p.x, p.z);
          if (hm !== null && p.y <= hm) hi = mid;
          else lo = mid;
        }
        p.copy(direction).multiplyScalar(hi).add(origin);
        const [gx, gy] = worldToGrid(this.grid.meta, p.x, p.z);
        const x = Math.round(gx);
        const y = Math.round(gy);
        return { cell: cellIndex(this.grid.meta, x, y), x, y, point: p.clone() };
      }
      prevAbove = above;
      prevT = t;
    }
    return null;
  }
}
