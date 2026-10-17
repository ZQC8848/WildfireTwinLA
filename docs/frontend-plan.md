# 前端执行计划（角色 A）

负责人：Qinchuan　分支：`a/web-frontend`　目录：`web/`

前端负责 3D 场景、GPU 火势模拟、集合预报、交互和实时数据显示。所有跨模块交互遵守 [team-plan.md](team-plan.md) 的四份接口约定；每个阶段都先用本地假数据跑通，不依赖 Tia（后端）和 Lucia（算法）的进度。

## 界面语言

**所有前端内容保持英文**：页面上的文字、HUD、面板、按钮、lil-gui 标签、提示与告警文案、图例、`console` 日志和抛出的错误信息都用英文，`<html lang="en">`。社区名、数据源名等专有名词沿用英文原名。代码注释不受此限制。

## 界面设计

页面布局、颜色、字体与 Plan / Respond 双模式见 [ui-design.md](ui-design.md)。P1 之后先做 P1.5 界面骨架，后续阶段的面板都挂到这套骨架上。

## 技术选型

| 项 | 选择 | 说明 |
|---|---|---|
| 构建 | Vite + TypeScript | — |
| 3D | three（安装时锁定当前稳定版） | `GPUComputationRenderer`、`EffectComposer`、`UnrealBloomPass` 来自 `three/examples/jsm` |
| 调参面板 | lil-gui | 图层切换、风速风向、模拟速度 |
| 业务面板 | 原生 TS + HTML/CSS | 方案对比、告警列表；不引入 React，减少依赖 |
| 渲染后端 | WebGL2 | 需要 `EXT_color_buffer_float`；启动时检测，不支持则提示 |
| 共享代码 | `packages/core`（Lucia 维护） | 通过 Vite alias `@core` 引用 |

## 目录结构

```
web/
├── index.html
├── vite.config.ts            alias @core → ../packages/core/src
├── src/
│   ├── main.ts               入口：初始化场景、加载数据、挂 UI
│   ├── data/
│   │   ├── loadGrid.ts       读 grid.json + grid.bin，失败时回退到 mock
│   │   └── mockGrid.ts       高斯山包合成网格 + 假建筑 + 假社区
│   ├── scene/
│   │   ├── terrain.ts        地形 mesh 与地表 ShaderMaterial
│   │   ├── buildings.ts      InstancedMesh 建筑
│   │   ├── smoke.ts          烟雾粒子
│   │   ├── markers.ts        火点标记
│   │   └── post.ts           Bloom 等后处理
│   ├── sim/
│   │   ├── ca.ts             单次 GPU 元胞自动机
│   │   ├── ensemble.ts       64 路图集集合预报 + 统计
│   │   ├── shaders/          *.glsl（spread、spotting、accumulate、ignite）
│   │   └── cpuReference.ts   CPU 参考实现，用于正确性对照与 benchmark
│   ├── interact/
│   │   ├── picking.ts        射线拾取 → 格子索引
│   │   ├── brush.ts          处理区笔刷 → 处理掩膜
│   │   └── timeline.ts       时间轴
│   ├── net/
│   │   ├── socket.ts         ServerMsg 客户端，live / replay
│   │   └── mockServer.ts     本地假消息源
│   ├── planner/
│   │   └── client.ts         调用 core Worker 的 computeArrival / planTreatments / evaluate
│   └── ui/
│       ├── gui.ts            lil-gui
│       └── panels.ts         方案对比、告警、通话状态
└── public/data/              → 软链或拷贝自仓库根 public/data
```

## 分阶段计划

### P0 骨架

**目标**：项目能跑起来，并确定共享文件的初版。

- 在 `web/` 初始化 Vite + TS，装 three、lil-gui；配置 `@core` alias。
- 按 team-plan 的约定 1–3 写出 `packages/core/src/types.ts` 和 `params.ts` 初版，**提 PR 请 Tia、Lucia 确认后冻结**。之后由 Lucia 维护。
- `mockGrid.ts`：512×512，若干高斯山包叠加噪声作高程；fuel、dryness 用低频噪声；山脚一片区域标为建筑类别；生成 2–3 个假社区。导出格式与约定 1 完全一致。
- 场景、相机、`OrbitControls`、窗口自适应、FPS 显示（`stats.js`）。

**验收**：`npm run dev` 打开页面能看到场景；`loadGrid()` 在没有真实数据时返回 mock，类型与 `GridMeta` 一致。

