// OSM 路网（可选文件 roads.json，数据管线 wildfire-roads 生成），只用于显示，模拟不读取。
// 光栅化成一张高分辨率贴图（4096² 时每像素约 3 m）铺在地形上，道路随地形起伏，没有贴合问题。
// 三个通道用 "lighter" 叠加，互不覆盖：
//   R 描边（比路面宽，shader 中画成深色路缘）
//   G 所有路面（土路以半强度虚线画入）
//   B 主干道与高速路面（shader 中用更醒目的颜色）

import * as THREE from "three";

export interface RoadData {
  classes: string[];
  /** 每条路：[类别, x0, y0, x1, y1, ...]，坐标为网格格数（从西北角起，x 向东，y 向南） */
  roads: number[][];
}

/** 各类路面宽度（米）：高速、主干道、次干道、街道、土路 */
const WIDTH_M = [24, 15, 11, 8, 4];
const CASING_M = 1.5;

export async function loadRoads(): Promise<RoadData | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/roads.json`);
    return res.ok ? ((await res.json()) as RoadData) : null;
  } catch {
    return null;
  }
}

export function rasterizeRoads(data: RoadData, gridWidth: number, cellSize: number, size: number): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, size, size);
  g.globalCompositeOperation = "lighter";
  g.lineCap = "round";
  g.lineJoin = "round";
  const px = size / gridWidth; // 每个网格格对应的像素数
  const pxPerM = px / cellSize;
  // 小路先画，大路后画；同一通道内重叠只会饱和，不会互相覆盖
  const order = data.roads.map((_, i) => i).sort((a, b) => data.roads[b][0] - data.roads[a][0]);
  const stroke = (road: number[], width: number, color: string, dash: number[] = []) => {
    g.strokeStyle = color;
    g.lineWidth = Math.max(1, width * pxPerM);
    g.setLineDash(dash.map((d) => d * pxPerM));
    g.beginPath();
    g.moveTo(road[1] * px, road[2] * px);
    for (let k = 3; k < road.length; k += 2) g.lineTo(road[k] * px, road[k + 1] * px);
    g.stroke();
  };
  for (const i of order) {
    const road = data.roads[i];
    const cls = road[0];
    const w = WIDTH_M[cls] ?? 6;
    if (cls === 4) {
      stroke(road, w, "rgb(0,150,0)", [14, 10]);
      continue;
    }
    stroke(road, w + 2 * CASING_M, "rgb(255,0,0)");
    stroke(road, w, "rgb(0,255,0)");
    if (cls <= 1) stroke(road, w, "rgb(0,0,255)");
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}
