// 读取 tools/assets 导出的低多边形 GLB：每个资产若干变体，每个变体 LOD0 / LOD1 两个网格。

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export const ASSET_NAMES = [
  "oak-coast-live",
  "oak-coast-live-young",
  "shrub-chamise",
  "shrub-manzanita",
  "shrub-scrub-oak",
  "pine-coulter",
  "fir-bigcone-douglas",
  "palm-mexican-fan",
  "palm-canary",
  "eucalyptus",
  "house-ranch",
  "house-craftsman",
  "house-spanish",
  "house-modern",
  "apartment-small",
  "fire-station",
  "transmission-tower",
  "utility-pole",
] as const;
export type AssetName = (typeof ASSET_NAMES)[number];

export interface AssetVariant {
  /** [LOD0, LOD1]；属性已改名为 position / normal / aColor / aPart，避免与 three 内置的 color 声明冲突 */
  lods: [THREE.BufferGeometry, THREE.BufferGeometry];
  /** LOD0 的包围盒（米，Y 向上） */
  box: THREE.Box3;
  /** 导线挂点（输电塔、配电杆） */
  wirePoints?: THREE.Vector3[];
}

export type AssetLibrary = Record<AssetName, AssetVariant[]>;

function prepare(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", src.getAttribute("position"));
  geo.setAttribute("normal", src.getAttribute("normal"));
  geo.setAttribute("aColor", src.getAttribute("color"));
  geo.setAttribute("aPart", src.getAttribute("_part"));
  if (src.index) geo.setIndex(src.index);
  geo.computeBoundingBox();
  return geo;
}

export async function loadAssets(): Promise<AssetLibrary> {
  const loader = new GLTFLoader();
  const base = `${import.meta.env.BASE_URL}models/`;
  const entries = await Promise.all(
    ASSET_NAMES.map(async (name) => {
      const gltf = await loader.loadAsync(`${base}${name}.glb`);
      const found = new Map<number, Partial<{ lod0: THREE.Mesh; lod1: THREE.Mesh }>>();
      gltf.scene.traverse((o) => {
        const m = /_v(\d+)_LOD([01])$/.exec(o.name);
        if (!m || !(o as THREE.Mesh).isMesh) return;
        const v = Number(m[1]);
        const slot = found.get(v) ?? {};
        slot[m[2] === "0" ? "lod0" : "lod1"] = o as THREE.Mesh;
        found.set(v, slot);
      });
      const variants: AssetVariant[] = [...found.keys()]
        .sort((a, b) => a - b)
        .map((v) => {
          const { lod0, lod1 } = found.get(v)!;
          if (!lod0 || !lod1) throw new Error(`${name}: variant ${v} is missing a LOD`);
          const g0 = prepare(lod0.geometry);
          const wire = lod0.userData.wire_points as number[][] | undefined;
          return {
            lods: [g0, prepare(lod1.geometry)],
            box: g0.boundingBox!.clone(),
            wirePoints: wire?.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
          };
        });
      return [name, variants] as const;
    }),
  );
  return Object.fromEntries(entries) as AssetLibrary;
}
