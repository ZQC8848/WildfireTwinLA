"""Blender 资产处理：Tripo GLB → 真实尺寸、减面、平直着色、逐面顶点色、部位属性。

在 Blender 中运行（MCP 或 `blender -b --python`）：
    exec(open(".../process_asset.py").read())
    process("oak-coast-live")

每个资产生成 LOD0、LOD1 两个对象，放在 WTLA_Assets 场景的同名集合中。
顶点属性：
- COLOR_0：逐面纯色（线性空间），来自 Tripo 贴图在面中心的采样
- _part：0 = 树冠 / 屋顶（会燃尽消失的部分），1 = 树干 / 墙体
"""

import colorsys
import pathlib

import bmesh
import bpy
import numpy as np
from mathutils import Vector

TRIPO = pathlib.Path.home() / "Assets/WildfireTwinLA/tripo"
# 通过 exec() 运行时没有 __file__，所以写成固定路径
EXPORT = pathlib.Path.home() / "Dev/web-ai/WildfireTwinLA/web/public/models"
SCENE = "WTLA_Assets"

# 名称 → (类别, 真实尺寸（米）, 尺寸含义, LOD0 三角面, LOD1 三角面)
SPECS = {
    "oak-coast-live": ("tree", 10, "height", 900, 140),
    "oak-coast-live-young": ("tree", 5, "height", 700, 120),
    "shrub-chamise": ("tree", 1.8, "height", 500, 80),
    "shrub-manzanita": ("tree", 2.2, "height", 600, 90),
    "shrub-scrub-oak": ("tree", 2.2, "height", 500, 80),
    "pine-coulter": ("tree", 17, "height", 900, 140),
    "fir-bigcone-douglas": ("tree", 20, "height", 900, 140),
    "palm-mexican-fan": ("tree", 20, "height", 600, 100),
    # palm-canary 已移除：Tripo 输出的树干藏在下垂叶丛中，无法区分树干与树冠
    "eucalyptus": ("tree", 24, "height", 900, 140),
    "house-ranch": ("house", 15, "length", 500, 60),
    "house-craftsman": ("house", 12, "length", 600, 60),
    "house-spanish": ("house", 14, "length", 600, 60),
    "house-modern": ("house", 14, "length", 500, 60),
    "apartment-small": ("house", 25, "length", 600, 60),
    "fire-station": ("house", 30, "length", 600, 60),
    # utility-pole 与 transmission-tower 在 build_props.py 中程序化建模
}

# 房屋目标高度（米）：Tripo 生成的房屋长高比与真实不符，按长边缩放后再单独校正高度
HOUSE_HEIGHT = {
    "house-ranch": 5,
    "house-craftsman": 6,
    "house-spanish": 6,
    "house-modern": 7,
    "apartment-small": 9,
    "fire-station": 9,
}

# 房屋 LOD1 的屋顶类型
ROOF = {
    "house-ranch": "hip",
    "house-craftsman": "hip",
    "house-spanish": "hip",
    "house-modern": "flat",
    "apartment-small": "flat",
    "fire-station": "flat",
}

# 颜色校正：Tripo 贴图整体偏暗
GAIN = 1.15


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def get_scene() -> bpy.types.Scene:
    # 后台模式没有窗口，直接用当前场景；交互模式下放进独立场景，不动用户的场景
    if bpy.app.background:
        return bpy.context.scene
    return bpy.data.scenes.get(SCENE) or bpy.data.scenes.new(SCENE)


def import_glb(name: str, sc: bpy.types.Scene) -> bpy.types.Object:
    before = set(bpy.data.objects)
    win = bpy.context.window
    prev = win.scene if win else None
    if win:
        win.scene = sc
    bpy.ops.import_scene.gltf(filepath=str(TRIPO / f"{name}.glb"))
    if win:
        win.scene = prev
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH"]
    assert len(meshes) == 1, f"{name}: expected 1 mesh, got {len(meshes)}"
    obj = meshes[0]
    # 把父级空物体的变换应用到网格上，再删掉空物体
    mw = obj.matrix_world.copy()
    obj.parent = None
    obj.matrix_world = mw
    for o in new:
        if o is not obj:
            bpy.data.objects.remove(o)
    obj.data.transform(obj.matrix_world)
    obj.matrix_world.identity()
    return obj


