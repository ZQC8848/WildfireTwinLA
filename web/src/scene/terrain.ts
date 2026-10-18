// 地形 mesh 与地表 shader：高程在 vertex shader 中位移，法线由相邻高程差计算，图层在 fragment shader 中切换。

import * as THREE from "three";
import { GRID_CHANNELS, type Grid } from "@core";
import { CLASS_COLORS, LAYERS, type LayerId } from "./layers";
import { FUEL_GROUP_COLORS, FuelGroup } from "../data/fuelModel";
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
uniform sampler2D uFuelGroup; // 可选：LANDFIRE 燃料类别（R × 255 = FuelGroup），Natural 图层按类别着色
uniform bool uHasFuelGroup;
uniform vec3 uFuelColors[4];  // 草地、草灌、灌丛、林地
uniform int uDevPalette;      // 建成区配色：0 暖灰混凝土，1 灌溉绿地，2 深色退后，3 混合（建成区用卫星影像）
uniform bool uSatDetail;
uniform sampler2D uRoads;     // 可选：OSM 路网贴图（R 描边，G 路面，B 主干道与高速），见 scene/roads.ts
uniform bool uHasRoads;      // 混合方案：卫星影像只用于建成区，并给野外的燃料配色加上影像的明暗纹理
uniform float uNight; // 0 白天（Plan）到 1 夜间（Respond）
uniform sampler2D uWater; // R 河岸有向距离（米），G 路缘有向距离（米），BA 水流方向
uniform vec3 uSkyColor;   // 水面反射的天空颜色，随模式变化
uniform float uWaterTime;
uniform float uSimMinutes; // 显示时刻（分钟）：通常是当前模拟时间，拖动时间轴时是回看的时刻
uniform sampler2D uTreat; // 处理掩膜：R × 255 = 0 无，1 防火带，2 计划烧除，3 疏伐，4 Zone 0
uniform bool uHasTreat;
uniform vec3 uRetardant;
uniform sampler2D uPerimeter; // 官方火界（R > 0 为火界内），只画轮廓作为对照
uniform bool uHasPerimeter;
uniform sampler2D uContact; // 紧急联络状态（每格 R × 255 = ContactCode，见 net/dispatch.ts）
uniform bool uHasContact;
uniform sampler2D uDamage; // 报告受损区域（R > 0 为区域内），只画虚线轮廓作为对照
uniform bool uHasDamage;
uniform sampler2D uForecast; // 集合预报统计（降采样网格）：R 燃烧概率，B 中位数着火时刻（距预报起点的分钟，-1 为未过半）
uniform bool uHasForecast;
uniform vec2 uForecastSize;
uniform float uForecastScale; // 每个预报格对应的网格格数
uniform float uStepMinutes; // 每步分钟数
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

