import "./style.css";
import * as THREE from "three";
import GUI from "lil-gui";
import { CellClass, GRID_CHANNELS, SpreadParams } from "@core";
import type { WindField } from "@core";
import { loadGrid } from "./data/loadGrid";
import { TerrainPicker } from "./interact/picking";
import { type LayerId } from "./scene/layers";
import { createScene } from "./scene/setup";
import { Terrain } from "./scene/terrain";
import { loadAssets } from "./scene/props/assets";
import { layoutProps } from "./scene/props/placement";
import { createPropMaterial } from "./scene/props/propMaterial";
import { PropField } from "./scene/props/propField";
import { Wires } from "./scene/props/wires";
import { Smoke } from "./scene/smoke";
import { WindLayer } from "./scene/windLayer";
import { FireSim } from "./sim/fireSim";
import { FireMonitor, formatMinutes } from "./sim/fireMonitor";
import { windGrid, windToGrid } from "./sim/wind";
import { TerrainWindModel, WindLibrary, buildWindField, type WindMode } from "./sim/terrainWind";
import { CpuFireSim } from "./sim/cpuReference";
import { Shell, compassName, type Mode } from "./ui/shell";
import { PlannerController } from "./planner/controller";
import { HotspotMarkers } from "./scene/hotspots";
import { RealtimeController } from "./realtime/controller";
import { Bloom } from "./scene/post";
import { CameraRig } from "./scene/cameraRig";
import { cellXY } from "@core";
import { NORTE_SCENARIO, norteIgnitionCells } from "./data/norte";
import { FUEL_GROUP_COLORS, FuelGroup, fuelGroups, fuelModelName } from "./data/fuelModel";
import { LAYERS } from "./scene/layers";
import { loadRoads, rasterizeRoads } from "./scene/roads";
import { HomeStatus, type HomeAlert } from "./sim/homeStatus";
import { HomeAlerts } from "./ui/homeAlerts";
import { HouseFlames } from "./scene/houseFlames";
import { FlyControls } from "./scene/flyControls";
import { sampleElevation, worldToGrid } from "./scene/coords";
import { ContactCode, DispatchClient, type ContactTask } from "./net/dispatch";
import { API } from "./net/feed";
import { ContactMarkers } from "./scene/contactMarkers";
import { ContactOutline, OutlineKind } from "./scene/contactOutline";
import { ContactDock, type ContactTaskView } from "./ui/contactDock";
import { ENSEMBLE_FACTOR, ENSEMBLE_MEMBERS, Ensemble, communityOutlook, type CommunityOutlook, type EnsembleResult } from "./sim/ensemble";

const q = new URLSearchParams(location.search);
const debug = q.has("debug");
document.body.classList.toggle("debug", debug);

const bundle = await loadGrid();
const { grid } = bundle;
const { meta } = grid;
const ctx = createScene(document.getElementById("app")!);

// LANDFIRE 燃料类别（有 fuel-model.bin 时）：地表按类别着色，水面用其中的水体
const groups = bundle.fuelModel ? fuelGroups(bundle.fuelModel) : undefined;
const terrain = new Terrain(grid, 1.5, bundle.source === "mock", groups);
// OSM 路网（可选 roads.json）：异步加载后光栅化成贴图，不阻塞首屏
loadRoads().then((roads) => {
  if (!roads) return;
  const size = Math.min(4096, ctx.renderer.capabilities.maxTextureSize);
  const tex = rasterizeRoads(roads, meta.width, meta.cellSize, size);
  tex.anisotropy = ctx.renderer.capabilities.getMaxAnisotropy();
  terrain.setRoads(tex);
});
// 报告受损区域（buildings.json 的 reportedDamageArea，街道级别，不是逐户确认）：Respond 模式下画成虚线轮廓
const damageCells = bundle.buildings.filter((b) => (b as { reportedDamageArea?: boolean }).reportedDamageArea).map((b) => b.cell);
terrain.setDamageArea(damageCells);
if (groups) {
  LAYERS.natural.swatches = [
    { label: "Cured grass", color: FUEL_GROUP_COLORS[FuelGroup.Grass]! },
    { label: "Grass and sage scrub", color: FUEL_GROUP_COLORS[FuelGroup.GrassShrub]! },
    { label: "Chaparral and woodland", color: FUEL_GROUP_COLORS[FuelGroup.Shrub]! },
    { label: "Developed land (satellite image)", color: "#8a8478" },
    { label: "Highways and major roads", color: "#d9c99a" },
    { label: "Streets and dirt roads", color: "#b3ada1" },
    { label: "Water", color: "#3f5f6a" },
  ];
}
// 数据署名（地图左下角）：Copernicus 与 OpenStreetMap 的使用条款要求注明出处
const ATTRIBUTION = {
  fuels: "Fuels: LANDFIRE",
  image: "Imagery: modified Copernicus Sentinel-2 data (2026)",
  roads: "Map data: © OpenStreetMap contributors",
};
let attribution = groups ? [ATTRIBUTION.fuels, ATTRIBUTION.image, ATTRIBUTION.roads] : [];
ctx.scene.add(terrain.mesh);

// 建成区配色。默认 hybrid：城区用与网格对齐的 Sentinel-2 真彩色底图（data/satellite.jpg），
// 野外保留燃料配色并叠加影像的明暗纹理。底图缺失时退回 concrete（暖灰）。
// 对比用：?palette=concrete | sage | recede | hybrid | satellite（satellite 为整片影像，不显示燃料类别）
const PALETTES = ["concrete", "sage", "recede", "hybrid"];
const paletteQ = q.get("palette") ?? (groups ? "hybrid" : "concrete");
terrain.uniforms.uDevPalette.value = Math.max(0, PALETTES.indexOf(paletteQ));
if (bundle.source === "real" && (paletteQ === "satellite" || paletteQ === "hybrid")) {
  new THREE.TextureLoader().load(
    `${import.meta.env.BASE_URL}data/satellite.jpg`,
    (tex) => (paletteQ === "hybrid" ? terrain.setSatelliteDetail(tex) : terrain.setSatellite(tex)),
    undefined,
    () => {
      console.info("[main] No satellite.jpg; using synthetic natural colors");
      terrain.uniforms.uDevPalette.value = 0;
      attribution = attribution.filter((a) => a !== ATTRIBUTION.image);
      // 失败可能发生在界面创建之前（模块仍在等待资源）；那时下面创建界面后会用更新过的署名
      try {
        shell.setAttribution(attribution.join(". "));
      } catch {
        /* shell 尚未创建 */
      }
    },
  );
}

// ---- 植被、建筑与电力设施 ----
const lib = await loadAssets();
const layout = layoutProps(grid, bundle.buildings, bundle.communities, lib);
const propMaterial = createPropMaterial(
  new THREE.Vector2(meta.width, meta.height),
  terrain.minElev,
  terrain.verticalScale,
  terrain.uniforms.uSunDir.value as THREE.Vector3,
);
const props = new PropField(layout, lib, meta, propMaterial);
// 燃烧预览的参数由地形和模型共用
terrain.uniforms.uBurn.value = propMaterial.uniforms.uBurn.value;
ctx.scene.add(props.object);
const wires = new Wires(layout.spans);
wires.rebuild(terrain.minElev, terrain.verticalScale);
ctx.scene.add(wires.object);

