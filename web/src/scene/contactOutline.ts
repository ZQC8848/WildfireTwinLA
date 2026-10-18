// 房屋描边（屏幕空间）：只描"通话中"和"需要帮助"的房屋，近景时让人一眼看出正在联络哪一栋。
//
// 1. 遮罩：把这些房屋单独渲染进一张遮罩（R = 通话中，G = 需要帮助）。顶点变换复用房屋 shader，
//    轮廓与画面上的模型完全一致（含竖向夸张、燃尽后压低的残骸）。先画一遍只写深度的地形，
//    被山体挡住的房屋不出现；被其他房屋挡住的仍然描出，方便在密集街区里找到它。
// 2. 合成：在 Bloom 之前的全屏 pass 里，按两圈采样找遮罩边缘：通话中是粉色脉动轮廓（亮度超过 1，会发光），
//    需要帮助是白色内圈加粉色外圈。房屋内部叠一层很淡的同色。
// 遮罩值随相机距离淡出，与房屋模型的 LOD 范围一致（更远处房屋不画，只剩屋顶标记）。

import * as THREE from "three";
import { FullScreenQuad, Pass } from "three/examples/jsm/postprocessing/Pass.js";
import type { AssetLibrary } from "./props/assets";
import type { Placement } from "./props/placement";
import { propVertexShader } from "./props/propMaterial";

export const enum OutlineKind {
  Calling = 1,
  NeedsHelp = 2,
}

/** 描边从这个距离开始淡出，到第二个距离消失（米）；房屋模型约 2 km 外不再绘制 */
const FADE: [number, number] = [1300, 1900];

const maskVertexShader = propVertexShader
  .replace("void main() {", "in float aKind;\nflat out float vKind;\nout float vDist;\n\nvoid main() {\n  vKind = aKind;")
  .replace("  vec4 mvPosition = modelViewMatrix * vec4(world, 1.0);", "  vDist = distance(world, cameraPosition);\n  vec4 mvPosition = modelViewMatrix * vec4(world, 1.0);");

const maskFragmentShader = /* glsl */ `
layout(location = 0) out highp vec4 pc_fragColor;
uniform vec2 uFade;
flat in float vKind;
in float vDist;

void main() {
  float f = 1.0 - smoothstep(uFade.x, uFade.y, vDist);
  pc_fragColor = vKind > 1.5 ? vec4(0.0, f, 0.0, 1.0) : vec4(f, 0.0, 0.0, 1.0);
}
`;

const compositeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tMask: { value: null as THREE.Texture | null },
    uTexel: { value: new THREE.Vector2() },
    uTime: { value: 0 },
    uPink: { value: new THREE.Color("#D63A73") },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tMask;
    uniform vec2 uTexel;
    uniform float uTime;
    uniform vec3 uPink;
    varying vec2 vUv;

    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      vec2 m0 = texture2D(tMask, vUv).rg;
      // 两圈各 12 个方向：内圈约 1.6 px，外圈约 3.4 px（按设备像素比放大）
      vec2 inner = vec2(0.0);
      vec2 outer = vec2(0.0);
      for (int i = 0; i < 12; i++) {
        float a = float(i) * 0.5235988;
        vec2 d = vec2(cos(a), sin(a)) * uTexel;
        inner = max(inner, texture2D(tMask, vUv + d * 1.6).rg);
        outer = max(outer, texture2D(tMask, vUv + d * 3.4).rg);
      }
      vec3 col = base.rgb;
      col = mix(col, uPink, 0.22 * m0.r);
      col = mix(col, vec3(1.0), 0.16 * m0.g);
      float pulse = 0.5 + 0.5 * sin(uTime * 6.0);
      float calling = clamp(max(inner.r, outer.r) - m0.r, 0.0, 1.0);
      col = mix(col, uPink * (1.3 + 1.0 * pulse), calling);
      float helpInner = clamp(inner.g - m0.g, 0.0, 1.0);
      float helpOuter = clamp(outer.g - max(inner.g, m0.g), 0.0, 1.0);
      col = mix(col, vec3(1.6), helpInner);
      col = mix(col, uPink * 1.5, helpOuter);
      gl_FragColor = vec4(col, base.a);
    }`,
};

interface Group {
  mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  offset: THREE.InstancedBufferAttribute;
  params: THREE.InstancedBufferAttribute;
  kind: THREE.InstancedBufferAttribute;
}

export class ContactOutline extends Pass {
  /** 工具条 "Contact status" 关闭时不描边 */
  shown = true;
  private mask: THREE.WebGLRenderTarget;
  private maskScene = new THREE.Scene();
  private maskMaterial: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  private composite: THREE.ShaderMaterial;
  private groups = new Map<string, Group>();
  private placements: Placement[] = [];
  private count = 0;
  private clearColor = new THREE.Color();

  constructor(
    layout: { items: Placement[] },
    private lib: AssetLibrary,
    propUniforms: Record<string, THREE.IUniform>,
    terrainDepth: THREE.Mesh,
    private camera: THREE.Camera,
    private pixelRatio: () => number,
  ) {
    super();
    for (const p of layout.items) if (p.building !== undefined) this.placements[p.building] = p;
    this.mask = new THREE.WebGLRenderTarget(1, 1, { samples: 4 });
    // 与房屋材质共用 uniforms（同一批对象），模拟状态、竖向夸张变化时自动同步
    this.maskMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: maskVertexShader,
      fragmentShader: maskFragmentShader,
      uniforms: { ...propUniforms, uFade: { value: new THREE.Vector2(...FADE) } },
    });
    this.maskScene.add(terrainDepth);
    this.composite = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(compositeShader.uniforms),
      vertexShader: compositeShader.vertexShader,
      fragmentShader: compositeShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.composite.uniforms.tMask.value = this.mask.texture;
    this.quad = new FullScreenQuad(this.composite);
    this.enabled = false;
  }

  /** 需要描边的房屋（buildings 数组序号）及类型 */
  setItems(items: { building: number; kind: OutlineKind }[]) {
    const byKey = new Map<string, { p: Placement; kind: OutlineKind }[]>();
    for (const it of items) {
      const p = this.placements[it.building];
      if (!p) continue;
      const key = `${p.asset}|${p.variant}`;
      let list = byKey.get(key);
      if (!list) byKey.set(key, (list = []));
      list.push({ p, kind: it.kind });
    }
    for (const g of this.groups.values()) g.mesh.geometry.instanceCount = 0;
    for (const [key, list] of byKey) {
      const g = this.group(key, list.length);
      list.forEach(({ p, kind }, j) => {
        g.offset.setXYZW(j, p.x, p.elev, p.z, p.rot);
        // 与 propField 一致：建筑的缩放存为负数，格子号用于读取火灾状态
        g.params.setXY(j, -p.scale, p.cell);
        g.kind.setX(j, kind);
      });
      g.offset.needsUpdate = g.params.needsUpdate = g.kind.needsUpdate = true;
      g.mesh.geometry.instanceCount = list.length;
    }
    this.count = items.length;
    this.enabled = this.shown && this.count > 0;
  }

  setShown(show: boolean) {
    this.shown = show;
    this.enabled = show && this.count > 0;
  }

  update(dt: number) {
    this.composite.uniforms.uTime.value += dt;
  }

  /** 每种"资产 × 变体"一组实例，容量不够时按 2 的幂扩大 */
  private group(key: string, need: number): Group {
    let g = this.groups.get(key);
    if (g && g.offset.count >= need) return g;
    const capacity = Math.max(8, 2 ** Math.ceil(Math.log2(need)));
    if (g) {
      this.maskScene.remove(g.mesh);
      g.mesh.geometry.dispose();
    }
    const [asset, v] = key.split("|");
    const src = this.lib[asset as keyof AssetLibrary][Number(v)].lods[0];
    const geo = new THREE.InstancedBufferGeometry();
    for (const name of ["position", "normal", "aColor", "aPart"]) geo.setAttribute(name, src.getAttribute(name));
    if (src.index) geo.setIndex(src.index);
    const offset = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    const params = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(THREE.DynamicDrawUsage);
    const kind = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aOffset", offset);
    geo.setAttribute("aParams", params);
    geo.setAttribute("aKind", kind);
    geo.instanceCount = 0;
    const mesh = new THREE.Mesh(geo, this.maskMaterial);
    mesh.frustumCulled = false;
    this.maskScene.add(mesh);
    g = { mesh, offset, params, kind };
    this.groups.set(key, g);
    return g;
  }

  setSize(width: number, height: number) {
    this.mask.setSize(width, height);
    const r = this.pixelRatio();
    this.composite.uniforms.uTexel.value.set(r / width, r / height);
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    renderer.getClearColor(this.clearColor);
    const clearAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.mask);
    renderer.clear();
    renderer.render(this.maskScene, this.camera);
    renderer.setClearColor(this.clearColor, clearAlpha);
    this.composite.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.mask.dispose();
    this.quad.dispose();
    this.composite.dispose();
    this.maskMaterial.dispose();
  }
}