### P1 地形与图层

**目标**：把网格渲染成可切换图层的 3D 地形。

- 网格数据打包为 `DataTexture`（RGBA Float32）。
- `PlaneGeometry(width·cellSize, height·cellSize, 511, 511)`，vertex shader 读高程位移；法线用相邻高程差在 shader 中计算，高程可加竖向夸张系数。
- 地表 fragment shader 的图层：高程晕渲、燃料热力图、干燥度、类别（不可燃/植被/建筑）、卫星底图（有纹理时）。
- 坐标约定：格子 `cell = y * width + x`，y 由北向南；世界坐标 x 向东、z 向南。写一对函数 `cellToWorld()` / `worldToCell()`，内部调用 core 的换算。
- lil-gui 切换图层、调竖向夸张。

**验收**：mock 地形能看出山脊与山谷；切换图层正确；鼠标悬停显示格子坐标、高程、燃料值。

### P1.5 界面骨架

> **状态：已完成**（分支 `a/p1.5-ui-shell`），按 [ui-design.md](ui-design.md) 实现：
> - `ui/tokens.css`：六个基础色、Barlow 三种宽度（自托管）、字号阶梯；`body[data-mode]` 两套取值。
> - `ui/shell.ts` / `shell.css`：顶栏（Plan / Respond 切换、Respond 下显示模拟时钟）、左侧简报侧栏、底部控制条（运行 / 单步 / 重置、速度、风向风速、地形风 / 均匀风）、地图浮层（悬停信息、图层与图例、风玫瑰）。
> - Plan 侧栏：区域概况、"Test a fire" 统计（燃烧面积、受影响房屋、到达的社区）。处理工具与方案对比留给 P4。
> - Respond 侧栏：最近社区（已到达时显示受影响房屋数，否则按当前推进速度外推的到达时间，再否则显示距离）、社区列表与告警等级、受影响房屋、事件流。数据来自 `sim/fireMonitor.ts`，全部由模拟状态计算，不是假数据。外呼状态留给 P5。
> - 模式切换：界面颜色由 CSS 过渡，场景天色、雾、地形与模型亮度、烟雾在 1.2 秒内同步过渡；`prefers-reduced-motion` 下立即切换。
> - lil-gui、HUD、FPS 只在 `?debug` 下出现；窄屏（< 900px）侧栏改为底部抽屉。
> - 调试 URL 新增 `?mode=respond`。

### P1.6 场景模型（已提前完成）

原属 P6 的建筑与植被模型提前接入，资产见 [assets.md](assets.md)。

- `scene/props/assets.ts`：读取 18 个低多边形 GLB（变体 × LOD0/LOD1）。
- `scene/props/placement.ts`：确定性布局。植被按燃料量（每格最多 5 株）、海拔、坡向、是否临水选树种；社区内是稀疏的院落树与街道棕榈；建筑按轮廓的长边定朝向、按尺寸选样式与缩放，社区中心放消防站；山地一条输电线、社区道路沿线配电杆。
- `scene/props/propField.ts`：每个"资产 × 变体 × LOD"一次 draw call；32×32 格分块，相机移动后按距离与视锥为每块选 LOD0 / LOD1 / 不显示。越高的物体可见距离越远。
- `scene/props/propMaterial.ts`：显示高度在 shader 中按竖向夸张计算；按格子火灾状态显示燃烧火光、燃尽后树冠与屋顶消失；玻璃在夜间亮灯。
- 状态接口：`uState`（P2 的状态纹理，R 通道 0/1/2）+ `uUseState`。P2 完成前用"Burn preview"圆环验证，地形与模型共用同一组预览参数。
- 调试：`?cam=x,y,z,tx,ty,tz` 指定相机，`?burn=<半径>` 直接显示燃烧预览。

### P2 GPU 元胞自动机（单次模拟）

