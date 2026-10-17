import "./style.css";
import * as THREE from "three";
import GUI from "lil-gui";
import { CellClass, GRID_CHANNELS, cellToLonLat } from "@core";
import { loadGrid } from "./data/loadGrid";
import { TerrainPicker } from "./interact/picking";
import { LAYERS, type LayerId } from "./scene/layers";
import { createScene } from "./scene/setup";
import { Terrain } from "./scene/terrain";
import { loadAssets } from "./scene/props/assets";
import { layoutProps } from "./scene/props/placement";
import { createPropMaterial } from "./scene/props/propMaterial";
import { PropField } from "./scene/props/propField";
import { Wires } from "./scene/props/wires";
import { Legend } from "./ui/legend";
import { FireSim } from "./sim/fireSim";
import { windGrid } from "./sim/wind";
import { Smoke } from "./scene/smoke";
import { WindLayer } from "./scene/windLayer";
import { TerrainWindModel, WindLibrary, buildWindField, type WindMode } from "./sim/terrainWind";
import { CpuFireSim } from "./sim/cpuReference";
import type { WindField } from "@core";

const bundle = await loadGrid();
const { grid } = bundle;
const { meta } = grid;
const ctx = createScene(document.getElementById("app")!);

const terrain = new Terrain(grid);
ctx.scene.add(terrain.mesh);

// Tia 导出与网格对齐的真彩色底图后自动启用；合成网格没有对应底图
if (bundle.source === "real") {
  new THREE.TextureLoader().load(
    `${import.meta.env.BASE_URL}data/satellite.jpg`,
    (tex) => terrain.setSatellite(tex),
    undefined,
    () => console.info("[main] No satellite.jpg; using synthetic natural colors"),
  );
}

// 植被、建筑与电力设施
const lib = await loadAssets();
const layout = layoutProps(grid, bundle.buildings, bundle.communities, lib);
const propMaterial = createPropMaterial(
  new THREE.Vector2(meta.width, meta.height),
  terrain.minElev,
  terrain.verticalScale,
  terrain.uniforms.uSunDir.value as THREE.Vector3,
);
const props = new PropField(layout, lib, meta, propMaterial);
// 燃烧预览的参数与时间由地形和模型共用
terrain.uniforms.uBurn.value = propMaterial.uniforms.uBurn.value;
ctx.scene.add(props.object);
const wires = new Wires(layout.spans);
wires.rebuild(terrain.minElev, terrain.verticalScale);
ctx.scene.add(wires.object);

let buildingCells = 0;
for (let c = 0; c < meta.width * meta.height; c++) {
  if (grid.data[c * GRID_CHANNELS + 3] === CellClass.Building) buildingCells++;
}
document.getElementById("hud")!.textContent = [
  `Data: ${bundle.source === "mock" ? "synthetic grid" : "real grid"}  ${meta.width}×${meta.height} @ ${meta.cellSize} m`,
  `Elevation: ${Math.round(terrain.minElev)}–${Math.round(terrain.maxElev)} m`,
  `Building cells: ${buildingCells}  Buildings: ${bundle.buildings.length}  Communities: ${bundle.communities.length}`,
  `Placed objects: ${props.count}  Wire spans: ${layout.spans.length}`,
].join("\n");
const hudBase = document.getElementById("hud")!.textContent;

// 图例与悬停信息
const panels = document.getElementById("panels")!;
const info = document.createElement("div");
info.className = "info";
panels.appendChild(info);
const legend = new Legend(panels);
const elevRange: [number, number] = [terrain.minElev, terrain.maxElev];

