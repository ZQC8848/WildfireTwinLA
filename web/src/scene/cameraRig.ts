// 相机预设之间的平滑过渡（三次缓动）；用户一拖动视角就中止过渡；系统偏好减少动态效果时直接跳转。

import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export class CameraRig {
  private from = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
  private to = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
  private t = 1;
  private duration = 1.6;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private controls: OrbitControls,
  ) {
    controls.addEventListener("start", () => (this.t = 1));
  }

  flyTo(pos: THREE.Vector3, target: THREE.Vector3) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
      this.t = 1;
      return;
    }
    this.from.pos.copy(this.camera.position);
    this.from.target.copy(this.controls.target);
    this.to.pos.copy(pos);
    this.to.target.copy(target);
    this.t = 0;
  }

  update(dt: number) {
    if (this.t >= 1) return;
    this.t = Math.min(1, this.t + dt / this.duration);
    const k = this.t < 0.5 ? 4 * this.t ** 3 : 1 - (-2 * this.t + 2) ** 3 / 2;
    this.camera.position.lerpVectors(this.from.pos, this.to.pos, k);
    this.controls.target.lerpVectors(this.from.target, this.to.target, k);
  }
}
