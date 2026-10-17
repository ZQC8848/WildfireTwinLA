"""程序化房屋。造型与配色照着 ~/Assets/WildfireTwinLA/concepts/ 的参考图。

局部坐标：正立面朝 -Y，X 为面宽，Z 向上，原点在占地中心的地面。
部位：屋顶 PART_BURN（燃尽时消失），墙体 / 门 / 柱 PART_SOLID，玻璃 PART_GLASS。
detail=False 时只生成墙体方块加屋顶（LOD1，二十几个面）。
"""

import math
import random

from mathutils import Matrix, Vector

from lowpoly import PART_BURN, PART_GLASS, PART_SOLID, Builder, Palette

GLASS = Palette(["#3d434a", "#353a40", "#454c54"], jitter=0.04)

# 墙面：从起点开始的水平方向 u（外法线 = u × Z）
SIDES = {
    "front": lambda r: (Vector((r[0], r[1], 0)), Vector((1, 0, 0)), r[2] - r[0]),
    "right": lambda r: (Vector((r[2], r[1], 0)), Vector((0, 1, 0)), r[3] - r[1]),
    "back": lambda r: (Vector((r[2], r[3], 0)), Vector((-1, 0, 0)), r[2] - r[0]),
    "left": lambda r: (Vector((r[0], r[3], 0)), Vector((0, -1, 0)), r[3] - r[1]),
}
UP = Vector((0, 0, 1))


def walls(b: Builder, rect, z0: float, z1: float, pal, bands: int = 1) -> None:
    """矩形的四面外墙；bands > 1 时分成水平条带，各取一个颜色（工匠风格的横向墙板）。"""
    for side in SIDES:
        o, u, length = SIDES[side](rect)
        for i in range(bands):
            za = z0 + (z1 - z0) * i / bands
            zb = z0 + (z1 - z0) * (i + 1) / bands
            p = o + UP * za
            b.face([p, p + u * length, p + u * length + UP * (zb - za), p + UP * (zb - za)], pal, PART_SOLID)


def window(b: Builder, rect, side: str, s: float, z: float, w: float, h: float, frame, arch: bool = False, glass=GLASS, part=PART_GLASS) -> None:
    """在某面墙距起点 s 处开窗：先贴略大的窗框，再贴玻璃。s 为窗中心。"""
    o, u, _ = SIDES[side](rect)
    f = 0.12
    base = o + u * (s - w / 2 - f) + UP * (z - f)
    if arch:
        b.arch_on_wall(base, u, UP, w + 2 * f, h + 2 * f, frame, PART_SOLID, offset=0.03)
        b.arch_on_wall(base + u * f + UP * f, u, UP, w, h, glass, part, offset=0.05)
    else:
        b.quad_on_wall(base, u, UP, w + 2 * f, h + 2 * f, frame, PART_SOLID, offset=0.03)
        b.quad_on_wall(base + u * f + UP * f, u, UP, w, h, glass, part, offset=0.05)


def door(b: Builder, rect, side: str, s: float, w: float, h: float, pal, frame=None, arch: bool = False) -> None:
    window(b, rect, side, s, 0.0 if frame is None else 0.12, w, h - (0 if frame is None else 0.12), frame or pal, arch=arch, glass=pal, part=PART_SOLID)


def _local(rect):
    """把矩形转换成"长边沿 X"的局部坐标，返回 (半长, 半宽, 变换矩阵)。"""
    x0, y0, x1, y1 = rect
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    hx, hy = (x1 - x0) / 2, (y1 - y0) / 2
    m = Matrix.Translation((cx, cy, 0))
    if hy > hx:
        m = m @ Matrix.Rotation(math.pi / 2, 4, "Z")
        hx, hy = hy, hx
    return hx, hy, m


def hip_roof(b: Builder, rect, wall_top: float, rise: float, overhang: float, pal, soffit) -> None:
    """四坡顶：屋脊沿长边。屋面经过墙顶线，出檐处略低。"""
    hx, hy, m = _local(rect)
    slope = rise / hy
    ez = wall_top - slope * overhang
    ex, ey = hx + overhang, hy + overhang
    top = wall_top + rise
    r = max(hx - hy, 0.0)
    T = lambda x, y, z: m @ Vector((x, y, z))
    c0, c1, c2, c3 = T(-ex, -ey, ez), T(ex, -ey, ez), T(ex, ey, ez), T(-ex, ey, ez)
    r0, r1 = T(-r, 0, top), T(r, 0, top)
    b.face([c0, c1, r1, r0], pal, PART_BURN)
    b.face([c2, c3, r0, r1], pal, PART_BURN)
    b.face([c3, c0, r0], pal, PART_BURN)
    b.face([c1, c2, r1], pal, PART_BURN)
    b.face([c3, c2, c1, c0], soffit, PART_BURN)