// ---- 风与火 ----
const simParams = {
  running: false,
  stepsPerSecond: 2,
  // Plan 默认情景：Norte Fire 当天中午的 HRRR 风
  windSpeed: NORTE_SCENARIO.windSpeed,
  windFrom: NORTE_SCENARIO.windFrom,
  windMode: "terrain" as WindMode,
  showWind: false,
  spotting: true,
  seed: 1,
};
// 地形修正风场：有 WindNinja 风场库（data/wind/）就用库，否则用地形启发式
const windModel = new TerrainWindModel(grid);
const windLibrary = await WindLibrary.load();
const windSource = () =>
  simParams.windMode === "uniform" ? "uniform" : windLibrary ? `WindNinja library (${windLibrary.index.source ?? "precomputed"})` : "terrain heuristic (approximate)";
const inflow = () => ({ speedMs: simParams.windSpeed, dirFromDeg: simParams.windFrom });
let currentWind: WindField = buildWindField(simParams.windMode, inflow(), windModel, windLibrary);
const sim = new FireSim(ctx.renderer, grid, terrain.gridTexture, currentWind);
const smoke = new Smoke(grid, windGrid(currentWind, meta.width, meta.height), terrain.minElev, terrain.verticalScale);
ctx.scene.add(smoke.object);
// 为了性能，烟雾和房屋冒泡默认关闭，用户可在右侧工具条打开
smoke.object.visible = false;
const windLayer = new WindLayer(grid, terrain.minElev, terrain.verticalScale);
ctx.scene.add(windLayer.object);
const monitor = new FireMonitor(grid, bundle.communities, bundle.buildings);

// ---- 集合预报（P3） ----
const ensemble = new Ensemble(ctx.renderer, grid);
let forecast: EnsembleResult | null = null;
let outlook: CommunityOutlook[] | null = null;
let forecastShown = true;
/** 预报显示时，模拟每推进这么久就自动重算一次 */
const FORECAST_REFRESH_MIN = 60;
function runForecast() {
  if (!simActive) return;
  forecast = ensemble.run(sim.texture, sim.minutes, currentWind, sim.treatMask);
  outlook = communityOutlook(forecast, bundle.communities, meta.width, ensemble.size);
  showForecast();
  shell.setForecast(
    true,
    `From T + ${formatMinutes(forecast.startMinutes)}: ${ENSEMBLE_MEMBERS} runs × ${forecast.steps} steps on a ${ensemble.size} × ${ensemble.size} grid (${ensemble.grid.meta.cellSize} m) in ${Math.round(forecast.ms)} ms on the GPU. Updates every simulated hour while shown.`,
    outlook,
  );
}
function showForecast() {
  // 回看过去时隐藏：预报属于它的起点之后
  const visible = forecastShown && !!forecast && (viewMinutes === null || viewMinutes >= forecast.startMinutes);
  terrain.setForecast(visible ? forecast!.texture : null, ensemble.size, ENSEMBLE_FACTOR);
}
function clearForecast() {
  forecast = null;
  outlook = null;
  terrain.setForecast(null);
  shell.setForecast(false, "64 fire simulations from the current fire, each with the wind direction varied up to ±15° and the speed up to ±20%.", null);
}

// ---- Bloom 与相机预设 ----
const bloom = new Bloom(ctx);
const rig = new CameraRig(ctx.camera, ctx.controls);
ctx.onFrame((dt) => rig.update(dt));

/** 格子集合的中心（世界坐标，地面高度按竖向夸张） */
function cellsCenter(cells: number[]): THREE.Vector3 | null {
  if (!cells.length) return null;
  let sx = 0;
  let sy = 0;
  let se = 0;
  for (const c of cells) {
    const [x, y] = cellXY(meta, c);
    sx += x;
    sy += y;
    se += grid.data[c * GRID_CHANNELS];
  }
  const n = cells.length;
  return new THREE.Vector3(
    (sx / n - (meta.width - 1) / 2) * meta.cellSize,
    (se / n - terrain.minElev) * terrain.verticalScale,
    (sy / n - (meta.height - 1) / 2) * meta.cellSize,
  );
}

function flyToView(view: "overview" | "fire" | "community") {
  if (view === "overview") {
    rig.flyTo(new THREE.Vector3(0, 9000, 11000), new THREE.Vector3(0, 600, 0));
    return;
  }
  if (view === "fire") {
    // 火头：燃烧格中最靠下风的一段的中心；从下风方向斜上方看过去，火线与烟都朝向镜头
    const cells = sim.burningSample.length ? sim.burningSample : testIgnitions;
    if (!cells.length) return;
    const [ux, uy] = windToGrid(inflow());
    const len = Math.hypot(ux, uy) || 1;
    const proj = cells.map((c) => ({ c, p: ((c % meta.width) * ux + Math.floor(c / meta.width) * uy) / len })).sort((a, b) => b.p - a.p);
    const head = proj.slice(0, Math.max(1, Math.ceil(proj.length * 0.15))).map((o) => o.c);
    const target = cellsCenter(head)!;
    // 从风向的侧面、偏上风一点的高处看：烟往下风飘，不会挡住镜头，火线、烟柱走向与前方社区都在画面里
    const down = new THREE.Vector3(ux / len, 0, uy / len);
    const side = new THREE.Vector3(-down.z, 0, down.x);
    rig.flyTo(target.clone().addScaledVector(side, 3400).addScaledVector(down, -900).add(new THREE.Vector3(0, 3000, 0)), target.clone().addScaledVector(down, 600));
    return;
  }
  // 社区：最紧迫的社区（没有火时取第一个），从南侧斜上方看
  const closest = monitor.closest();
  const comm = bundle.communities.find((c) => c.id === closest?.id) ?? bundle.communities[0];
  if (!comm) return;
  const target = cellsCenter(comm.cells.filter((_, i) => i % 7 === 0))!;
  rig.flyTo(target.clone().add(new THREE.Vector3(600, 1100, 1700)), target);
}

// ---- 时间轴：显示时刻（null 表示当前时刻） ----
let viewMinutes: number | null = null;
let smokeEnabled = false;
function goLive() {
  viewMinutes = null;
  smoke.object.visible = smokeEnabled;
  if (forecast) showForecast();
}

// 实时数据推送的 5×5 风场：均匀风模式下直接使用；地形风模式下取其平均作为来流
let feedField: WindField | null = null;
const applyWind = () => {
  currentWind = simParams.windMode === "uniform" && feedField ? feedField : buildWindField(simParams.windMode, inflow(), windModel, windLibrary);
  sim.setWind(currentWind);
  smoke.setWind(windGrid(currentWind, meta.width, meta.height));
  windLayer.update(currentWind, simParams.windSpeed);
  windLayer.object.visible = simParams.showWind;
};
applyWind();

let simActive = false;
const activateSim = () => {
  if (simActive) return;
  simActive = true;
  propMaterial.uniforms.uBurnOn.value = false;
  terrain.uniforms.uBurnOn.value = false;
  propMaterial.uniforms.uUseState.value = true;
  terrain.uniforms.uUseState.value = true;
};

