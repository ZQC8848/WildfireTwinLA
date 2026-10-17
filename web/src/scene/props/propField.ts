// 植被、建筑、电力设施的实例化渲染与按距离分块 LOD。
//
// 每个"资产 × 变体"的实例按 32×32 格的分块排好序；相机移动后，逐块判断距离与视锥，
// 把落在 LOD0 / LOD1 距离内的块整段拷贝进对应的实例缓冲。每个"资产 × 变体 × LOD"一次 draw call。

import * as THREE from "three";
import type { GridMeta } from "@core";
import type { AssetLibrary, AssetName } from "./assets";
import type { Layout, Placement } from "./placement";

const CHUNK = 32;

interface Drawable {
  mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  offset: THREE.InstancedBufferAttribute;
  params: THREE.InstancedBufferAttribute;
}

interface Group {
  asset: AssetName;
  /** 按分块排序后的实例数据 */
  offset: Float32Array;
  params: Float32Array;
  /** chunkStart[k]..chunkStart[k+1] 是第 k 块的实例区间 */
  chunkStart: Int32Array;
  lods: [Drawable, Drawable];
  /** LOD0 / LOD1 的最大距离（米，未乘全局倍率） */
  dist: [number, number];
}

export class PropField {
  readonly object = new THREE.Group();
  readonly count: number;
  /** 全局 LOD 距离倍率（调试面板） */
  lodScale = 1;
  private groups: Group[] = [];
  private chunkCenter: THREE.Vector3[] = [];
  private chunkElev: Float32Array;
  private chunkRadius: number;
  private lastCam = new THREE.Vector3(Infinity, 0, 0);
  private lastQuat = new THREE.Quaternion();
  private frustum = new THREE.Frustum();
  private projView = new THREE.Matrix4();
  private sphere = new THREE.Sphere();
  private dirty = true;

