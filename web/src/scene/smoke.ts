// 烟雾粒子：从正在燃烧的格子生成，上升、扩散、变淡，并沿出生处的风向漂移。
//
// 固定容量的粒子池循环复用。CPU 只写新生粒子的出生数据（位置、时间、风、种子），
// 运动与外观全部在 shader 中按年龄计算，所以每帧开销与粒子总数无关。
// 漂移距离随高度增加（风切变），烟柱会被风吹弯；改变风向后，新生的烟随之转向。

import * as THREE from "three";
import { GRID_CHANNELS, type Grid } from "@core";

const vertexShader = /* glsl */ `
in vec4 aSpawn; // x, 地面高程（米）, z, 出生时间（秒）
in vec4 aWind;  // 风速 向东, 向南（m/s）, 随机种子, 大小系数
in vec2 aPace;  // 出生时的漂移系数与寿命（秒）。每个粒子固定，全局节奏变化不会拖动空中已有的烟

uniform float uTime;
uniform float uVScale;
uniform float uMinElev;
uniform float uRise;

out vec2 vUv;
out float vAge;
out float vSeed;
out float vAlpha;

#include <fog_pars_vertex>

void main() {
  float age = uTime - aSpawn.w;
  float life = aPace.y;
  if (age < 0.0 || age > life) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // 不在生命期内：放到裁剪空间之外
    return;
  }
  float k = age / life;
  float seed = aWind.z;
  // 上升：开始快、逐渐趋缓（热烟羽浮力减弱）
  float h = uRise * (1.0 - pow(1.0 - k, 2.2));
  // 漂移：越高越受风影响，烟柱向下风方向弯
  vec2 drift = aWind.xy * aPace.x * age * (0.25 + 0.75 * k);
  // 横向扩散：每个粒子沿一个随机方向单调向外散开，烟羽随高度变宽；不用周期函数，避免来回摆动
  float ang = seed * 19.47;
  vec2 turb = vec2(cos(ang), sin(ang)) * (60.0 + 90.0 * fract(seed * 7.31)) * k;
  vec3 center = vec3(aSpawn.x + drift.x + turb.x, (aSpawn.y - uMinElev) * uVScale + 20.0 + h, aSpawn.z + drift.y + turb.y);

  float size = mix(60.0, 480.0, sqrt(k)) * aWind.w;
  vec4 mvPosition = viewMatrix * vec4(center, 1.0);
  // 绕视线方向随机旋转，避免所有粒子同一朝向
  float r = seed * 6.2831853 + age * 0.05;
  mat2 rot = mat2(cos(r), sin(r), -sin(r), cos(r));
  mvPosition.xy += rot * position.xy * size;
  gl_Position = projectionMatrix * mvPosition;

  vUv = uv;
  vAge = k;
  vSeed = seed;
  vAlpha = smoothstep(0.0, 0.06, k) * (1.0 - smoothstep(0.5, 1.0, k));
  #include <fog_vertex>
}
`;

