import "./style.css";
import GUI from "lil-gui";
import { CellClass, GRID_CHANNELS, cellToLonLat } from "@core";
import { loadGrid } from "./data/loadGrid";
import { createScene } from "./scene/setup";
import { createTerrainPreview } from "./scene/terrainPreview";

const bundle = await loadGrid();
const { grid } = bundle;
const ctx = createScene(document.getElementById("app")!);

const terrain = createTerrainPreview(grid);
ctx.scene.add(terrain);

let buildingCells = 0;
for (let c = 0; c < grid.meta.width * grid.meta.height; c++) {
  if (grid.data[c * GRID_CHANNELS + 3] === CellClass.Building) buildingCells++;
}
const [lon, lat] = cellToLonLat(grid.meta, (grid.meta.height / 2) * grid.meta.width + grid.meta.width / 2);
document.getElementById("hud")!.textContent = [
  `数据：${bundle.source === "mock" ? "合成网格" : "真实网格"}  ${grid.meta.width}×${grid.meta.height} @ ${grid.meta.cellSize} m`,
  `中心：${lat.toFixed(4)}, ${lon.toFixed(4)}`,
  `建筑格：${buildingCells}  建筑：${bundle.buildings.length}  社区：${bundle.communities.length}`,
].join("\n");

const gui = new GUI({ title: "WildfireTwinLA" });
gui.add(terrain.material, "wireframe").name("线框");

// 调试用
Object.assign(window, { bundle, ctx });
