// 风场图层：在地形上方画风向箭头。箭头长度与颜色表示风速，颜色用 ui-design 中约定给风与水的 Marine。
// 显示高度在 shader 中按竖向夸张计算，与地形、模型一致。

import * as THREE from "three";
import { GRID_CHANNELS, type Grid, type WindField } from "@core";
import { windGrid } from "../sim/wind";

const vertexShader = /* glsl */ `
in vec4 aArrow; // x, 地面高程（米）, z, 方向角（弧度，世界 xz 平面内从 +x 起算）
in vec2 aSize;  // 长度系数, 相对风速

uniform float uVScale;
uniform float uMinElev;
uniform float uLift;
uniform float uWidth;

out float vSpeed;

#include <fog_pars_vertex>

void main() {
  vec3 p = position;
  p.x *= aSize.x;
  p.z *= uWidth;
  float c = cos(aArrow.w);
  float s = sin(aArrow.w);
  vec3 rp = vec3(p.x * c - p.z * s, p.y, p.x * s + p.z * c);
  vec3 world = vec3(aArrow.x, (aArrow.y - uMinElev) * uVScale + uLift, aArrow.z) + rp;
  vSpeed = aSize.y;
  vec4 mvPosition = modelViewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const fragmentShader = /* glsl */ `
layout(location = 0) out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor

uniform vec3 uColor;
uniform float uOpacity;

in float vSpeed;

#include <fog_pars_fragment>

void main() {
  // 与来流同速为 Marine 蓝；减弱处更暗，明显加速（1.6 倍以上）处逐渐变白
  vec3 col = vSpeed < 1.0
    ? mix(uColor * 0.45, uColor, clamp((vSpeed - 0.3) / 0.7, 0.0, 1.0))
    : mix(uColor, vec3(0.95, 0.97, 1.0), smoothstep(1.2, 2.0, vSpeed) * 0.85);
  gl_FragColor = vec4(col, uOpacity);
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/** 指向 +x、平躺在 xz 平面的箭头，长度 1（x 从 -0.5 到 0.5） */
function arrowGeometry(width: number): THREE.BufferGeometry {
  const hw = width / 2;
  const head = 0.32;
  const pts = [
    // 箭杆
    [-0.5, -hw * 0.45],
    [0.5 - head, -hw * 0.45],
    [0.5 - head, hw * 0.45],
    [-0.5, -hw * 0.45],
    [0.5 - head, hw * 0.45],
    [-0.5, hw * 0.45],
    // 箭头
    [0.5 - head, -hw],
    [0.5, 0],
    [0.5 - head, hw],
  ];
  const pos = new Float32Array(pts.length * 3);
  pts.forEach(([x, z], i) => pos.set([x, 0, z], i * 3));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return geo;
}

export class WindLayer {
  readonly object: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  readonly material: THREE.ShaderMaterial;
  private arrow: THREE.InstancedBufferAttribute;
  private size: THREE.InstancedBufferAttribute;
  private cells: number[] = [];

  constructor(
    private grid: Grid,
    minElev: number,
    vScale: number,
    spacing = 10,
  ) {
    const { width: W, height: H } = grid.meta;
    for (let y = Math.floor(spacing / 2); y < H; y += spacing)
      for (let x = Math.floor(spacing / 2); x < W; x += spacing) this.cells.push(y * W + x);
    const n = this.cells.length;
    const base = arrowGeometry(0.16);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute("position", base.getAttribute("position"));
    this.arrow = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.size = new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2);
    geo.setAttribute("aArrow", this.arrow);
    geo.setAttribute("aSize", this.size);
    geo.instanceCount = n;
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      fog: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uVScale: { value: vScale },
          uMinElev: { value: minElev },
          uLift: { value: 40 },
          uWidth: { value: 1 },
          uColor: { value: new THREE.Color("#6F9DBF") },
          uOpacity: { value: 0.7 },
        },
      ]),
    });
    this.object = new THREE.Mesh(geo, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 5;
    // 每 spacing 格放一支箭头，最长约 0.8 个箭头间距；箭头宽度也按这个单位缩放
    this.lengthUnit = spacing * grid.meta.cellSize * 0.8;
    this.material.uniforms.uWidth.value = this.lengthUnit;
  }

  private readonly lengthUnit: number;

  /** 按风场更新箭头；inflowSpeed 为来流风速，用于把局部风速换算成相对值 */
  update(field: WindField, inflowSpeed: number) {
    const { width: W, height: H, cellSize: S } = this.grid.meta;
    const wind = windGrid(field, W, H);
    const arrow = this.arrow.array as Float32Array;
    const size = this.size.array as Float32Array;
    const ref = Math.max(inflowSpeed, 0.5);
    this.cells.forEach((c, i) => {
      const vx = wind[c * 2];
      const vy = wind[c * 2 + 1];
      const speed = Math.hypot(vx, vy);
      const rel = speed / ref;
      const x = c % W;
      const y = Math.floor(c / W);
      arrow[i * 4] = (x - (W - 1) / 2) * S;
      arrow[i * 4 + 1] = this.grid.data[c * GRID_CHANNELS];
      arrow[i * 4 + 2] = (y - (H - 1) / 2) * S;
      arrow[i * 4 + 3] = Math.atan2(vy, vx); // 世界坐标 x 向东、z 向南，与网格速度分量同轴
      size[i * 2] = this.lengthUnit * Math.min(1.6, 0.35 + 0.65 * rel);
      size[i * 2 + 1] = rel;
    });
    this.arrow.needsUpdate = true;
    this.size.needsUpdate = true;
  }
}
