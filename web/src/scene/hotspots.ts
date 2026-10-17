// 卫星火点标记：在火点位置立一根发光的细柱，高度按火辐射功率（FRP），颜色按来源。
// VIIRS 375 m、MODIS 1 km、GOES 2 km，越粗糙的来源颜色越淡，提醒位置不确定性更大。
// 到达时模型还没烧到的像元画成 Marine 蓝（模型漏报）；报告起火点（REPORT）画成白色的粗柱。

import * as THREE from "three";
import { GRID_CHANNELS, type Grid } from "@core";
import type { FeedHotspot } from "../net/messages";

const SOURCE_COLORS: Record<string, string> = {
  VIIRS: "#F26A1B",
  MODIS: "#F59A5E",
  GOES: "#F7C29A",
  REPORT: "#FFF4E8",
};
const MISSED = "#6F9DBF";

export class HotspotMarkers {
  readonly object: THREE.InstancedMesh;
  private items: FeedHotspot[] = [];
  private missed = new Set<string>();
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

  /** missed：到达时模型还没烧到的像元 id */
  add(items: FeedHotspot[], missed?: Set<string>) {
    missed?.forEach((id) => this.missed.add(id));
    const seen = new Set(this.items.map((h) => h.id));
    for (const h of items) if (!seen.has(h.id) && this.items.length < this.capacity) this.items.push(h);
    this.layout();
  }

  clear() {
    this.items = [];
    this.missed.clear();
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
      const report = h.source === "REPORT";
      const height = report ? 900 : 120 + Math.min(600, h.frp * 8);
      this.dummy.position.set((x - (W - 1) / 2) * S, ground, (y - (H - 1) / 2) * S);
      this.dummy.scale.set(report ? 18 : 14, height, report ? 18 : 14);
      this.dummy.updateMatrix();
      this.object.setMatrixAt(i, this.dummy.matrix);
      // 卫星火点颜色乘以 2.5，亮度超过 1，经 Bloom 发光；报告起火点保持在 1 以下，不发光，只靠白色和粗细区分
      const hex = this.missed.has(h.id) ? MISSED : SOURCE_COLORS[h.source] ?? SOURCE_COLORS.VIIRS;
      this.object.setColorAt(i, this.color.set(hex).multiplyScalar(report ? 0.9 : 2.5));
    });
    this.object.count = this.items.length;
    this.object.instanceMatrix.needsUpdate = true;
    if (this.object.instanceColor) this.object.instanceColor.needsUpdate = true;
  }
}
