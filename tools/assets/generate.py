"""程序化资产的组装、参考图对照与导出。

交互（Blender MCP）：
    import sys; sys.path.insert(0, ".../tools/assets")
    import importlib, generate; importlib.reload(generate)
    generate.build("oak-coast-live"); generate.show_reference("oak-coast-live")

后台批量：见 build_all.py。
每个资产导出一个 GLB，节点为 <name>_v<i>_LOD0 / <name>_v<i>_LOD1，都在原点。
"""

import importlib
import pathlib
import random
import zlib

import bpy

import lowpoly
import trees

importlib.reload(lowpoly)
importlib.reload(trees)
try:
    import houses

    importlib.reload(houses)
    HOUSES = houses.HOUSES
except ImportError:  # houses.py 尚未就绪时只生成树
    HOUSES = {}

CONCEPTS = pathlib.Path.home() / "Assets/WildfireTwinLA/concepts"
EXPORT = pathlib.Path(__file__).resolve().parents[2] / "web/public/models"
REF_COLL = "WTLA_References"


def registry() -> dict:
    return {**trees.TREES, **HOUSES}


def build(name: str) -> dict:
    fn, variants = registry()[name]
    coll = lowpoly.fresh_collection(name)
    stats = {}
    x = 0.0
    for v in range(variants):
        seed = zlib.crc32(f"{name}/{v}".encode())
        for lod in (0, 1):
            b = lowpoly.Builder(seed=seed + lod)
            fn(b, lod == 0, random.Random(seed))
            obj = b.to_object(f"{name}_v{v}_LOD{lod}", coll)
            stats[obj.name] = b.tris()
        # 展示用排版：变体沿 X 排开，LOD1 放在 LOD0 后方（导出时归零）
        w = max(coll.objects[f"{name}_v{v}_LOD0"].dimensions.x, coll.objects[f"{name}_v{v}_LOD0"].dimensions.y, 2)
        for lod in (0, 1):
            coll.objects[f"{name}_v{v}_LOD{lod}"].location = (x + w / 2, lod * (w + 4), 0)
        x += w + 4
    return stats


def show_reference(name: str, at=(0, 0, 0)) -> None:
    """把参考图作为图片空物体立在模型左侧，方便在视口中对照（不参与导出）。"""
    path = CONCEPTS / f"{name}.png"
    if not path.exists():
        return
    sc = lowpoly.get_scene()
    coll = bpy.data.collections.get(REF_COLL)
    if not coll:
        coll = bpy.data.collections.new(REF_COLL)
        sc.collection.children.link(coll)
    ref_name = f"ref_{name}"
    old = bpy.data.objects.get(ref_name)
    if old:
        bpy.data.objects.remove(old)
    img = bpy.data.images.load(str(path), check_existing=True)
    obj = bpy.data.objects.new(ref_name, None)
    obj.empty_display_type = "IMAGE"
    obj.data = img
    model = bpy.data.objects.get(f"{name}_v0_LOD0")
    h = model.dimensions.z if model else 10
    obj.empty_display_size = h * 1.25
    obj.rotation_euler = (1.5708, 0, 0)
    obj.location = (at[0] - h * 0.7, at[1], h * 0.6)
    coll.objects.link(obj)


def gallery() -> None:
    """展示排版：每个资产的 v0 LOD0 一字排开，参考图立在模型后方。只影响视口，不影响导出。"""
    rows = {
        0: [n for n in trees.TREES if not n.startswith("shrub") and n != "oak-coast-live-young"],
        1: ["oak-coast-live-young"] + [n for n in trees.TREES if n.startswith("shrub")],
        2: list(HOUSES) + ["transmission-tower", "utility-pole"],
    }
    for row, names in rows.items():
        x = 0.0
        for n in names:
            coll = bpy.data.collections.get(n)
            if not coll:
                continue
            for o in coll.objects:
                o.hide_set(not o.name.endswith("_v0_LOD0"))
            o = coll.objects[f"{n}_v0_LOD0"]
            w = max(o.dimensions.x, o.dimensions.y, o.dimensions.z * 0.6)
            o.location = (x + w / 2, row * 60, 0)
            show_reference(n, at=(x + w / 2 + o.dimensions.z * 0.7, row * 60 + w * 0.6 + 2, 0))
            x += w + 6


def export(name: str) -> pathlib.Path:
    EXPORT.mkdir(parents=True, exist_ok=True)
    coll = bpy.data.collections[name]
    saved = {o.name: o.location.copy() for o in coll.objects}
    for o in coll.objects:
        o.location = (0, 0, 0)
    path = EXPORT / f"{name}.glb"
    # 按集合导出，不依赖选中状态，也不切换场景（交互模式下用 temp_override 切场景会让 Blender 5.2 崩溃）
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
    for o in coll.objects:
        o.location = saved[o.name]
    return path
