# Norte 数据修复计划

2026-10-17 起，#16 的后续修复由 Qinchuan（A）接手，Tia 不再处理这些条目。背景见 [norte-fire.md](norte-fire.md)。

## 核查发现

| 问题 | 证据 | 影响 |
|---|---|---|
| 回放长达 28 小时 | `norte-replay.jsonl` 的风场一直发到 10-17 23:00Z | 模型没有灭火，T+20h 时火区内有 1,100 多栋房屋；真实火灾是 570 英亩、6 栋房屋受损 |
| 草地被判成不可燃 | `cli.py` 中 `classes = np.where(fuel > 0, 1, 0)`，而 `fuel = clip((NDVI − 0.15) / 0.6)`；10 月枯草的 NDVI 在 0.1–0.2 | 与 LANDFIRE 逐格对照：Tia 的不可燃格中 24% 是草地（GR）、14% 是草灌（GS），约 4 万格可燃燃料被当成防火带 |
| 城区绿化被判成野外植被 | 同上：NDVI 高就算植被 | Tia 的植被格中 54% 在 LANDFIRE 里是城区（NB1） |
| VIIRS 火点缺少卫星编号 | 回放的 `items` 没有 `satellite` | 前端只能显示 "VIIRS"，无法区分每次过境 |
| 疏散令时间没有出处 | 回放写的是 19:54Z（12:54 PDT），`sourceUrl` 指向 CAL FIRE 事件页；新闻和 CAL FIRE 页面都没有给出具体发布时间 | 前端把它当作官方信息显示 |
| 建筑轮廓格式不符合约定 | `buildings.json` 存的是 GeoJSON Polygon，`types.ts` 约定的是 `[lon, lat][]` | 前端已兼容（#20），但 Lucia 的脚本和约定都按数组处理 |
| 没有最终火界 | NIFC WFIGS 还没发布；Sentinel-2 最近一景是 10-16 18:38Z，起火后 5 分钟，下一景最早在 10-19 前后 | 无法计算最终 IoU |

## 修复项

**F1 回放截止到 10-17 01:00Z（18:00 PDT）**

依据：
- 最后一次 VIIRS 检测是 21:48Z；
- 00:00Z 之后风速降到 2–4 m/s；
- OCFA 发言人表示 17:45 PDT 前大部分火势已被扑灭（CBS LA）。

火界事件放在截止时刻，作为最后一条，并另外记录它的真实观测时间。

**F2 VIIRS 火点加上 `satellite` 字段**

取值为 FIRMS 的 `N`、`N20`、`N21`。

**F3 疏散令时间标为近似**

没有找到公开的发布时间。新闻显示，12:30 PDT 前后各区已在疏散。处理方式：
- 事件放在 19:30Z；
- 设 `issuedAt: null`、`timeApproximate: true`；
- 标题注明"exact issue time not published"；
- 来源列出 OCFA（经 CBS LA、KTLA 报道）。

**F4 建筑轮廓改回约定格式**

`load_buildings` 输出外环 `[lon, lat][]`（MultiPolygon 取第一个面）。现有的 `buildings.json` 按同一函数转换，不重新下载。

**F5 燃料与类别改用 LANDFIRE**

数据：LF2025 FBFM40 **2026 秋季季节燃料**（`LF2025_FBFM40_FA26`，30 m），用 LANDFIRE ImageServer 按网格范围直接导出到 25 m 网格。

- 新命令 `wildfire-source fbfm40`：下载燃料模型图。
- 新模块 `fuels.py`：Scott & Burgan 40 种燃料模型 → `fuel`（0–1，相对火行为强度）与类别。
  - NB1 城区：NDVI 显示有绿化的格子算低燃料植被（0.12，代表庭院绿化，火只能慢慢蔓延）；其余不可燃。
  - NB8 水体、NB9 裸地及其他 NB 类：不可燃。
  - GR、GS、SH、TU、TL、SB：按燃料模型取值。干燥度保留 Sentinel-2 NDMI 的结果。
  - OSM 建筑格仍为建筑类。
