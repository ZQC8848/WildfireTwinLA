// 地形 mesh 与地表 shader：高程在 vertex shader 中位移，法线由相邻高程差计算，图层在 fragment shader 中切换。

import * as THREE from "three";
import { GRID_CHANNELS, type Grid } from "@core";
import { CLASS_COLORS, LAYERS, type LayerId } from "./layers";
import { buildWaterTexture } from "./waterField";

const vertexShader = /* glsl */ `
uniform sampler2D uGrid;
uniform vec2 uGridSize;
uniform float uCellSize;
uniform float uVScale;
uniform float uMinElev;

out vec3 vNormalW;
out vec2 vCell;
out float vElev;
out vec2 vWorldXZ;
out float vWorldY;

#include <fog_pars_vertex>

float elevAt(ivec2 c) {
  c = clamp(c, ivec2(0), ivec2(uGridSize) - 1);
  return texelFetch(uGrid, c, 0).r;
}

void main() {
  ivec2 c = ivec2(round(uv.x * (uGridSize.x - 1.0)), round((1.0 - uv.y) * (uGridSize.y - 1.0)));
  float e = elevAt(c);
  float dx = (elevAt(c + ivec2(1, 0)) - elevAt(c - ivec2(1, 0))) * uVScale / (2.0 * uCellSize);
  float dz = (elevAt(c + ivec2(0, 1)) - elevAt(c - ivec2(0, 1))) * uVScale / (2.0 * uCellSize);
  vNormalW = normalize(vec3(-dx, 1.0, -dz));
  vCell = vec2(c);
  vElev = e;

  vec3 pos = position;
  pos.y = (e - uMinElev) * uVScale;
  vWorldXZ = pos.xz;
  vWorldY = pos.y;
  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const fragmentShader = /* glsl */ `
// GLSL3 模式下 three 不再定义 gl_FragColor，这里自行声明，供 colorspace/fog chunk 使用
layout(location = 0) out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor

uniform sampler2D uGrid;
uniform vec2 uGridSize;
uniform int uLayer;
uniform vec3 uRamp[4];
uniform vec2 uElevRange;
uniform bool uContours;
uniform float uContourStep;
uniform vec3 uSunDir;
uniform vec2 uHover;
uniform sampler2D uSatellite;
uniform bool uHasSatellite;
uniform vec3 uClassColors[3];
// 0 稀疏干草，1 茂密灌丛，2 干燥色调，3 建筑
uniform vec3 uNatural[4];
uniform float uNight; // 0 白天（Plan）到 1 夜间（Respond）
uniform sampler2D uWater; // R 河岸有向距离（米），G 路缘有向距离（米），BA 水流方向
uniform vec3 uSkyColor;   // 水面反射的天空颜色，随模式变化
uniform float uWaterTime;
uniform sampler2D uState; // 火势模拟状态：R = 0 未燃 / 1 燃烧中 / 2 已燃尽
uniform bool uUseState;
uniform bool uBurnOn;
uniform vec4 uBurn; // 圆心 x, 圆心 z, 火线半径, 火线宽度（与模型 shader 共用同一个对象）
uniform float uTime;

in vec3 vNormalW;
in vec2 vCell;
in float vElev;
in vec2 vWorldXZ;
in float vWorldY;

#include <fog_pars_fragment>

vec4 cellAt(ivec2 c) {
  c = clamp(c, ivec2(0), ivec2(uGridSize) - 1);
  return texelFetch(uGrid, c, 0);
}

// 燃料与干燥度做双线性插值，避免 25 m 格子的块状感
vec4 bilinear(vec2 p) {
  vec2 f = fract(p);
  ivec2 c = ivec2(floor(p));
  vec4 a = mix(cellAt(c), cellAt(c + ivec2(1, 0)), f.x);
  vec4 b = mix(cellAt(c + ivec2(0, 1)), cellAt(c + ivec2(1, 1)), f.x);
  return mix(a, b, f.y);
}

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

vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0) * 3.0;
  if (t < 1.0) return mix(uRamp[0], uRamp[1], t);
  if (t < 2.0) return mix(uRamp[1], uRamp[2], t - 1.0);
  return mix(uRamp[2], uRamp[3], t - 2.0);
}

vec4 waterAt(vec2 p) {
  vec2 f = fract(p);
  ivec2 c = ivec2(floor(p));
  ivec2 hi = ivec2(uGridSize) - 1;
  vec4 a = mix(texelFetch(uWater, clamp(c, ivec2(0), hi), 0), texelFetch(uWater, clamp(c + ivec2(1, 0), ivec2(0), hi), 0), f.x);
  vec4 b = mix(texelFetch(uWater, clamp(c + ivec2(0, 1), ivec2(0), hi), 0), texelFetch(uWater, clamp(c + ivec2(1, 1), ivec2(0), hi), 0), f.x);
  return mix(a, b, f.y);
}