> **状态：已完成**（分支 `a/p2-fire-sim`），实现见 `web/src/sim/`：
> - `shaders.ts`：Alexandridis 规则加飞火（沿上风方向按对数正态距离采样，建筑只能被飞火点燃），随机数用 PCG 整数哈希。
> - `fireSim.ts`：两张 RGBA32F 渲染目标交替更新（ping-pong），按掩膜点火，异步读回统计燃烧格、受影响面积和受波及的建筑格。
> - `wind.ts`：按 core 的新 `WindField`（单一风况或 W×H 采样）生成风场纹理，在速度分量上双线性插值，与 `core.windAt` 一致。
> - `cpuReference.ts`：规则与随机数完全相同的 CPU 实现。合成网格上跑 80 步对照：GPU 62,840 格，CPU 62,806 格，IoU 99.7%。
> - 地形与模型直接读取状态纹理 `uState`，取代燃烧预览。
> - 交互：点击地形点火；运行、单步、重置；调节步速、风速、风向、飞火开关、随机种子；"Check against CPU" 按钮。
> - 调试 URL：`?wind=速度,来向&ignite=x,y&steps=N`，`?cpucheck=N`。
>
> 与原计划的差异：没有用 `GPUComputationRenderer`，改为自写 ping-pong（`FullScreenQuad` 加两个渲染目标），因为点火和重置需要额外的绘制通道。

**目标**：在地形上看到火按坡度、风、燃料蔓延。

- `GPUComputationRenderer` 建状态变量（RGBA Float），ping-pong 更新。通道：R 状态、G 已燃步数、B 到达时间、A 处理标记。
- `spread.glsl`：按 Alexandridis 公式计算 8 邻域点燃概率；常量从 `params.ts` 读成 uniform；PCG hash 随机数，种子每步更新。
- 风场：5×5 的 `[speed, dirFrom]` 打包为小纹理，shader 内双线性插值；lil-gui 提供全局风速、风向覆盖。
- 点火：射线拾取到格子，`ignite.glsl` 把指定格子写成燃烧状态（批量点火用一张小的点火列表纹理）。
- 地表 shader 读状态纹理叠加显示：燃烧中为自发光橙红加 noise 闪烁，已燃尽为焦黑。
- 控制：播放、暂停、单步、速度倍率、重置。
- `cpuReference.ts`：同一规则的 CPU 版本（固定种子），用于对照。

**验收**：
- 无风平地上近似圆形扩散；上坡方向明显更快；顺风方向拉长。
- 不可燃格（道路、水体）挡住蔓延。
- 固定种子下，GPU 与 CPU 参考实现的燃烧面积曲线趋势一致。

### P3 飞火与集合预报

**目标**：加入飞火，并用 64 路并行模拟得到燃烧概率和到达时间分布。

- `spotting`：每个未燃格在上风方向采样 M 个点，距离服从对数正态分布（均值 `distMeanPerWindMs · V`），采样点燃烧则以 `pBase · fuel · dryness` 概率点燃；建筑格乘飞火易损系数（受 Zone 0 处理影响）。
- **图集与显存**：64 路 × 512² 的 RGBA32F 图集达 4096²，单张约 256 MB，ping-pong 需两张，不可接受。方案：集合预报在 **256×256** 降采样网格上运行，8×8 图集为 2048²，状态用 **RGBA16F**（到达时间以分钟存，半精度上限 65504 足够），单张约 32 MB。单次高清模拟（P2）仍用 512²。
- 每个 tile 的种子、风速风向扰动（±15° 风向、±20% 风速）作为 tile 索引的函数在 shader 中计算；邻格查找钳制在 tile 内。
- `accumulate.glsl`：把 64 个 tile 归约到 256² 统计纹理，输出燃烧概率与到达时间的 P50、P90（P50/P90 用直方图分桶近似，或输出均值与方差）。
- 地表新增图层：燃烧概率（半透明红色渐变）、到达时间等时线（`fract(arrival/Δ)` + `fwidth` 抗锯齿，每小时一条）。
- Benchmark：CPU 参考实现串行 64 次 vs GPU 一次推进，记录耗时，写入 README。

**验收**：风速调高时燃烧概率图出现下风方向的离散斑点（飞火）；等时线随风向变形；benchmark 有可复现的数字。

### P4 防控交互与方案对比

**目标**：实现"人工 prevent + 算法控制"的界面闭环。

- `brush.ts`：在地形上拖拽绘制处理区，可选半径和类型（break / burn / thin / zone0）；结果写入 `Uint8Array` 处理掩膜（约定 3），同步上传为纹理。
- 地表 shader 读掩膜，用不同颜色的斜线纹理显示处理区；模拟 shader 读掩膜应用 `TreatmentEffect`。
- `planner/client.ts`：通过 Worker 调用 core 的三个函数。Lucia 的真实现完成前，使用约定中的假实现（直线防火带、随机指标）。
- 方案面板：人工方案、贪心方案、最小割方案三列，显示 `Metrics`（受威胁建筑、燃烧面积、成本、每美元减少损失）；点哪一列就在地形上显示哪个方案。
- 风速滑块联动：改变风速后重跑集合预报，各方案指标刷新。
- "算法补全"按钮：把当前人工处理作为 `fixed` 传给 `planTreatments`。

