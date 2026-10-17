"""一次性重建全部程序化资产并导出到 web/public/models/。

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python tools/assets/build_all.py
"""

import pathlib
import sys

import bpy

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import generate  # noqa: E402

bpy.ops.wm.read_factory_settings(use_empty=True)
for name in generate.registry():
    stats = generate.build(name)
    print("RESULT", name, stats)

exec((HERE / "build_props.py").read_text())
print("RESULT transmission-tower", build_tower())  # noqa: F821
print("RESULT utility-pole", build_pole())  # noqa: F821

for coll in bpy.context.scene.collection.children:
    path = generate.export(coll.name)
    print("RESULT export", coll.name, path.stat().st_size // 1024, "KB")
