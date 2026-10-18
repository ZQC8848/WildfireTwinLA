// 植被与建筑共用的实例化 shader：
// - 每个实例只存 (x, 高程, z, 旋转) 与 (缩放, 格子号)，显示高度在 shader 中按竖向夸张计算，滑块调整无需重建
// - 按所在格子的火灾状态改变外观：燃烧中发出火光；燃尽后树冠（aPart = 0）消失、其余部分变焦黑。
//   建筑（缩放存为负数作标记，见 propField）燃尽后整体压低成焦黑残骸，起火后约 2 小时内残骸里有余烬闪烁
// - 状态来源：P2 的模拟状态纹理（uUseState）；尚无模拟时可用 uBurnOn 的圆环做预览
// - 玻璃（aPart = 2）在夜间（uNight）亮灯

import * as THREE from "three";

const vertexShader = /* glsl */ `
in vec4 aColor;
in float aPart;
in vec4 aOffset; // x, 地面高程（米）, z, 绕 Y 旋转
in vec2 aParams; // 缩放（建筑为负数）, 格子号

uniform float uVScale;
uniform float uMinElev;
uniform float uTime;
uniform float uSway;
uniform sampler2D uState;
uniform bool uUseState;
uniform float uViewMinutes; // 显示时刻（分钟）
uniform bool uViewLive;     // 是否显示当前时刻（而不是回看）
uniform float uStepMinutes;
uniform sampler2D uTreat; // 处理掩膜（同地形）
uniform bool uHasTreat;
uniform vec2 uGridSize;
uniform bool uBurnOn;
uniform vec4 uBurn; // 圆心 x, 圆心 z, 火线半径, 火线宽度

out vec3 vColor;
out vec3 vNormalW;
flat out float vPart;
flat out float vState;
out float vLocalY;
out float vSeed;
flat out float vBuilding;
out float vAge;        // 着火后经过的分钟数（显示时刻）
out vec3 vLocalPos;

#include <fog_pars_vertex>

float arrivalAt(float cell) {
  int c = int(cell + 0.5);
  int w = int(uGridSize.x);
  return texelFetch(uState, ivec2(c % w, c / w), 0).b;
}

float stateAt(float cell, vec2 xz) {
  if (uUseState) {
    int c = int(cell + 0.5);
    int w = int(uGridSize.x);
    vec4 st = texelFetch(uState, ivec2(c % w, c / w), 0);
    // 时间轴回看：显示时刻之后才着火的格子当作未燃；回看时按着火后经过的时间近似燃烧中 / 已燃尽
    if (st.r < 0.5 || st.b > uViewMinutes + 1e-3) return 0.0;
    if (uViewLive) return st.r;
    return uViewMinutes - st.b < 3.0 * uStepMinutes ? 1.0 : 2.0;
  }
  if (uBurnOn) {
    float d = length(xz - uBurn.xy);
    if (d < uBurn.z - uBurn.w) return 2.0;
    if (d < uBurn.z) return 1.0;
  }
  return 0.0;
}

void main() {
  float s = abs(aParams.x);
  bool building = aParams.x < 0.0;
  float c = cos(aOffset.w);
  float sn = sin(aOffset.w);
  float st = stateAt(aParams.y, aOffset.xz);
  // 处理区里的植被：防火带全部清除；计划烧除去掉约 60%；疏伐去掉约 40% 并压低树冠
  if (uHasTreat) {
    int cc = int(aParams.y + 0.5);
    int gw = int(uGridSize.x);
    int t = int(texelFetch(uTreat, ivec2(cc % gw, cc / gw), 0).r * 255.0 + 0.5);
    float r = fract(sin(dot(aOffset.xz, vec2(12.9898, 78.233))) * 43758.5453);
    if (t == 1 || (t == 2 && r < 0.6) || (t == 3 && r < 0.4)) s = 0.0;
    if (t == 3) s *= 0.8;
  }
  vec3 p = position * s;
  // 燃尽的建筑：屋顶与墙体一起压低到约四成高度，留下焦黑残骸（屋顶不再整个消失）
  if (building && st > 1.5) p.y *= 0.42;
  if (aPart < 0.5 && !building) {
    if (st > 1.5) p *= 0.0; // 燃尽：树冠塌缩消失
    float ph = aOffset.x * 0.13 + aOffset.z * 0.07;
    p.x += sin(uTime * 1.3 + ph) * 0.01 * p.y * uSway;
    p.z += cos(uTime * 1.1 + ph) * 0.01 * p.y * uSway;
  }
  vec3 rp = vec3(p.x * c + p.z * sn, p.y, -p.x * sn + p.z * c);
  vNormalW = vec3(normal.x * c + normal.z * sn, normal.y, -normal.x * sn + normal.z * c);
  vec3 world = vec3(aOffset.x, (aOffset.y - uMinElev) * uVScale, aOffset.z) + rp;

  vColor = aColor.rgb;
  vPart = aPart;
  vState = st;
  vLocalY = position.y;
  vSeed = fract(sin(aParams.y * 12.9898) * 43758.5453);
  vBuilding = building ? 1.0 : 0.0;
  vAge = uUseState && st > 0.5 ? uViewMinutes - arrivalAt(aParams.y) : 0.0;
  vLocalPos = position;

  vec4 mvPosition = modelViewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const fragmentShader = /* glsl */ `
