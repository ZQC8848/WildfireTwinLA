// 卫星火点标记：在火点位置立一根发光的细柱，高度按火辐射功率（FRP），颜色按来源。
// VIIRS 375 m、MODIS 1 km、GOES 2 km，越粗糙的来源颜色越淡，提醒位置不确定性更大。

import * as THREE from "three";
import { GRID_CHANNELS, type Grid } from "@core";
import type { FeedHotspot } from "../net/messages";

const SOURCE_COLORS: Record<string, string> = {
  VIIRS: "#F26A1B",
  MODIS: "#F59A5E",
  GOES: "#F7C29A",
};

export class HotspotMarkers {
  readonly object: THREE.InstancedMesh;
  private items: FeedHotspot[] = [];
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();

  constructor(
    private grid: Grid,
    private minElev: number,
    private vScale: number,
    private capacity = 4000,
  ) {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    geo.translate(0, 0.5, 0);
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false, fog: true });
    this.object = new THREE.InstancedMesh(geo, mat, capacity);
    this.object.count = 0;
    this.object.frustumCulled = false;
    this.object.renderOrder = 6;
  }

  get count(): number {
    return this.items.length;
  }

  add(items: FeedHotspot[]) {
    const seen = new Set(this.items.map((h) => h.id));
    for (const h of items) if (!seen.has(h.id) && this.items.length < this.capacity) this.items.push(h);
    this.layout();
  }

  clear() {
    this.items = [];
    this.object.count = 0;
  }

  setVerticalScale(v: number) {
    this.vScale = v;
    this.layout();
  }

  private layout() {
    const { width: W, height: H, cellSize: S } = this.grid.meta;
    this.items.forEach((h, i) => {
      const x = h.cell % W;
      const y = Math.floor(h.cell / W);
      const ground = (this.grid.data[h.cell * GRID_CHANNELS] - this.minElev) * this.vScale;
      const height = 120 + Math.min(600, h.frp * 8);
      this.dummy.position.set((x - (W - 1) / 2) * S, ground, (y - (H - 1) / 2) * S);
      this.dummy.scale.set(14, height, 14);
      this.dummy.updateMatrix();
      this.object.setMatrixAt(i, this.dummy.matrix);
      this.object.setColorAt(i, this.color.set(SOURCE_COLORS[h.source] ?? SOURCE_COLORS.VIIRS));
    });
    this.object.count = this.items.length;
    this.object.instanceMatrix.needsUpdate = true;
    if (this.object.instanceColor) this.object.instanceColor.needsUpdate = true;
  }
}
