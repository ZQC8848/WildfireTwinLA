// 火势元胞自动机的 GPU shader。每个片元对应一个格子，纹理坐标 = 网格坐标（x 向东，y 由北向南）。
//
// 状态纹理 RGBA32F：
//   R 状态：0 未燃，1 燃烧中，2 已燃尽
//   G 已燃烧的步数
//   B 着火时刻（分钟），未着火为 -1
//   A 预留（P4 处理掩膜）
//
// 蔓延规则：Alexandridis et al. (2008)
//   p = ph · (1 + pveg) · (1 + pden) · pw · ps
//   pw = exp(c1·V) · exp(c2·V·(cosθ − 1))，θ 为风去向与蔓延方向的夹角
//   ps = exp(a·θs)，θs 为两格之间的坡度角（度，上坡为正）
// 多个燃烧邻格独立作用：点燃概率 = 1 − Π(1 − p_i)。
// 飞火：在上风方向按对数正态距离采样，采样点在燃烧则以 pSpot 概率点燃；建筑格只能被飞火点燃。
//   草和灌丛的轻飞火占绝大多数：平均飞行距离 uSpotDistPerMs·V，空中约 16 s 燃尽，超过 uSpotMaxPerMs·V 的落点无效。
//   少量重飞火（房屋、棕榈、被抬升的灌丛）大风时能飞一两公里（Norte 的 MIRADA 起火点在 2.4 km 外）：
//   占比从 5 m/s 时的 0 线性升到 10 m/s 时的 uSpotLongShare，平均距离 uSpotLongPerMs·V，σ = 1.0，不设上限。
// 处理过的格子燃料少：防火带、计划烧除里的燃烧格向外蔓延和放出飞火都按剩余燃料（fuelMul）打折。
//
// 随机数用无符号整数哈希（PCG），GPU 与 CPU 参考实现得到同一串随机数。
//
// 集合预报（P3）：同一个 shader 支持把 uTiles.x × uTiles.y 个成员拼成一张图集，每个成员是 uSize 大小的一块。
// 邻格与飞火查找限制在本块内；每块有自己的随机种子和风扰动（风向 ±uDirJitter、风速 ±uSpeedJitter）。
// 第 0 块不加扰动、种子不变，所以 uTiles = (1, 1) 时与单次模拟完全一致（CPU 对照不受影响）。

export const fullscreenVertex = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const common = /* glsl */ `
layout(location = 0) out highp vec4 pc_fragColor;

uint pcg(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

// 格子坐标 + 步数 + 种子 + 通道 → [0, 1)
float rand(ivec2 c, uint step, uint seed, uint k) {
  uint h = pcg(uint(c.x) + pcg(uint(c.y) + pcg(step + pcg(seed + k * 0x9e3779b9u))));
  return float(h >> 8u) / 16777216.0;
}
`;

