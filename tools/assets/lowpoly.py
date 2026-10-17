"""程序化低多边形建模的公共工具。

所有面都用独立顶点（导出后即平直着色），每个面带颜色与部位：
    PART_BURN = 0   树冠、屋顶：燃尽时消失
    PART_SOLID = 1  树干、墙体、杆件：燃尽后变黑但保留
    PART_GLASS = 2  窗户：Respond 模式夜间亮灯、燃烧时透出火光
坐标：Blender Z 向上，米制，原点在底部中心。
"""

import math
import random

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

PART_BURN, PART_SOLID, PART_GLASS = 0, 1, 2
SCENE = "WTLA_Assets"


def hex_rgb(h: str) -> tuple:
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) / 255 for i in (0, 2, 4))


def shade(c, k: float) -> tuple:
    return tuple(min(1.0, max(0.0, x * k)) for x in c)


def srgb_to_linear(c) -> tuple:
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


class Palette:
    """按权重随机取色，再做 ±jitter 的明度扰动，得到参考图那种切面深浅不一的效果。"""

    def __init__(self, colors: list[str], weights: list[float] | None = None, jitter: float = 0.06):
        self.colors = [hex_rgb(c) for c in colors]
        self.weights = weights or [1] * len(colors)
        self.jitter = jitter

    def pick(self, rng: random.Random) -> tuple:
        c = rng.choices(self.colors, self.weights)[0]
        return shade(c, 1 + rng.uniform(-self.jitter, self.jitter))


def as_palette(color) -> Palette:
    if isinstance(color, Palette):
        return color
    if isinstance(color, str):
        return Palette([color], jitter=0)
    return Palette(["#%02x%02x%02x" % tuple(int(x * 255) for x in color)], jitter=0)