// ---- 界面 ----
const shell = new Shell(
  {
    onMode: (mode) => setMode(mode),
    onRunToggle: () => {
      if (!simActive) return;
      goLive();
      simParams.running = !simParams.running;
      shell.setRunning(simParams.running);
    },
    onStep: () => {
      if (!simActive) return;
      goLive();
      sim.advance(1);
    },
    onReset: () => resetSim(),
    onSpeed: (sps) => (simParams.stepsPerSecond = sps),
    onWind: (dir, speed) => {
      feedField = null; // 手动改风后不再使用推送的风场
      simParams.windFrom = dir;
      simParams.windSpeed = speed;
      shell.setWind(dir, speed);
      applyWind();
    },
    onWindModel: (model) => {
      simParams.windMode = model;
      applyWind();
    },
    onLayer: (layer) => (terrain.layer = layer),
    onTool: (tool) => planner.setTool(tool),
    onBrush: (r) => planner.setBrush(r),
    onClearPlan: () => planner.clear(),
    onBudget: (v) => planner.setBudget(v),
    onSuggest: () => planner.suggest(),
    onShowPlan: (key) => planner.show(key),
    onFeed: (mode) => startFeed(mode),
    onShowSmoke: (show) => {
      // 关闭期间不更新烟雾；打开时先补算一段，烟柱立即成形
      if (show && !smokeEnabled) smoke.warmup(smoke.material.uniforms.uLife.value, propMaterial.uniforms.uTime.value);
      smokeEnabled = show;
      smoke.object.visible = show && viewMinutes === null;
    },
    onScrub: (minutes) => {
      // 拖动时间轴：暂停模拟，回看任意时刻；烟雾只属于当前时刻，回看时隐藏
      viewMinutes = minutes >= sim.minutes ? null : minutes;
      simParams.running = false;
      shell.setRunning(false);
      smoke.object.visible = smokeEnabled && viewMinutes === null;
      showForecast();
      refreshPanels();
    },
    onView: (view) => flyToView(view),
    onNow: () => {
      goLive();
      refreshPanels();
    },
    onForecast: () => runForecast(),
    onShowAlerts: (show) => homeAlerts.setVisible(show),
    onShowMarkers: (show) => (markers.object.visible = show),
    onShowContact: (show) => {
      contactMarkers.object.visible = show;
      contactOutline.setShown(show);
    },
    onContactOpen: () => dock.setOpen(true),
    onCameraMode: (mode) => fly.setEnabled(mode === "fly"),
    onNorth: () => {
      // 转到正北：轨道模式绕旋转中心转到目标的正南方；飞行模式原地转向北方
      const cam = ctx.camera.position;
      if (fly.enabled) {
        const dir = ctx.camera.getWorldDirection(new THREE.Vector3());
        ctx.controls.target.copy(cam).addScaledVector(dir, 500);
        const flat = Math.hypot(dir.x, dir.z);
        rig.flyTo(cam.clone(), cam.clone().add(new THREE.Vector3(0, dir.y * 500, -flat * 500)));
        return;
      }
      const t = ctx.controls.target;
      const off = cam.clone().sub(t);
      rig.flyTo(t.clone().add(new THREE.Vector3(0, off.y, Math.hypot(off.x, off.z))), t.clone());
    },
    onShowForecast: (show) => {
      forecastShown = show;
      showForecast();
    },
    onShowWind: (show) => {
      simParams.showWind = show;
      windLayer.object.visible = show;
    },
  },
  {
    areaLabel: bundle.source === "real" ? "San Juan Capistrano and San Clemente" : "Norte Fire area, synthetic terrain",
    windDir: simParams.windFrom,
    windSpeed: simParams.windSpeed,
    stepsPerSecond: simParams.stepsPerSecond,
    layer: "natural",
    elevRange: [terrain.minElev, terrain.maxElev],
  },
);
shell.setDamageLegend(damageCells.length > 0);
shell.setAttribution(attribution.join(". "));
// 指南针跟随相机朝向（0 为正北，顺时针）
ctx.onFrame(() => {
  const d = ctx.camera.getWorldDirection(new THREE.Vector3());
  if (Math.hypot(d.x, d.z) > 1e-3) shell.setHeading((Math.atan2(d.x, -d.z) * 180) / Math.PI);
});

// 本区域概况
{
  const n = meta.width * meta.height;
  let veg = 0;
  let dense = 0;
  for (let c = 0; c < n; c++) {
    if (grid.data[c * GRID_CHANNELS + 3] !== CellClass.Vegetation) continue;
    veg++;
    if (grid.data[c * GRID_CHANNELS + 1] > 0.6) dense++;
  }
  const km2 = (n * meta.cellSize * meta.cellSize) / 1e6;
  const share = (g: FuelGroup) => {
    let k = 0;
    for (let c = 0; c < n; c++) if (groups![c] === g && grid.data[c * GRID_CHANNELS + 3] === CellClass.Vegetation) k++;
    return `${Math.round((k / Math.max(1, veg)) * 100)}% of vegetation`;
  };
  shell.setOverview([
    ["Area", `${km2.toFixed(0)} km²`],
    ["Wildland vegetation", `${Math.round((veg / n) * 100)}%`],
    ...((groups
      ? [
          ["Cured grass", share(FuelGroup.Grass)],
          ["Grass and sage scrub", share(FuelGroup.GrassShrub)],
          ["Chaparral", share(FuelGroup.Shrub)],
        ]
      : [["Dense chaparral", `${Math.round((dense / Math.max(1, veg)) * 100)}% of vegetation`]]) as [string, string][]),
    ["Homes", bundle.buildings.length.toLocaleString("en-US")],
    ["Communities", String(bundle.communities.length)],
    ["Data", bundle.source === "mock" ? "Synthetic test grid" : groups ? "LANDFIRE, Sentinel-2, USGS 3DEP and OSM" : "Sentinel-2, USGS 3DEP and OSM"],
  ]);
}

const resetSim = () => {
  sim.reset();
  goLive();
  testIgnitions = [];
  headPrev = null;
  frontSpeed = 0;
  smoke.clear();
  monitor.reset();
  clearForecast();
  refreshHomes();
  contactStoppedByUser = false;
  if (dispatch.state !== "off") void dispatch.stop();
  simParams.running = false;
  shell.setRunning(false);
};

// ---- 模式切换：界面光线由 CSS 过渡，场景光线在这里同步过渡 ----
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const PLAN_BG = new THREE.Color("#d4d8cf");
const RESPOND_BG = new THREE.Color("#1c1714");
let night = 0;
let nightTarget = 0;
const sceneBg = ctx.scene.background as THREE.Color;
const fog = ctx.scene.fog as THREE.Fog;
const applyNight = (v: number) => {
  terrain.uniforms.uNight.value = v;
  propMaterial.uniforms.uNight.value = v * 0.85;
  smoke.material.uniforms.uNight.value = v;
  sceneBg.copy(PLAN_BG).lerp(RESPOND_BG, v);
  fog.color.copy(sceneBg);
  (terrain.uniforms.uSkyColor.value as THREE.Color).copy(sceneBg);
  bloom.setNight(v);
};
function setMode(mode: Mode) {
  shell.setMode(mode);
  nightTarget = mode === "respond" ? 1 : 0;
  terrain.showDamageArea(mode === "respond");
  homeAlerts.setNight(mode === "respond");
  if (mode === "respond") terrain.layer = "natural";
  else terrain.layer = (document.getElementById("layer") as HTMLSelectElement).value as LayerId;
  if (reducedMotion) {
    night = nightTarget;
    applyNight(night);
  }
}
applyNight(0);

