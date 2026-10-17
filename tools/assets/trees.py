"""程序化树木与灌木。轮廓、比例和配色照着 ~/Assets/WildfireTwinLA/concepts/ 的参考图调。

每个生成器签名为 fn(b: Builder, detail: bool, rng: random.Random)：
- b 负责几何与逐面颜色（自带一个只用于颜色扰动的 rng）
- rng 决定结构（枝干方向、叶团位置），同一变体的 LOD0 / LOD1 共用同一个种子，所以轮廓一致
配色来自参考图的主色聚类（tools 中的 palette 提取结果）。
"""

import math
import random

from mathutils import Vector

from lowpoly import PART_BURN, PART_SOLID, Builder, Palette

TAU = math.tau
GOLDEN = math.pi * (3 - math.sqrt(5))


def curve(p0, direction, length, segs, bend=(0, 0, 0)):
    """从 p0 出发、沿 direction 的二次弯曲折线；bend 为末端相对直线的偏移。"""
    p0, d, bend = Vector(p0), Vector(direction).normalized(), Vector(bend)
    return [p0 + d * length * t + bend * t * t for t in (i / segs for i in range(segs + 1))]


def taper(r0, r1, n):
    return [r0 + (r1 - r0) * i / (n - 1) for i in range(n)]


def polar(r, a, z):
    return Vector((r * math.cos(a), r * math.sin(a), z))


# ---------------------------------------------------------------- 海岸活橡树
OAK_LEAF = Palette(["#333b24", "#4b5036", "#646949", "#807f5e"], [0.19, 0.32, 0.29, 0.17])
OAK_BARK = Palette(["#6a5a4a", "#7a6a58", "#5a4c3e"], jitter=0.05)


def dome_points(n: int, rng: random.Random, center, radius: float, height: float, low: float = 0.15):
    """在椭球穹顶表面上用黄金角螺旋均匀撒点，用来摆放拼成树冠的叶团。low 为穹顶下沿相对中心的高度比例。"""
    center = Vector(center)
    out = []
    for i in range(n):
        t = (i + 0.5) / n
        cos_phi = 1 - t * (1 - low)  # 从顶部到下沿
        sin_phi = math.sqrt(max(0.0, 1 - cos_phi * cos_phi))
        a = i * GOLDEN + rng.uniform(-0.25, 0.25)
        out.append(center + Vector((radius * sin_phi * math.cos(a), radius * sin_phi * math.sin(a), height * cos_phi)))
    return out


def oak_coast_live(b: Builder, detail: bool, rng: random.Random) -> None:
    """成年海岸活橡树（参考图）：高约 10 m、宽约 14 m；粗壮、扭转的主干在约 3.5 m 处分成两根大枝和一根小枝，
    向两侧大幅伸展；树冠是由许多圆形叶团紧密拼成的宽穹顶，下沿在两侧垂到约 4 m。"""
    lean = polar(rng.uniform(0.2, 0.5), rng.uniform(0, TAU), 0)
    fork = Vector((0, 0, 3.0)) + lean
    b.tube([(0, 0, 0), Vector((0, 0, 0.5)) + lean * 0.1, Vector((0, 0, 1.7)) + lean * 0.5, fork], [1.4, 1.0, 0.82, 0.72], 8 if detail else 5, OAK_BARK, PART_SOLID, cap=False, twist=0.25)
    base_a = rng.uniform(0, TAU)
    limbs = [(base_a, 0.62, 4.8), (base_a + math.pi + rng.uniform(-0.4, 0.4), 0.56, 4.4)]
    if detail:
        limbs.append((base_a + math.pi / 2 + rng.uniform(-0.5, 0.5), 0.3, 3.0))
    for a, r, reach in limbs:
        end = fork + polar(reach, a, rng.uniform(1.8, 2.6))
        pts = curve(fork, end - fork, (end - fork).length, 4 if detail else 2, bend=polar(-0.5, a, 0.9))
        b.tube(pts, taper(r, r * 0.35, len(pts)), 6 if detail else 4, OAK_BARK, PART_SOLID, twist=0.3)
    center = Vector((0, 0, 6.9)) + lean
    if detail:
        # 较多的小叶团叠在一起，轮廓更接近参考图里圆润的团簇，而不是几个大晶体
        for p in dome_points(24, rng, center, 5.4, 2.4, low=-0.2):
            s = rng.uniform(0.85, 1.15)
            b.blob(p, (1.55 * s, 1.55 * s, 1.3 * s), OAK_LEAF, PART_BURN, jitter=0.22)
    else:
        for p in dome_points(5, rng, center, 3.6, 1.8, low=-0.1):
            b.blob(p, (3.0, 3.0, 2.2), OAK_LEAF, PART_BURN)


