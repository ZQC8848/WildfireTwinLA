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
fScene.add(sceneParams, "night", 0, 1, 0.01).name("Night").onChange((v: number) => (propMaterial.uniforms.uNight.value = v));

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

let hudTimer = 0;
ctx.onFrame((dt) => {
  propMaterial.uniforms.uTime.value += dt;
  terrain.uniforms.uTime.value = propMaterial.uniforms.uTime.value;
  if (sceneParams.burnPreview) (propMaterial.uniforms.uBurn.value as THREE.Vector4).z += sceneParams.burnSpeed * dt;
  props.update(ctx.camera);
  hudTimer += dt;
  if (hudTimer > 0.5) {
    hudTimer = 0;
    const st = props.stats();
    document.getElementById("hud")!.textContent =
      `${hudBase}\nVisible: ${st.instances} instances, ${(st.triangles / 1e6).toFixed(2)} M triangles, ${st.drawCalls} draw calls`;
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

// 调试用
Object.assign(window, { bundle, ctx, terrain, props, layout });