// ---- 悬停信息与点击点火 ----
const picker = new TerrainPicker(grid, ctx.camera, ctx.renderer.domElement, terrain);

// ---- 防控方案（P4） ----
// 最近一次测试火的点火格，供方案对比使用；重置时清空
let testIgnitions: number[] = [];
const planner: PlannerController = new PlannerController({
  grid,
  buildings: bundle.buildings,
  sim,
  renderer: ctx.renderer,
  gridTexture: terrain.gridTexture,
  terrainUniforms: terrain.uniforms,
  propUniforms: propMaterial.uniforms,
  controls: ctx.controls,
  picker,
  canvas: ctx.renderer.domElement,
  shell,
  inflow,
  windField: () => currentWind,
  ignitions: () => testIgnitions,
  scenario: () => ({ cells: norteIgnitionCells(meta), label: NORTE_SCENARIO.label }),
});

// ---- 实时数据与回放（P5） ----
const markers = new HotspotMarkers(grid, terrain.minElev, terrain.verticalScale);
ctx.scene.add(markers.object);
const realtime: RealtimeController = new RealtimeController({
  grid,
  communities: bundle.communities,
  sim,
  monitor,
  markers,
  setPerimeter: (cells) => terrain.setPerimeter(cells),
  activateSim: () => activateSim(),
  resetSim: () => resetSim(),
  setRunning: (running) => {
    simParams.running = running;
    shell.setRunning(running);
  },
  setFeedWind: (mean, field) => {
    feedField = field;
    simParams.windSpeed = Math.round(mean.speedMs * 2) / 2;
    simParams.windFrom = Math.round(mean.dirFromDeg);
    shell.setWind(simParams.windFrom, simParams.windSpeed);
    applyWind();
  },
  addIgnitions: (cells) => testIgnitions.push(...cells),
  onChange: () => refreshPanels(),
});
// ---- 房屋受损：冒泡提示与屋顶火苗 ----
// 每栋房屋的锚点：屋顶上方 4 m；火苗站在屋顶上，尺寸取房屋水平尺寸
const roofAnchors: THREE.Vector3[] = [];
const roofSize: number[] = [];
for (const p of layout.items) {
  if (p.building === undefined) continue;
  const box = lib[p.asset][p.variant].box;
  const top = (p.elev - terrain.minElev) * terrain.verticalScale + box.max.y * p.scale;
  roofAnchors[p.building] = new THREE.Vector3(p.x, top + 4, p.z);
  roofSize[p.building] = Math.max(6, Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * p.scale * 0.8);
}
bundle.buildings.forEach((b, i) => {
  if (roofAnchors[i]) return;
  const [x, y] = cellXY(meta, b.cell);
  roofAnchors[i] = new THREE.Vector3((x - (meta.width - 1) / 2) * meta.cellSize, (grid.data[b.cell * GRID_CHANNELS] - terrain.minElev) * terrain.verticalScale + 10, (y - (meta.height - 1) / 2) * meta.cellSize);
  roofSize[i] = 8;
});
const homeStatus = new HomeStatus(grid, bundle.buildings, roofAnchors, bundle.communities);
// 紧急联络在地图上的表达：每户一个屋顶标记（所有距离、所有状态）；通话中与需要帮助的房屋再加屏幕空间描边（近景）
const contactMarkers = new ContactMarkers(roofAnchors);
ctx.scene.add(contactMarkers.object);
const contactOutline = new ContactOutline(layout, lib, propMaterial.uniforms, terrain.createDepthMesh(), ctx.camera, () => ctx.renderer.getPixelRatio());
// 放在 Bloom 之前，脉动的轮廓才会发光
bloom.composer.insertPass(contactOutline, 1);
{
  const size = ctx.renderer.getDrawingBufferSize(new THREE.Vector2());
  contactOutline.setSize(size.x, size.y);
}
ctx.onFrame((dt) => {
  contactMarkers.update(dt, ctx.renderer.domElement.clientHeight, ctx.renderer.getPixelRatio());
  contactOutline.update(dt);
});
/** 世界坐标 (x, z) 处的地面高度（显示坐标，已含竖向夸张） */
const groundAt = (x: number, z: number) => {
  const [gx, gy] = worldToGrid(meta, x, z);
  return (sampleElevation(grid, gx, gy) - terrain.minElev) * terrain.verticalScale;
};
const houseFlames = new HouseFlames();
ctx.scene.add(houseFlames.object);
const describeHome = (a: HomeAlert): { title: string; rows: [string, string][] } => {
  const rows: [string, string][] = [];
  if (a.community) rows.push(["Community", a.community]);
  if (a.state === "threat") {
    if (a.etaMin !== undefined) rows.push(["Fire expected", a.etaMin < 5 ? "any minute" : `in about ${formatMinutes(Math.round(a.etaMin / 5) * 5)}`]);
    if (a.distanceM !== undefined) rows.push(["Nearest fire", `${Math.round(a.distanceM / 10) * 10} m upwind`]);
    if (a.chance !== undefined) rows.push(["Chance in 8 hours", `${Math.round(a.chance * 100)}%`]);
  } else if (a.ignitedMin !== undefined) {
    rows.push(["Ignited", `T + ${formatMinutes(a.ignitedMin)}, by embers`]);
  }
  rows.push(["Home hardening", a.hardened ? "Yes (Zone 0)" : "No"]);
  const call = realtime.callStatus(bundle.buildings[a.id].id);
  if (call) rows.push(["Resident call", call.replace(/_/g, " ")]);
  rows.push(["Source", a.state === "threat" && a.chance !== undefined ? "64-run forecast" : "Simulation"]);
  const titles = { burning: "Home on fire", burned: "Home destroyed", threat: "Home threatened", calling: "Calling this home", help: "Resident needs help" };
  const task = dispatch.tasks.get(`call-hh-${bundle.buildings[a.id].id}`);
  if (task) {
    // 紧急联络：只有打码后的住户信息（模拟数据）
    rows.unshift(["Resident", task.household.owner], ["Phone", task.household.phone], ["Address", task.household.address]);
    rows.push(["Call", CALL_LABELS[task.status] ?? task.status]);
  }
  return { title: titles[a.state], rows };
};
const homeAlerts = new HomeAlerts(
  ctx.camera,
  ctx.renderer.domElement,
  {
    onHover: (title, rows, x, y) => shell.showHover(x, y, title, rows),
    onLeave: () => shell.hideHover(),
    onFly: (target, distance) => {
      // 保持当前的观察方向，拉近到指定距离
      const dir = ctx.camera.position.clone().sub(ctx.controls.target).normalize();
      if (dir.y < 0.35) dir.setY(0.35).normalize();
      rig.flyTo(target.clone().addScaledVector(dir, distance), target);
    },
    // 点到通话中或需要帮助的房屋：在联络面板里定位到这户
    onPick: (members) => {
      const m = members.find((a) => a.state === "help") ?? members.find((a) => a.state === "calling");
      if (m) dock.reveal(bundle.buildings[m.id].id);
    },
  },
  describeHome,
  groundAt,
  // 画面焦点：轨道模式下是旋转中心；飞行模式下取视线前方（典型观察距离处）的地面点
  () => {
    if (!fly.enabled) return ctx.controls.target;
    const dir = ctx.camera.getWorldDirection(new THREE.Vector3());
    const h = Math.max(50, ctx.camera.position.y - groundAt(ctx.camera.position.x, ctx.camera.position.z));
    return ctx.camera.position.clone().addScaledVector(dir.setY(0).normalize(), h * 1.6);
  },
  (shown, total) => shell.setAlertCount(shown, total),
);
homeAlerts.setVisible(false);

