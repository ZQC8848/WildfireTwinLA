"""一次性重建全部资产并导出到 web/public/models/。

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python tools/assets/build_all.py
"""

import pathlib

import bpy

HERE = pathlib.Path(__file__).resolve().parent
exec((HERE / "process_asset.py").read_text())
exec((HERE / "build_props.py").read_text())

bpy.ops.wm.read_factory_settings(use_empty=True)
for name in SPECS:
    print("RESULT", name, process(name))
print("RESULT transmission-tower", build_tower())
print("RESULT utility-pole", build_pole())
for coll in bpy.context.scene.collection.children:
    path = export(coll.name)
    print("RESULT export", coll.name, path.stat().st_size // 1024, "KB")
