"""程序化建模：输电铁塔与木质配电杆（细杆结构不适合图生 3D）。

在 Blender 中运行：
    exec(open(".../build_props.py").read())
    build_tower(); build_pole()

与 process_asset.py 输出一致：逐面顶点色 Col、_part 属性（全部为 1，不会燃尽消失）、
平直着色、WTLA_VertexColor 材质。导线挂点写入对象自定义属性 wire_points（导出为 glTF extras），
three.js 按这些点生成悬链线。
"""

import math

import bmesh
import bpy
import numpy as np
from mathutils import Vector

SCENE = "WTLA_Assets"

STEEL = (0.655, 0.678, 0.698)
INSULATOR = (0.43, 0.45, 0.47)
WOOD = (0.416, 0.333, 0.267)
GREY = (0.549, 0.569, 0.588)


def _lin(c):
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


class Builder:
    def __init__(self):
        self.bm = bmesh.new()
        self.face_colors = []

    def _add_faces(self, verts, faces, color):
        vs = [self.bm.verts.new(v) for v in verts]
        for f in faces:
            self.bm.faces.new([vs[i] for i in f])
            self.face_colors.append(color)

    def beam(self, a, b, t, color, sides=4):
        """a→b 的方截面（或多边形截面）杆件，不加端盖。"""
        a, b = Vector(a), Vector(b)
        d = (b - a).normalized()
        up = Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((1, 0, 0))
        u = d.cross(up).normalized()
        v = d.cross(u).normalized()
        ring = [
            (u * math.cos(2 * math.pi * k / sides + math.pi / sides) + v * math.sin(2 * math.pi * k / sides + math.pi / sides)) * t
            for k in range(sides)
        ]
        verts = [a + r for r in ring] + [b + r for r in ring]
        faces = [(k, (k + 1) % sides, sides + (k + 1) % sides, sides + k) for k in range(sides)]
        self._add_faces(verts, faces, color)

    def cylinder(self, center, r_bottom, r_top, height, color, sides=8, caps=True):
        c = Vector(center)
        bot = [c + Vector((r_bottom * math.cos(2 * math.pi * k / sides), r_bottom * math.sin(2 * math.pi * k / sides), 0)) for k in range(sides)]
        top = [c + Vector((r_top * math.cos(2 * math.pi * k / sides), r_top * math.sin(2 * math.pi * k / sides), height)) for k in range(sides)]
        faces = [(k, (k + 1) % sides, sides + (k + 1) % sides, sides + k) for k in range(sides)]
        if caps:
            faces += [tuple(range(sides - 1, -1, -1)), tuple(range(sides, 2 * sides))]
        self._add_faces(bot + top, faces, color)

    def box(self, center, size, color):
        c, s = Vector(center), Vector(size) / 2
        verts = [c + Vector((sx * s.x, sy * s.y, sz * s.z)) for sz in (-1, 1) for sy in (-1, 1) for sx in (-1, 1)]
        faces = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]
        self._add_faces(verts, faces, color)


def _finish(obj: bpy.types.Object, face_colors_by_orig: list, orig_index: list) -> None:
    me = obj.data
    col = me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
    part = me.attributes.new("_part", "FLOAT", "POINT")
    corner = np.empty((len(me.loops), 4), dtype=np.float32)
    for p, oi in zip(me.polygons, orig_index):
        c = _lin(face_colors_by_orig[oi])
        for li in p.loop_indices:
            corner[li] = (*c, 1)
        p.use_smooth = False
    col.data.foreach_set("color", corner.ravel())
    part.data.foreach_set("value", np.ones(len(me.vertices), dtype=np.float32))
    mat = bpy.data.materials.get("WTLA_VertexColor")
    if mat:
        me.materials.append(mat)


def _make(builder: Builder, name: str, coll: bpy.types.Collection) -> bpy.types.Object:
    # triangulate 会把四边形拆开，用 face 层记录每个三角形来自哪个原始面，以便查颜色
    bm = builder.bm
    layer = bm.faces.layers.int.new("orig")
    for i, f in enumerate(bm.faces):
        f[layer] = i
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    orig = [f[layer] for f in bm.faces]
    bmesh.ops.split_edges(bm, edges=bm.edges[:])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    coll.objects.link(obj)
    _finish(obj, builder.face_colors, orig)
    return obj


def _collection(name: str) -> bpy.types.Collection:
    sc = bpy.context.scene if bpy.app.background else (bpy.data.scenes.get(SCENE) or bpy.data.scenes.new(SCENE))
    coll = bpy.data.collections.get(name)
    if coll:
        for o in list(coll.objects):
            bpy.data.objects.remove(o)
    else:
        coll = bpy.data.collections.new(name)
        sc.collection.children.link(coll)
    return coll