def texture_pixels(obj: bpy.types.Object) -> tuple[np.ndarray, int, int]:
    mat = obj.data.materials[0]
    img = next(n.image for n in mat.node_tree.nodes if n.type == "TEX_IMAGE" and n.image)
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    return px.reshape(h, w, 4), w, h


def normalize(obj: bpy.types.Object, size: float, mode: str) -> None:
    pts = np.array([v.co[:] for v in obj.data.vertices])
    mn, mx = pts.min(0), pts.max(0)
    extent = mx[2] - mn[2] if mode == "height" else max(mx[0] - mn[0], mx[1] - mn[1])
    s = size / extent
    # 原点：底部中心
    cx, cy = (mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2
    for v in obj.data.vertices:
        v.co = Vector(((v.co.x - cx) * s, (v.co.y - cy) * s, (v.co.z - mn[2]) * s))


def weld(obj: bpy.types.Object, size: float) -> None:
    """Tripo 网格在 UV 接缝处顶点断开，不先合并的话减面会把网格撕裂。"""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=size * 1e-3)
    bm.to_mesh(obj.data)
    bm.free()


def decimate(obj: bpy.types.Object, target: int) -> None:
    # 单次 collapse 常常停在目标之上，迭代到接近目标或不再下降为止
    for _ in range(6):
        obj.data.calc_loop_triangles()
        tris = len(obj.data.loop_triangles)
        if tris <= target * 1.1:
            return
        mod = obj.modifiers.new("dec", "DECIMATE")
        mod.ratio = target / tris
        mod.use_collapse_triangulate = True
        with bpy.context.temp_override(object=obj, active_object=obj):
            bpy.ops.object.modifier_apply(modifier=mod.name)
        obj.data.calc_loop_triangles()
        if len(obj.data.loop_triangles) >= tris * 0.97:
            return


def bake_face_colors(obj: bpy.types.Object, tex: tuple[np.ndarray, int, int], kind: str, palm: bool = False) -> dict:
    pixels, w, h = tex
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    # 拆开所有边：每个面独立顶点，导出后即为平直着色，且部位属性可以逐面设置
    bmesh.ops.split_edges(bm, edges=bm.edges[:])
    uv = bm.loops.layers.uv.active
    height = max(v.co.z for v in bm.verts)

    face_rgb, face_part = [], []
    for f in bm.faces:
        # 在面中心与三个顶点向中心收缩的位置各采样一次，取平均，减少接缝处采到错色
        uvs = [l[uv].uv for l in f.loops]
        c = sum(uvs, Vector((0, 0))) / 3
        samples = [c] + [u.lerp(c, 0.6) for u in uvs]
        rgb = np.zeros(3)
        for s in samples:
            x = min(w - 1, max(0, int(s.x * w)))
            y = min(h - 1, max(0, int(s.y * h)))
            rgb += pixels[y, x, :3]
        rgb = np.clip(rgb / len(samples) * GAIN, 0, 1)
        face_rgb.append(rgb)

        hue, sat, _ = colorsys.rgb_to_hsv(*rgb)
        if kind == "tree":
            # 绿色、黄绿、灰绿的叶子算树冠；棕色、灰色的枝干算树干
            leafy = (0.14 <= hue <= 0.5 and sat > 0.08) or rgb[1] > rgb[0] * 1.03
            part = 0 if leafy else 1
            if palm:
                # 棕榈树干颜色偏绿，靠几何判断：中轴附近、下半部分的面算树干
                c3 = f.calc_center_median()
                if c3.z < height * 0.5 and (c3.x**2 + c3.y**2) ** 0.5 < height * 0.12:
                    part = 1
        elif kind == "house":
            n = f.normal
            cz = f.calc_center_median().z
            part = 0 if (n.z > 0.25 and cz > height * 0.35) else 1
        else:
            part = 1
        face_part.append(part)

    bm.to_mesh(obj.data)
    bm.free()
    me = obj.data
    for a in list(me.color_attributes):
        me.color_attributes.remove(a)
    col = me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
    part_attr = me.attributes.new("_part", "FLOAT", "POINT")
    lin = srgb_to_linear(np.array(face_rgb))
    corner = np.empty((len(me.loops), 4), dtype=np.float32)
    point = np.zeros(len(me.vertices), dtype=np.float32)
    for poly, rgb, part in zip(me.polygons, lin, face_part):
        for li in poly.loop_indices:
            corner[li, :3] = rgb
            corner[li, 3] = 1
            point[me.loops[li].vertex_index] = part
    col.data.foreach_set("color", corner.ravel())
    part_attr.data.foreach_set("value", point)
    for p in me.polygons:
        p.use_smooth = False
    return {"canopy_or_roof": face_part.count(0), "trunk_or_wall": face_part.count(1)}


