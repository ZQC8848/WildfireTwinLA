import "./style.css";
import * as THREE from "three";
import GUI from "lil-gui";
import { CellClass, GRID_CHANNELS, cellToLonLat } from "@core";
import { loadGrid } from "./data/loadGrid";
import { TerrainPicker } from "./interact/picking";
import { LAYERS, type LayerId } from "./scene/layers";
import { createScene } from "./scene/setup";
import { Terrain } from "./scene/terrain";
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

let buildingCells = 0;
for (let c = 0; c < meta.width * meta.height; c++) {
  if (grid.data[c * GRID_CHANNELS + 3] === CellClass.Building) buildingCells++;
}
document.getElementById("hud")!.textContent = [
  `Data: ${bundle.source === "mock" ? "synthetic grid" : "real grid"}  ${meta.width}×${meta.height} @ ${meta.cellSize} m`,
  `Elevation: ${Math.round(terrain.minElev)}–${Math.round(terrain.maxElev)} m`,
  `Building cells: ${buildingCells}  Buildings: ${bundle.buildings.length}  Communities: ${bundle.communities.length}`,
].join("\n");

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
  .onChange((v: number) => (terrain.verticalScale = v));
fTerrain.add(params, "contours").name("Contours").onChange((v: boolean) => (terrain.uniforms.uContours.value = v));
fTerrain
  .add(params, "contourStep", 10, 200, 10)
  .name("Contour step (m)")
  .onChange((v: number) => (terrain.uniforms.uContourStep.value = v));
fTerrain.add(terrain.mesh.material, "wireframe").name("Wireframe");

// 调试用
Object.assign(window, { bundle, ctx, terrain });