layout(location = 0) out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor

uniform vec3 uSunDir;
uniform float uTime;
uniform float uNight;

in vec3 vColor;
in vec3 vNormalW;
flat in float vPart;
flat in float vState;
in float vLocalY;
in float vSeed;
flat in float vBuilding;
in float vAge;
in vec3 vLocalPos;

#include <fog_pars_fragment>

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec3 n = normalize(vNormalW);
  float diffuse = max(dot(n, normalize(uSunDir)), 0.0);
  float sky = 0.5 + 0.5 * n.y;
  // 与地形同一套光照，模型和地面明暗一致
  float light = mix(0.32 + 0.18 * sky + 0.72 * diffuse, 0.22 + 0.12 * sky, uNight);
  vec3 col = vColor * light;
  vec3 glow = vec3(0.0);

  if (vState > 1.5) {
    col = mix(col, vec3(0.045, 0.04, 0.035), 0.85);
    if (vBuilding > 0.5) {
      // 残骸里零星的余烬：约 1.5 m 的斑块随机闪烁，起火后 2 小时内逐渐熄灭
      float cellNoise = hash13(floor(vLocalPos * 0.7) + vSeed * 17.0);
      float flick = 0.6 + 0.4 * sin(uTime * (2.0 + 3.0 * cellNoise) + cellNoise * 40.0);
      float smoulder = step(0.82, cellNoise) * flick * (1.0 - smoothstep(30.0, 120.0, vAge));
      glow += vec3(1.0, 0.32, 0.06) * smoulder * 1.4;
    }
  } else if (vState > 0.5) {
    float f = fract(sin(floor(uTime * 9.0 + vSeed * 7.0) * 12.9898 + vSeed * 78.233) * 43758.5453);
    f = mix(f, 0.5 + 0.5 * sin(uTime * 13.0 + vLocalY * 2.5 + vSeed * 30.0), 0.5);
    vec3 ember = mix(vec3(0.95, 0.24, 0.03), vec3(1.0, 0.62, 0.12), f);
    col = mix(col * 0.25, ember, 0.75);
    glow = ember * 0.8;
  }

  if (vPart > 1.5 && vState < 1.5) {
    // 夜间窗户亮灯（每栋随机一点差异）；燃烧时窗户透出火光
    vec3 lamp = vec3(1.0, 0.78, 0.45) * (0.7 + 0.3 * vSeed);
    glow += lamp * uNight * step(0.25, vSeed);
    if (vState > 0.5) glow += vec3(1.0, 0.45, 0.1);
  }

  gl_FragColor = vec4(col + glow, 1.0);
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export function createPropMaterial(gridSize: THREE.Vector2, minElev: number, vScale: number, sunDir: THREE.Vector3): THREE.ShaderMaterial {
  const empty = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  empty.needsUpdate = true;
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader,
    fragmentShader,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uVScale: { value: vScale },
        uMinElev: { value: minElev },
        uTime: { value: 0 },
        uSway: { value: 1 },
        uState: { value: null },
        uUseState: { value: false },
        uViewMinutes: { value: 0 },
        uViewLive: { value: true },
        uStepMinutes: { value: 5 },
        uTreat: { value: null },
        uHasTreat: { value: false },
        uGridSize: { value: gridSize },
        uBurnOn: { value: false },
        uBurn: { value: new THREE.Vector4(0, 0, 0, 150) },
        uSunDir: { value: sunDir },
        uNight: { value: 0 },
      },
    ]),
  });
  // UniformsUtils.merge 会克隆纹理与向量，赋值放在合并之后，让太阳方向与地形共用同一个对象
  material.uniforms.uState.value = empty;
  material.uniforms.uSunDir.value = sunDir;
  return material;
}