def remesh(obj: bpy.types.Object) -> None:
    """叶团互不相连时 collapse 减不下去，先体素重建成一个整体。体素按树冠宽度取，高瘦的树也不会糊成一团。"""
    mod = obj.modifiers.new("remesh", "REMESH")
    mod.mode = "VOXEL"
    mod.voxel_size = max(obj.dimensions.x, obj.dimensions.y) / 20
    with bpy.context.temp_override(object=obj, active_object=obj):
        bpy.ops.object.modifier_apply(modifier=mod.name)


def transfer_from(obj: bpy.types.Object, ref: bpy.types.Object) -> dict:
    """按最近的面，从已烘焙的 ref 复制逐面颜色与部位。"""
    from mathutils.bvhtree import BVHTree

    rme = ref.data
    tree = BVHTree.FromPolygons([v.co for v in rme.vertices], [p.vertices[:] for p in rme.polygons])
    rcol = np.empty(len(rme.loops) * 4, dtype=np.float32)
    rme.color_attributes["Col"].data.foreach_get("color", rcol)
    rcol = rcol.reshape(-1, 4)
    rpart = np.empty(len(rme.vertices), dtype=np.float32)
    rme.attributes["_part"].data.foreach_get("value", rpart)

    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bmesh.ops.split_edges(bm, edges=bm.edges[:])
    bm.to_mesh(obj.data)
    bm.free()
    me = obj.data
    for a in list(me.color_attributes):
        me.color_attributes.remove(a)
    for name in [a.name for a in me.attributes if a.name == "_part"]:
        me.attributes.remove(me.attributes[name])
    col = me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
    part_attr = me.attributes.new("_part", "FLOAT", "POINT")
    corner = np.empty((len(me.loops), 4), dtype=np.float32)
    point = np.zeros(len(me.vertices), dtype=np.float32)
    parts = []
    for p in me.polygons:
        _, _, idx, _ = tree.find_nearest(p.center)
        rp = rme.polygons[idx]
        c = rcol[rp.loop_start]
        part = rpart[rme.loops[rp.loop_start].vertex_index]
        parts.append(int(part))
        for li in p.loop_indices:
            corner[li] = c
            point[me.loops[li].vertex_index] = part
        p.use_smooth = False
    col.data.foreach_set("color", corner.ravel())
    part_attr.data.foreach_set("value", point)
    return {"canopy_or_roof": parts.count(0), "trunk_or_wall": parts.count(1)}