def gable_roof(b: Builder, rect, wall_top: float, rise: float, overhang: float, pal, gable, soffit, ridge_along: str = "x", stripes=None) -> None:
    """双坡顶，两端是山墙三角。stripes=(色1, 色2, 条宽) 时屋面按条带交替着色（西班牙筒瓦）。"""
    x0, y0, x1, y1 = rect
    if ridge_along == "y":
        # 旋转 90° 复用同一套逻辑
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        m = Matrix.Translation((cx, cy, 0)) @ Matrix.Rotation(math.pi / 2, 4, "Z")
        hx, hy = (y1 - y0) / 2, (x1 - x0) / 2
    else:
        m = Matrix.Translation(((x0 + x1) / 2, (y0 + y1) / 2, 0))
        hx, hy = (x1 - x0) / 2, (y1 - y0) / 2
    T = lambda x, y, z: m @ Vector((x, y, z))
    slope = rise / hy
    ez = wall_top - slope * overhang
    top = wall_top + rise
    ex, ey = hx + overhang * 0.7, hy + overhang
    n = 1 if not stripes else max(2, int(2 * ex / stripes[2]))
    for i in range(n):
        xa = -ex + 2 * ex * i / n
        xb = -ex + 2 * ex * (i + 1) / n
        c = pal if not stripes else stripes[i % 2]
        b.face([T(xa, -ey, ez), T(xb, -ey, ez), T(xb, 0, top), T(xa, 0, top)], c, PART_BURN)
        b.face([T(xb, ey, ez), T(xa, ey, ez), T(xa, 0, top), T(xb, 0, top)], c, PART_BURN)
    # 山墙三角（墙体的一部分）
    b.face([T(-hx, hy, wall_top), T(-hx, -hy, wall_top), T(-hx, 0, top)], gable, PART_SOLID)
    b.face([T(hx, -hy, wall_top), T(hx, hy, wall_top), T(hx, 0, top)], gable, PART_SOLID)
    # 檐下
    b.face([T(-ex, -hy, ez), T(-ex, -ey, ez), T(ex, -ey, ez), T(ex, -hy, ez)][::-1], soffit, PART_BURN)
    b.face([T(ex, hy, ez), T(ex, ey, ez), T(-ex, ey, ez), T(-ex, hy, ez)][::-1], soffit, PART_BURN)


def flat_roof(b: Builder, rect, z: float, parapet: float, pal, cap) -> None:
    """平屋顶加女儿墙：外墙应已建到 z + parapet。"""
    x0, y0, x1, y1 = rect
    t = 0.25
    b.face([(x0 + t, y0 + t, z), (x1 - t, y0 + t, z), (x1 - t, y1 - t, z), (x0 + t, y1 - t, z)], pal, PART_BURN)
    zt = z + parapet
    # 女儿墙顶面与内侧
    b.face([(x0, y0, zt), (x1, y0, zt), (x1 - t, y0 + t, zt), (x0 + t, y0 + t, zt)], cap, PART_SOLID)
    b.face([(x1, y0, zt), (x1, y1, zt), (x1 - t, y1 - t, zt), (x1 - t, y0 + t, zt)], cap, PART_SOLID)
    b.face([(x1, y1, zt), (x0, y1, zt), (x0 + t, y1 - t, zt), (x1 - t, y1 - t, zt)], cap, PART_SOLID)
    b.face([(x0, y1, zt), (x0, y0, zt), (x0 + t, y0 + t, zt), (x0 + t, y1 - t, zt)], cap, PART_SOLID)
    for a, c in (((x0 + t, y0 + t), (x1 - t, y0 + t)), ((x1 - t, y0 + t), (x1 - t, y1 - t)), ((x1 - t, y1 - t), (x0 + t, y1 - t)), ((x0 + t, y1 - t), (x0 + t, y0 + t))):
        b.face([(c[0], c[1], z), (a[0], a[1], z), (a[0], a[1], zt), (c[0], c[1], zt)], cap, PART_SOLID)