**验收**：画一条防火带后，集合预报的燃烧概率在防火带后方明显下降；三种方案可切换对比；所有交互只通过约定 3 的接口与 core 交互。

### P5 实时数据与回放

**目标**：接入后端事件流，支持 live 与 Eaton replay 两种模式。

- `socket.ts`：连接后端 WebSocket，按 `ServerMsg` 类型分发；断线自动重连。`mockServer.ts` 在后端未就绪时按固定节奏模拟同样的消息。
- `hotspots`：用 InstancedMesh 在地形上显示火点（颜色按来源，大小按 FRP）；同时把对应格子注入单次模拟与集合预报的初始状态（同化）。
- `incident.perimeterCells`：有官方火界时，把内部格子设为已燃尽。
- `wind`：更新风场纹理并触发集合预报重算。
- `alert`：社区上方显示告警徽标（watch / warning / imminent 三色）和 ETA；告警列表面板。
- `call_status`：对应建筑着色（确认 / 未接通 / 需要协助）。
- 模式切换：URL 参数 `?mode=live` / `?mode=replay&event=eaton`；回放模式下时间轴驱动消息时间。

**验收**：在 `replay=eaton` 下从起火开始回放，火点随时间出现、模拟随之推进、社区告警依次触发。

### P6 视觉与场景完整度

**目标**：把场景做到可以直接用于 demo 和 pitch。

- 建筑：读取 `buildings.json`，InstancedMesh 挤出块；按风险着色（白 / 琥珀 / 闪烁红）。
- 烟雾：燃烧格生成实例化 billboard 粒子，按风场平流，透明度随高度衰减；粒子数量上限可调。
- 后处理：`UnrealBloomPass` 让火线发光；可选轻微雾效增加纵深。
- 卫星底图：使用 Tia 导出的与网格对齐的真彩色纹理。
- 时间轴：拖动只改 uniform `currentTime`，`arrival < currentTime` 的格子显示为已烧，可来回拖动。
- 相机预设：全景、火头特写、社区近景，带平滑过渡，用于演示。
- 可选：Google Photorealistic 3D Tiles（`3d-tiles-renderer` + `GoogleCloudAuthPlugin`），拉近到社区时显示真实建筑；仅作视觉，不参与模拟。

**验收**：一镜到底的演示流程画面完整，主流笔记本上保持流畅帧率。

### P7 Demo 整合与发布

**目标**：串起完整演示流程并可公开访问。

- Demo 脚本（与 pitch 对应）：全景与燃料图层 → Eaton 回放与真实火界对比 → 画防火带并与算法方案比较 → 拉高风速展示飞火与预算转向 Zone 0 → 实时模式与告警、外呼状态。
- 一键切换 demo 状态（预设场景、预设风况、预设处理方案），避免现场手动操作出错。
- 性能检查：集合预报耗时、帧率、显存；必要时降低集合规模或粒子数。
- `vite build`，部署为静态站点（如 Vercel）；后端地址通过环境变量配置。
- README 补充：运行方法、截图或 GIF、benchmark 数字。

**验收**：线上地址可访问；断开后端时自动退回 mock 数据仍能完整演示。

## 与队友的对接点

| 阶段 | 需要谁 | 内容 | 未就绪时 |
|---|---|---|---|
| P0 | Tia、Lucia | 确认 `types.ts`、`params.ts` 初版 | 先按 team-plan 约定开发 |
| P1 | Tia | 真实 `grid.bin`、卫星底图 | mock 网格 |
| P2–P3 | Lucia | 标定后的 `stepMinutes` 等参数 | 用文献默认值 |
| P4 | Lucia | Worker 中的 `planTreatments`、`evaluate` 真实现 | 约定中的假实现 |
| P5 | Tia | WebSocket 服务、Eaton replay 数据 | `mockServer.ts` |
| P6 | Tia | `buildings.json` | mock 建筑 |

## 提交约定

- 每个阶段至少一个独立提交，提交信息以阶段号开头，如 `P2: GPU cellular automaton with wind and slope`。
- 只改 `web/` 下的文件；`packages/core` 的改动走 PR 并请 Lucia review。
- 每个阶段完成后推送分支，阶段性地向 main 开 PR，方便队友联调。