// ---- 相机：轨道模式（默认）与飞行模式（WASD，类似 Unity 编辑器） ----
const fly = new FlyControls(
  ctx.camera,
  ctx.controls,
  ctx.renderer.domElement,
  groundAt,
  () => {
    const r = ctx.renderer.domElement.getBoundingClientRect();
    return picker.pick(r.left + r.width / 2, r.top + r.height / 2)?.point ?? null;
  },
  (scale) => shell.setFlySpeed(scale),
);
ctx.onFrame((dt) => {
  fly.update(dt);
  if (fly.busy) rig.stop();
});
function refreshHomes() {
  if (!simActive || !sim.lastState) {
    homeStatus.reset();
    homeAlerts.setItems([]);
    houseFlames.set([]);
    return;
  }
  const [ux, uy] = windToGrid(inflow());
  const len = Math.hypot(ux, uy);
  const alerts = homeStatus.update({
    state: sim.lastState,
    viewMinutes: viewMinutes ?? sim.minutes,
    live: viewMinutes === null,
    nowMinutes: sim.minutes,
    stepMinutes: SpreadParams.stepMinutes,
    forecast,
    downwind: len > 0.5 ? [ux / len, uy / len] : null,
    spreadRate: monitor.spreadRate,
    treatMask: sim.treatMask,
    contacts: contactBubbles(),
  });
  homeAlerts.setItems(alerts);
  houseFlames.set(
    alerts
      .filter((a) => a.state === "burning")
      .map((a) => ({ position: a.anchor.clone().setY(a.anchor.y - 4), size: roofSize[a.id], seed: (a.id % 997) / 997 })),
  );
}
ctx.onFrame((dt) => {
  houseFlames.material.uniforms.uTime.value += dt;
  homeAlerts.update();
});

// ---- 紧急联络（后端调度器，net/dispatch.ts）：起火后优先外呼最近的房屋，并给附近所有住户发短信 ----
const CALL_LABELS: Record<string, string> = {
  queued: "Waiting in the call queue",
  ringing: "Ringing",
  talking: "On the call",
  confirmed: "Confirmed safe",
  needs_help: "Asked for help",
  no_answer: "No answer, texted instead",
  failed: "Call failed, texted instead",
};
/** 回放在调度开始后的倍速：每秒 5 分钟，把舞台交给外呼流水线 */
const CONTACT_REPLAY_SPEED = 1;
const buildingIndex = new Map(bundle.buildings.map((b, i) => [b.id, i]));
let contactDirty = true;
let contactStoppedByUser = false;
const dispatch = new DispatchClient(() => (contactDirty = true), meta.width);
// 没有后端（公开网站）：实时数据不可用；回放和紧急联络都在浏览器内运行
if (!API) shell.setLiveAvailable(false);
const dock = new ContactDock({
  onToggle: () => {
    if (dispatch.state === "active" || dispatch.state === "starting") {
      contactStoppedByUser = true;
      void dispatch.stop();
    } else void startContact();
  },
  onFocus: (buildingId) => focusHome(buildingId),
  onHover: (buildingId) => {
    // 面板里悬停的那户在地图上描边
    const i = buildingId === null ? undefined : buildingIndex.get(buildingId);
    if (i === undefined) return terrain.clearHover();
    const cell = bundle.buildings[i].cell;
    terrain.setHover(cell % meta.width, Math.floor(cell / meta.width));
  },
  onRefresh: () => renderContact(),
});

function contactBubbles(): Map<string, "calling" | "help"> {
  const out = new Map<string, "calling" | "help">();
  for (const [id, code] of dispatch.codes) {
    if (code === ContactCode.Calling) out.set(id, "calling");
    else if (code === ContactCode.NeedsHelp) out.set(id, "help");
  }
  return out;
}

// 屋顶标记与描边：每户自己的状态（一户一个标记，不再按格子合并）
const contactByBuilding = new Uint8Array(bundle.buildings.length);
function refreshContactLayer() {
  contactByBuilding.fill(0);
  const outlined: { building: number; kind: OutlineKind }[] = [];
  for (const [id, code] of dispatch.codes) {
    const i = buildingIndex.get(id);
    if (i === undefined) continue;
    contactByBuilding[i] = code;
    if (code === ContactCode.Calling) outlined.push({ building: i, kind: OutlineKind.Calling });
    else if (code === ContactCode.NeedsHelp) outlined.push({ building: i, kind: OutlineKind.NeedsHelp });
  }
  contactMarkers.setCodes(contactByBuilding);
  contactOutline.setItems(outlined);
}

function contactView(t: ContactTask): ContactTaskView {
  const h = t.household;
  const ageS = Math.max(0, Date.now() / 1000 - t.updatedAt);
  return {
    buildingId: h.buildingId,
    owner: h.owner,
    phone: h.phone,
    address: h.address,
    vulnerable: h.vulnerable,
    status: t.status,
    attempt: t.attempt,
    etaMin: t.etaMin,
    ageS,
    elapsedS: ageS * (dispatch.summary?.demoSpeed ?? 1),
  };
}

/** 队列最多列出的条数（面板内滚动） */
const QUEUE_ROWS = 50;

function renderContact() {
  const callQueue = dispatch.queue("call");
  const textQueue = dispatch.queue("text");
  const s = dispatch.summary;
  dock.render({
    state: dispatch.state,
    summary: s,
    lines: dispatch.lines().map((t) => t && contactView(t)),
    help: dispatch.needsHelp().slice(0, 12).map(contactView),
    queue: { call: callQueue.slice(0, QUEUE_ROWS).map(contactView), text: textQueue.slice(0, QUEUE_ROWS).map(contactView) },
    queueTotals: { call: callQueue.length, text: textQueue.length },
  });
  const entry = {
    off: "Off. Starts when a fire is detected",
    starting: "Starting…",
    offline: "Backend offline",
    active: s ? `${s.calling} on the line · ${(s.callQueued + s.textQueued).toLocaleString("en-US")} waiting` : "Live",
  }[dispatch.state];
  shell.setContactEntry(entry, dispatch.state === "active" ? (s?.needsHelp ?? 0) : 0);
}

function focusHome(buildingId: string) {
  const i = buildingIndex.get(buildingId);
  if (i === undefined) return;
  const target = roofAnchors[i];
  const dir = ctx.camera.position.clone().sub(ctx.controls.target).normalize();
  if (dir.y < 0.35) dir.setY(0.35).normalize();
  rig.flyTo(target.clone().addScaledVector(dir, 280), target.clone());
}

/** 接入数据源。回放的第一条事件就是起火，所以紧急联络开启时回放从一开始就用慢速 */
function startFeed(mode: "off" | "live" | "replay") {
  realtime.start(mode, contactStoppedByUser ? undefined : CONTACT_REPLAY_SPEED);
}

