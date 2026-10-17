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
}

export function createScene(container: HTMLElement): SceneContext {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const gl = renderer.getContext() as WebGL2RenderingContext;
  if (!gl.getExtension("EXT_color_buffer_float")) {
    console.warn("[scene] 不支持 EXT_color_buffer_float，GPU 模拟将无法运行");
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
  stats.dom.style.cssText = "position:fixed;top:0;left:0;";
  document.body.appendChild(stats.dom);

  window.addEventListener("resize", () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  });

  const callbacks: ((dt: number) => void)[] = [];
  const timer = new THREE.Timer();
  renderer.setAnimationLoop((time) => {
    timer.update(time);
    const dt = timer.getDelta();
    for (const fn of callbacks) fn(dt);
    controls.update();
    renderer.render(scene, camera);
    stats.update();
  });

  return { renderer, scene, camera, controls, stats, onFrame: (fn) => callbacks.push(fn) };
}