const fragmentShader = /* glsl */ `
layout(location = 0) out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor

uniform float uOpacity;
uniform float uNight;

in vec2 vUv;
in float vAge;
in float vSeed;
in float vAlpha;

#include <fog_pars_fragment>

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
}

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  // 柔和的圆形，边缘用噪声打碎，看起来像一团烟而不是圆片
  float n = vnoise(p * 2.5 + vSeed * 13.0) * 0.6 + vnoise(p * 6.0 - vSeed * 7.0) * 0.4;
  float shape = smoothstep(1.0, 0.15, r + (n - 0.5) * 0.55);
  float a = shape * vAlpha * uOpacity;
  if (a < 0.003) discard;

  // 年轻的烟偏深、底部被火映红；老的烟变浅灰
  // 山火烟带黄褐色调，不是纯白
  vec3 young = vec3(0.2, 0.17, 0.15);
  vec3 old = vec3(0.56, 0.52, 0.47);
  vec3 col = mix(young, old, smoothstep(0.0, 0.6, vAge));
  // 上亮下暗，烟团有体积感
  col *= 0.78 + 0.3 * (p.y * 0.5 + 0.5);
  float fireLit = (1.0 - smoothstep(0.0, 0.25, vAge)) * smoothstep(-0.2, 0.8, -p.y);
  col += vec3(0.9, 0.35, 0.08) * fireLit * (0.35 + 0.9 * uNight);
  col *= mix(1.0, 0.45, uNight); // 夜间烟本身更暗

  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

const BASE_DRIFT = 9;
const BASE_LIFE = 16;
/** 烟的平均漂移速度是火头推进速度的多少倍 */
const LEAD = 1.8;
/** 烟羽最大长度（米） */
const MAX_PLUME = 4000;

export class Smoke {
  readonly object: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  readonly material: THREE.ShaderMaterial;
  /** 每秒最多生成的粒子数 */
  rate = 380;
  private spawn: THREE.InstancedBufferAttribute;
  private wind: THREE.InstancedBufferAttribute;
  private pace: THREE.InstancedBufferAttribute;
  private next = 0;
  private acc = 0;
  private sources: number[] = [];
  /** 按火势强度的累积分布，用于加权抽取烟源 */
  private cdf: Float64Array = new Float64Array(0);
  private cellWind: Float32Array;
  private rng = 1;

  constructor(
    private grid: Grid,
    cellWind: Float32Array,
    minElev: number,
    vScale: number,
    readonly capacity = 5000,
  ) {
    this.cellWind = cellWind;
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute("position", quad.getAttribute("position"));
    geo.setAttribute("uv", quad.getAttribute("uv"));
    geo.setIndex(quad.getIndex());
    const spawn = new Float32Array(capacity * 4);
    for (let i = 0; i < capacity; i++) spawn[i * 4 + 3] = -1e6; // 初始全部"已死亡"
    this.spawn = new THREE.InstancedBufferAttribute(spawn, 4).setUsage(THREE.DynamicDrawUsage);
    this.wind = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aSpawn", this.spawn);
    geo.setAttribute("aWind", this.wind);
    this.pace = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aPace", this.pace);
    geo.instanceCount = capacity;

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      fog: true,
      transparent: true,
      depthWrite: false,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uTime: { value: 0 },
          // uLife / uDrift 只是新生粒子写入 aPace 的当前节奏，shader 不直接读取
          uLife: { value: BASE_LIFE },
          uVScale: { value: vScale },
          uMinElev: { value: minElev },
          uRise: { value: 1100 },
          uDrift: { value: BASE_DRIFT },
          uOpacity: { value: 0.5 },
          uNight: { value: 0 },
        },
      ]),
    });
    this.object = new THREE.Mesh(geo, this.material);
    this.object.frustumCulled = false;
    // 在不透明物体之后绘制
    this.object.renderOrder = 10;
  }

  /** 烟源：正在燃烧的格子；weights 为火势强度，烟更多地从燃烧最猛的地方升起 */
  setSources(cells: number[], weights?: number[]) {
    this.sources = cells.slice();
    this.cdf = new Float64Array(cells.length);
    let acc = 0;
    for (let i = 0; i < cells.length; i++) {
      acc += weights ? weights[i] : 1;
      this.cdf[i] = acc;
    }
  }

  private pickSource(): number {
    const total = this.cdf[this.cdf.length - 1];
    const r = this.random() * total;
    let lo = 0;
    let hi = this.cdf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cdf[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return this.sources[lo];
  }

  setWind(cellWind: Float32Array) {
    this.cellWind = cellWind;
  }

  /** 清空所有粒子（模拟重置时） */
  clear() {
    (this.spawn.array as Float32Array).fill(-1e6);
    this.spawn.needsUpdate = true;
    this.sources = [];
    this.cdf = new Float64Array(0);
  }

  private random(): number {
    // xorshift，避免 Math.random 在不同运行间造成截图差异
    let x = this.rng;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x >>> 0;
    return this.rng / 4294967296;
  }

  /** 预先模拟 seconds 秒（出生时间记为负值），让烟柱一开始就完整；用于调试截图与回放跳转 */
  warmup(seconds: number, now: number, dt = 0.1) {
    for (let t = now - seconds; t < now; t += dt) this.update(dt, t);
    this.material.uniforms.uTime.value = now;
  }

  // 漂移节奏：模拟是时间压缩的（每秒几十步），火线在屏幕上推进很快。
  // 粒子在整个生命期内的平均漂移速度 = 风速 × uDrift（漂移公式的时间平均系数为 1），
  // 所以把 uDrift 设为"火头推进速度 × LEAD / 风速"，顺风时烟就会跑到火头前面。
  private driftTarget = BASE_DRIFT;
  private lifeTarget = BASE_LIFE;

  /** frontSpeed：火头沿风向的推进速度（米 / 真实秒）；windSpeed：来流风速（m/s） */
  setPace(frontSpeed: number, windSpeed: number) {
    const v = Math.max(windSpeed, 1);
    this.driftTarget = Math.min(400, Math.max(BASE_DRIFT, (frontSpeed * LEAD) / v));
    // 烟羽长度（风速 × 漂移系数 × 寿命）控制在 MAX_PLUME 以内
    this.lifeTarget = Math.min(BASE_LIFE, Math.max(6, MAX_PLUME / (v * this.driftTarget)));
  }

  update(dt: number, time: number) {
    // 平滑过渡，避免空中已有的烟突然跳动
    const u = this.material.uniforms;
    const a = 1 - Math.exp(-dt / 1.5);
    u.uDrift.value += (this.driftTarget - u.uDrift.value) * a;
    u.uLife.value += (this.lifeTarget - u.uLife.value) * a;
    this.material.uniforms.uTime.value = time;
    if (!this.sources.length) return;
    // 火越大烟越多，但有上限
    // 寿命缩短时按比例多生成，空中的粒子总数保持不变，烟羽拉长后不会变稀
    const lifeScale = BASE_LIFE / this.material.uniforms.uLife.value;
    const perSecond = Math.min(this.rate, 30 + this.sources.length * 0.25) * lifeScale;
    this.acc += perSecond * dt;
    let n = Math.floor(this.acc);
    this.acc -= n;
    if (!n) return;
    n = Math.min(n, this.capacity);

    const { width: W, height: H, cellSize: S } = this.grid.meta;
    const spawn = this.spawn.array as Float32Array;
    const wind = this.wind.array as Float32Array;
    const pace = this.pace.array as Float32Array;
    const first = this.next;
    for (let i = 0; i < n; i++) {
      const c = this.pickSource();
      const gx = (c % W) + this.random() - 0.5;
      const gy = Math.floor(c / W) + this.random() - 0.5;
      const j = this.next;
      spawn[j * 4] = (gx - (W - 1) / 2) * S;
      spawn[j * 4 + 1] = this.grid.data[c * GRID_CHANNELS];
      spawn[j * 4 + 2] = (gy - (H - 1) / 2) * S;
      spawn[j * 4 + 3] = time - this.random() * dt;
      wind[j * 4] = this.cellWind[c * 2];
      wind[j * 4 + 1] = this.cellWind[c * 2 + 1];
      wind[j * 4 + 2] = this.random();
      wind[j * 4 + 3] = 0.7 + 0.6 * this.random();
      pace[j * 2] = this.material.uniforms.uDrift.value;
      pace[j * 2 + 1] = this.material.uniforms.uLife.value;
      this.next = (this.next + 1) % this.capacity;
    }
    // 只上传改动过的区段（环形缓冲可能绕回开头）
    for (const attr of [this.spawn, this.wind, this.pace]) {
      const s = attr.itemSize;
      attr.clearUpdateRanges();
      if (first + n <= this.capacity) attr.addUpdateRange(first * s, n * s);
      else {
        attr.addUpdateRange(first * s, (this.capacity - first) * s);
        attr.addUpdateRange(0, (first + n - this.capacity) * s);
      }
      attr.needsUpdate = true;
    }
  }
}
