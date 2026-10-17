// 着火房屋屋顶上的火苗：实例化的竖直公告板（只绕竖轴朝向相机），片元里用噪声画出跳动的火舌。
// 颜色亮度超过 1，经 Bloom 发光；与地面火线的面状橙色区分开，远处也能看出是房子在烧。

import * as THREE from "three";

const vertexShader = /* glsl */ `
in vec4 aFlame; // 屋顶中心 x, y, z, 尺寸（米）
in float aSeed;
uniform float uTime;
out vec2 vUv;
out float vSeed;

void main() {
  vUv = uv;
  vSeed = aSeed;
  // 绕竖轴朝向相机：取相机到火苗的水平方向的垂直方向作为横轴
  vec3 toCam = cameraPosition - aFlame.xyz;
  vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x) + 1e-5);
  float flicker = 0.85 + 0.15 * sin(uTime * 7.0 + aSeed * 31.0) * sin(uTime * 3.1 + aSeed * 11.0);
  float w = aFlame.w;
  float h = aFlame.w * 1.6 * flicker;
  vec3 world = aFlame.xyz + right * (position.x * w) + vec3(0.0, (position.y + 0.5) * h, 0.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const fragmentShader = /* glsl */ `
layout(location = 0) out highp vec4 pc_fragColor;
uniform float uTime;
in vec2 vUv;
in float vSeed;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

void main() {
  vec2 p = vUv - vec2(0.5, 0.0);
  // 向上流动的噪声扭曲火舌的边缘
  float n = noise(vec2(p.x * 6.0 + vSeed * 9.0, vUv.y * 4.0 - uTime * 3.5 - vSeed * 5.0));
  float width = 0.42 * (1.0 - vUv.y) * (0.75 + 0.5 * n);
  float shape = 1.0 - smoothstep(width * 0.6, width, abs(p.x));
  shape *= 1.0 - smoothstep(0.55, 1.0, vUv.y + 0.25 * n);
  if (shape < 0.02) discard;
  // 内焰偏黄、外焰偏橙红；整体亮度大于 1，经 Bloom 发光
  float core = 1.0 - smoothstep(0.0, width * 0.7, abs(p.x)) * (0.6 + vUv.y);
  vec3 col = mix(vec3(1.0, 0.28, 0.04), vec3(1.0, 0.75, 0.3), clamp(core, 0.0, 1.0)) * 2.4;
  pc_fragColor = vec4(col * shape, shape);
}
`;

export interface FlameSite {
  position: THREE.Vector3;
  size: number;
  seed: number;
}

export class HouseFlames {
  readonly object: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  readonly material: THREE.ShaderMaterial;
  private flame: THREE.InstancedBufferAttribute;
  private seed: THREE.InstancedBufferAttribute;

  constructor(private capacity = 3000) {
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geo.setAttribute("position", quad.getAttribute("position"));
    geo.setAttribute("uv", quad.getAttribute("uv"));
    geo.setIndex(quad.getIndex());
    this.flame = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.seed = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aFlame", this.flame);
    geo.setAttribute("aSeed", this.seed);
    geo.instanceCount = 0;
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.object = new THREE.Mesh(geo, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 7;
  }

  set(sites: FlameSite[]) {
    const n = Math.min(this.capacity, sites.length);
    const f = this.flame.array as Float32Array;
    const s = this.seed.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const site = sites[i];
      f.set([site.position.x, site.position.y, site.position.z, site.size], i * 4);
      s[i] = site.seed;
    }
    this.object.geometry.instanceCount = n;
    this.flame.needsUpdate = true;
    this.seed.needsUpdate = true;
  }
}