- `wildfire-grid --fbfm40`：完整重建时使用。
- 新命令 `wildfire-fuel`：在已有的 `grid.bin` 上重算燃料和类别。这次用它，不需要重新下载 DEM 和 Sentinel-2。
- 新增可选输出 `fuel-model.bin`：每格 1 字节，存 FBFM40 代码。前端用它显示悬停标签（草地、草灌、灌丛、城区绿化），也用它判断水面，不再靠"高程 ≤ 1 m 算海"的近似规则。

**F6 火界**

- 优先使用 NIFC WFIGS 官方火界。新增 `wildfire-norte-perimeter`，每次运行时先查 WFIGS。
- WFIGS 没有时，用火后 Sentinel-2 的 dNBR。等 10-19 之后的影像，命令先写好。
- 两者都没有时，用临时的卫星检测范围：60 个 VIIRS 像元按扫描和轨迹方向的尺寸合并，明确标为 "VIIRS-detected area (375 m pixels), not an official perimeter"。
- 前端按 `perimeterSource` 显示名称，不再一律写 "Official perimeter"。

**F7 报告受损区域（原 B6）**

用 OSM 取 Avenida Calita、Via La Mirada、Via De Agua 的路线，把路两侧 60 m 内的建筑标为 `reportedDamageArea: true`。前端增加对照图层。

**F8 验证与通知**
- `data-pipeline` 和 `server` 的测试；
- 前端类型检查；
- 无头浏览器跑一遍回放；
- 网格变了以后，请 Lucia 重跑 C1 和 C3。

可选（不在这一轮）：GOES-18 早期检测（原 B5）。

## 状态（2026-10-17，分支 `a/norte-data-fixes`）

F1–F8 已完成。GOES 不在这一轮。

| 项 | 结果 |
|---|---|
| F1 | 回放共 23 条事件，截止在 10-17 01:00Z，风场 8 条，火界是最后一条 |
| F2 | 每个 VIIRS 火点带 `satellite`（N、N20、N21） |
| F3 | 疏散令放在 19:30Z，`issuedAt: null`、`timeApproximate: true`，标题注明发布时间未公开 |
| F4 | `buildings.json` 改为 `[lon, lat][]`，坐标保留 6 位小数，文件从 24 MB 降到 19 MB |
| F5 | 不可燃从 41% 变为 52%（海 13%，其余为城区），可燃植被从 51% 变为 39%：枯草占植被 42%、草灌 51%、灌丛 2%，平均燃料 0.52。新增 `fuel-model.bin` |
| F6 | WFIGS 还没有官方火界，Sentinel-2 也没有火后影像，暂用 VIIRS 检测范围（563 ha，明确标注不是官方火界） |
| F7 | 三条街两侧 60 m 内的 212 栋建筑标为 `reportedDamageArea` |
| F8 | data-pipeline 测试 16 个、server 测试 23 个全部通过，ruff 通过，前端类型检查通过 |

真实地形回放的前后对比（无头浏览器，单次随机运行）：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 卫星像元在过境时已被模型烧到 | 37 / 60 | 55 / 60 |
| 第一次过境（13:08 PDT） | 2 / 15 | 11 / 15 |
| 回放结束时火区内房屋 | 1,100 多（T+20h） | 约 100–250（T+6h25m） |
| 报告受损区域的建筑被模型烧到 | — | 212 栋中 28 栋 |
| 与 VIIRS 检测范围的重合度 | — | 43% |

模型仍然高估房屋损失（真实为 6 栋），原因是模型里没有灭火。

需要 Lucia 在新网格上重跑 C1 和 C3。

以后有火后影像或官方火界时，按下面的步骤更新：

```bash
cd data-pipeline
uv run wildfire-norte-perimeter          # 先查 WFIGS，没有时退回 VIIRS 检测范围
# 有火后 Sentinel-2 时（B08 / B12 可用签名 COG URL）：
uv run wildfire-norte-perimeter --skip-wfigs --pre-nir PRE_B08 --pre-swir PRE_B12 \
  --post-nir POST_B08 --post-swir POST_B12 --post-time 2026-10-19T18:40:00Z
uv run wildfire-norte-replay --grid ../web/public/data/grid.json
```
