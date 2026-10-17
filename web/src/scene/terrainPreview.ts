// P0 临时地形预览：CPU 位移 + 顶点色，用于检查网格数据。P1 由 terrain.ts 的 shader 版本替换。

import * as THREE from "three";
import { CellClass, GRID_CHANNELS, type Grid } from "@core";

export function createTerrainPreview(grid: Grid, verticalScale = 1.5): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial> {
  const { width, height, cellSize } = grid.meta;
  const geo = new THREE.PlaneGeometry(width * cellSize, height * cellSize, width - 1, height - 1);
  // 旋转后：顶点行 j 对应格子 y = j（由北向南），x 向东，世界 z 向南
  geo.rotateX(-Math.PI / 2);

  let minElev = Infinity;
  for (let c = 0; c < width * height; c++) minElev = Math.min(minElev, grid.data[c * GRID_CHANNELS]);

  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(width * height * 3);
  const low = new THREE.Color(0x8a7f5a);
  const veg = new THREE.Color(0x2f5d2a);
  const dry = new THREE.Color(0xb59a4a);
  const building = new THREE.Color(0xd8d8d8);
  const unburnable = new THREE.Color(0x4a5560);
  const tmp = new THREE.Color();

  for (let c = 0; c < width * height; c++) {
    const i = c * GRID_CHANNELS;
    pos.setY(c, (grid.data[i] - minElev) * verticalScale);
    const cls = grid.data[i + 3];
    if (cls === CellClass.Building) tmp.copy(building);
    else if (cls === CellClass.Unburnable) tmp.copy(unburnable);
    else tmp.copy(low).lerp(veg, grid.data[i + 1]).lerp(dry, grid.data[i + 2] * 0.35);
    tmp.toArray(colors, c * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
}