def oak_coast_live_young(b: Builder, detail: bool, rng: random.Random) -> None:
    """幼年海岸活橡树（参考图）：高约 5 m，单根略倾斜、偏粗的主干在约 1.9 m 处分出两三根短枝，
    上面是比主干宽得多的圆形树冠，由几个叶团拼成。"""
    lean = polar(rng.uniform(0.15, 0.35), rng.uniform(0, TAU), 0)
    fork = Vector((0, 0, 1.9)) + lean
    b.tube([(0, 0, 0), Vector((0, 0, 0.9)) + lean * 0.4, fork], [0.34, 0.27, 0.23], 6 if detail else 4, OAK_BARK, PART_SOLID, cap=False, twist=0.2)
    if detail:
        for i in range(3):
            a = rng.uniform(0, TAU)
            b.tube([fork, fork + polar(0.9, a, 1.1)], [0.15, 0.07], 4, OAK_BARK, PART_SOLID)
    center = fork + Vector((0, 0, 1.6))
    if detail:
        for p in dome_points(9, rng, center, 1.35, 1.1, low=-0.35):
            s = rng.uniform(0.9, 1.1)
            b.blob(p, (0.95 * s, 0.95 * s, 0.85 * s), OAK_LEAF, PART_BURN, jitter=0.2)
    else:
        b.blob(center + Vector((0, 0, 0.2)), (2.0, 2.0, 1.5), OAK_LEAF, PART_BURN)


# ---------------------------------------------------------------- 灌木
CHAMISE_LEAF = Palette(["#3f422d", "#55593d", "#6e724d", "#8d8d62"], [0.24, 0.3, 0.27, 0.15], jitter=0.08)
STEM = Palette(["#5c5040", "#6a5d4b"], jitter=0.05)


def shrub_chamise(b: Builder, detail: bool, rng: random.Random) -> None:
    """Chamise（参考图）：高约 1.8 m、宽约 2.4 m 的密实圆团，细密针状叶，所以叶团多而小、扰动大；
    底部能看到几根细枝。"""
    if detail:
        for i in range(6):
            a = i * TAU / 6 + rng.uniform(-0.3, 0.3)
            b.tube([(0, 0, 0), polar(0.4, a, 0.35), polar(0.8, a, 0.6)], [0.05, 0.035, 0.02], 4, STEM, PART_SOLID)
        for p in dome_points(11, rng, (0, 0, 0.85), 0.85, 0.75, low=-0.3):
            s = rng.uniform(0.85, 1.1)
            b.blob(p, (0.52 * s, 0.52 * s, 0.5 * s), CHAMISE_LEAF, PART_BURN, jitter=0.32, flatten_bottom=0.3)
    else:
        b.tube([(0, 0, 0), (0, 0, 0.5)], [0.06, 0.05], 3, STEM, PART_SOLID, cap=False)
        b.blob((0, 0, 0.95), (1.2, 1.2, 0.85), CHAMISE_LEAF, PART_BURN, jitter=0.25, flatten_bottom=0.5)