// 燃料类别配色：四个角的类别颜色做双线性混合，类别边界不出现 25 m 方块
vec3 fuelColorAt(ivec2 c, vec3 fallback) {
  c = clamp(c, ivec2(0), ivec2(uGridSize) - 1);
  int g = int(texelFetch(uFuelGroup, c, 0).r * 255.0 + 0.5);
  return g >= 1 && g <= 4 ? uFuelColors[g - 1] : fallback;
}
vec3 fuelColor(vec2 p, vec3 fallback) {
  vec2 f = fract(p);
  ivec2 c = ivec2(floor(p));
  vec3 a = mix(fuelColorAt(c, fallback), fuelColorAt(c + ivec2(1, 0), fallback), f.x);
  vec3 b = mix(fuelColorAt(c + ivec2(0, 1), fallback), fuelColorAt(c + ivec2(1, 1), fallback), f.x);
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

// 四种处理手段的覆盖度（双线性），边缘平滑
vec4 treatCoverage(vec2 p) {
  vec2 f = fract(p);
  ivec2 c = ivec2(floor(p));
  ivec2 hi = ivec2(uGridSize) - 1;
  vec4 acc = vec4(0.0);
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      int t = int(texelFetch(uTreat, clamp(c + ivec2(i, j), ivec2(0), hi), 0).r * 255.0 + 0.5);
      float wgt = (i == 1 ? f.x : 1.0 - f.x) * (j == 1 ? f.y : 1.0 - f.y);
      acc += wgt * vec4(t == 1, t == 2, t == 3, t == 4);
    }
  }
  return smoothstep(0.3, 0.6, acc);
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
      // 有 LANDFIRE 燃料类别时按类别着色：枯草是草黄色，不会因为燃料值高被画成深绿灌丛
      if (uHasFuelGroup) veg = mix(fuelColor(vCell, veg), uNatural[2], dryness * 0.15);
      // 建成区（不可燃城区与建筑格的地面）的配色方案，只在有燃料类别时生效
      vec3 devGround = uNatural[3];
      vec3 devPaved = vec3(0.47, 0.46, 0.43) * (0.94 + 0.12 * vnoise(vWorldXZ * 0.02));
      if (uHasFuelGroup && uDevPalette == 1) {
        // 灌溉绿地：南加州社区从空中看是灰绿色的树冠与草坪，与金黄的枯草山坡对比
        // 白天光照会把颜色整体提亮约 1.2 倍，所以基色取得偏深
        float canopy = smoothstep(0.5, 0.8, vnoise(vWorldXZ * 0.085));
        float roofs = smoothstep(0.72, 0.88, vnoise(vWorldXZ * 0.21 + 7.3));
        vec3 sage = mix(vec3(0.33, 0.39, 0.29), vec3(0.22, 0.29, 0.2), canopy * 0.7);
        devPaved = mix(sage, vec3(0.5, 0.48, 0.44), roofs * 0.25);
        devGround = devPaved;
      } else if (uHasFuelGroup && uDevPalette == 2) {
        // 深色退后：建成区沉到背景，野外燃料与火线最突出
        devPaved = vec3(0.2, 0.195, 0.185) * (0.92 + 0.16 * vnoise(vWorldXZ * 0.03));
        devGround = devPaved * 1.1;
      } else if (uHasFuelGroup && uSatDetail) {
        vec3 sat = texture(uSatellite, vec2((vCell.x + 0.5) / uGridSize.x, 1.0 - (vCell.y + 0.5) / uGridSize.y)).rgb;
        float lum = dot(sat, vec3(0.299, 0.587, 0.114));
        devPaved = mix(vec3(lum), sat, 0.8) * 0.92;
        devGround = devPaved;
        // 野外仍按燃料类别着色，乘上影像的相对明暗：山脊、沟谷、小路的细节都在
        veg *= clamp(0.55 + 1.6 * lum, 0.7, 1.3);
      }
      col = vb.x * veg + vb.y * (uHasFuelGroup ? devGround : uNatural[3]);
      // 河岸外 10 m 内略暗：湿润的河岸
      col *= 1.0 - 0.22 * smoothstep(10.0, 0.0, wf.r) * (1.0 - water);
      // 大片铺装（城区的停车场、硬化地面）离路缘较远处过渡到浅色混凝土，窄路仍是深色路面
      vec3 paved = mix(uClassColors[0], vec3(0.5, 0.5, 0.47), smoothstep(-10.0, -35.0, wf.g));
      // 有燃料类别时，不可燃区域几乎都是城区（道路无法单独识别），统一画成暖灰色的建成区地面
      if (uHasFuelGroup) paved = devPaved;
      col = mix(col, paved, road);
      // 路网：细的深色路缘、略透明的暖灰路面，主干道与高速偏暖黄；随后与地面一起受光照。
      // 颜色压得比底图亮不了太多：路网是参照，不能抢燃料配色与火的视觉重心
      if (uHasRoads) {
        vec3 rd = texture(uRoads, vec2((vCell.x + 0.5) / uGridSize.x, 1.0 - (vCell.y + 0.5) / uGridSize.y)).rgb;
        col = mix(col, vec3(0.16, 0.15, 0.14), rd.r * 0.4);
        col = mix(col, vec3(0.7, 0.68, 0.63), rd.g * 0.8);
        col = mix(col, vec3(0.86, 0.79, 0.6), rd.b * 0.9);
      }
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
  float fireCover = 0.0; // 当前火场（含燃尽）覆盖度，预报图层不画在已烧的地方
  if (uUseState) {
    // 用着火时刻（状态纹理 B 通道）的等值线画火线，代替逐格混合，火场边缘是平滑而不规则的曲线。
    // 两套插值：front 决定"火线在哪里"，已烧格的到达时间钳在当前时间 2 步以内，
    //   这样火线停住时（遇到防火带、河岸）显示边界最多停在两格中点，不会在视觉上继续往前爬；
    // age 决定"着火后多久"，用真实的到达时间，用于燃烧带、余烬、焦黑的分层着色。
    float T = uSimMinutes;
    float S = uStepMinutes;
    vec2 f = fract(vCell);
    ivec2 c0 = ivec2(floor(vCell));
    float front = 0.0;
    float arr = 0.0;
    for (int j = 0; j < 2; j++) {
      for (int i = 0; i < 2; i++) {
        ivec2 cc = clamp(c0 + ivec2(i, j), ivec2(0), ivec2(uGridSize) - 1);
        vec4 st = texelFetch(uState, cc, 0);
        float wgt = (i == 1 ? f.x : 1.0 - f.x) * (j == 1 ? f.y : 1.0 - f.y);
        // 时间轴回看：着火时刻晚于显示时刻 T 的格子当作未燃
        bool lit = st.r > 0.5 && st.b <= T + 1e-3;
        front += wgt * (lit ? max(st.b, T - 2.0 * S) : T + 2.0 * S);
        arr += wgt * (lit ? st.b : T);
      }
    }
    // 两层噪声扰动阈值，火线有指状突出与凹湾，而不是光滑的等值线
    float wobble = (vnoise(vWorldXZ * 0.022) - 0.5) * 1.6 * S + (vnoise(vWorldXZ * 0.085 + 3.1) - 0.5) * 0.7 * S;
    float edge = T - front + wobble;
    float aa = fwidth(edge) * 0.75 + 1e-3;
    float inside = smoothstep(-aa, aa, edge) * (1.0 - max(water, road));
    fireCover = inside;
    float age = max(T - arr + wobble, 0.0);
    // 燃烧持续时间与模拟规则一致：植被 2 + 3×燃料 步，建筑 8 步
    float dur = mix((2.0 + 3.0 * fuel) * S, 8.0 * S, vb.y);
    float burning = inside * (1.0 - smoothstep(dur * 0.65, dur, age));
    // 刚烧过的地方是暗红余烬，随后冷却成焦黑
    vec3 ember = vec3(0.2, 0.06, 0.02);
    vec3 charcoal = vec3(0.055, 0.05, 0.045);
    vec3 burnt = mix(ember, charcoal, smoothstep(dur, dur * 3.0, age));
    col = mix(col, burnt, inside * 0.9);
    float flick = 0.35 + 0.65 * vnoise(vWorldXZ * 0.03 + vec2(uTime * 0.9, -uTime * 0.6)) * (0.6 + 0.4 * vnoise(vWorldXZ * 0.11 - uTime * 2.3));
    // 最外缘（刚着火）最亮；燃烧带内部是随时间流动的斑驳火团，团与团之间是暗红的燃烧地面
    float leading = 1.0 - smoothstep(0.0, 1.5 * S, age);
    float patches = smoothstep(0.35, 0.8, vnoise(vWorldXZ * 0.06 + vec2(uTime * 0.35, -uTime * 0.25)));
    burnGlow = burning * flick * (0.95 * leading + (1.0 - leading) * patches * 0.6);
    // 余烬中零星的火星
    float spark = step(0.86, vnoise(vWorldXZ * 0.25 + uTime * 0.4)) * inside * (1.0 - smoothstep(dur, dur * 2.5, age));
    burnGlow += spark * 0.35 * flick;
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

  // 处理区：统一用阻燃剂粉红（人的干预），四种手段用不同纹理区分，不只靠颜色（色觉无障碍）
  if (uHasTreat) {
    vec4 tc = treatCoverage(vCell);
    if (dot(tc, vec4(1.0)) > 0.001) {
      float u = (vWorldXZ.x + vWorldXZ.y) / 14.0;
      float aaS = fwidth(u) * 1.2;
      float stripe = smoothstep(0.5 - aaS, 0.5 + aaS, abs(fract(u) - 0.5) * 2.0);
      float v = (vWorldXZ.x - vWorldXZ.y) / 14.0;
      float cross = smoothstep(0.5 - aaS, 0.5 + aaS, abs(fract(v) - 0.5) * 2.0);
      vec2 g = fract(vWorldXZ / 10.0) - 0.5;
      float dots = 1.0 - smoothstep(0.18, 0.24, length(g));
      vec3 bare = vec3(0.62, 0.55, 0.45); // 防火带：清到裸土
      vec3 pink = uRetardant * mix(1.0, 0.55, uNight);
      // 防火带：裸土 + 粉色斜线；计划烧除：粉色斜线；疏伐：粉色圆点；Zone 0：粉色交叉线
      col = mix(col, mix(bare * (0.32 + 0.18 * sky + 0.72 * diffuse) * mix(1.0, 0.38, uNight), pink, stripe * 0.75), tc.x);
      col = mix(col, pink, tc.y * stripe * 0.7);
      col = mix(col, pink, tc.z * dots * 0.8);
      col = mix(col, pink, tc.w * max(stripe, cross) * 0.6);
    }
  }

  // 官方火界轮廓：取覆盖度 0.5 等值线，画成带深色描边的浅色线，白天夜间都清楚
  if (uHasPerimeter) {
    vec2 f = fract(vCell);
    ivec2 c0 = ivec2(floor(vCell));
    ivec2 hi = ivec2(uGridSize) - 1;
    float cov = 0.0;
    for (int j = 0; j < 2; j++) {
      for (int i = 0; i < 2; i++) {
        float v = texelFetch(uPerimeter, clamp(c0 + ivec2(i, j), ivec2(0), hi), 0).r;
        cov += (i == 1 ? f.x : 1.0 - f.x) * (j == 1 ? f.y : 1.0 - f.y) * step(0.5 / 255.0, v);
      }
    }
    float d = abs(cov - 0.5);
    float fw = max(fwidth(cov), 1e-4);
    float line = 1.0 - smoothstep(fw * 1.2, fw * 2.2, d);
    float halo = 1.0 - smoothstep(fw * 2.2, fw * 4.0, d);
    col = mix(col, vec3(0.05), halo * 0.6);
    col = mix(col, vec3(0.93, 0.95, 0.92), line);
  }

  // 报告受损区域：与官方火界同样取覆盖度 0.5 等值线，画成浅色虚线，与实线的火界区分
  if (uHasDamage) {
    vec2 f = fract(vCell);
    ivec2 c0 = ivec2(floor(vCell));
    ivec2 hi = ivec2(uGridSize) - 1;
    float cov = 0.0;
    for (int j = 0; j < 2; j++) {
      for (int i = 0; i < 2; i++) {
        float v = texelFetch(uDamage, clamp(c0 + ivec2(i, j), ivec2(0), hi), 0).r;
        cov += (i == 1 ? f.x : 1.0 - f.x) * (j == 1 ? f.y : 1.0 - f.y) * step(0.5 / 255.0, v);
      }
    }
    float d = abs(cov - 0.5);
    float fw = max(fwidth(cov), 1e-4);
    float line = 1.0 - smoothstep(fw * 1.0, fw * 2.0, d);
    float dash = step(0.45, fract((vWorldXZ.x + vWorldXZ.y) / 36.0));
    col = mix(col, vec3(0.05), (1.0 - smoothstep(fw * 2.0, fw * 3.5, d)) * 0.45 * dash);
    col = mix(col, vec3(0.98, 0.86, 0.62), line * dash);
  }

  // 集合预报：燃烧概率画成半透明的暖红色（概率越高越浓），中位数到达时间每小时一条等时线
  if (uHasForecast) {
    vec2 p = vCell / uForecastScale - 0.5;
    vec2 f = fract(p);
    ivec2 c0 = ivec2(floor(p));
    ivec2 hi = ivec2(uForecastSize) - 1;
    float prob = 0.0;
    float med = 0.0;
    float valid = 0.0;
    for (int j = 0; j < 2; j++) {
      for (int i = 0; i < 2; i++) {
        vec4 v = texelFetch(uForecast, clamp(c0 + ivec2(i, j), ivec2(0), hi), 0);
        float wgt = (i == 1 ? f.x : 1.0 - f.x) * (j == 1 ? f.y : 1.0 - f.y);
        prob += wgt * v.r;
        med += wgt * max(v.b, 0.0);
        valid += wgt * step(0.0, v.b);
      }
    }
    float open = (1.0 - fireCover) * (1.0 - water);
    float shade = smoothstep(0.03, 0.12, prob) * (0.1 + 0.32 * prob) * open;
    vec3 heat = mix(vec3(0.95, 0.66, 0.3), vec3(0.82, 0.2, 0.12), smoothstep(0.2, 0.9, prob));
    col = mix(col, heat * mix(1.0, 0.8, uNight), shade);
    // 等时线只画在一半以上成员都烧到的区域内（四个角都有中位数，插值才有意义）
    float hours = med / 60.0;
    float dh = abs(fract(hours + 0.5) - 0.5);
    float line = (1.0 - smoothstep(0.4, 1.1, dh / max(fwidth(hours), 1e-4))) * step(0.999, valid) * step(0.25, hours) * open;
    col = mix(col, vec3(0.98, 0.92, 0.84), line * 0.6);
  }

  // 紧急联络状态点：每个房屋格中心一个点，形状与颜色按状态区分（Retardant 粉红系，人的干预）。
  // 点的屏幕半径至少约 2 像素，远处也看得见；外呼中的点脉动并超过 1 的亮度，经 Bloom 发光
  if (uHasContact) {
    ivec2 cc = ivec2(floor(vCell + 0.5));
    int code = int(texelFetch(uContact, clamp(cc, ivec2(0), ivec2(uGridSize) - 1), 0).r * 255.0 + 0.5);
    if (code > 0) {
      float px = max(fwidth(vCell.x), fwidth(vCell.y));
      float r = code == 7 ? 0.44 : code >= 3 ? 0.36 : 0.24;
      r = max(r, 2.2 * px);
      float dist = length(vCell - vec2(cc));
      float disc = 1.0 - smoothstep(r - px, r + px, dist);
      float ring = disc * smoothstep(r * 0.55 - px, r * 0.55 + px, dist);
      float core = 1.0 - smoothstep(r * 0.32 - px, r * 0.32 + px, dist);
      vec3 pink = uRetardant;
      if (code == 1) col = mix(col, vec3(0.74, 0.71, 0.66), ring * 0.9);          // 短信排队：灰色空心
      else if (code == 2) col = mix(col, vec3(0.94, 0.68, 0.8), disc * 0.95);     // 已发短信：浅粉实心
      else if (code == 3) col = mix(col, pink, ring);                              // 外呼排队：粉红空心
      else if (code == 4) col = mix(col, pink * (1.1 + 0.7 * (0.5 + 0.5 * sin(uTime * 7.0))), disc); // 外呼中：脉动
      else if (code == 5) col = mix(mix(col, pink, disc), vec3(1.0), core * disc); // 已确认安全：粉红点 + 白心
      else if (code == 6) col = mix(col, pink * 0.55, ring);                       // 未接通：暗粉空心
      else if (code == 7) col = mix(mix(col, vec3(1.0), disc), pink, ring);        // 需要帮助：白底粉边
    }
  }

  // 悬停格子描边
  vec2 d = abs(vCell - uHover);
  float m = max(d.x, d.y);
  if (m < 0.5) {
    float edge = smoothstep(0.5 - fwidth(m) * 2.0, 0.5, m);
    col = mix(col * 1.25, vec3(1.0, 0.85, 0.2), edge);
  }

  // 白天火光收敛，夜间（Respond）完全亮起；颜色偏深橙，避免叠加后饱和成黄白
  col += vec3(1.0, 0.36, 0.05) * burnGlow * mix(0.9, 1.6, uNight);
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
    /** 合成网格：把社区外的不可燃区域当作溪流；真实数据只把海平面附近的区域当作水面 */
    inferStreams = true,
    /** 可选：每格的燃料类别（FuelGroup）。提供时用它着色，并用其中的水体判断水面 */
    fuelGroups?: Uint8Array,
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
          uSimMinutes: { value: 0 },
          uTreat: { value: null },
          uHasTreat: { value: false },
          uRetardant: { value: new THREE.Color("#D63A73") },
          uPerimeter: { value: null },
          uHasPerimeter: { value: false },
          uContact: { value: null },
          uHasContact: { value: false },
          uDamage: { value: null },
          uHasDamage: { value: false },
          uForecast: { value: null },
          uHasForecast: { value: false },
          uForecastSize: { value: new THREE.Vector2(1, 1) },
          uForecastScale: { value: 2 },
          uStepMinutes: { value: 5 },
          uState: { value: null },
          uUseState: { value: false },
          uBurnOn: { value: false },
          uBurn: { value: new THREE.Vector4() },
          uTime: { value: 0 },
          uHasSatellite: { value: false },
          // 建筑格的地面：有 3D 房屋后不再画成浅白块，改为院落草地与铺装的混合色
          uNatural: { value: ["#a89a63", "#3d5a2c", "#9e8550", "#9c9a84"].map((c) => new THREE.Color(c)) },
          uFuelGroup: { value: null },
          uHasFuelGroup: { value: false },
          uDevPalette: { value: 0 },
          uSatDetail: { value: false },
          uRoads: { value: null },
          uHasRoads: { value: false },
          uFuelColors: {
            value: [FuelGroup.Grass, FuelGroup.GrassShrub, FuelGroup.Shrub, FuelGroup.Timber].map((g) => new THREE.Color(FUEL_GROUP_COLORS[g])),
          },
          uClassColors: {
            value: [CLASS_COLORS.unburnable, CLASS_COLORS.vegetation, CLASS_COLORS.building].map((c) => new THREE.Color(c)),
          },
        },
      ]),
    });
    // UniformsUtils.merge 会克隆纹理，所以在合并之后再赋值
    material.uniforms.uGrid.value = this.gridTexture;
    material.uniforms.uWater.value = buildWaterTexture(grid, inferStreams, fuelGroups);
    if (fuelGroups) {
      const tex = new THREE.DataTexture(fuelGroups, width, height, THREE.RedFormat, THREE.UnsignedByteType);
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
      tex.needsUpdate = true;
      material.uniforms.uFuelGroup.value = tex;
      material.uniforms.uHasFuelGroup.value = true;
    }

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

  /** 设置官方火界（格子索引列表）；传 null 清除 */
  setPerimeter(cells: number[] | null) {
    const { width, height } = this.grid.meta;
    if (!cells) {
      this.uniforms.uHasPerimeter.value = false;
      return;
    }
    const mask = new Uint8Array(width * height);
    for (const c of cells) if (c >= 0 && c < mask.length) mask[c] = 255;
    const old = this.uniforms.uPerimeter.value as THREE.DataTexture | null;
    old?.dispose();
    const tex = new THREE.DataTexture(mask, width, height, THREE.RedFormat, THREE.UnsignedByteType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    this.uniforms.uPerimeter.value = tex;
    this.uniforms.uHasPerimeter.value = true;
  }

  /** 报告受损区域：建筑格向外扩 dilate 格后连成一片，画成虚线轮廓；传 null 清除 */
  setDamageArea(cells: number[] | null, dilate = 3) {
    const { width: W, height: H } = this.grid.meta;
    (this.uniforms.uDamage.value as THREE.DataTexture | null)?.dispose();
    this.uniforms.uHasDamage.value = false;
    if (!cells?.length) return;
    const mask = new Uint8Array(W * H);
    for (const c of cells) {
      const x = c % W;
      const y = Math.floor(c / W);
      for (let dy = -dilate; dy <= dilate; dy++)
        for (let dx = -dilate; dx <= dilate; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (dx * dx + dy * dy <= dilate * dilate && xx >= 0 && yy >= 0 && xx < W && yy < H) mask[yy * W + xx] = 255;
        }
    }
    const tex = new THREE.DataTexture(mask, W, H, THREE.RedFormat, THREE.UnsignedByteType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    this.uniforms.uDamage.value = tex;
  }

  private contactTex: THREE.DataTexture | null = null;
  private contactShown = true;

  /** 紧急联络状态（每格一个 ContactCode）；传 null 清除 */
  setContactCodes(codes: Uint8Array | null) {
    if (!codes) {
      this.uniforms.uHasContact.value = false;
      return;
    }
    const { width: W, height: H } = this.grid.meta;
    if (!this.contactTex) {
      this.contactTex = new THREE.DataTexture(new Uint8Array(W * H), W, H, THREE.RedFormat, THREE.UnsignedByteType);
      this.contactTex.minFilter = THREE.NearestFilter;
      this.contactTex.magFilter = THREE.NearestFilter;
      this.uniforms.uContact.value = this.contactTex;
    }
    (this.contactTex.image.data as Uint8Array).set(codes);
    this.contactTex.needsUpdate = true;
    this.uniforms.uHasContact.value = this.contactShown;
  }

  showContact(show: boolean) {
    this.contactShown = show;
    this.uniforms.uHasContact.value = show && !!this.contactTex;
  }

  /** 显示或隐藏报告受损区域（只在 Respond 模式显示） */
  showDamageArea(show: boolean) {
    this.uniforms.uHasDamage.value = show && !!this.uniforms.uDamage.value;
  }

  /** 显示集合预报（texture 为统计纹理，size 为其边长，scale 为每个预报格对应的网格格数）；传 null 隐藏 */
  setForecast(texture: THREE.Texture | null, size = 1, scale = 2) {
    this.uniforms.uHasForecast.value = !!texture;
    if (!texture) return;
    this.uniforms.uForecast.value = texture;
    this.uniforms.uForecastSize.value.set(size, size);
    this.uniforms.uForecastScale.value = scale;
  }

  /** 路网贴图（scene/roads.ts 光栅化），只在 Natural 图层显示 */
  setRoads(tex: THREE.Texture) {
    this.uniforms.uRoads.value = tex;
    this.uniforms.uHasRoads.value = true;
  }

  /** 混合方案：卫星影像只用于建成区，并作为野外燃料配色的明暗纹理 */
  setSatelliteDetail(tex: THREE.Texture) {
    tex.colorSpace = THREE.SRGBColorSpace;
    this.uniforms.uSatellite.value = tex;
    this.uniforms.uSatDetail.value = true;
  }

  setSatellite(tex: THREE.Texture) {
    tex.colorSpace = THREE.SRGBColorSpace;
    this.uniforms.uSatellite.value = tex;
    this.uniforms.uHasSatellite.value = true;
  }
}
