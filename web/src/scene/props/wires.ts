// 导线：相邻两座塔（或两根杆）对应挂点之间的悬链线近似（抛物线下垂）。
// 塔的显示高度随竖向夸张变化，所以夸张系数改变时重建几何（线段很少，开销可忽略）。

import * as THREE from "three";
import type { WireSpan } from "./placement";

const SEGMENTS = 12;

export class Wires {
  readonly object: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;

  constructor(private spans: WireSpan[]) {
    this.object = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x2b2b2b, fog: true }));
    this.object.frustumCulled = false;
  }

  rebuild(minElev: number, vScale: number) {
    const pos: number[] = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (const s of this.spans) {
      const ya = (s.a.elev - minElev) * vScale;
      const yb = (s.b.elev - minElev) * vScale;
      const n = Math.min(s.pointsA.length, s.pointsB.length);
      for (let i = 0; i < n; i++) {
        a.set(s.a.x, ya, s.a.z).add(s.pointsA[i]);
        b.set(s.b.x, yb, s.b.z).add(s.pointsB[i]);
        const sag = a.distanceTo(b) * 0.035;
        let px = a.x;
        let py = a.y;
        let pz = a.z;
        for (let k = 1; k <= SEGMENTS; k++) {
          const t = k / SEGMENTS;
          const x = a.x + (b.x - a.x) * t;
          const z = a.z + (b.z - a.z) * t;
          const y = a.y + (b.y - a.y) * t - 4 * sag * t * (1 - t);
          pos.push(px, py, pz, x, y, z);
          px = x;
          py = y;
          pz = z;
        }
      }
    }
    this.object.geometry.dispose();
    this.object.geometry = new THREE.BufferGeometry();
    this.object.geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  }
}