# ---------------------------------------------------------------- 牧场式
RANCH_WALL = Palette(["#ded4c3", "#d6ccb9"], jitter=0.03)
RANCH_TRIM = Palette(["#bdb09d"], jitter=0.02)
RANCH_ROOF = Palette(["#505153", "#5a5b5c", "#656463"], jitter=0.04)
RANCH_GARAGE = Palette(["#988b7b", "#8f8272"], jitter=0.02)
DARK_WOOD = Palette(["#5b4636", "#51382b"], jitter=0.03)


def house_ranch(b: Builder, detail: bool, rng: random.Random) -> None:
    """单层牧场式（参考图）：长约 15 m 的低矮长条主体，低坡四坡顶、宽出檐，一端连着车库，屋顶有烟囱。"""
    flip = rng.random() < 0.5
    fx = (lambda x: -x) if flip else (lambda x: x)
    main = (min(fx(-7.5), fx(3.0)), -4.5, max(fx(-7.5), fx(3.0)), 4.5)
    garage = (min(fx(3.0), fx(7.5)), -3.8, max(fx(3.0), fx(7.5)), 4.5)
    walls(b, main, 0, 2.9, RANCH_WALL)
    walls(b, garage, 0, 2.7, RANCH_WALL)
    hip_roof(b, main, 2.9, 1.6, 0.6 if detail else 0.4, RANCH_ROOF, RANCH_TRIM)
    hip_roof(b, garage, 2.7, 1.3, 0.6 if detail else 0.4, RANCH_ROOF, RANCH_TRIM)
    if not detail:
        return
    mw = main[2] - main[0]
    for s in (0.18, 0.72):
        window(b, main, "front", mw * s, 1.0, 2.2, 1.2, RANCH_TRIM)
    door(b, main, "front", mw * 0.45 if not flip else mw * 0.55, 1.0, 2.1, DARK_WOOD, RANCH_TRIM)
    gw = garage[2] - garage[0]
    door(b, garage, "front", gw / 2, 3.4, 2.2, RANCH_GARAGE)
    for side in ("left", "right"):
        rect = main if (side == "left") != flip else garage
        window(b, rect, side, (rect[3] - rect[1]) / 2, 1.1, 1.2, 1.0, RANCH_TRIM)
    for s in (0.25, 0.6):
        window(b, main, "back", mw * s, 1.1, 1.6, 1.0, RANCH_TRIM)
    cx = fx(-4.5)
    b.box((cx - 0.4, 0.8, 2.6), (cx + 0.4, 1.6, 4.9), Palette(["#8a7f72", "#9a8f82"], jitter=0.03), PART_SOLID)


# ---------------------------------------------------------------- 工匠风格
CRAFT_SIDING = Palette(["#86826c", "#7d7a63", "#8e8a73"], jitter=0.03)
CRAFT_TRIM = Palette(["#e4d7bd", "#ddd0b6"], jitter=0.02)
CRAFT_ROOF = Palette(["#433b30", "#4e4038", "#5a4c3e"], jitter=0.04)
STONE = Palette(["#8a8780", "#9a978f", "#76736c"], jitter=0.05)