  constructor(
    layout: Layout,
    lib: AssetLibrary,
    meta: GridMeta,
    readonly material: THREE.ShaderMaterial,
  ) {
    const { width: W, height: H, cellSize: S } = meta;
    const cw = Math.ceil(W / CHUNK);
    const ch = Math.ceil(H / CHUNK);
    const nChunks = cw * ch;
    this.chunkRadius = (CHUNK * S) / Math.SQRT2;
    const chunkOf = (p: Placement) => {
      const gx = Math.min(W - 1, Math.max(0, Math.floor(p.x / S + (W - 1) / 2)));
      const gy = Math.min(H - 1, Math.max(0, Math.floor(p.z / S + (H - 1) / 2)));
      return Math.floor(gy / CHUNK) * cw + Math.floor(gx / CHUNK);
    };

    // 分块中心与平均高程
    const elevSum = new Float32Array(nChunks);
    const elevN = new Float32Array(nChunks);
    for (const p of layout.items) {
      const k = chunkOf(p);
      elevSum[k] += p.elev;
      elevN[k]++;
    }
    this.chunkElev = new Float32Array(nChunks);
    for (let k = 0; k < nChunks; k++) {
      this.chunkElev[k] = elevN[k] ? elevSum[k] / elevN[k] : 0;
      const cx = ((k % cw) * CHUNK + CHUNK / 2 - (W - 1) / 2) * S;
      const cz = (Math.floor(k / cw) * CHUNK + CHUNK / 2 - (H - 1) / 2) * S;
      this.chunkCenter.push(new THREE.Vector3(cx, 0, cz));
    }

    const byKey = new Map<string, Placement[]>();
    for (const p of layout.items) {
      const key = `${p.asset}|${p.variant}`;
      let list = byKey.get(key);
      if (!list) byKey.set(key, (list = []));
      list.push(p);
    }
    this.count = layout.items.length;

    for (const [key, list] of byKey) {
      const [asset, v] = key.split("|") as [AssetName, string];
      const variant = lib[asset][Number(v)];
      const n = list.length;
      const chunks = list.map(chunkOf);
      const order = list.map((_, i) => i).sort((a, b) => chunks[a] - chunks[b]);
      const offset = new Float32Array(n * 4);
      const params = new Float32Array(n * 2);
      const chunkStart = new Int32Array(nChunks + 1);
      order.forEach((idx, j) => {
        const p = list[idx];
        offset.set([p.x, p.elev, p.z, p.rot], j * 4);
        params.set([p.scale, p.cell], j * 2);
        chunkStart[chunks[idx] + 1]++;
      });
      for (let k = 0; k < nChunks; k++) chunkStart[k + 1] += chunkStart[k];

      const height = variant.box.max.y;
      const lods = variant.lods.map((src) => {
        const geo = new THREE.InstancedBufferGeometry();
        for (const name of ["position", "normal", "aColor", "aPart"]) geo.setAttribute(name, src.getAttribute(name));
        if (src.index) geo.setIndex(src.index);
        const off = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
        const par = new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2).setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute("aOffset", off);
        geo.setAttribute("aParams", par);
        geo.instanceCount = 0;
        const mesh = new THREE.Mesh(geo, material);
        mesh.frustumCulled = false;
        mesh.name = `${asset}_v${v}`;
        this.object.add(mesh);
        return { mesh, offset: off, params: par };
      }) as [Drawable, Drawable];

      // 越高的物体在越远处仍然可见；输电塔在全景下也能看到
      this.groups.push({ asset, offset, params, chunkStart, lods, dist: [150 + 30 * height, 700 + 200 * height] });
    }
  }

  /** 竖向夸张或 LOD 倍率变化后强制刷新 */
  invalidate() {
    this.dirty = true;
  }

  update(camera: THREE.PerspectiveCamera) {
    if (!this.dirty && camera.position.distanceToSquared(this.lastCam) < 4 && camera.quaternion.angleTo(this.lastQuat) < 0.01) return;
    this.dirty = false;
    this.lastCam.copy(camera.position);
    this.lastQuat.copy(camera.quaternion);
    camera.updateMatrixWorld();
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);

    const u = this.material.uniforms;
    const vs = u.uVScale.value as number;
    const minE = u.uMinElev.value as number;
    const nChunks = this.chunkCenter.length;
    const dist = new Float32Array(nChunks);
    for (let k = 0; k < nChunks; k++) {
      const c = this.chunkCenter[k];
      c.y = (this.chunkElev[k] - minE) * vs;
      this.sphere.set(c, this.chunkRadius + 60);
      dist[k] = this.frustum.intersectsSphere(this.sphere) ? Math.max(0, camera.position.distanceTo(c) - this.chunkRadius) : Infinity;
    }

    for (const g of this.groups) {
      const d0 = g.dist[0] * this.lodScale;
      const d1 = g.dist[1] * this.lodScale;
      const cursor = [0, 0];
      for (let k = 0; k < nChunks; k++) {
        const a = g.chunkStart[k];
        const b = g.chunkStart[k + 1];
        if (a === b || dist[k] > d1) continue;
        const lod = dist[k] <= d0 ? 0 : 1;
        const dst = g.lods[lod];
        (dst.offset.array as Float32Array).set(g.offset.subarray(a * 4, b * 4), cursor[lod] * 4);
        (dst.params.array as Float32Array).set(g.params.subarray(a * 2, b * 2), cursor[lod] * 2);
        cursor[lod] += b - a;
      }
      g.lods.forEach((d, i) => {
        d.mesh.geometry.instanceCount = cursor[i];
        d.mesh.visible = cursor[i] > 0;
        for (const attr of [d.offset, d.params]) {
          attr.clearUpdateRanges();
          attr.addUpdateRange(0, cursor[i] * attr.itemSize);
          attr.needsUpdate = true;
        }
      });
    }
  }

  /** 当前可见实例数与三角面数（调试用） */
  stats(): { instances: number; triangles: number; drawCalls: number } {
    let instances = 0;
    let triangles = 0;
    let drawCalls = 0;
    for (const g of this.groups)
      for (const d of g.lods) {
        const n = d.mesh.geometry.instanceCount;
        if (!n) continue;
        const geo = d.mesh.geometry;
        const tris = (geo.index ? geo.index.count : geo.getAttribute("position").count) / 3;
        instances += n;
        triangles += n * tris;
        drawCalls++;
      }
    return { instances, triangles, drawCalls };
  }
}
