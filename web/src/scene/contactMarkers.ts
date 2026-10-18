// 紧急联络的屋顶标记：每户一个点，浮在自己的屋顶上方，形状与颜色按联络状态区分（Retardant 粉红系，人的干预）。
// 全部房屋放在一个 THREE.Points 里，一次 draw call；状态是每户 1 字节的顶点属性，变化时才上传。
// 点的屏幕尺寸按距离换算并限制在几个像素之间：远处不会缩没，近处不会盖住房子。
// 编码与 net/dispatch.ts 的 ContactCode 一致：
//   1 短信排队：灰色空心   2 已发短信：浅粉实心   3 外呼排队：粉红空心   4 通话中：粉红实心并脉动（超过 1 的亮度，经 Bloom 发光）
//   5 确认安全：粉红点加白心   6 未接通：暗粉空心   7 需要帮助：白底粉边

import * as THREE from "three";

const vertexShader = /* glsl */ `
in float aCode;
uniform float uViewportH;
uniform float uPixelRatio;
flat out float vCode;
out float vFar;

void main() {
  vCode = aCode;
  if (aCode < 0.5) {
    // 没有联络任务：移出裁剪空间，不产生像素
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  // 约 6 m 宽的点在当前距离下的像素数，再限制在各状态的上下限之间。
  // 远处成千上万的排队点只画得很小（读作密度），通话中与需要帮助保持醒目
  float px = 6.0 * projectionMatrix[1][1] * uViewportH * 0.5 / max(-mv.z, 1.0);
  int code = int(aCode + 0.5);
  vec2 range = code <= 2 ? vec2(2.5, 6.0)   // 短信
    : code == 4 ? vec2(6.0, 12.0)           // 通话中
    : code == 7 ? vec2(7.0, 14.0)           // 需要帮助
    : code == 5 ? vec2(4.0, 9.0)            // 确认安全
    : vec2(3.5, 9.0);                       // 外呼排队、未接通
  gl_PointSize = clamp(px, range.x, range.y) * uPixelRatio;
  // 远处（点被放大到下限以上）时，排队与短信的点变淡，让底图透出来
  vFar = 1.0 - clamp(px / range.x, 0.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
layout(location = 0) out highp vec4 pc_fragColor;
uniform vec3 uPink;
uniform float uTime;
flat in float vCode;
in float vFar;

void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d = length(p);
  float aa = max(fwidth(d), 1e-3) * 1.2;
  float disc = 1.0 - smoothstep(1.0 - aa, 1.0, d);
  if (disc <= 0.0) discard;
  float hollow = smoothstep(0.52 - aa, 0.52 + aa, d);
  float core = 1.0 - smoothstep(0.38 - aa, 0.38 + aa, d);
  // 外缘一圈暗边，浅色地面上也分得清
  float rim = smoothstep(0.78 - aa, 0.78 + aa, d);
  int code = int(vCode + 0.5);
  vec3 col;
  float a = disc;
  if (code == 1) { col = vec3(0.74, 0.71, 0.66); a *= hollow * 0.85; }
  else if (code == 2) { col = vec3(0.94, 0.68, 0.8); a *= 0.9; }
  else if (code == 3) { col = uPink; a *= hollow; }
  else if (code == 4) { col = uPink * (1.2 + 0.9 * (0.5 + 0.5 * sin(uTime * 6.0))); }
  else if (code == 5) { col = mix(uPink, vec3(1.0), core); }
  else if (code == 6) { col = uPink * 0.55; a *= hollow; }
  else { col = mix(vec3(1.15), uPink * 1.2, hollow); }
  col = mix(col, col * 0.35, rim * 0.6);
  if (code <= 3 || code == 6) a *= mix(1.0, 0.5, vFar);
  pc_fragColor = vec4(col, a);
}
`;

export class ContactMarkers {
  readonly object: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private codes: THREE.BufferAttribute;

  /** anchors：每户屋顶上方的锚点（与房屋冒泡同一组），按 buildings 数组的序号 */
  constructor(anchors: THREE.Vector3[]) {
    const n = anchors.length;
    const pos = new Float32Array(n * 3);
    anchors.forEach((a, i) => pos.set([a.x, a.y - 1.5, a.z], i * 3));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.codes = new THREE.BufferAttribute(new Uint8Array(n), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aCode", this.codes);
    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: {
        uPink: { value: new THREE.Color("#D63A73") },
        uTime: { value: 0 },
        uViewportH: { value: 1 },
        uPixelRatio: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
    });
    this.object = new THREE.Points(geo, material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 5;
    // 不参与射线拾取（5 万个点逐个检测太慢；地图拾取只看地形）
    this.object.raycast = () => {};
  }

  /** 每户的状态编码（ContactCode），长度等于房屋数；全 0 表示没有联络任务 */
  setCodes(codes: Uint8Array) {
    (this.codes.array as Uint8Array).set(codes);
    this.codes.needsUpdate = true;
  }

  update(dt: number, viewportH: number, pixelRatio: number) {
    const u = this.object.material.uniforms;
    u.uTime.value += dt;
    u.uViewportH.value = viewportH;
    u.uPixelRatio.value = pixelRatio;
  }
}
