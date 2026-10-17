// 读取 Tia 导出的网格数据；不存在或格式不对时回退到合成网格。

import { GRID_CHANNELS, type Building, type Community, type GridMeta } from "@core";
import { createMockGrid, type GridBundle } from "./mockGrid";

const BASE = `${import.meta.env.BASE_URL}data/`;

async function fetchJSON<T>(name: string): Promise<T> {
  const res = await fetch(BASE + name);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
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
      const [buildings, communities] = await Promise.all([
        fetchJSON<Building[]>("buildings.json").catch(() => []),
        fetchJSON<Community[]>("communities.json").catch(() => []),
      ]);
      return { grid: { meta, data }, buildings, communities, source: "real" };
    } catch (err) {
      console.info("[loadGrid] Falling back to synthetic grid:", (err as Error).message);
    }
  }
  return createMockGrid();
}