MANZ_BARK = Palette(["#7f4837", "#6e3b2c", "#8f5440"], jitter=0.05)
MANZ_LEAF = Palette(["#5a6040", "#676d46", "#8a895c"], [0.3, 0.4, 0.3])


def shrub_manzanita(b: Builder, detail: bool, rng: random.Random) -> None:
    """Manzanita（参考图）：高约 2.2 m、宽约 3.4 m；从基部放射出 5~6 根光滑扭曲的红褐色枝干，
    向外铺开并再分叉，枝端托着许多小叶团，枝干在叶团之间清楚可见。"""
    n = 6 if detail else 4
    base_a = rng.uniform(0, TAU)
    for i in range(n):
        a = base_a + TAU * i / n + rng.uniform(-0.25, 0.25)
        end = polar(rng.uniform(1.1, 1.5), a, rng.uniform(1.1, 1.5))
        pts = curve((0, 0, 0.05), end, end.length, 3 if detail else 2, bend=polar(0.3, a + 1.3, -0.2))
        b.tube(pts, taper(0.11, 0.04, len(pts)), 5 if detail else 4, MANZ_BARK, PART_SOLID, twist=0.5)
        if detail:
            mid = pts[len(pts) // 2]
            sub = mid + polar(rng.uniform(0.5, 0.8), a + rng.choice((-1, 1)) * 0.9, 0.5)
            b.tube([mid, sub], [0.05, 0.025], 4, MANZ_BARK, PART_SOLID)
            b.blob(sub + Vector((0, 0, 0.2)), (0.42, 0.42, 0.36), MANZ_LEAF, PART_BURN)
            b.blob(end + Vector((0, 0, 0.25)), (0.5, 0.5, 0.42), MANZ_LEAF, PART_BURN)
        else:
            b.blob(end + Vector((0, 0, 0.25)), (0.8, 0.8, 0.6), MANZ_LEAF, PART_BURN)


SCRUB_LEAF = Palette(["#394025", "#4f5936", "#677247", "#7f8856"], [0.14, 0.31, 0.3, 0.22])


def shrub_scrub_oak(b: Builder, detail: bool, rng: random.Random) -> None:
    """灌木栎 / toyon：低矮密实、宽约 3.5 m，不规则叶团贴近地面。"""
    if detail:
        for i in range(3):
            a = rng.uniform(0, TAU)
            b.tube([(0, 0, 0), polar(0.3, a, 0.5)], [0.07, 0.04], 4, STEM, PART_SOLID)
        for i in range(8):
            a = i * GOLDEN + rng.uniform(-0.3, 0.3)
            r = 0.2 if i == 0 else rng.uniform(0.7, 1.15)
            b.blob(polar(r, a, rng.uniform(0.75, 1.3)), (0.8, 0.8, 0.65), SCRUB_LEAF, PART_BURN, flatten_bottom=0.4)
    else:
        b.blob((0, 0, 0.9), (1.75, 1.6, 0.95), SCRUB_LEAF, PART_BURN, flatten_bottom=0.6)


# ---------------------------------------------------------------- 针叶树
PINE_LEAF = Palette(["#40442f", "#595a3e", "#74724f", "#938e6b"], [0.29, 0.3, 0.26, 0.1])
PINE_BARK = Palette(["#6b5846", "#5b4a3b", "#7a6550"], jitter=0.05)


def pine_coulter(b: Builder, detail: bool, rng: random.Random) -> None:
    """Coulter 松（参考图）：高约 17 m，粗直的主干，冠部从约 5 m 起由分层的簇状针叶团组成，
    下层宽、上层窄，整体是不规则的宽锥形。"""
    wob = lambda z: Vector((0.15 * math.sin(z * 0.4), 0.1 * math.cos(z * 0.3), z))
    zs = [0, 4, 8, 12, 15.5, 16.8] if detail else [0, 8, 16.8]
    b.tube([wob(z) for z in zs], taper(0.6, 0.08, len(zs)), 6 if detail else 4, PINE_BARK, PART_SOLID)
    if detail:
        tiers = [5.2, 7.0, 8.8, 10.6, 12.3, 14.0]
        k = 0
        for t, z in enumerate(tiers):
            length = 3.3 - 0.4 * t
            for j in range(4 if t < 3 else 3):
                a = k * GOLDEN + rng.uniform(-0.2, 0.2)
                k += 1
                start = wob(z)
                end = start + polar(length, a, rng.uniform(0.1, 0.5))
                b.tube([start, end], [0.14, 0.05], 4, PINE_BARK, PART_SOLID, cap=False)
                s = 1.0 + 0.3 * (1 - t / len(tiers))
                b.blob(end + Vector((0, 0, 0.2)), (1.25 * s, 1.25 * s, 0.85 * s), PINE_LEAF, PART_BURN, jitter=0.25)
        b.blob(wob(15.8), (1.1, 1.1, 1.2), PINE_LEAF, PART_BURN, jitter=0.25)
    else:
        for z, r in ((6.8, 3.2), (10.2, 2.7), (13.4, 2.0), (15.9, 1.2)):
            b.blob(wob(z), (r, r, 1.7), PINE_LEAF, PART_BURN)


FIR_LEAF = Palette(["#303b2b", "#43513f", "#5d6a51"], [0.25, 0.45, 0.3])


def fir_bigcone_douglas(b: Builder, detail: bool, rng: random.Random) -> None:
    """大果黄杉：高约 20 m 的窄锥形，分层枝条向下扫，深蓝绿色。"""
    b.tube([(0, 0, 0), (0, 0, 3.5)], [0.4, 0.33], 6 if detail else 4, PINE_BARK, PART_SOLID, cap=False)
    tiers = 8 if detail else 4
    for i in range(tiers):
        t = i / (tiers - 1)
        z = 3.0 + t * 14.0
        radius = 4.3 * (1 - t) + 0.9 * t
        height = 3.6 * (1 - t) + 2.4 * t
        b.cone((0, 0, z), radius, height * (1.0 if detail else 1.6), 8 if detail else 6, FIR_LEAF, PART_BURN, droop=0.9 * (1 - t) + 0.3, jitter=0.12)
    b.cone((0, 0, 17.8), 0.7, 2.0, 6, FIR_LEAF, PART_BURN, base_cap=False)


# ---------------------------------------------------------------- 棕榈
FAN_TRUNK = Palette(["#a29883", "#8f8574", "#b0a690"], jitter=0.04)
FAN_SKIRT = Palette(["#8a7a62", "#a29883", "#6f5f4a", "#bbb4a5"], [0.35, 0.3, 0.2, 0.15])
FAN_LEAF = Palette(["#636552", "#7f826b", "#8f9278"], [0.3, 0.45, 0.25])


def palm_mexican_fan(b: Builder, detail: bool, rng: random.Random) -> None:
    """墨西哥扇棕（参考图）：高约 20 m，极细的直树干；顶部是小而圆的扇形叶冠，
    冠下一圈蓬松的枯叶"裙子"，颜色是棕褐和浅黄褐。"""
    bend = polar(rng.uniform(0.3, 0.8), rng.uniform(0, TAU), 0)
    zs = [0, 4, 8, 12, 15, 17.2] if detail else [0, 9, 17.2]
    pts = [Vector((0, 0, z)) + bend * (z / 17.2) ** 2 for z in zs]
    band = lambda i, k: FAN_TRUNK if i % 2 == 0 else Palette(["#958b77"], jitter=0.03)
    b.tube(pts, taper(0.36, 0.25, len(pts)), 6 if detail else 4, band if detail else FAN_TRUNK, PART_SOLID, cap=False)
    top = pts[-1]
    # 枯叶裙：上窄下宽，下沿参差
    sides = 9 if detail else 5
    ring_top, ring_bot = [], []
    off = rng.uniform(0, TAU)
    for k in range(sides):
        a = off + TAU * k / sides
        ring_top.append(top + polar(0.4, a, 1.2))
        ring_bot.append(top + polar(rng.uniform(0.8, 1.0), a, rng.uniform(-1.5, -1.0)))
    for k in range(sides):
        j = (k + 1) % sides
        b.face([ring_bot[k], ring_bot[j], ring_top[j], ring_top[k]], FAN_SKIRT, PART_BURN)
    crown = top + Vector((0, 0, 1.6))
    if not detail:
        b.blob(crown, (1.8, 1.8, 1.3), FAN_LEAF, PART_BURN)
        return
    b.blob(crown, (0.55, 0.55, 0.45), FAN_LEAF, PART_BURN)
    for i in range(14):
        a = i * GOLDEN
        elev = rng.uniform(-0.35, 1.0)  # 叶柄仰角（弧度），有上扬也有下垂，冠形接近球
        d = Vector((math.cos(a) * math.cos(elev), math.sin(a) * math.cos(elev), math.sin(elev)))
        c = crown + d * 1.1
        b.face([crown + Vector((0, 0, 0.06)), c, crown - Vector((0, 0, 0.06))], FAN_LEAF, PART_BURN)
        side = Vector((-math.sin(a), math.cos(a), 0))
        out = (d + Vector((0, 0, 0.25))).normalized()
        rim = [c + (side * math.cos(t) + out * math.sin(t)) * 1.5 for t in (math.pi * j / 4 for j in range(5))]
        for j in range(4):
            b.face([c, rim[j], rim[j + 1]], FAN_LEAF, PART_BURN)


CANARY_TRUNK_A = Palette(["#7a5c42"], jitter=0.04)
CANARY_TRUNK_B = Palette(["#5e4532"], jitter=0.04)
CANARY_LEAF = Palette(["#4d5137", "#656847", "#7e7e57", "#99956b"], [0.21, 0.32, 0.25, 0.17])


def palm_canary(b: Builder, detail: bool, rng: random.Random) -> None:
    """加纳利海枣（参考图）：高约 12 m，粗壮的菱形纹树干约占 6 m；顶部是又大又密的拱形羽状叶冠，
    宽度接近整株高度，外圈叶片下垂到树干中部。"""
    zs = [0, 1.2, 2.4, 3.6, 4.8, 6.0] if detail else [0, 6.0]
    diamond = lambda i, k: CANARY_TRUNK_A if (i + k) % 2 == 0 else CANARY_TRUNK_B
    b.tube([(0, 0, z) for z in zs], taper(0.7, 0.58, len(zs)), 8 if detail else 5, diamond if detail else CANARY_TRUNK_A, PART_SOLID, cap=False, twist=0.39)
    crown = Vector((0, 0, 6.6))
    b.blob(crown, (1.0, 1.0, 0.9), CANARY_LEAF, PART_BURN)
    n, segs = (24, 4) if detail else (9, 2)
    for i in range(n):
        a = i * GOLDEN + rng.uniform(-0.1, 0.1)
        t = i / n
        elev = 1.35 - 1.1 * t + rng.uniform(-0.1, 0.1)  # 先生成的叶片更直立，后面的更平展
        length = rng.uniform(6.4, 7.6)
        out = Vector((math.cos(a), math.sin(a), 0))
        side = Vector((-math.sin(a), math.cos(a), 0))
        pts, p = [crown], crown.copy()
        v = (out * math.cos(elev) + Vector((0, 0, math.sin(elev)))) * (length / segs)
        for s_ in range(segs):
            p = p + v
            v = v + Vector((0, 0, -0.5 * length / segs))
            pts.append(p.copy())
        for s_ in range(segs):
            w0 = 1.0 * math.sin(math.pi * (s_ + 0.3) / (segs + 0.3)) + 0.12
            w1 = 1.0 * math.sin(math.pi * (s_ + 1.3) / (segs + 0.3)) + 0.12 if s_ + 1 < segs else 0.0
            p0, p1 = pts[s_], pts[s_ + 1]
            drop = Vector((0, 0, 0.18))  # 中肋略高、两侧略低，形成 V 形折面
            for sgn in (-1, 1):
                b.face([p0, p0 + side * w0 * sgn - drop, p1 + side * w1 * sgn - drop, p1], CANARY_LEAF, PART_BURN)


# ---------------------------------------------------------------- 桉树
EUC_BARK = Palette(["#b8b2a6", "#9a9a8d", "#a89a86", "#88796c", "#cec8c0"], [0.25, 0.25, 0.2, 0.15, 0.15], jitter=0.04)
EUC_LEAF = Palette(["#5a6257", "#6a7766", "#758275", "#8a9a8c"], [0.3, 0.3, 0.25, 0.15])


def eucalyptus(b: Builder, detail: bool, rng: random.Random) -> None:
    """桉树（参考图）：高约 24 m；斑驳的浅灰褐树干略弯，在约 8 m 处分成主枝，主枝再分出侧枝；
    叶子是许多沿枝条分布、竖向拉长、下垂的小叶簇，冠形稀疏通透，看得到枝干。"""
    lean = polar(rng.uniform(0.4, 0.9), rng.uniform(0, TAU), 0)
    fork = Vector((0, 0, 8)) + lean
    b.tube([(0, 0, 0), Vector((0, 0, 4)) + lean * 0.3, fork], [0.62, 0.5, 0.42], 6 if detail else 4, EUC_BARK, PART_SOLID, cap=False, twist=0.2)
    n = 3
    base_a = rng.uniform(0, TAU)
    for i in range(n):
        a = base_a + TAU * i / n + rng.uniform(-0.3, 0.3)
        end = fork + polar(rng.uniform(3.0, 4.8), a, rng.uniform(11, 14))
        pts = curve(fork, end - fork, (end - fork).length, 4 if detail else 2, bend=polar(-1.2, a, -0.8))
        b.tube(pts, taper(0.36, 0.1, len(pts)), 5 if detail else 4, EUC_BARK, PART_SOLID)
        if not detail:
            b.blob(pts[-1] - Vector((0, 0, 1.0)), (2.6, 2.6, 3.4), EUC_LEAF, PART_BURN, jitter=0.25)
            continue
        b.blob(pts[-1] - Vector((0, 0, 0.6)), (1.1, 1.1, 1.7), EUC_LEAF, PART_BURN, jitter=0.3)
        for frac in (0.45, 0.65, 0.85):
            p = pts[1] + (pts[-1] - pts[1]) * frac
            aa = a + rng.choice((-1, 1)) * rng.uniform(0.7, 1.4)
            tip = p + polar(rng.uniform(1.8, 2.8), aa, rng.uniform(0.6, 1.4))
            b.tube([p, tip], [0.1, 0.04], 4, EUC_BARK, PART_SOLID, cap=False)
            b.blob(tip - Vector((0, 0, 0.9)), (0.95, 0.95, 1.6), EUC_LEAF, PART_BURN, jitter=0.3)


TREES = {
    "oak-coast-live": (oak_coast_live, 3),
    "oak-coast-live-young": (oak_coast_live_young, 3),
    "shrub-chamise": (shrub_chamise, 3),
    "shrub-manzanita": (shrub_manzanita, 3),
    "shrub-scrub-oak": (shrub_scrub_oak, 3),
    "pine-coulter": (pine_coulter, 3),
    "fir-bigcone-douglas": (fir_bigcone_douglas, 3),
    "palm-mexican-fan": (palm_mexican_fan, 3),
    "palm-canary": (palm_canary, 3),
    "eucalyptus": (eucalyptus, 3),
}
