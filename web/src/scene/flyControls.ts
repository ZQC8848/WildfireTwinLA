// 飞行相机（类似 Unity 编辑器的 Scene 视图）：
// - 右键拖动转视角；WASD 前后左右，Q / E 下降 / 上升，按住 Shift 加速
// - 滚轮：前后推进；按住右键时滚轮调节移动速度
// - 速度随离地高度变化：贴近地面时慢，高空时快
// - 不会钻到地形下面
// 启用时关闭 OrbitControls（setup.ts 只在 controls.enabled 时调用 controls.update()）；
// 切回轨道模式时，把轨道中心放到屏幕中心对着的地面点，视角不跳。

import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const MOVE_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ShiftLeft", "ShiftRight"]);
const LOOK_SPEED = 0.0028;
const MIN_CLEARANCE_M = 8;

export class FlyControls {
  enabled = false;
  /** 滚轮按住右键时调节的速度倍率 */
  speedScale = 1;
  private keys = new Set<string>();
  private looking = false;
  private euler = new THREE.Euler(0, 0, 0, "YXZ");
  private v = new THREE.Vector3();

  constructor(
    private camera: THREE.PerspectiveCamera,
    private controls: OrbitControls,
    canvas: HTMLCanvasElement,
    /** 世界坐标 (x, z) 处的地面高度（显示坐标，已含竖向夸张） */
    private groundAt: (x: number, z: number) => number,
    /** 屏幕中心对着的地面点；没有命中时返回 null */
    private centerHit: () => THREE.Vector3 | null,
    private onSpeed?: (scale: number) => void,
  ) {
    addEventListener("keydown", (e) => {
      if (!this.enabled || !MOVE_KEYS.has(e.code)) return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || e.metaKey || e.ctrlKey || e.altKey) return;
      this.keys.add(e.code);
      e.preventDefault();
    });
    addEventListener("keyup", (e) => this.keys.delete(e.code));
    addEventListener("blur", () => this.keys.clear());
    canvas.addEventListener("pointerdown", (e) => {
      if (!this.enabled || e.button !== 2) return;
      this.looking = true;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!this.enabled || !this.looking) return;
      this.euler.setFromQuaternion(this.camera.quaternion);
      this.euler.y -= e.movementX * LOOK_SPEED;
      this.euler.x = THREE.MathUtils.clamp(this.euler.x - e.movementY * LOOK_SPEED, -1.5, 1.5);
      this.euler.z = 0;
      this.camera.quaternion.setFromEuler(this.euler);
    });
    const stopLook = (e: PointerEvent) => {
      if (e.button === 2) this.looking = false;
    };
    canvas.addEventListener("pointerup", stopLook);
    canvas.addEventListener("pointercancel", () => (this.looking = false));
    canvas.addEventListener("contextmenu", (e) => this.enabled && e.preventDefault());
    canvas.addEventListener(
      "wheel",
      (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        if (this.looking) {
          this.speedScale = THREE.MathUtils.clamp(this.speedScale * (e.deltaY < 0 ? 1.25 : 0.8), 0.1, 10);
          this.onSpeed?.(this.speedScale);
          return;
        }
        // 滚轮推进：每格移动离地高度的 15%
        const step = Math.max(20, this.height() * 0.15) * Math.sign(-e.deltaY);
        this.camera.getWorldDirection(this.v);
        this.camera.position.addScaledVector(this.v, step);
        this.keepAboveGround();
      },
      { passive: false },
    );
  }

  /** 正在移动或转视角（用于中止相机预设的过渡） */
  get busy(): boolean {
    return this.looking || [...this.keys].some((k) => !k.startsWith("Shift"));
  }

  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    this.keys.clear();
    this.looking = false;
    this.controls.enabled = !on;
    if (!on) {
      // 切回轨道：轨道中心放到屏幕中心对着的地面点（没有命中就放在前方 1.5 km）。
      // 先刷新相机矩阵：本帧刚转过视角时，射线要按新的朝向投射
      this.camera.updateMatrixWorld();
      const hit = this.centerHit();
      this.camera.getWorldDirection(this.v);
      const target = hit ?? this.camera.position.clone().addScaledVector(this.v, 1500);
      const minD = this.controls.minDistance;
      if (target.distanceTo(this.camera.position) < minD) target.copy(this.camera.position).addScaledVector(this.v, minD);
      this.controls.target.copy(target);
      this.controls.update();
    }
  }

  private height(): number {
    return Math.max(1, this.camera.position.y - this.groundAt(this.camera.position.x, this.camera.position.z));
  }

  private keepAboveGround() {
    const g = this.groundAt(this.camera.position.x, this.camera.position.z);
    if (this.camera.position.y < g + MIN_CLEARANCE_M) this.camera.position.y = g + MIN_CLEARANCE_M;
  }

  update(dt: number) {
    if (!this.enabled) return;
    const k = this.keys;
    const f = (k.has("KeyW") ? 1 : 0) - (k.has("KeyS") ? 1 : 0);
    const r = (k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0);
    const u = (k.has("KeyE") ? 1 : 0) - (k.has("KeyQ") ? 1 : 0);
    if (!f && !r && !u) return;
    // 速度（米 / 秒）：离地高度的 0.8 倍，限制在 30–2500 之间
    const speed = THREE.MathUtils.clamp(this.height() * 0.8, 30, 2500) * this.speedScale * (k.has("ShiftLeft") || k.has("ShiftRight") ? 3 : 1);
    const forward = this.camera.getWorldDirection(new THREE.Vector3());
    const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();
    const move = new THREE.Vector3().addScaledVector(forward, f).addScaledVector(right, r).addScaledVector(this.camera.up, u);
    if (move.lengthSq() > 0) this.camera.position.addScaledVector(move.normalize(), speed * dt);
    this.keepAboveGround();
  }
}
