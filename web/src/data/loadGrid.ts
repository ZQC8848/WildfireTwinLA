// 读取 Tia 导出的网格数据；不存在或格式不对时回退到合成网格。

import { GRID_CHANNELS, type Building, type Community, type GridMeta } from "@core";
import { createMockGrid, type GridBundle } from "./mockGrid";

const BASE = `${import.meta.env.BASE_URL}data/`;

async function fetchJSON<T>(name: string): Promise<T> {
  const res = await fetch(BASE + name);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/** 约定的轮廓是 [lon, lat] 数组；也接受 GeoJSON Polygon / MultiPolygon（取外环，多面取第一个） */
function normalizeFootprint(b: Building): Building {
  const p = b.polygonLonLat as unknown;
  if (!p || Array.isArray(p)) return b;
  const g = p as { type?: string; coordinates?: unknown };
  const ring = g.type === "Polygon" ? (g.coordinates as [number, number][][])?.[0] : g.type === "MultiPolygon" ? (g.coordinates as [number, number][][][])?.[0]?.[0] : undefined;
  return { ...b, polygonLonLat: ring?.map(([lon, lat]) => [lon, lat] as [number, number]) };
}

/** 可选的 fuel-model.bin（每格 1 字节 FBFM40 代码）；不存在或长度不对时返回 undefined */
async function loadFuelModel(cells: number): Promise<Uint8Array | undefined> {
  try {
    const res = await fetch(BASE + "fuel-model.bin");
    if (!res.ok) return undefined;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.length === cells ? bytes : undefined;
  } catch {
    return undefined;
  }
}

export async function loadGrid(): Promise<GridBundle> {
  const forceMock = new URLSearchParams(location.search).has("mock");
  if (!forceMock) {
    try {
      const meta = await fetchJSON<GridMeta>("grid.json");
      const res = await fetch(BASE + "grid.bin");
      if (!res.ok) throw new Error(`grid.bin: HTTP ${res.status}`);
      const data = new Float32Array(await res.arrayBuffer());
      const expected = meta.width * meta.height * GRID_CHANNELS;
      if (data.length !== expected) throw new Error(`grid.bin: length ${data.length}, expected ${expected}`);
      const [buildings, communities, fuelModel] = await Promise.all([
        fetchJSON<Building[]>("buildings.json").catch(() => []),
        fetchJSON<Community[]>("communities.json").catch(() => []),
        loadFuelModel(meta.width * meta.height),
      ]);
      return { grid: { meta, data }, buildings: buildings.map(normalizeFootprint), communities, source: "real", fuelModel };
    } catch (err) {
      console.info("[loadGrid] Falling back to synthetic grid:", (err as Error).message);
    }
  }
  return createMockGrid();
}