export const stepFragment = /* glsl */ `
${common}
uniform sampler2D uState;
uniform sampler2D uGrid;  // R 高程, G 燃料, B 干燥度, A 类别
uniform sampler2D uTreat; // 处理掩膜：R × 255 = 0 无，1 防火带，2 计划烧除，3 疏伐，4 Zone 0
uniform float uBreakMul;  // 各处理手段对蔓延概率的倍率（来自 core 的 TreatmentEffect）
uniform float uBurnMul;
uniform float uThinMul;
uniform float uZone0Mul;
uniform sampler2D uWind;  // R 向东, G 向南（m/s）
uniform vec2 uWindSize;
uniform ivec2 uSize;
uniform float uCellSize;
uniform uint uStep;
uniform uint uSeed;
uniform float uStepMinutes;
uniform float uPh;
uniform float uC1;
uniform float uC2;
uniform float uA;
uniform bool uSpotting;
uniform float uSpotBase;
uniform float uSpotDistPerMs;
uniform int uSpotSamples;
uniform float uSpotMaxPerMs;
uniform float uSpotLongShare;
uniform float uSpotLongPerMs;
uniform ivec2 uTiles;
uniform float uDirJitter;   // 弧度
uniform float uSpeedJitter; // 比例

vec2 windAt(ivec2 c) {
  // 与 core.windAt 一致：网格角点对齐采样网格角点，在速度分量上双线性插值
  vec2 p = vec2(c) / max(vec2(uSize - 1), vec2(1.0)) * (uWindSize - 1.0);
  ivec2 p0 = ivec2(floor(p));
  ivec2 p1 = min(p0 + 1, ivec2(uWindSize) - 1);
  vec2 f = p - vec2(p0);
  vec2 a = mix(texelFetch(uWind, p0, 0).rg, texelFetch(uWind, ivec2(p1.x, p0.y), 0).rg, f.x);
  vec2 b = mix(texelFetch(uWind, ivec2(p0.x, p1.y), 0).rg, texelFetch(uWind, p1, 0).rg, f.x);
  return mix(a, b, f.y);
}

// 燃烧格剩下的燃料（块内坐标）：防火带、计划烧除按 fuelMul，其余为 1
float fuelLeft(ivec2 c) {
  int t = int(texelFetch(uTreat, c, 0).r * 255.0 + 0.5);
  return t == 1 ? uBreakMul : t == 2 ? uBurnMul : 1.0;
}

void main() {
  ivec2 a = ivec2(gl_FragCoord.xy); // 图集坐标
  ivec2 tile = a / uSize;
  ivec2 c = a - tile * uSize;       // 本块内的格子坐标
  ivec2 o = tile * uSize;
  uint tileId = uint(tile.y * uTiles.x + tile.x);
  uint seed = uSeed + tileId * 7919u;
  vec4 s = texelFetch(uState, a, 0);
  vec4 g = texelFetch(uGrid, c, 0);

  if (s.r > 1.5) { pc_fragColor = s; return; }

  if (s.r > 0.5) {
    // 燃烧持续步数随燃料增加；建筑燃烧更久
    float dur = g.a > 1.5 ? 8.0 : 2.0 + floor(3.0 * g.g + 0.5);
    s.g += 1.0;
    if (s.g >= dur) s.r = 2.0;
    pc_fragColor = s;
    return;
  }

  // 未燃：不可燃格永远不会着火
  if (g.a < 0.5) { pc_fragColor = s; return; }

  vec2 wind = windAt(c);
  if (tileId > 0u) {
    // 成员的风扰动只取决于块号，整个模拟过程中保持不变
    float ang = (rand(ivec2(0), tileId, 0x51ed27u, 1u) * 2.0 - 1.0) * uDirJitter;
    float mag = 1.0 + (rand(ivec2(0), tileId, 0x51ed27u, 2u) * 2.0 - 1.0) * uSpeedJitter;
    wind = mag * vec2(wind.x * cos(ang) - wind.y * sin(ang), wind.x * sin(ang) + wind.y * cos(ang));
  }
  float V = length(wind);
  vec2 wdir = V > 1e-4 ? wind / V : vec2(0.0);

  // 处理效果：防火带、计划烧除按燃料倍率、疏伐按蔓延速率倍率降低本格被引燃的概率；Zone 0 降低房屋的飞火易损性
  int treat = int(texelFetch(uTreat, c, 0).r * 255.0 + 0.5);
  float treatMul = treat == 1 ? uBreakMul : treat == 2 ? uBurnMul : treat == 3 ? uThinMul : 1.0;
  float notIgnite = 1.0;
  if (g.a < 1.5 && g.g > 0.0) {
    // 植被格：8 邻域的燃烧格独立作用
    float pveg = mix(-0.4, 0.4, g.g);
    float pden = mix(-0.4, 0.3, g.b);
    float base = uPh * (1.0 + pveg) * (1.0 + pden);
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        if (dx == 0 && dy == 0) continue;
        ivec2 n = c + ivec2(dx, dy);
        if (n.x < 0 || n.y < 0 || n.x >= uSize.x || n.y >= uSize.y) continue;
        float nr = texelFetch(uState, o + n, 0).r;
        if (nr < 0.5 || nr > 1.5) continue;
        vec2 dir = normalize(vec2(-dx, -dy)); // 从邻格指向本格
        bool diag = dx != 0 && dy != 0;
        float dist = uCellSize * (diag ? 1.41421356 : 1.0);
        float cosT = dot(wdir, dir);
        float pw = exp(uC1 * V) * exp(uC2 * V * (cosT - 1.0));
        float slope = degrees(atan(g.r - texelFetch(uGrid, n, 0).r, dist));
        float ps = exp(uA * slope);
        // 对角邻格的概率略降，减轻方格网造成的方形火场
        float p = clamp(base * pw * ps * (diag ? 0.83 : 1.0) * treatMul * fuelLeft(n), 0.0, 1.0);
        notIgnite *= 1.0 - p;
      }
    }
  }

  if (uSpotting && V > 2.0) {
    // 飞火：从本格逆风回溯，看上风方向一定距离处是否有燃烧格
    float meanDist = uSpotDistPerMs * V;
    float longShare = uSpotLongShare * clamp((V - 5.0) / 5.0, 0.0, 1.0);
    float susceptibility = (g.a > 1.5 ? 2.5 * (0.5 + g.b) * (treat == 4 ? uZone0Mul : 1.0) : g.g * (0.5 + g.b)) * treatMul;
    for (int k = 0; k < 8; k++) {
      if (k >= uSpotSamples) break;
      float u1 = max(rand(c, uStep, seed, uint(10 + k * 3)), 1e-6);
      float u2 = rand(c, uStep, seed, uint(11 + k * 3));
      float u3 = rand(c, uStep, seed, uint(12 + k * 3));
      // 对数正态：轻飞火 sigma = 0.6、均值 meanDist，超过燃尽距离的不算；重飞火 sigma = 1.0
      float z = sqrt(-2.0 * log(u1)) * cos(6.2831853 * u2);
      bool lofted = rand(c, uStep, seed, uint(40 + k)) < longShare;
      float d = lofted ? uSpotLongPerMs * V * exp(z - 0.5) : meanDist * exp(0.6 * z - 0.18);
      if (!lofted && d > uSpotMaxPerMs * V) continue;
      float jitter = radians(15.0) * (u3 * 2.0 - 1.0);
      vec2 back = -vec2(wdir.x * cos(jitter) - wdir.y * sin(jitter), wdir.x * sin(jitter) + wdir.y * cos(jitter));
      ivec2 src = c + ivec2(round(back * d / uCellSize));
      if (src.x < 0 || src.y < 0 || src.x >= uSize.x || src.y >= uSize.y || src == c) continue;
      float sr = texelFetch(uState, o + src, 0).r;
      if (sr > 0.5 && sr < 1.5) notIgnite *= 1.0 - clamp(uSpotBase * susceptibility * fuelLeft(src), 0.0, 1.0);
    }
  }

  if (rand(c, uStep, seed, 0u) < 1.0 - notIgnite) {
    s.r = 1.0;
    s.g = 0.0;
    s.b = float(uStep + 1u) * uStepMinutes;
  }
  pc_fragColor = s;
}
`;