def build_tower(height: float = 40.0) -> dict:
    """钢格构输电塔：四根收分主腿、分层横隔与交叉斜材、上下两层横担，横担端部悬挂绝缘子串。"""
    coll = _collection("transmission-tower")
    levels = [0, 7, 13, 18, 23, 27.5, 31, 35.5]
    half = lambda z: 4.0 + (1.0 - 4.0) * min(z, 31) / 31  # 主腿半宽：底部 4 m，31 m 处 1 m
    corners = lambda z: [Vector((sx * half(z), sy * half(z), z)) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    arms = [(27.5, 7.5), (35.5, 5.5)]  # (高度, 单侧外伸)
    wire_points = []

    def build(detail: bool) -> Builder:
        b = Builder()
        t = 0.18 if detail else 0.3
        for z0, z1 in zip(levels, levels[1:]):
            c0, c1 = corners(z0), corners(z1)
            for k in range(4):
                b.beam(c0[k], c1[k], t, STEEL)  # 主腿
                if detail:
                    j = (k + 1) % 4
                    b.beam(c0[k], c1[j], t * 0.6, STEEL)  # 交叉斜材
                    b.beam(c0[j], c1[k], t * 0.6, STEEL)
            for k in range(4):
                b.beam(c1[k], c1[(k + 1) % 4], t * 0.7, STEEL)  # 横隔
        top = Vector((0, 0, height))
        for c in corners(levels[-1]):
            b.beam(c, top, t * 0.8, STEEL)  # 塔顶
        for z, reach in arms:
            h = half(z)
            for side in (-1, 1):
                tip = Vector((side * (h + reach), 0, z))
                for y in (-h, h):
                    b.beam(Vector((side * h, y, z)), tip, t * 0.8, STEEL)  # 下弦
                    b.beam(Vector((side * h, y, z + 2.2)), tip, t * 0.7, STEEL)  # 上弦
                    if detail:
                        b.beam(Vector((side * h, y, z)), Vector((side * (h + reach * 0.5), 0, z + 1.1)), t * 0.5, STEEL)
                # 绝缘子串：几节圆盘
                drop = 2.4
                for i in range(5 if detail else 1):
                    if detail:
                        b.cylinder(tip - Vector((0, 0, 0.4 + i * 0.45)), 0.35, 0.35, 0.22, INSULATOR, sides=8)
                    else:
                        b.cylinder(tip - Vector((0, 0, drop)), 0.25, 0.25, drop, INSULATOR, sides=4, caps=False)
                if detail:
                    b.beam(tip, tip - Vector((0, 0, drop)), 0.05, INSULATOR)
                    wire_points.append([round(tip.x, 3), round(tip.y, 3), round(tip.z - drop, 3)])
        return b

    lod0 = _make(build(True), "transmission-tower_LOD0", coll)
    lod1 = _make(build(False), "transmission-tower_LOD1", coll)
    # glTF Y 轴向上：导出时 Blender 的 (x, y, z) 变为 (x, z, -y)
    lod0["wire_points"] = [[p[0], p[2], -p[1]] for p in wire_points]
    lod1.location.x = 20
    return {lod: len(o.data.polygons) for lod, o in (("LOD0", lod0), ("LOD1", lod1))}


def build_pole(height: float = 12.0) -> dict:
    """木质配电杆：收分杆身、横担与斜撑、三个针式绝缘子、一个变压器桶。"""
    coll = _collection("utility-pole")
    wire_points = []

    def build(detail: bool) -> Builder:
        b = Builder()
        b.cylinder((0, 0, 0), 0.16, 0.12, height, WOOD, sides=8 if detail else 4, caps=detail)
        arm_z = height - 0.9
        b.box((0, 0, arm_z), (2.6, 0.12, 0.12), WOOD)
        if detail:
            for side in (-1, 1):
                b.beam((0, 0, arm_z - 0.8), (side * 0.75, 0, arm_z - 0.05), 0.03, GREY)
            for x in (-1.15, -0.45, 1.15):
                b.cylinder((x, 0, arm_z + 0.06), 0.07, 0.05, 0.28, GREY, sides=6)
                wire_points.append([x, arm_z + 0.34, 0.0])
            b.cylinder((0.42, 0, height - 3.6), 0.28, 0.28, 1.1, GREY, sides=8)
            b.box((0.2, 0, height - 3.2), (0.16, 0.08, 0.5), GREY)
        else:
            b.box((0.42, 0, height - 3.05), (0.5, 0.5, 1.1), GREY)
        return b

    lod0 = _make(build(True), "utility-pole_LOD0", coll)
    lod1 = _make(build(False), "utility-pole_LOD1", coll)
    lod0["wire_points"] = wire_points
    lod1.location.x = 5
    return {lod: len(o.data.polygons) for lod, o in (("LOD0", lod0), ("LOD1", lod1))}