const CLASS_NAMES = ["Unburnable", "Vegetation", "Building"];
const picker = new TerrainPicker(grid, ctx.camera, ctx.renderer.domElement, terrain);
let pending: PointerEvent | null = null;
ctx.renderer.domElement.addEventListener("pointermove", (e) => (pending = e));
ctx.renderer.domElement.addEventListener("pointerleave", () => {
  pending = null;
  terrain.clearHover();
  info.textContent = "";
});
ctx.onFrame(() => {
  if (!pending) return;
  const hit = picker.pick(pending.clientX, pending.clientY);
  pending = null;
  if (!hit) {
    terrain.clearHover();
    info.textContent = "";
    return;
  }
  terrain.setHover(hit.x, hit.y);
  const i = hit.cell * GRID_CHANNELS;
  const [lon, lat] = cellToLonLat(meta, hit.cell);
  info.textContent = [
    `Cell      (${hit.x}, ${hit.y})  #${hit.cell}`,
    `Lat/Lon   ${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    `Elevation ${grid.data[i].toFixed(0)} m`,
    `Fuel      ${grid.data[i + 1].toFixed(2)}`,
    `Dryness   ${grid.data[i + 2].toFixed(2)}`,
    `Class     ${CLASS_NAMES[grid.data[i + 3]] ?? "?"}`,
  ].join("\n");
});

// 调参面板
const params = { layer: "natural" as LayerId, verticalScale: terrain.verticalScale, contours: false, contourStep: 50 };
const layerOptions = Object.fromEntries(Object.entries(LAYERS).map(([id, def]) => [def.label, id]));
const applyLayer = () => {
  terrain.layer = params.layer;
  legend.show(params.layer, elevRange);
};
applyLayer();

const gui = new GUI({ title: "WildfireTwinLA" });
const fTerrain = gui.addFolder("Terrain");
fTerrain.add(params, "layer", layerOptions).name("Layer").onChange(applyLayer);
fTerrain
  .add(params, "verticalScale", 1, 4, 0.1)
  .name("Vertical exaggeration")
  .onChange((v: number) => {
    terrain.verticalScale = v;
    propMaterial.uniforms.uVScale.value = v;
    windLayer.material.uniforms.uVScale.value = v;
    smoke.material.uniforms.uVScale.value = v;
    props.invalidate();
    wires.rebuild(terrain.minElev, v);
  });
fTerrain.add(params, "contours").name("Contours").onChange((v: boolean) => (terrain.uniforms.uContours.value = v));
fTerrain
  .add(params, "contourStep", 10, 200, 10)
  .name("Contour step (m)")
  .onChange((v: number) => (terrain.uniforms.uContourStep.value = v));
fTerrain.add(terrain.mesh.material, "wireframe").name("Wireframe");

const sceneParams = { models: true, wires: true, lodScale: 1, sway: 1, night: 0, burnPreview: false, burnSpeed: 60 };
const fScene = gui.addFolder("Scene objects");
fScene.add(sceneParams, "models").name("Trees and buildings").onChange((v: boolean) => (props.object.visible = v));
fScene.add(sceneParams, "wires").name("Power lines").onChange((v: boolean) => (wires.object.visible = v));
fScene
  .add(sceneParams, "lodScale", 0.25, 3, 0.05)
  .name("Detail distance")
  .onChange((v: number) => {
    props.lodScale = v;
    props.invalidate();
  });
fScene.add(sceneParams, "sway", 0, 3, 0.1).name("Wind sway").onChange((v: number) => (propMaterial.uniforms.uSway.value = v));
fScene.add(sceneParams, "night", 0, 1, 0.01).name("Night").onChange((v: number) => {
  propMaterial.uniforms.uNight.value = v;
  smoke.material.uniforms.uNight.value = v;
});

// 燃烧预览：P2 的模拟完成前，用一个从山地向外扩张的圆环验证模型的燃烧与燃尽效果
const burnCenter = new THREE.Vector2(0, -meta.height * meta.cellSize * 0.18);
const fBurn = gui.addFolder("Burn preview");
fBurn
  .add(sceneParams, "burnPreview")
  .name("Enabled")
  .onChange((v: boolean) => {
    propMaterial.uniforms.uBurnOn.value = v;
    terrain.uniforms.uBurnOn.value = v;
    (propMaterial.uniforms.uBurn.value as THREE.Vector4).set(burnCenter.x, burnCenter.y, 0, 150);
  });
fBurn.add(sceneParams, "burnSpeed", 10, 300, 10).name("Spread (m/s)");

// ---- GPU 火势模拟 ----
const simParams = {
  running: false,
  stepsPerSecond: 20,
  windSpeed: 8,
  windFrom: 45,
  windMode: "terrain" as WindMode,
  showWind: true,
  spotting: true,
  igniteOnClick: true,
  seed: 1,
};
// 地形修正风场：有 WindNinja 风场库（data/wind/）就用库，否则用地形启发式
const windModel = new TerrainWindModel(grid);
const windLibrary = await WindLibrary.load();
const windSource = () =>
  simParams.windMode === "uniform" ? "uniform" : windLibrary ? `WindNinja library (${windLibrary.index.source ?? "precomputed"})` : "terrain heuristic (approximate)";
let currentWind: WindField = buildWindField(simParams.windMode, { speedMs: simParams.windSpeed, dirFromDeg: simParams.windFrom }, windModel, windLibrary);
const windField = (): WindField => currentWind;
const sim = new FireSim(ctx.renderer, grid, terrain.gridTexture, windField());
const smoke = new Smoke(grid, windGrid(windField(), meta.width, meta.height), terrain.minElev, terrain.verticalScale);
ctx.scene.add(smoke.object);
const windLayer = new WindLayer(grid, terrain.minElev, terrain.verticalScale);
ctx.scene.add(windLayer.object);
const applyWind = () => {
  currentWind = buildWindField(simParams.windMode, { speedMs: simParams.windSpeed, dirFromDeg: simParams.windFrom }, windModel, windLibrary);
  sim.setWind(currentWind);
  smoke.setWind(windGrid(currentWind, meta.width, meta.height));
  windLayer.update(currentWind, simParams.windSpeed);
  windLayer.object.visible = simParams.showWind;
};
applyWind();
let simActive = false;
let simLine = "Fire: click the terrain to ignite";
let checkLine = "";
const activateSim = () => {
  if (simActive) return;
  simActive = true;
  sceneParams.burnPreview = false;
  propMaterial.uniforms.uBurnOn.value = false;
  terrain.uniforms.uBurnOn.value = false;
  propMaterial.uniforms.uUseState.value = true;
  terrain.uniforms.uUseState.value = true;
};
const resetSim = () => {
  sim.reset();
  smoke.clear();
  simParams.running = false;
};

// 点击（不是拖拽）地形点火
let downAt: [number, number] | null = null;
ctx.renderer.domElement.addEventListener("pointerdown", (e) => (downAt = [e.clientX, e.clientY]));
ctx.renderer.domElement.addEventListener("pointerup", (e) => {
  if (!downAt || !simParams.igniteOnClick) return;
  const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
  downAt = null;
  if (moved > 4) return;
  const hit = picker.pick(e.clientX, e.clientY);
  if (!hit) return;
  activateSim();
  sim.igniteDisc(hit.x, hit.y, 1.5);
  simParams.running = true;
  fSim.controllersRecursive().forEach((c) => c.updateDisplay());
});

/** 固定点火点与种子，GPU 与 CPU 各跑 steps 步，比较燃烧面积与火场重合度（IoU） */
function runCpuCheck(steps = 80) {
  activateSim();
  resetSim();
  sim.seed = simParams.seed;
  sim.spotting = simParams.spotting;
  // 点火点：山地中燃料最高的格子
  let best = 0;
  let cell = 0;
  for (let y = Math.floor(meta.height * 0.2); y < meta.height * 0.5; y++)
    for (let x = Math.floor(meta.width * 0.3); x < meta.width * 0.7; x++) {
      const c = y * meta.width + x;
      if (grid.data[c * 4 + 3] === CellClass.Vegetation && grid.data[c * 4 + 1] > best) {
        best = grid.data[c * 4 + 1];
        cell = c;
      }
    }
  const cx = cell % meta.width;
  const cy = Math.floor(cell / meta.width);
  const seedCells: number[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) seedCells.push((cy + dy) * meta.width + cx + dx);

  const t0 = performance.now();
  sim.ignite(seedCells);
  sim.advance(steps);
  const gpu = sim.readState(); // 同步读回会等待 GPU 完成，计时包含全部步骤
  const tGpu = performance.now() - t0;

  const t1 = performance.now();
  const cpu = new CpuFireSim(grid, windField(), { seed: simParams.seed, spotting: simParams.spotting });
  cpu.ignite(seedCells);
  cpu.advance(steps);
  const tCpu = performance.now() - t1;

  let a = 0;
  let b = 0;
  let both = 0;
  for (let c = 0; c < meta.width * meta.height; c++) {
    const g = gpu[c * 4] > 0.5;
    const k = cpu.state[c * 4] > 0.5;
    if (g) a++;
    if (k) b++;
    if (g && k) both++;
  }
  const iou = both / Math.max(1, a + b - both);
  checkLine = `CPU check (${steps} steps): GPU ${a} cells in ${tGpu.toFixed(0)} ms, CPU ${b} cells in ${tCpu.toFixed(0)} ms, IoU ${(iou * 100).toFixed(1)}%`;
  console.info(`[sim] ${checkLine}`);
  return { gpuCells: a, cpuCells: b, iou, tGpu, tCpu };
}

const fSim = gui.addFolder("Fire simulation");
fSim.add(simParams, "running").name("Run");
fSim.add({ step: () => (activateSim(), sim.advance(1)) }, "step").name("Step once");
fSim.add({ reset: resetSim }, "reset").name("Reset");
fSim.add(simParams, "stepsPerSecond", 1, 60, 1).name("Steps per second");
fSim.add(simParams, "windSpeed", 0, 30, 0.5).name("Wind speed (m/s)").onChange(applyWind);
fSim.add(simParams, "windFrom", 0, 359, 1).name("Wind from (°)").onChange(applyWind);
fSim
  .add(simParams, "windMode", { "Uniform (single wind)": "uniform", "Terrain-adjusted": "terrain" })
  .name("Wind model")
  .onChange(applyWind);
fSim.add(simParams, "showWind").name("Show wind field").onChange((v: boolean) => (windLayer.object.visible = v));
fSim.add(simParams, "spotting").name("Spotting (embers)").onChange((v: boolean) => (sim.spotting = v));
fSim.add(simParams, "igniteOnClick").name("Click to ignite");
fSim.add(simParams, "seed", 1, 999, 1).name("Random seed").onChange((v: number) => (sim.seed = v));
fSim.add({ check: () => runCpuCheck() }, "check").name("Check against CPU");
const smokeParams = { visible: true, rate: smoke.rate, opacity: 0.32 };
const fSmoke = fSim.addFolder("Smoke");
fSmoke.add(smokeParams, "visible").name("Show smoke").onChange((v: boolean) => (smoke.object.visible = v));
fSmoke.add(smokeParams, "rate", 20, 600, 10).name("Particles per second").onChange((v: number) => (smoke.rate = v));
fSmoke.add(smokeParams, "opacity", 0.05, 0.8, 0.01).name("Opacity").onChange((v: number) => (smoke.material.uniforms.uOpacity.value = v));

let hudTimer = 0;
let stepAcc = 0;
let smokeVersion = -1;
ctx.onFrame((dt) => {
  propMaterial.uniforms.uTime.value += dt;
  terrain.uniforms.uTime.value = propMaterial.uniforms.uTime.value;
  if (sceneParams.burnPreview) (propMaterial.uniforms.uBurn.value as THREE.Vector4).z += sceneParams.burnSpeed * dt;
  if (simActive && simParams.running) {
    stepAcc += dt * simParams.stepsPerSecond;
    const n = Math.min(8, Math.floor(stepAcc));
    stepAcc -= n;
    if (n > 0) sim.advance(n);
  }
  // 每步之后状态纹理会换成另一张，所以每帧都重新指向当前那张
  propMaterial.uniforms.uState.value = sim.texture;
  terrain.uniforms.uState.value = sim.texture;
  props.update(ctx.camera);
  // 烟源随模拟读回更新（约每 0.5 秒）
  if (simActive && sim.sampleVersion !== smokeVersion) {
    smokeVersion = sim.sampleVersion;
    smoke.setSources(sim.burningSample);
  }
  smoke.update(dt, propMaterial.uniforms.uTime.value);
  hudTimer += dt;
  if (hudTimer > 0.5) {
    hudTimer = 0;
    const st = props.stats();
    // 每 0.5 秒异步读回一次：既更新统计，也刷新烟源
    const fsAsync = simActive ? sim.stats() : null;
    if (fsAsync && (simParams.running || !simLine.startsWith("Fire (sync)"))) {
      const fs = fsAsync;
      const h = Math.floor(fs.minutes / 60);
      const m = Math.round(fs.minutes % 60);
      simLine = `Fire: ${h}h ${String(m).padStart(2, "0")}m  burning ${fs.burningCells} cells, affected ${fs.burnedAreaHa.toFixed(0)} ha, building cells hit ${fs.buildingCellsBurned}`;
    }
    document.getElementById("hud")!.textContent =
      `${hudBase}\nWind: ${simParams.windSpeed} m/s from ${simParams.windFrom}°, ${windSource()}\nVisible: ${st.instances} instances, ${(st.triangles / 1e6).toFixed(2)} M triangles, ${st.drawCalls} draw calls\n${simLine}${checkLine ? "\n" + checkLine : ""}`;
  }
});

// 调试：?cam=x,y,z,tx,ty,tz 指定相机位置与目标，便于截图对比
const camParam = new URLSearchParams(location.search).get("cam");
if (camParam) {
  const v = camParam.split(",").map(Number);
  if (v.length === 6 && v.every(Number.isFinite)) {
    ctx.camera.position.set(v[0], v[1], v[2]);
    ctx.controls.target.set(v[3], v[4], v[5]);
    ctx.controls.update();
  }
}
if (new URLSearchParams(location.search).has("burn")) {
  sceneParams.burnPreview = true;
  propMaterial.uniforms.uBurnOn.value = true;
  terrain.uniforms.uBurnOn.value = true;
  (propMaterial.uniforms.uBurn.value as THREE.Vector4).set(burnCenter.x, burnCenter.y, Number(new URLSearchParams(location.search).get("burn")) || 1500, 150);
  sceneParams.burnSpeed = 0;
}

// 调试：?wind=速度,来向  ?ignite=x,y  ?steps=N（加载后立即点火并推进 N 步）  ?cpucheck（运行 CPU 对照）
const q = new URLSearchParams(location.search);
const modeQ = q.get("windmode");
if (modeQ === "uniform" || modeQ === "terrain") {
  simParams.windMode = modeQ;
  applyWind();
}
const windQ = q.get("wind")?.split(",").map(Number);
if (windQ?.length === 2 && windQ.every(Number.isFinite)) {
  [simParams.windSpeed, simParams.windFrom] = windQ;
  applyWind();
}
const igniteQ = q.get("ignite")?.split(",").map(Number);
if (igniteQ?.length === 2 && igniteQ.every(Number.isFinite)) {
  activateSim();
  sim.igniteDisc(igniteQ[0], igniteQ[1], 1.5);
  sim.advance(Number(q.get("steps")) || 0);
  // 同步统计一次，不依赖异步读回（便于无头截图验证）
  const fs = sim.statsSync();
  smoke.setSources(sim.burningSample);
  smokeVersion = sim.sampleVersion;
  smoke.warmup(smoke.material.uniforms.uLife.value, 0);
  simLine = `Fire (sync): ${Math.floor(fs.minutes / 60)}h ${String(fs.minutes % 60).padStart(2, "0")}m  burning ${fs.burningCells} cells, affected ${fs.burnedAreaHa.toFixed(0)} ha, building cells hit ${fs.buildingCellsBurned}`;
}
if (q.has("cpucheck")) runCpuCheck(Number(q.get("cpucheck")) || 80);
fSim.controllersRecursive().forEach((c) => c.updateDisplay());

// 调试用
Object.assign(window, { bundle, ctx, terrain, props, layout, sim, smoke, runCpuCheck });