async function startContact() {
  contactStoppedByUser = false;
  dock.setOpen(true);
  // 起火时立即给回放减速（不等后端响应），让观众看清外呼队列的推进
  if (realtime.mode === "replay") realtime.setReplaySpeed(CONTACT_REPLAY_SPEED);
  await dispatch.start();
}

// 每 1.5 秒上报一次燃烧格与模型到达时间；面板与状态点在状态变化后最多每 0.25 秒刷新一次
let firePushTimer = 0;
let contactRenderTimer = 0;
ctx.onFrame((dt) => {
  firePushTimer += dt;
  if (firePushTimer >= 1.5 && dispatch.state === "active" && simActive && sim.burningSample.length) {
    firePushTimer = 0;
    const etas: Record<string, number> = {};
    for (const a of homeStatus.alerts) {
      const id = bundle.buildings[a.id].id;
      if (a.state === "burning") etas[id] = 0;
      else if (a.etaMin !== undefined) etas[id] = a.etaMin;
    }
    void dispatch.pushFire(sim.burningSample, etas, simParams.windFrom, simParams.windSpeed);
  }
  contactRenderTimer += dt;
  // 运行中持续刷新：通话计时，以及线路上的结果到时回到空闲
  if (contactRenderTimer >= 0.25 && (contactDirty || dispatch.state === "active")) {
    contactRenderTimer = 0;
    if (contactDirty) refreshContactLayer();
    contactDirty = false;
    renderContact();
  }
});

let pending: PointerEvent | null = null;
ctx.renderer.domElement.addEventListener("pointermove", (e) => (pending = e));
ctx.renderer.domElement.addEventListener("pointerleave", () => {
  pending = null;
  terrain.clearHover();
  shell.hideHover();
});
const describe = (cell: number): string => {
  const cls = grid.data[cell * GRID_CHANNELS + 3];
  const fuel = grid.data[cell * GRID_CHANNELS + 1];
  if (cls === CellClass.Building) return "Neighborhood";
  const named = bundle.fuelModel ? fuelModelName(bundle.fuelModel[cell]) : null;
  if (named) return named;
  if (cls === CellClass.Unburnable) return "Road or stream";
  return fuel > 0.6 ? "Dense chaparral" : fuel > 0.3 ? "Chaparral and grass" : "Dry grass";
};
const fireStateAt = (cell: number): string | null => {
  if (!simActive || !sim.lastState) return null;
  const s = sim.lastState[cell * 4];
  return s > 1.5 ? "Burned" : s > 0.5 ? "Burning" : "Not burned";
};
ctx.onFrame(() => {
  if (!pending) return;
  const e = pending;
  pending = null;
  const hit = picker.pick(e.clientX, e.clientY);
  if (!hit) {
    terrain.clearHover();
    shell.hideHover();
    return;
  }
  terrain.setHover(hit.x, hit.y);
  const i = hit.cell * GRID_CHANNELS;
  const rows: [string, string][] = [
    ["Elevation", `${Math.round(grid.data[i]).toLocaleString("en-US")} m`],
    ["Fuel load", `${Math.round(grid.data[i + 1] * 100)}%`],
    ["Dryness", `${Math.round(grid.data[i + 2] * 100)}%`],
  ];
  const fire = fireStateAt(hit.cell);
  if (fire) rows.push(["Fire", fire]);
  shell.showHover(e.clientX, e.clientY, describe(hit.cell), rows);
});

let downAt: [number, number] | null = null;
ctx.renderer.domElement.addEventListener("pointerdown", (e) => (downAt = [e.clientX, e.clientY]));
ctx.renderer.domElement.addEventListener("pointerup", (e) => {
  // 点火只在 Plan 模式下可用；Respond 模式的火只来自实时数据或回放
  if (!downAt || e.button !== 0 || planner.isPainting || shell.mode === "respond") return;
  const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
  downAt = null;
  if (moved > 4) return;
  const hit = picker.pick(e.clientX, e.clientY);
  if (!hit) return;
  activateSim();
  sim.igniteDisc(hit.x, hit.y, 1.5);
  testIgnitions.push(hit.cell);
  monitor.log(sim.minutes, `Ignition at ${Math.round(grid.data[hit.cell * GRID_CHANNELS]).toLocaleString("en-US")} m, ${describe(hit.cell).toLowerCase()}`, "watch");
  simParams.running = true;
  shell.setRunning(true);
});

// ---- 火头推进速度：烟雾的漂移节奏跟着它走 ----
// 把燃烧格投影到来流的下风方向，取第 98 百分位（排除零星飞火）作为火头位置，
// 用两次读回之间的真实时间求推进速度（米 / 秒），指数平滑。暂停或火在后退时衰减到 0。
let headPrev: number | null = null;
let headTime = 0;
let frontSpeed = 0;
function updateFrontPace(now = performance.now() / 1000, running = simParams.running) {
  const [ux, uy] = windToGrid(inflow());
  const len = Math.hypot(ux, uy);
  const cells = sim.burningSample;
  if (!cells.length || len < 1e-3) {
    headPrev = null;
    frontSpeed *= 0.5;
  } else {
    const proj = cells.map((c) => ((c % meta.width) * ux + Math.floor(c / meta.width) * uy) / len).sort((a, b) => a - b);
    const head = proj[Math.floor((proj.length - 1) * 0.98)] * meta.cellSize;
    if (headPrev !== null && now > headTime) {
      const v = Math.max(0, (head - headPrev) / (now - headTime));
      frontSpeed = running ? 0.7 * frontSpeed + 0.3 * v : frontSpeed * 0.5;
    }
    headPrev = head;
  }
  headTime = now;
  smoke.setPace(frontSpeed, simParams.windSpeed);
}

// ---- 每帧 ----
let checkLine = ""; // CPU 对照结果（调试 HUD）
let uiTimer = 0;
let readTimer = 0;
let stepAcc = 0;
let sampleSeen = -1;
ctx.onFrame((dt) => {
  propMaterial.uniforms.uTime.value += dt;
  terrain.uniforms.uTime.value = propMaterial.uniforms.uTime.value;
  terrain.uniforms.uWaterTime.value = propMaterial.uniforms.uTime.value;
  if (night !== nightTarget) {
    night = nightTarget > night ? Math.min(nightTarget, night + dt / 1.2) : Math.max(nightTarget, night - dt / 1.2);
    applyNight(night);
  }
  if (simActive && simParams.running) {
    // 回放中模拟跟着回放时钟走，火点和风才会落在正确的模拟时刻；其余情况按速度档推进
    const replayAt = realtime.replayMinutes();
    if (replayAt !== null) {
      const n = Math.min(8, Math.floor((replayAt - sim.minutes) / SpreadParams.stepMinutes));
      if (n > 0) sim.advance(n);
    } else {
      stepAcc += dt * simParams.stepsPerSecond;
      const n = Math.min(8, Math.floor(stepAcc));
      stepAcc -= n;
      if (n > 0) sim.advance(n);
    }
  }
  // 每步之后状态纹理会换成另一张，所以每帧都重新指向当前那张
  propMaterial.uniforms.uState.value = sim.texture;
  terrain.uniforms.uState.value = sim.texture;
  const shownMinutes = viewMinutes ?? sim.minutes;
  terrain.uniforms.uSimMinutes.value = shownMinutes;
  propMaterial.uniforms.uViewMinutes.value = shownMinutes;
  propMaterial.uniforms.uViewLive.value = viewMinutes === null;
  propMaterial.uniforms.uStepMinutes.value = SpreadParams.stepMinutes;
  terrain.uniforms.uStepMinutes.value = SpreadParams.stepMinutes;
  props.update(ctx.camera);
  if (smokeEnabled) smoke.update(dt, propMaterial.uniforms.uTime.value);

  // 运行中每 0.12 秒异步读回一次（约 2–3 步），烟源紧跟火线；暂停时放慢到 0.5 秒
  readTimer += dt;
  if (simActive && readTimer >= (simParams.running ? 0.12 : 0.5)) {
    readTimer = 0;
    sim.stats();
  }
  if (simActive && sim.sampleVersion !== sampleSeen && sim.lastState) {
    sampleSeen = sim.sampleVersion;
    smoke.setSources(sim.burningSample, sim.burningWeight);
    updateFrontPace();
    monitor.update(sim.lastState, sim.burningSample, sim.lastStatsMinutes);
  }
  uiTimer += dt;
  if (uiTimer < 0.5) return;
  uiTimer = 0;
  refreshPanels();
});

