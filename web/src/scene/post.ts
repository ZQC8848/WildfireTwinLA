// 后处理：只让超过 1.0 的亮度（火线、燃烧中的模型、火点标记）泛光，白天的浅色地形与界面不受影响。
// 场景先渲染到 HalfFloat 渲染目标（可以存下大于 1 的亮度），最后由 OutputPass 统一做 sRGB 转换。

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { SceneContext } from "./setup";

export class Bloom {
  readonly composer: EffectComposer;
  readonly pass: UnrealBloomPass;
  enabled = true;

  constructor(ctx: SceneContext) {
    const { renderer, scene, camera } = ctx;
    const size = renderer.getSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    this.pass = new UnrealBloomPass(size, 0.9, 0.5, 1.0);
    this.composer.addPass(this.pass);
    this.composer.addPass(new OutputPass());
    ctx.render = () => (this.enabled ? this.composer.render() : renderer.render(scene, camera));
    ctx.onResize((w, h) => this.composer.setSize(w, h));
  }

  /** Respond（夜间）下火光更强 */
  setNight(v: number) {
    this.pass.strength = 0.55 + 0.6 * v;
  }
}