def house_craftsman(b: Builder, detail: bool, rng: random.Random) -> None:
    """工匠风格平房（参考图）：面宽约 12 m，低坡前山墙、宽出檐与外露椽头，横向墙板；
    正面是带顶的前廊，锥形木柱立在石砌柱墩上。"""
    body = (-5.0, -3.6, 5.0, 5.4)
    walls(b, body, 0.5, 3.4, CRAFT_SIDING, bands=6 if detail else 1)
    walls(b, body, 0, 0.5, STONE)
    gable_roof(b, body, 3.4, 2.4, 0.9 if detail else 0.5, CRAFT_ROOF, CRAFT_SIDING, CRAFT_TRIM, ridge_along="y")
    porch = (-5.0, -6.2, 5.0, -3.6)
    if not detail:
        b.box((porch[0], porch[1], 0), (porch[2], porch[3], 0.5), STONE, PART_SOLID)
        gable_roof(b, porch, 3.0, 1.0, 0.4, CRAFT_ROOF, CRAFT_TRIM, CRAFT_TRIM, ridge_along="y")
        return
    b.box((porch[0], porch[1], 0), (porch[2], porch[3], 0.5), STONE, PART_SOLID)
    b.box((-0.8, porch[1] - 0.9, 0), (0.8, porch[1], 0.25), STONE, PART_SOLID)  # 台阶
    gable_roof(b, porch, 3.0, 1.1, 0.5, CRAFT_ROOF, CRAFT_TRIM, CRAFT_TRIM, ridge_along="y")
    for x in (-4.5, -1.3, 1.3, 4.5):
        y = porch[1] + 0.45
        b.box((x - 0.4, y - 0.4, 0.5), (x + 0.4, y + 0.4, 1.4), STONE, PART_SOLID)
        b.tube([(x, y, 1.4), (x, y, 3.0)], [0.32, 0.2], 4, CRAFT_TRIM, PART_SOLID, cap=False)
    bw = body[2] - body[0]
    for s in (0.2, 0.8):
        window(b, body, "front", bw * s, 1.3, 1.8, 1.4, CRAFT_TRIM)
    door(b, body, "front", bw * 0.5, 1.0, 2.2, Palette(["#6b4a33"], jitter=0.03), CRAFT_TRIM)
    # 山墙上的小窗
    window(b, (body[0], body[1], body[2], body[3]), "front", bw * 0.5, 3.8, 1.4, 0.7, CRAFT_TRIM)
    for side in ("left", "right"):
        for s in (0.3, 0.7):
            window(b, body, side, (body[3] - body[1]) * s, 1.3, 1.2, 1.3, CRAFT_TRIM)
    # 外露椽头
    for side in (-1, 1):
        for y in (-2.5, 0.0, 2.5, 5.0):
            x = side * 5.0
            b.box((min(x, x + side * 0.7), y - 0.08, 3.2), (max(x, x + side * 0.7), y + 0.08, 3.35), CRAFT_TRIM, PART_BURN)


# ---------------------------------------------------------------- 西班牙复兴式
SP_WALL = Palette(["#e6dbce", "#ece3d7", "#d4c8b9"], [0.5, 0.3, 0.2], jitter=0.02)
SP_TILE_A = Palette(["#b45b3c", "#bf6442"], jitter=0.04)
SP_TILE_B = Palette(["#9c4a30", "#a3502f"], jitter=0.04)
SP_WOOD = Palette(["#51382b", "#5e4232"], jitter=0.03)


def house_spanish(b: Builder, detail: bool, rng: random.Random) -> None:
    """西班牙复兴式（参考图）：单层，白灰泥墙，红陶筒瓦低坡屋顶；主体后部横向，前部伸出一翼，
    翼正面一扇拱窗，主体正面一扇拱形入口门，檐下露出深色木椽。"""
    main = (-7.0, -1.0, 7.0, 5.0)
    wing = (-6.5, -5.0, 0.5, -1.0)
    walls(b, main, 0, 3.3, SP_WALL)
    walls(b, wing, 0, 3.0, SP_WALL)
    stripes = (SP_TILE_A, SP_TILE_B, 0.45) if detail else None
    gable_roof(b, main, 3.3, 1.5, 0.35, SP_TILE_A, SP_WALL, SP_WOOD, ridge_along="x", stripes=stripes)
    gable_roof(b, wing, 3.0, 1.4, 0.35, SP_TILE_A, SP_WALL, SP_WOOD, ridge_along="y", stripes=stripes)
    if not detail:
        return
    window(b, wing, "front", 3.5, 0.9, 1.6, 1.9, SP_WOOD, arch=True)
    door(b, main, "front", 10.5, 1.3, 2.5, SP_WOOD, SP_WOOD, arch=True)
    window(b, main, "front", 12.8, 1.1, 0.9, 1.2, SP_WOOD)
    for side, rect, s in (("left", main, 3.0), ("right", main, 3.0), ("right", wing, 2.0)):
        window(b, rect, side, s, 1.1, 1.0, 1.3, SP_WOOD)
    for s in (2.5, 7.0, 11.5):
        window(b, main, "back", s, 1.1, 1.2, 1.3, SP_WOOD)