function refreshPanels() {
  refreshHomes();
  shell.setElapsed(simActive ? sim.minutes : null);
  shell.setViewAvailable(simActive && (sim.burningSample.length > 0 || testIgnitions.length > 0));
  shell.setTimeline(
    simActive ? sim.minutes : null,
    viewMinutes ?? sim.minutes,
    viewMinutes === null,
    [...monitor.events.map((e) => ({ minutes: e.minutes, level: e.level })), ...realtime.ticks()],
  );
  const reached = monitor.communities.filter((c) => c.level === "reached").length;
  const fs = simActive ? sim.stats() : null;
  // 预报：有火时可以运行；显示中且模拟已推进一小时以上时自动重算
  const fireNow = !!fs && fs.burningCells > 0;
  // 紧急联络：Respond 中出现火情时自动启动（用户手动停止后不再自动启动，直到重置）
  if (fireNow && shell.mode === "respond" && dispatch.state === "off" && !contactStoppedByUser) void startContact();
  if (forecast && forecastShown && fireNow && viewMinutes === null && sim.minutes - forecast.startMinutes >= FORECAST_REFRESH_MIN) runForecast();
  else shell.setForecast(fireNow, null, outlook);
  shell.setPlanFire(
    fs
      ? [
          ["Elapsed", formatMinutes(sim.minutes)],
          ["Burned area", `${Math.round(fs.burnedAreaHa).toLocaleString("en-US")} ha`],
          ["Homes affected", `${monitor.homesAffected.toLocaleString("en-US")} of ${monitor.totalHomes.toLocaleString("en-US")}`],
          ["Communities reached", `${reached} of ${monitor.communities.length}`],
          ["Wind", `${compassName(simParams.windFrom)} ${simParams.windSpeed} m/s, ${simParams.windMode === "terrain" ? "terrain-adjusted" : "uniform"}`],
        ]
      : null,
  );
  const feedRows: [string, string][] = [];
  if (realtime.mode !== "off") {
    const ag = realtime.agreement();
    feedRows.push(["Satellite hotspots", realtime.hotspotsReceived.toLocaleString("en-US")]);
    if (ag) {
      feedRows.push(["Satellite passes", String(realtime.passes.length)]);
      feedRows.push(["Pixels the model had reached", `${ag.reached} of ${ag.pixels} (${Math.round((ag.reached / ag.pixels) * 100)}%)`]);
      feedRows.push(["Model fire near a detection", `${Math.round(ag.confirmedShare * 100)}%`]);
    }
    if (realtime.mode === "replay" && damageCells.length) {
      let reached = 0;
      if (sim.lastState) for (const c of damageCells) if (sim.lastState[c * 4] > 0.5) reached++;
      feedRows.push(["Reported damage area, buildings the model reached", `${reached} of ${damageCells.length}`]);
    }
    if (realtime.perimeter) {
      feedRows.push([realtime.perimeterLabel, `${Math.round(realtime.perimeterHa).toLocaleString("en-US")} ha`]);
      const iou = realtime.perimeterMatch(sim.lastState);
      if (iou !== null) feedRows.push(["Overlap with simulation", `${Math.round(iou * 100)}%`]);
    }
  }
  shell.setFeed(realtime.mode, realtime.status, feedRows, realtime.bundledReplay);
  shell.setRespond(simActive ? monitor.closest() : null, monitor.communities, { affected: monitor.homesAffected, total: monitor.totalHomes }, monitor.events);
  if (debug) {
    const st = props.stats();
    document.getElementById("hud")!.textContent = [
      `Data: ${bundle.source} ${meta.width}×${meta.height} @ ${meta.cellSize} m`,
      `Wind: ${simParams.windSpeed} m/s from ${simParams.windFrom}°, ${windSource()}`,
      `Visible: ${st.instances} instances, ${(st.triangles / 1e6).toFixed(2)} M triangles, ${st.drawCalls} draw calls`,
      fs ? `Fire: burning ${fs.burningCells} cells, affected ${fs.burnedAreaHa.toFixed(0)} ha, building cells ${fs.buildingCellsBurned}` : "Fire: none",
      checkLine,
    ]
      .filter(Boolean)
      .join("\n");
  }
}
refreshPanels();