/** 按掩膜点火：掩膜 > 0 的可燃格（未燃）设为燃烧中 */
export const igniteFragment = /* glsl */ `
${common}
uniform sampler2D uState;
uniform sampler2D uGrid;
uniform sampler2D uMask;
uniform float uMinutes;

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uState, c, 0);
  float cls = texelFetch(uGrid, c, 0).a;
  if (texelFetch(uMask, c, 0).r > 0.5 && s.r < 0.5 && cls > 0.5) {
    s = vec4(1.0, 0.0, uMinutes, s.a);
  }
  pc_fragColor = s;
}
`;

/** 重置：全部未燃，着火时刻 -1 */
export const resetFragment = /* glsl */ `
${common}
void main() {
  pc_fragColor = vec4(0.0, 0.0, -1.0, 0.0);
}
`;

/** 集合预报的初值：把全分辨率的模拟状态按 2×2 降采样，复制到图集的每一块。
 *  块内有燃烧格则为燃烧中，否则有燃尽格则为燃尽；着火时刻记为 0（预报从此刻起算） */
export const ensembleInitFragment = /* glsl */ `
${common}
uniform sampler2D uSrc;
uniform ivec2 uSize;
uniform int uFactor;

void main() {
  ivec2 a = ivec2(gl_FragCoord.xy);
  ivec2 c = a - (a / uSize) * uSize;
  bool burning = false;
  bool burned = false;
  for (int j = 0; j < uFactor; j++)
    for (int i = 0; i < uFactor; i++) {
      float r = texelFetch(uSrc, c * uFactor + ivec2(i, j), 0).r;
      burning = burning || (r > 0.5 && r < 1.5);
      burned = burned || r > 1.5;
    }
  pc_fragColor = burning ? vec4(1.0, 0.0, 0.0, 0.0) : burned ? vec4(2.0, 0.0, 0.0, 0.0) : vec4(0.0, 0.0, -1.0, 0.0);
}
`;

/** 集合统计：对每个格子收集各成员的着火时刻并排序，输出
 *  R 燃烧概率，G 第 10 百分位着火时刻（最早的可能），B 中位数，A 第 90 百分位；对应分位上未着火时为 -1 */
export const ensembleReduceFragment = (members: number) => /* glsl */ `
${common}
uniform sampler2D uAtlas;
uniform ivec2 uSize;
uniform ivec2 uTiles;
const int M = ${members};

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float t[M];
  int burned = 0;
  for (int k = 0; k < M; k++) {
    ivec2 tile = ivec2(k % uTiles.x, k / uTiles.x);
    vec4 s = texelFetch(uAtlas, tile * uSize + c, 0);
    float v = s.r > 0.5 ? max(s.b, 0.0) : 1e9;
    if (s.r > 0.5) burned++;
    // 插入排序
    int j = k - 1;
    while (j >= 0 && t[j] > v) {
      t[j + 1] = t[j];
      j--;
    }
    t[j + 1] = v;
  }
  float p10 = t[M / 10];
  float p50 = t[M / 2 - 1];
  float p90 = t[(M * 9) / 10 - 1];
  pc_fragColor = vec4(float(burned) / float(M), p10 < 1e8 ? p10 : -1.0, p50 < 1e8 ? p50 : -1.0, p90 < 1e8 ? p90 : -1.0);
}
`;