# ---------------------------------------------------------------- 现代
MOD_WALL = Palette(["#c8c3bc", "#d9d9d4"], jitter=0.02)
MOD_WOOD = Palette(["#997b60", "#8a6c52", "#a8896b"], jitter=0.03)
MOD_ROOF = Palette(["#474542", "#525050"], jitter=0.03)
MOD_DARK = Palette(["#2e3135", "#383b3f"], jitter=0.02)


def house_modern(b: Builder, detail: bool, rng: random.Random) -> None:
    """两层现代住宅（参考图）：方正体块，平屋顶带女儿墙；二层体块偏移出挑，
    一侧是木饰面的凸出体块；大面积深色窗、深灰车库门。"""
    ground = (-7.0, -5.0, 7.0, 5.0)
    upper = (-7.0, -2.5, 2.6, 5.0)
    wood = (2.6, -3.6, 7.0, 1.4)
    walls(b, ground, 0, 3.5, MOD_WALL)
    flat_roof(b, ground, 3.2, 0.3, MOD_ROOF, MOD_WALL)
    walls(b, upper, 3.2, 6.8, MOD_WALL)
    flat_roof(b, upper, 6.5, 0.3, MOD_ROOF, MOD_WALL)
    if detail:
        # 木饰面体块：竖向木条交替着色
        x0, y0, x1, y1 = wood
        n = 8
        for i in range(n):
            xa, xb = x0 + (x1 - x0) * i / n, x0 + (x1 - x0) * (i + 1) / n
            b.face([(xa, y0, 3.2), (xb, y0, 3.2), (xb, y0, 7.0), (xa, y0, 7.0)], MOD_WOOD, PART_SOLID)
        for side in ("right", "back", "left"):
            o, u, length = SIDES[side](wood)
            p = o + UP * 3.2
            b.face([p, p + u * length, p + u * length + UP * 3.8, p + UP * 3.8], MOD_WOOD, PART_SOLID)
        b.face([(x0, y0, 7.0), (x1, y0, 7.0), (x1, y1, 7.0), (x0, y1, 7.0)], MOD_ROOF, PART_BURN)
    else:
        b.box((wood[0], wood[1], 3.2), (wood[2], wood[3], 7.0), MOD_WOOD, PART_SOLID)
    if not detail:
        return
    door(b, ground, "front", 10.5, 4.6, 2.5, MOD_DARK)
    window(b, ground, "front", 3.6, 0.5, 4.2, 2.3, MOD_DARK)
    door(b, ground, "front", 7.0, 1.0, 2.4, MOD_WOOD, MOD_DARK)
    window(b, upper, "front", 2.4, 4.0, 3.6, 1.8, MOD_DARK)
    window(b, upper, "front", 7.2, 4.0, 2.4, 1.8, MOD_DARK)
    window(b, wood, "front", 2.2, 4.3, 2.6, 1.8, MOD_DARK)
    for side, rect in (("left", ground), ("left", upper), ("back", ground), ("back", upper)):
        length = SIDES[side](rect)[2]
        window(b, rect, side, length * 0.5, 0.9 if rect is ground else 4.2, min(3.0, length * 0.4), 1.6, MOD_DARK)


# ---------------------------------------------------------------- 小公寓楼
APT_WALL = Palette(["#e1d3bd", "#d8c9b1", "#cbbaa2"], [0.5, 0.3, 0.2], jitter=0.02)
APT_ROOF = Palette(["#4d4a49", "#5a5756"], jitter=0.03)
APT_TRIM = Palette(["#f0ebe2"], jitter=0.02)
APT_RAIL = Palette(["#4d4a49", "#5d5a58"], jitter=0.03)
APT_PARK = Palette(["#2f2d2b", "#383533"], jitter=0.02)