// ---- 调试面板（?debug） ----
/** 固定点火点与种子，GPU 与 CPU 各跑 steps 步，比较燃烧面积与火场重合度（IoU） */
function runCpuCheck(steps = 80) {
  activateSim();
  resetSim();
  sim.seed = simParams.seed;
  sim.spotting = simParams.spotting;
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
  const gpu = sim.readState();
  const tGpu = performance.now() - t0;
  const t1 = performance.now();
  const cpu = new CpuFireSim(grid, currentWind, { seed: simParams.seed, spotting: simParams.spotting });
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

/** P3 benchmark：同一个起始火场，GPU 一次跑 64 个成员，对比 CPU 参考实现逐个串行运行（取 cpuRuns 次外推到 64） */
function runBench(cpuRuns = 4) {
  if (!simActive) return null;
  const state = sim.statsSync() && sim.lastState!;
  ensemble.run(sim.texture, sim.minutes, currentWind, sim.treatMask); // 预热：编译 shader、分配显存
  const gpu = [0, 1, 2].map(() => ensemble.run(sim.texture, sim.minutes, currentWind, sim.treatMask).ms).sort((a, b) => a - b)[1];
  const g = ensemble.grid.meta;
  const cells = new Set<number>();
  for (let c = 0; c < meta.width * meta.height; c++) {
    const r = state[c * 4];
    if (r > 0.5 && r < 1.5) cells.add(Math.floor(Math.floor(c / meta.width) / ENSEMBLE_FACTOR) * g.width + Math.floor((c % meta.width) / ENSEMBLE_FACTOR));
  }
  const steps = forecast?.steps ?? 48;
  const t0 = performance.now();
  for (let k = 0; k < cpuRuns; k++) {
    const cpu = new CpuFireSim(ensemble.grid, currentWind, { seed: k + 1, spotting: true });
    cpu.ignite([...cells]);
    cpu.advance(steps);
  }
  const cpuPerRun = (performance.now() - t0) / cpuRuns;
  const result = { members: ENSEMBLE_MEMBERS, steps, grid: `${g.width}x${g.height}`, gpuMs: Math.round(gpu), cpuMsPerRun: Math.round(cpuPerRun), cpuMsFor64: Math.round(cpuPerRun * ENSEMBLE_MEMBERS), speedup: +((cpuPerRun * ENSEMBLE_MEMBERS) / gpu).toFixed(1) };
  console.info("[bench]", result);
  return result;
}

if (debug) {
  const gui = new GUI({ title: "Debug" });
  const params = { verticalScale: terrain.verticalScale, contours: false, contourStep: 50 };
  const fTerrain = gui.addFolder("Terrain");
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
  fTerrain.add(params, "contourStep", 10, 200, 10).name("Contour step (m)").onChange((v: number) => (terrain.uniforms.uContourStep.value = v));
  fTerrain.add(terrain.mesh.material, "wireframe").name("Wireframe");
  const sceneParams = { models: true, wires: true, lodScale: 1, sway: 1 };
  const fScene = gui.addFolder("Scene objects");
  fScene.add(sceneParams, "models").name("Trees and buildings").onChange((v: boolean) => (props.object.visible = v));
  fScene.add(sceneParams, "wires").name("Power lines").onChange((v: boolean) => (wires.object.visible = v));
  fScene.add(sceneParams, "lodScale", 0.25, 3, 0.05).name("Detail distance").onChange((v: number) => {
    props.lodScale = v;
    props.invalidate();
  });
  fScene.add(sceneParams, "sway", 0, 3, 0.1).name("Wind sway").onChange((v: number) => (propMaterial.uniforms.uSway.value = v));
  const fSim = gui.addFolder("Fire simulation");
  fSim.add(simParams, "spotting").name("Spotting (embers)").onChange((v: boolean) => (sim.spotting = v));
  fSim.add(simParams, "seed", 1, 999, 1).name("Random seed").onChange((v: number) => (sim.seed = v));
  fSim.add({ check: () => runCpuCheck() }, "check").name("Check against CPU");
  fSim.add({ bench: () => runBench() }, "bench").name("Benchmark forecast (GPU vs CPU)");
  const smokeParams = { rate: smoke.rate, opacity: smoke.material.uniforms.uOpacity.value as number };
  const fAlerts = gui.addFolder("Home alerts");
  fAlerts.add(homeAlerts, "maxVisible", 5, 160, 1).name("Max bubbles");
  fAlerts.add(homeAlerts, "rangeFactor", 1, 10, 0.5).name("Range × camera height");
  fAlerts.add(homeAlerts, "minRange", 300, 5000, 100).name("Min range (m)");
  const fSmoke = gui.addFolder("Smoke");
  fSmoke.add(smokeParams, "rate", 20, 600, 10).name("Particles per second").onChange((v: number) => (smoke.rate = v));
  fSmoke.add(smokeParams, "opacity", 0.05, 0.8, 0.01).name("Opacity").onChange((v: number) => (smoke.material.uniforms.uOpacity.value = v));
}

// ---- 调试 URL 参数 ----
// ?cam=x,y,z,tx,ty,tz 相机；?mode=respond 模式；?windmode=uniform|terrain；?wind=速度,来向；
// ?ignite=x,y&steps=N 点火并推进；?cpucheck=N CPU 对照；?burn=半径 燃烧预览
// ?view=overview|fire|community 加载后切换到相机预设（直接跳转，便于截图）
const camQ = q.get("cam")?.split(",").map(Number);
if (camQ?.length === 6 && camQ.every(Number.isFinite)) {
  ctx.camera.position.set(camQ[0], camQ[1], camQ[2]);
  ctx.controls.target.set(camQ[3], camQ[4], camQ[5]);
  ctx.controls.update();
}
if (q.has("burn")) {
  const c = new THREE.Vector2(0, -meta.height * meta.cellSize * 0.18);
  propMaterial.uniforms.uBurnOn.value = true;
  terrain.uniforms.uBurnOn.value = true;
  (propMaterial.uniforms.uBurn.value as THREE.Vector4).set(c.x, c.y, Number(q.get("burn")) || 1500, 150);
}
const modeQ = q.get("windmode");
if (modeQ === "uniform" || modeQ === "terrain") {
  simParams.windMode = modeQ;
  shell.setWindModel(modeQ);
  applyWind();
}
const windQ = q.get("wind")?.split(",").map(Number);
if (windQ?.length === 2 && windQ.every(Number.isFinite)) {
  [simParams.windSpeed, simParams.windFrom] = windQ;
  shell.setWind(simParams.windFrom, simParams.windSpeed);
  applyWind();
}
const igniteQ = q.get("ignite")?.split(",").map(Number);
if (igniteQ?.length === 2 && igniteQ.every(Number.isFinite)) {
  activateSim();
  sim.igniteDisc(igniteQ[0], igniteQ[1], 1.5);
  monitor.log(0, "Ignition placed", "watch");
  // 分几段推进并逐段监测，让事件流和推进速度估计有历史可用
  const steps = Number(q.get("steps")) || 0;
  for (let done = 0; done < steps; ) {
    const n = Math.min(10, steps - done);
    sim.advance(n);
    done += n;
    sim.statsSync();
    monitor.update(sim.lastState!, sim.burningSample, sim.minutes);
    updateFrontPace(done / simParams.stepsPerSecond, true);
  }
  sim.statsSync();
  sampleSeen = sim.sampleVersion;
  smoke.setSources(sim.burningSample, sim.burningWeight);
  smoke.warmup(smoke.material.uniforms.uLife.value, 0);
  refreshPanels();
}
// ?paint=x0,y0,x1,y1,类型[,半径] 画一条处理线；?suggest 加载后生成并对比方案
const paintQ = q.get("paint")?.split(",");
if (paintQ && paintQ.length >= 5) {
  const [x0, y0, x1, y1] = paintQ.slice(0, 4).map(Number);
  planner.yours.stroke(x0, y0, x1, y1, Number(paintQ[5]) || 3, paintQ[4] as "break");
  planner.commitEdit();
}
if (q.has("suggest")) planner.suggest();
const viewQ = q.get("view");
if (viewQ === "overview" || viewQ === "fire" || viewQ === "community") {
  flyToView(viewQ);
  rig.update(10);
}
if (q.has("bloom") && q.get("bloom") === "0") bloom.enabled = false;
if (q.has("cpucheck")) runCpuCheck(Number(q.get("cpucheck")) || 80);
// ?forecast 加载后运行一次集合预报；?bench 运行 GPU / CPU 对比（都需要先有火，例如配合 ?ignite）
if (q.has("forecast")) runForecast();
if (q.has("bench")) Object.assign(window, { benchResult: runBench(Number(q.get("bench")) || 4) });
const feedQ = q.get("feed");
if (feedQ === "live" || feedQ === "replay") startFeed(feedQ);
const modeParam = q.get("mode");
if (modeParam === "respond" || modeParam === "plan") {
  setMode(modeParam);
  night = nightTarget;
  applyNight(night);
}

// 调试用
Object.assign(window, { bundle, ctx, terrain, props, layout, sim, smoke, monitor, shell, runCpuCheck, realtime, planner, ensemble, runForecast, runBench, getForecast: () => ({ forecast, outlook }), homeStatus, homeAlerts, houseFlames, markers, fly, dispatch, contactMarkers, contactOutline });
