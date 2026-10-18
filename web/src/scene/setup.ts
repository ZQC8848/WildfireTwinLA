import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import Stats from "three/examples/jsm/libs/stats.module.js";

export interface SceneContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  stats: Stats;
  /** 每帧回调，参数为距上一帧的秒数 */
  onFrame: (fn: (dt: number) => void) => void;
  /** 每帧的绘制函数，默认直接渲染场景；后处理（Bloom）会替换它 */
  render: () => void;
  /** 画布尺寸变化时的回调 */
  onResize: (fn: (w: number, h: number) => void) => void;
}

export function createScene(container: HTMLElement): SceneContext {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const gl = renderer.getContext() as WebGL2RenderingContext;
  if (!gl.getExtension("EXT_color_buffer_float")) {
    console.warn("[scene] EXT_color_buffer_float is not supported; GPU simulation will not run");
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1117);
  scene.fog = new THREE.Fog(0x0d1117, 20000, 45000);

  const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 10, 100000);
  camera.position.set(0, 9000, 11000);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.48;
  controls.minDistance = 300;
  controls.maxDistance = 30000;

  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a2f25, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(-6000, 8000, 4000);
  scene.add(sun);

  const stats = new Stats();
  stats.dom.style.cssText = "position:fixed;top:60px;right:8px;left:auto;z-index:30;";
  stats.dom.classList.add("stats");
  document.body.appendChild(stats.dom);

  const resizeCallbacks: ((w: number, h: number) => void)[] = [];
  // 跟随容器而不是窗口：右侧联络面板展开或收起时，地图宽度也会变
  let size = "";
  new ResizeObserver(() => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h || `${w}x${h}` === size) return;
    size = `${w}x${h}`;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    for (const fn of resizeCallbacks) fn(w, h);
  }).observe(container);

  const callbacks: ((dt: number) => void)[] = [];
  const timer = new THREE.Timer();
  renderer.setAnimationLoop((time) => {
    timer.update(time);
    const dt = timer.getDelta();
    for (const fn of callbacks) fn(dt);
    // 飞行模式下关闭轨道控制（见 flyControls.ts），否则 update() 会把相机朝向拉回轨道中心
    if (controls.enabled) controls.update();
    ctx.render();
    stats.update();
  });

  const ctx: SceneContext = {
    renderer,
    scene,
    camera,
    controls,
    stats,
    onFrame: (fn) => callbacks.push(fn),
    render: () => renderer.render(scene, camera),
    onResize: (fn) => resizeCallbacks.push(fn),
  };
  return ctx;
}