def apartment_small(b: Builder, detail: bool, rng: random.Random) -> None:
    """三层小公寓楼（参考图）：长方体块，平屋顶带女儿墙；底层是几个开放的停车洞口，
    上两层规则排列的白框窗，正面有小阳台。"""
    rect = (-12.5, -7.5, 12.5, 7.5)
    floors, fh = 3, 2.9
    top = floors * fh
    walls(b, rect, 0, top + 0.5, APT_WALL)
    flat_roof(b, rect, top, 0.5, APT_ROOF, APT_TRIM)
    if not detail:
        return
    o, u, w = SIDES["front"](rect)
    for i in range(4):
        b.quad_on_wall(o + u * (1.5 + i * 5.7), u, UP, 4.6, 2.4, APT_PARK, PART_SOLID, offset=0.04)
    for f in range(1, floors):
        z = f * fh + 0.8
        for i in range(6):
            s = 2.3 + i * 4.08
            window(b, rect, "front", s, z, 1.5, 1.4, APT_TRIM)
        for s in (6.4, 18.6):
            x = rect[0] + s
            b.box((x - 1.6, rect[1] - 1.0, f * fh + 0.05), (x + 1.6, rect[1], f * fh + 0.25), APT_TRIM, PART_SOLID, bottom=True)
            b.box((x - 1.6, rect[1] - 1.05, f * fh + 0.25), (x + 1.6, rect[1] - 0.95, f * fh + 1.25), APT_RAIL, PART_SOLID)
    for f in range(floors):
        z = f * fh + 0.8
        for i in range(6):
            window(b, rect, "back", 2.3 + i * 4.08, z, 1.5, 1.4, APT_TRIM)
        for side in ("left", "right"):
            for s in (4.0, 11.0):
                window(b, rect, side, s, z, 1.3, 1.4, APT_TRIM)
    b.box((2.0, 1.0, top), (4.5, 3.0, top + 1.3), APT_RAIL, PART_SOLID)  # 屋顶设备


# ---------------------------------------------------------------- 消防站
FS_WALL = Palette(["#c5b59b", "#bcab90", "#cdbea5"], jitter=0.02)
FS_RED = Palette(["#a34131", "#963b2c"], jitter=0.03)
FS_ROOF = Palette(["#545251", "#5e5c5a"], jitter=0.03)
FS_TRIM = Palette(["#d9ccb6"], jitter=0.02)


def fire_station(b: Builder, detail: bool, rng: random.Random) -> None:
    """小型消防站（参考图）：单层灰泥建筑，平屋顶；正面三樘大型红色车库门（消防车库位），
    一侧是带红色百叶的晾水带塔楼，侧入口上方有小雨棚。"""
    hall = (-15.0, -10.0, 15.0, 10.0)
    tower = (-15.0, -10.0, -10.5, -5.5)
    walls(b, hall, 0, 6.0, FS_WALL)
    flat_roof(b, hall, 5.6, 0.4, FS_ROOF, FS_TRIM)
    walls(b, tower, 6.0, 11.0, FS_WALL)
    flat_roof(b, tower, 10.6, 0.4, FS_ROOF, FS_TRIM)
    if not detail:
        b.quad_on_wall((-8.0, -10.0, 0.0), (1, 0, 0), UP, 21.0, 4.4, FS_RED, PART_SOLID, offset=0.04)
        return
    for i in range(3):
        x = -7.6 + i * 7.2
        b.quad_on_wall((x - 0.2, -10.0, 0.0), (1, 0, 0), UP, 5.0, 4.8, FS_TRIM, PART_SOLID, offset=0.03)
        b.quad_on_wall((x, -10.0, 0.0), (1, 0, 0), UP, 4.6, 4.6, FS_RED, PART_SOLID, offset=0.05)
        b.quad_on_wall((x + 0.3, -10.0, 3.0), (1, 0, 0), UP, 4.0, 0.6, GLASS, PART_GLASS, offset=0.07)
    for k in range(4):
        b.quad_on_wall((tower[0] + 1.3, tower[1], 7.0 + k * 0.8), (1, 0, 0), UP, 2.0, 0.45, FS_RED, PART_SOLID, offset=0.04)
    window(b, hall, "front", 2.5, 1.6, 1.6, 1.8, FS_TRIM)
    for side in ("left", "right", "back"):
        length = SIDES[side](hall)[2]
        for s in (0.25, 0.5, 0.75):
            window(b, hall, side, length * s, 2.0, 2.0, 1.6, FS_TRIM)
    door(b, hall, "right", 4.0, 1.2, 2.4, FS_RED, FS_TRIM)
    b.box((15.0, -6.0, 2.7), (16.4, -2.0, 2.95), FS_ROOF, PART_BURN, bottom=True)  # 雨棚


# 名称 → (生成器, 变体数)
HOUSES = {
    "house-ranch": (house_ranch, 2),
    "house-craftsman": (house_craftsman, 1),
    "house-spanish": (house_spanish, 1),
    "house-modern": (house_modern, 1),
    "apartment-small": (apartment_small, 1),
    "fire-station": (fire_station, 1),
}