class Builder:
    def __init__(self, seed: int = 0):
        self.rng = random.Random(seed)
        self.verts: list[Vector] = []
        self.faces: list[tuple] = []
        self.colors: list[tuple] = []
        self.parts: list[int] = []

    # ---- 基本面 ----
    def face(self, pts, color, part: int) -> None:
        pal = as_palette(color)
        base = len(self.verts)
        self.verts.extend(Vector(p) for p in pts)
        self.faces.append(tuple(range(base, base + len(pts))))
        self.colors.append(pal.pick(self.rng))
        self.parts.append(part)

    def quad_on_wall(self, origin, u, v, w: float, h: float, color, part: int, offset: float = 0.03) -> None:
        """在墙面上贴一块矩形（窗、门），origin 为左下角，u 为水平方向，v 为竖直方向，沿法线外移 offset 防止 z-fighting。"""
        o, u, v = Vector(origin), Vector(u).normalized(), Vector(v).normalized()
        n = u.cross(v).normalized() * offset
        self.face([o + n, o + u * w + n, o + u * w + v * h + n, o + v * h + n], color, part)

    def arch_on_wall(self, origin, u, v, w: float, h: float, color, part: int, segs: int = 5, offset: float = 0.03) -> None:
        """顶部为半圆拱的窗或门。"""
        o, u, v = Vector(origin), Vector(u).normalized(), Vector(v).normalized()
        n = u.cross(v).normalized() * offset
        r = w / 2
        spring = h - r
        pts = [o, o + u * w]
        for i in range(segs + 1):
            a = math.pi * i / segs
            pts.append(o + u * (r + r * math.cos(a)) + v * (spring + r * math.sin(a)))
        self.face([p + n for p in pts], color, part)

    # ---- 体块 ----
    def box(self, lo, hi, color, part: int, bottom: bool = False, matrix: Matrix | None = None) -> None:
        lo, hi = Vector(lo), Vector(hi)
        c = [Vector((x, y, z)) for z in (lo.z, hi.z) for y in (lo.y, hi.y) for x in (lo.x, hi.x)]
        if matrix:
            c = [matrix @ p for p in c]
        quads = [(4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]
        if bottom:
            quads.append((0, 2, 3, 1))
        for q in quads:
            self.face([c[i] for i in q], color, part)

    def tube(self, pts, radii, sides: int, color, part: int, cap: bool = True, twist: float = 0.0) -> None:
        """沿折线的收分管：树干、枝干、杆件。"""
        pts = [Vector(p) for p in pts]
        rings = []
        normal = None
        for i, p in enumerate(pts):
            a = pts[max(i - 1, 0)]
            b = pts[min(i + 1, len(pts) - 1)]
            t = (b - a).normalized()
            if normal is None:
                ref = Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0))
                normal = t.cross(ref).normalized()
            else:
                normal = (normal - t * normal.dot(t)).normalized()
            binormal = t.cross(normal)
            ring = []
            for k in range(sides):
                ang = 2 * math.pi * k / sides + twist * i
                ring.append(p + (normal * math.cos(ang) + binormal * math.sin(ang)) * radii[i])
            rings.append(ring)
        # color 可以是函数 (段号, 边号) -> 颜色，用于树皮的环纹、菱形纹
        pick = color if callable(color) else (lambda i, k: color)
        for i in range(len(rings) - 1):
            r0, r1 = rings[i], rings[i + 1]
            for k in range(sides):
                j = (k + 1) % sides
                self.face([r0[k], r0[j], r1[j], r1[k]], pick(i, k), part)
        if cap and radii[-1] > 1e-4:
            self.face(rings[-1], pick(len(rings) - 2, 0), part)

    def blob(self, center, size, color, part: int, jitter: float = 0.18, subdiv: int = 1, flatten_bottom: float = 0.0) -> None:
        """扰动的二十面体团：树冠、灌木叶团。size 为三轴半径。"""
        bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=1.0)
        rot = Matrix.Rotation(self.rng.uniform(0, math.tau), 3, "Z")
        cache = {}
        for v in bm.verts:
            k = 1 + self.rng.uniform(-jitter, jitter)
            p = rot @ (v.co * k)
            if flatten_bottom and p.z < -flatten_bottom:
                p.z = -flatten_bottom + (p.z + flatten_bottom) * 0.3
            cache[v.index] = Vector(center) + Vector((p.x * size[0], p.y * size[1], p.z * size[2]))
        for f in bm.faces:
            self.face([cache[v.index] for v in f.verts], color, part)
        bm.free()

    def cone(self, base, radius: float, height: float, sides: int, color, part: int, droop: float = 0.0, base_cap: bool = True, jitter: float = 0.0) -> None:
        """圆锥。droop > 0 时边缘下垂，用于针叶树分层。"""
        base = Vector(base)
        apex = base + Vector((0, 0, height))
        off = self.rng.uniform(0, math.tau)
        ring = []
        for k in range(sides):
            a = off + 2 * math.pi * k / sides
            r = radius * (1 + self.rng.uniform(-jitter, jitter))
            ring.append(base + Vector((r * math.cos(a), r * math.sin(a), -droop * self.rng.uniform(0.7, 1.0))))
        for k in range(sides):
            self.face([ring[k], ring[(k + 1) % sides], apex], color, part)
        if base_cap:
            self.face(list(reversed(ring)), color, part)

    # ---- 输出 ----
    def tris(self) -> int:
        return sum(len(f) - 2 for f in self.faces)

    def to_object(self, name: str, coll: bpy.types.Collection) -> bpy.types.Object:
        me = bpy.data.meshes.new(name)
        me.from_pydata([v[:] for v in self.verts], [], self.faces)
        me.validate()
        col = me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
        part = me.attributes.new("_part", "FLOAT", "POINT")
        corner = np.empty((len(me.loops), 4), dtype=np.float32)
        point = np.zeros(len(me.vertices), dtype=np.float32)
        for poly, c, p in zip(me.polygons, self.colors, self.parts):
            lin = srgb_to_linear(c)
            for li in poly.loop_indices:
                corner[li] = (*lin, 1)
                point[me.loops[li].vertex_index] = p
            poly.use_smooth = False
        col.data.foreach_set("color", corner.ravel())
        part.data.foreach_set("value", point)
        me.materials.append(vertex_color_material())
        obj = bpy.data.objects.new(name, me)
        coll.objects.link(obj)
        return obj


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


def get_scene() -> bpy.types.Scene:
    # 后台模式直接用当前场景；交互模式放进独立场景，不动用户自己的场景
    if bpy.app.background:
        return bpy.context.scene
    return bpy.data.scenes.get(SCENE) or bpy.data.scenes.new(SCENE)


def fresh_collection(name: str) -> bpy.types.Collection:
    sc = get_scene()
    coll = bpy.data.collections.get(name)
    if coll:
        for o in list(coll.objects):
            me = o.data
            bpy.data.objects.remove(o)
            if me and me.users == 0:
                bpy.data.meshes.remove(me)
    else:
        coll = bpy.data.collections.new(name)
        sc.collection.children.link(coll)
    return coll
