# 3D 资产清单

流程：codex-imagegen 生成白底参考图 → 确认 → **在 Blender 中用 Python 程序化建模**（照参考图的轮廓、比例与主色）→ glTF 放入 `web/public/models/`。

风格：低多边形建筑沙盘，平直着色、可见多边形切面、无贴图，颜色取自参考图的主色聚类，贴合 [ui-design.md](ui-design.md) 的色板。

文件位置：参考图在 `~/Assets/WildfireTwinLA/concepts/`（不进 git）；生成脚本在 `tools/assets/`；导出的 glTF 进仓库。

## 为什么改为程序化建模

最初用 Tripo 图生 3D，再自动减面到 500–900 面。减面算法不知道哪里是屋檐、哪里是窗框，结果出现屋顶破口、房屋低模塌成碎片、树冠与树干分不开（加纳利海枣因此一度被移除）。程序化建模只放必要的面，所以：

- 面数更低：房屋 LOD0 74–300 面（Tripo 版 500–600），针叶树 130 面（Tripo 版 900）
- 拓扑干净，没有破口
- 部位在生成时就确定，不靠颜色猜测；新增"玻璃"部位，用于夜间亮灯和火光透出
- 同一生成器换种子就是新变体，树木每种 3 个变体，没有额外成本

Tripo 的批量脚本（`tools/assets/tripo_generate.py`）保留在仓库中备用，当前资产都不依赖它。

## 参考图统一要求

- 单个物体，三分之四视角，略俯视约 20°，物体完整、居中、四周留白
- 纯白背景，柔和均匀的棚拍光，无投影、无地面、无其他物体、无文字
- 低多边形沙盘风格，可见切面，哑光纯色，无贴图、无描边
- 植被用偏灰的 chaparral 绿与鼠尾草绿，不用饱和绿
- 第一张（海岸活橡树）作为风格基准，其余以它为参考图保持一致

## 清单

| # | 文件名 | 资产 | 放置位置 | 高度 | 变体 | LOD0 / LOD1 面数 |
|---|---|---|---|---|---|---|
| 1 | `oak-coast-live` | 海岸活橡树（成年，宽冠） | 峡谷底、溪流两侧 | 约 10 m | 3 | 684 / 166 |
| 2 | `oak-coast-live-young` | 海岸活橡树（幼树） | 同上 | 约 5 m | 3 | 234 / 36 |
| 3 | `shrub-chamise` | Chamise 灌木丛 | 山坡主体植被 | 约 2 m | 3 | 328 / 26 |
| 4 | `shrub-manzanita` | Manzanita（红褐扭曲枝干） | 山坡 | 约 2.2 m | 3 | 498 / 152 |
| 5 | `shrub-scrub-oak` | 灌木栎 / toyon | 山坡、山脚 | 约 2 m | 3 | 190 / 20 |
| 6 | `pine-coulter` | Coulter 松 | 高海拔山脊 | 约 17 m | 3 | 672 / 98 |
| 7 | `fir-bigcone-douglas` | 大果黄杉 | 高海拔北坡 | 约 20 m | 3 | 130 / 54 |
| 8 | `palm-mexican-fan` | 墨西哥扇棕 | 社区道路两侧 | 约 20 m | 3 | 168 / 46 |
| 9 | `palm-canary` | 加纳利海枣 | 社区 | 约 12 m | 3 | 484 / 102 |
| 10 | `eucalyptus` | 桉树 | 社区周边、防风林 | 约 24 m | 3 | 465 / 130 |
| 11 | `house-ranch` | 单层牧场式住宅 | 建筑格 | 约 5 m | 2（车库左右镜像） | 74 / 32 |
| 12 | `house-craftsman` | 工匠风格平房 | 建筑格 | 约 6 m | 1 | 280 / 46 |
| 13 | `house-spanish` | 西班牙复兴式 | 建筑格 | 约 5 m | 1 | 244 / 36 |
| 14 | `house-modern` | 两层现代住宅 | 建筑格 | 约 7 m | 1 | 116 / 62 |
| 15 | `apartment-small` | 三层小公寓楼 | 建筑格（大面积轮廓） | 约 10 m | 1 | 300 / 26 |
| 16 | `fire-station` | 消防站 | 社区 1 处 | 约 11 m | 1 | 134 / 54 |
| 17 | `transmission-tower` | 输电铁塔 | 沿山脊 | 约 40 m | 1 | 1712 / 640 |
| 18 | `utility-pole` | 木质配电杆 | 社区街道 | 12 m | 1 | 156 / 32 |

导线不做模型，在 three 中按 `wire_points` 用悬链线生成。草地不做模型，由地表 shader 表现。

## 导出格式（`web/public/models/<name>.glb`）

| 项 | 内容 |
|---|---|
| 节点 | `<name>_v<i>_LOD0`（近景）、`<name>_v<i>_LOD1`（中景），都在原点 |
| 坐标 | 米制，Y 向上，原点在底部中心；房屋正立面朝 glTF 的 +Z（Blender 的 -Y） |
| 顶点属性 | `POSITION`、`NORMAL`、`COLOR_0`（逐面纯色，线性空间）、`_PART` |
| `_PART` | 0 = 树冠、屋顶（燃尽时消失）；1 = 树干、墙体、杆件（燃尽后变黑保留）；2 = 玻璃（夜间亮灯、火光透出） |
| 着色 | 平直着色（每个面独立顶点），无贴图 |
| extras | 输电塔、配电杆节点带 `wire_points`（glTF 坐标），用于生成导线 |

## 脚本

| 文件 | 作用 |
|---|---|
| `tools/assets/lowpoly.py` | 建模基础：管、叶团、圆锥、方块、墙面开窗，逐面颜色与部位，输出网格 |
| `tools/assets/trees.py` | 10 种树木与灌木的生成器 |
| `tools/assets/houses.py` | 6 种建筑的生成器 |
| `tools/assets/build_props.py` | 输电塔、配电杆 |
| `tools/assets/generate.py` | 组装变体与 LOD、参考图对照排版（`gallery()`）、导出 |
| `tools/assets/build_all.py` | 后台一次性重建并导出全部资产 |

在 Blender MCP 中迭代某个资产：

```python
import sys; sys.path.insert(0, "<repo>/tools/assets")
import importlib, generate; importlib.reload(generate)
generate.build("oak-coast-live"); generate.gallery()
```

重建并导出全部资产：

```bash
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python tools/assets/build_all.py
```