// 沿水流方向平移的两层噪声，作为水面起伏的高度
float ripple(vec2 q, vec2 flow) {
  return vnoise(q - flow * uWaterTime * 0.55) * 0.62 + vnoise(q * 2.3 - flow * uWaterTime * 1.15 + 7.3) * 0.38;
}

vec3 oneHot(float cls) {
  return vec3(cls < 0.5, cls > 0.5 && cls < 1.5, cls > 1.5);
}

// 类别的双线性权重（不可燃、植被、建筑），让类别边界平滑过渡而不是逐格锯齿
vec3 classWeights(vec2 p) {
  vec2 f = fract(p);
  ivec2 c = ivec2(floor(p));
  vec3 a = mix(oneHot(cellAt(c).a), oneHot(cellAt(c + ivec2(1, 0)).a), f.x);
  vec3 b = mix(oneHot(cellAt(c + ivec2(0, 1)).a), oneHot(cellAt(c + ivec2(1, 1)).a), f.x);
  vec3 w = mix(a, b, f.y);
  // 稍微收紧过渡带
  w = smoothstep(0.25, 0.75, w);
  return w / max(w.x + w.y + w.z, 1e-4);
}

void main() {
  vec4 smoothCell = bilinear(vCell);
  vec3 w = classWeights(vCell);
  // 河流与道路的覆盖度来自有向距离场的 0 等值线，屏幕空间抗锯齿，岸线与路缘是平滑曲线
  vec4 wf = waterAt(vCell);
  float aaW = max(fwidth(wf.r) * 0.75, 0.6);
  float aaR = max(fwidth(wf.g) * 0.75, 0.6);
  float water = 1.0 - smoothstep(-aaW, aaW, wf.r);
  float road = 1.0 - smoothstep(-aaR, aaR, wf.g);
  // 植被与建筑之间仍用原来的双线性权重，只是去掉不可燃部分后重新归一
  vec2 vb = w.yz;
  float vbSum = vb.x + vb.y;
  vb = vbSum > 1e-3 ? vb / vbSum : vec2(1.0, 0.0);
  w = vec3(max(water, road), (1.0 - max(water, road)) * vb);
  float fuel = smoothCell.g;
  float dryness = smoothCell.b;

  vec3 col;
  if (uLayer == 0) {
    if (uHasSatellite) {
      col = texture(uSatellite, vec2((vCell.x + 0.5) / uGridSize.x, 1.0 - (vCell.y + 0.5) / uGridSize.y)).rgb;
    } else {
      // 燃料到覆盖度的曲线：中等燃料就已经是大片深色灌丛，稀疏处才露出干草
      float cover = smoothstep(0.08, 0.6, fuel);
      vec3 veg = mix(mix(uNatural[0], uNatural[1], cover), uNatural[2], dryness * 0.25);
      col = vb.x * veg + vb.y * uNatural[3];
      // 河岸外 10 m 内略暗：湿润的河岸
      col *= 1.0 - 0.22 * smoothstep(10.0, 0.0, wf.r) * (1.0 - water);
      col = mix(col, uClassColors[0], road);
    }
  } else if (uLayer == 1) {
    col = ramp((vElev - uElevRange.x) / (uElevRange.y - uElevRange.x));
  } else if (uLayer == 2) {
    col = mix(ramp(fuel), uClassColors[0], w.x);
  } else if (uLayer == 3) {
    col = mix(ramp(dryness), uClassColors[0], w.x);
  } else {
    col = w.x * uClassColors[0] + w.y * uClassColors[1] + w.z * uClassColors[2];
  }

  // 等高线
  if (uContours) {
    float h = vElev / uContourStep;
    float fw = fwidth(h);
    float line = 1.0 - smoothstep(fw * 0.5, fw * 1.5, abs(fract(h - 0.5) - 0.5));
    col = mix(col, col * 0.35, line * 0.8);
  }

  // 半球环境光 + 平行光
  vec3 n = normalize(vNormalW);
  float diffuse = max(dot(n, normalize(uSunDir)), 0.0);
  float sky = 0.5 + 0.5 * n.y;
  col *= 0.32 + 0.18 * sky + 0.72 * diffuse;
  // Respond 模式：天色暗下来，火光（后面叠加）成为唯一的亮色
  col *= mix(1.0, 0.38, uNight);

  if (water > 0.001) {
    vec3 wcol;
    if (uLayer == 0) {
      // 水面：按离岸距离分浅水与深水；起伏的法线带来菲涅尔反射与太阳高光；岸边一圈水沫
      vec2 flow = wf.ba;
      vec2 q = vWorldXZ * 0.045;
      float e = 0.12;
      float hx = ripple(q + vec2(e, 0.0), flow) - ripple(q - vec2(e, 0.0), flow);
      float hz = ripple(q + vec2(0.0, e), flow) - ripple(q - vec2(0.0, e), flow);
      vec3 wn = normalize(vec3(-hx * 1.4, 1.0, -hz * 1.4));
      float depth = clamp(-wf.r / 18.0, 0.0, 1.0);
      // 山谷溪流：浅处偏青绿、深处偏墨绿蓝，不用泳池式的亮蓝
      wcol = mix(vec3(0.34, 0.49, 0.5), vec3(0.11, 0.23, 0.28), depth);
      vec3 V = normalize(cameraPosition - vec3(vWorldXZ.x, vWorldY, vWorldXZ.y));
      vec3 L = normalize(uSunDir);
      wcol *= 0.62 + 0.38 * max(dot(wn, L), 0.0);
      float fres = pow(1.0 - max(dot(wn, V), 0.0), 4.0);
      wcol = mix(wcol, uSkyColor, fres * 0.35);
      float foam = smoothstep(-6.0, -2.0, wf.r) * (1.0 - smoothstep(-2.0, 0.0, wf.r));
      foam *= smoothstep(0.45, 0.8, vnoise(vWorldXZ * 0.12 - flow * uWaterTime * 1.6));
      wcol = mix(wcol, vec3(0.88, 0.92, 0.92), foam * 0.55);
      wcol *= mix(1.0, 0.32, uNight);
      float spec = pow(max(dot(wn, normalize(L + V)), 0.0), 140.0);
      wcol += vec3(1.0, 0.97, 0.9) * spec * 0.7 * (1.0 - uNight);
    } else {
      // 数据图层下用平涂的 Marine，与风和水的语义色一致
      wcol = vec3(0.435, 0.616, 0.749) * 0.75 * (0.32 + 0.18 * sky + 0.72 * diffuse) * mix(1.0, 0.38, uNight);
    }
    col = mix(col, wcol, water);
  }

  // 火势状态：燃尽为灰黑，燃烧处发光。双线性混合四个格子，火场边缘不出现方格锯齿
  float burnGlow = 0.0;
  if (uUseState) {
    vec2 f = fract(vCell);
    ivec2 c0 = ivec2(floor(vCell));
    float burned = 0.0;
    float burning = 0.0;
    for (int j = 0; j < 2; j++) {
      for (int i = 0; i < 2; i++) {
        ivec2 cc = clamp(c0 + ivec2(i, j), ivec2(0), ivec2(uGridSize) - 1);
        float st = texelFetch(uState, cc, 0).r;
        float wgt = (i == 1 ? f.x : 1.0 - f.x) * (j == 1 ? f.y : 1.0 - f.y);
        burned += wgt * step(1.5, st);
        burning += wgt * step(0.5, st) * (1.0 - step(1.5, st));
      }
    }
    col = mix(col, vec3(0.06, 0.055, 0.05), (burned + burning) * 0.85);
    float flick = 0.35 + 0.65 * vnoise(vWorldXZ * 0.03 + vec2(uTime * 0.9, -uTime * 0.6)) * (0.6 + 0.4 * vnoise(vWorldXZ * 0.11 - uTime * 2.3));
    burnGlow = burning * flick;
  } else if (uBurnOn && w.x < 0.5) { // 河流与道路不参与燃烧预览
    float d = length(vWorldXZ - uBurn.xy);
    if (d < uBurn.z - uBurn.w) {
      col = mix(col, vec3(0.06, 0.055, 0.05), 0.85);
    } else if (d < uBurn.z) {
      float t = (d - (uBurn.z - uBurn.w)) / uBurn.w;
      // 两层噪声叠加的不规则闪烁，避免正弦造成的规则条纹
      float flick = 0.35 + 0.65 * vnoise(vWorldXZ * 0.03 + vec2(uTime * 0.9, -uTime * 0.6)) * (0.6 + 0.4 * vnoise(vWorldXZ * 0.11 - uTime * 2.3));
      burnGlow = smoothstep(0.0, 0.5, t) * (1.0 - smoothstep(0.7, 1.0, t)) * flick;
      col = mix(col * 0.4, vec3(0.08, 0.06, 0.05), 1.0 - t);
    }
  }

  // 悬停格子描边
  vec2 d = abs(vCell - uHover);
  float m = max(d.x, d.y);
  if (m < 0.5) {
    float edge = smoothstep(0.5 - fwidth(m) * 2.0, 0.5, m);
    col = mix(col * 1.25, vec3(1.0, 0.85, 0.2), edge);
  }

  col += vec3(1.0, 0.4, 0.06) * burnGlow * 1.6;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export class Terrain {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  readonly minElev: number;
  readonly maxElev: number;
  readonly gridTexture: THREE.DataTexture;
  private _layer: LayerId = "natural";
  private _verticalScale: number;

  constructor(
    readonly grid: Grid,
    verticalScale = 1.5,
  ) {
    const { width, height, cellSize } = grid.meta;
    this._verticalScale = verticalScale;

    let min = Infinity;
    let max = -Infinity;
    for (let c = 0; c < width * height; c++) {
      const e = grid.data[c * GRID_CHANNELS];
      if (e < min) min = e;
      if (e > max) max = e;
    }
    this.minElev = min;
    this.maxElev = max;

    this.gridTexture = new THREE.DataTexture(grid.data, width, height, THREE.RGBAFormat, THREE.FloatType);
    this.gridTexture.minFilter = THREE.NearestFilter;
    this.gridTexture.magFilter = THREE.NearestFilter;
    this.gridTexture.needsUpdate = true;

    // 顶点间距恰好为 cellSize，顶点位于格子中心
    const geo = new THREE.PlaneGeometry((width - 1) * cellSize, (height - 1) * cellSize, width - 1, height - 1);
    geo.rotateX(-Math.PI / 2);

    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uGrid: { value: null },
          uGridSize: { value: new THREE.Vector2(width, height) },
          uCellSize: { value: cellSize },
          uVScale: { value: verticalScale },
          uMinElev: { value: min },
          uLayer: { value: 0 },
          uRamp: { value: [new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color()] },
          uElevRange: { value: new THREE.Vector2(min, max) },
          uContours: { value: false },
          uContourStep: { value: 50 },
          uSunDir: { value: new THREE.Vector3(-0.6, 0.8, 0.4).normalize() },
          uHover: { value: new THREE.Vector2(-10, -10) },
          uSatellite: { value: null },
          uNight: { value: 0 },
          uWater: { value: null },
          uSkyColor: { value: new THREE.Color("#d4d8cf") },
          uWaterTime: { value: 0 },
          uState: { value: null },
          uUseState: { value: false },
          uBurnOn: { value: false },
          uBurn: { value: new THREE.Vector4() },
          uTime: { value: 0 },
          uHasSatellite: { value: false },
          // 建筑格的地面：有 3D 房屋后不再画成浅白块，改为院落草地与铺装的混合色
          uNatural: { value: ["#a89a63", "#3d5a2c", "#9e8550", "#9c9a84"].map((c) => new THREE.Color(c)) },
          uClassColors: {
            value: [CLASS_COLORS.unburnable, CLASS_COLORS.vegetation, CLASS_COLORS.building].map((c) => new THREE.Color(c)),
          },
        },
      ]),
    });
    // UniformsUtils.merge 会克隆纹理，所以在合并之后再赋值
    material.uniforms.uGrid.value = this.gridTexture;
    material.uniforms.uWater.value = buildWaterTexture(grid);

    this.mesh = new THREE.Mesh(geo, material);
    // 几何体是平的，位移在 GPU 上完成，包围体不可信
    this.mesh.frustumCulled = false;
  }

  get uniforms() {
    return this.mesh.material.uniforms;
  }

  get layer(): LayerId {
    return this._layer;
  }

  set layer(id: LayerId) {
    this._layer = id;
    const def = LAYERS[id];
    this.uniforms.uLayer.value = def.code;
    if (def.ramp) def.ramp.forEach((hex, i) => (this.uniforms.uRamp.value[i] as THREE.Color).set(hex));
  }

  get verticalScale(): number {
    return this._verticalScale;
  }

  set verticalScale(v: number) {
    this._verticalScale = v;
    this.uniforms.uVScale.value = v;
  }

  setHover(x: number, y: number) {
    this.uniforms.uHover.value.set(x, y);
  }

  clearHover() {
    this.uniforms.uHover.value.set(-10, -10);
  }

  setSatellite(tex: THREE.Texture) {
    tex.colorSpace = THREE.SRGBColorSpace;
    this.uniforms.uSatellite.value = tex;
    this.uniforms.uHasSatellite.value = true;
  }
}