def house_block(name: str, ref: bpy.types.Object) -> bpy.types.Object:
    """房屋 LOD1：自动减面到几十个面会塌成碎片，改为按 LOD0 生成"墙体方块 + 屋顶"的简化体块。"""
    me = ref.data
    co = np.empty(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    part = np.empty(len(me.vertices), dtype=np.float32)
    me.attributes["_part"].data.foreach_get("value", part)
    col = np.empty(len(me.loops) * 4, dtype=np.float32)
    me.color_attributes["Col"].data.foreach_get("color", col)
    col = col.reshape(-1, 4)[:, :3]

    def avg_color(p: int) -> tuple:
        area = [(poly.area, col[poly.loop_start]) for poly in me.polygons if part[me.loops[poly.loop_start].vertex_index] == p]
        w = sum(a for a, _ in area) or 1
        return tuple(sum(a * c for a, c in area) / w)

    (x0, y0, _), (x1, y1, top) = co.min(0), co.max(0)
    flat = ROOF[name] == "flat"
    eave = top - 0.4 if flat else top * 0.55

    bm = bmesh.new()
    face_part = []

    def quad_box(lo, hi, p):
        vs = [bm.verts.new((x, y, z)) for z in (lo[2], hi[2]) for y in (lo[1], hi[1]) for x in (lo[0], hi[0])]
        for f in ((0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)):
            bm.faces.new([vs[i] for i in f])
            face_part.append(p)

    quad_box((x0, y0, 0), (x1, y1, eave), 1)
    if flat:
        quad_box((x0 - 0.2, y0 - 0.2, eave), (x1 + 0.2, y1 + 0.2, top), 0)
    else:
        # 四坡顶：屋脊沿长边，四周出檐 0.4 m
        o = 0.4
        ex0, ey0, ex1, ey1 = x0 - o, y0 - o, x1 + o, y1 + o
        long_x = (x1 - x0) >= (y1 - y0)
        half_short = ((ey1 - ey0) if long_x else (ex1 - ex0)) / 2
        cx, cy = (ex0 + ex1) / 2, (ey0 + ey1) / 2
        if long_x:
            r0 = bm.verts.new((ex0 + half_short, cy, top))
            r1 = bm.verts.new((ex1 - half_short, cy, top))
        else:
            r0 = bm.verts.new((cx, ey0 + half_short, top))
            r1 = bm.verts.new((cx, ey1 - half_short, top))
        c = [bm.verts.new(v) for v in ((ex0, ey0, eave), (ex1, ey0, eave), (ex1, ey1, eave), (ex0, ey1, eave))]
        if long_x:
            faces = [(c[0], c[1], r1, r0), (c[2], c[3], r0, r1), (c[3], c[0], r0), (c[1], c[2], r1)]
        else:
            faces = [(c[1], c[2], r1, r0), (c[3], c[0], r0, r1), (c[0], c[1], r0), (c[2], c[3], r1)]
        for f in faces:
            bm.faces.new(f)
            face_part.append(0)
        bm.faces.new((c[3], c[2], c[1], c[0]))  # 檐口底面
        face_part.append(0)

    layer = bm.faces.layers.int.new("p")
    for f, p in zip(bm.faces, face_part):
        f[layer] = p
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    tri_part = [f[layer] for f in bm.faces]
    bmesh.ops.split_edges(bm, edges=bm.edges[:])
    out = bpy.data.meshes.new(f"{name}_LOD1")
    bm.to_mesh(out)
    bm.free()

    colors = {0: avg_color(0), 1: avg_color(1)}
    ca = out.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
    pa = out.attributes.new("_part", "FLOAT", "POINT")
    corner = np.empty((len(out.loops), 4), dtype=np.float32)
    point = np.zeros(len(out.vertices), dtype=np.float32)
    for poly, p in zip(out.polygons, tri_part):
        for li in poly.loop_indices:
            corner[li] = (*colors[p], 1)
            point[out.loops[li].vertex_index] = p
        poly.use_smooth = False
    ca.data.foreach_set("color", corner.ravel())
    pa.data.foreach_set("value", point)
    return bpy.data.objects.new(f"{name}_LOD1", out)


def vertex_color_material() -> bpy.types.Material:
    mat = bpy.data.materials.get("WTLA_VertexColor")
    if mat:
        return mat
    mat = bpy.data.materials.new("WTLA_VertexColor")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    attr = nt.nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Col"
    nt.links.new(attr.outputs[0], bsdf.inputs[0])
    bsdf.inputs["Roughness"].default_value = 0.95
    return mat


def process(name: str) -> dict:
    kind, size, mode, lod0, lod1 = SPECS[name]
    sc = get_scene()
    coll = bpy.data.collections.get(name)
    if coll:
        for o in list(coll.objects):
            bpy.data.objects.remove(o)
    else:
        coll = bpy.data.collections.new(name)
        sc.collection.children.link(coll)

    src = import_glb(name, sc)
    tex = texture_pixels(src)
    normalize(src, size, mode)
    if name in HOUSE_HEIGHT:
        top = max(v.co.z for v in src.data.vertices)
        k = HOUSE_HEIGHT[name] / top
        for v in src.data.vertices:
            v.co.z *= k
    weld(src, size)
    mat = vertex_color_material()

    stats = {}
    for lod, target in (("LOD0", lod0), ("LOD1", lod1)):
        obj = src.copy()
        obj.data = src.data.copy()
        obj.name = obj.data.name = f"{name}_{lod}"
        for c in obj.users_collection:
            c.objects.unlink(obj)
        coll.objects.link(obj)
        if lod == "LOD1" and kind == "tree":
            remesh(obj)
            decimate(obj, target)
            parts = transfer_from(obj, coll.objects[f"{name}_LOD0"])
        else:
            decimate(obj, target)
            parts = bake_face_colors(obj, tex, kind, palm=name.startswith("palm"))
        obj.data.materials.clear()
        obj.data.materials.append(mat)
        obj.data.calc_loop_triangles()
        stats[lod] = {"tris": len(obj.data.loop_triangles), **parts}

    if kind == "house":
        old = coll.objects[f"{name}_LOD1"]
        bpy.data.objects.remove(old)
        block = house_block(name, coll.objects[f"{name}_LOD0"])
        block.data.materials.append(mat)
        coll.objects.link(block)
        stats["LOD1"] = {"tris": len(block.data.polygons), "procedural": True}

    # 删除导入的原始网格与其贴图材质
    old_mats = list(src.data.materials)
    for c in src.users_collection:
        c.objects.unlink(src)
    bpy.data.objects.remove(src)
    for m in old_mats:
        if m and m.users == 0:
            bpy.data.materials.remove(m)

    # LOD1 放在 LOD0 旁边，方便对照
    dims = coll.objects[f"{name}_LOD0"].dimensions
    coll.objects[f"{name}_LOD1"].location.x = dims.x * 1.3
    return stats


def export(name: str) -> pathlib.Path:
    """把集合里的 LOD0、LOD1 导出为一个 GLB：两个对象都放回原点，Y 轴向上，保留 _part 属性与 extras。"""
    EXPORT.mkdir(parents=True, exist_ok=True)
    coll = bpy.data.collections[name]
    objs = [o for o in coll.objects if o.name.endswith(("_LOD0", "_LOD1"))]
    saved = {o.name: o.location.copy() for o in objs}
    for o in objs:
        o.location = (0, 0, 0)
    path = EXPORT / f"{name}.glb"
    # 按集合导出，不依赖选中状态或切换场景（交互模式下用 temp_override 切场景会让 Blender 5.2 崩溃）
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        collection=name,
        export_yup=True,
        export_attributes=True,
        export_extras=True,
        export_vertex_color="ACTIVE",
        export_materials="EXPORT",
        export_texcoords=False,
        export_animations=False,
    )
    for o in objs:
        o.location = saved[o.name]
    return path
