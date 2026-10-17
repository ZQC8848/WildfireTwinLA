# 团队分工

三人团队。分工原则：**按目录划清所有权，模块之间只通过事先约定的数据格式交互**。每人的代码只放在自己的目录里，基本不会产生合并冲突；接口约定好之后，每人都可以先用假数据开发，不必等待别人。

## 一、角色

| 角色 | 负责人 | 负责模块 | 需要的能力 |
|---|---|---|---|
| **A：3D 与 GPU 模拟** | Qinchuan | Three.js 场景与渲染、GPU 元胞自动机、64 路集合预报、时间轴、画防火带的笔刷交互、方案对比界面 | 图形、shader、前端 |
| **B：数据与实时后端** | Tia | 离线数据预处理（DEM、Sentinel-2、建筑统一成网格）；FIRMS、GOES、风况轮询；火点聚类；WebSocket 推送；告警规则；Retell 外呼与住户登记 | Python GIS、Node 或 Python 后端 |
| **C：防控算法与验证** | Lucia | ROS 蔓延速率模型、Dijkstra 到达时间、路径流量、贪心优化、最小割基线、方案评估指标；Eaton 回放验证（IoU、Δt 标定） | 算法；土木或环境工程背景更佳 |

关键的边界划分：

- **蔓延模型有两份实现，共用一份参数**。A 写 GPU 上的随机元胞自动机，用于可视化和集合预报；C 写 CPU 上的确定性 Dijkstra，用于规划和告警。物理规则只在 `params.ts` 定义一次，代码各写各的。
- **告警放在后端，由 B 负责**。B 直接调用 C 的确定性到达时间函数判断"火几点到哪个社区"，不依赖 A 在浏览器里跑的 GPU 结果，前后端互不等待。
- **C 的算法库是纯 TypeScript，不依赖 Three.js**。它既在浏览器的 Web Worker 里跑（给 A 的界面用），也在 Node 里跑（给 B 的告警用）。

## 二、仓库结构与所有权

```
WildfireTwinLA/
├── data-pipeline/        B    Python：下载、重投影、导出网格
├── server/               B    Node：轮询器、聚类、WebSocket、告警、Retell
├── packages/core/        C    TS 纯算法库：网格读取、坐标换算、ROS、Dijkstra、规划器
│   ├── src/types.ts      共有  全部接口类型，改动需三人同意
│   ├── src/params.ts     共有  蔓延模型参数，C 维护数值，A 读成 shader uniform
│   └── src/worker.ts     C    Web Worker 入口
├── web/                  A    Vite + Three.js 前端
├── analysis/             C    Python：Eaton 回放验证、Δt 标定
└── public/data/          B    生成的网格数据（产物）
```

Git 规则：

- 每人在自己的分支上开发（`a/…`、`b/…`、`c/…`），通过 PR 合入 main。
- `types.ts` 和 `params.ts` 是仅有的共有文件，改动前在群里说一声；可用 CODEOWNERS 要求这两个文件的 PR 三人都 review。
- 不改别人目录下的文件；需要别人改的，提 issue 或直接沟通。

## 三、接口约定（最先确定，确定后冻结）

### 约定 1：网格数据（B 产出 → A、C 读取）

```ts
// public/data/grid.json
interface GridMeta {
  width: number;                         // 512
  height: number;                        // 512
  cellSize: number;                      // 25（米）
  crs: "EPSG:32611";
  originUTM: [number, number];           // 左上角
  bboxLonLat: [number, number, number, number]; // [w, s, e, n]
}
// public/data/grid.bin：Float32Array(width * height * 4)
//   每格 [elevation, fuel 0-1, dryness 0-1, class]，class：0 不可燃 / 1 植被 / 2 建筑
// public/data/buildings.json：[{ id, cell, weight, polygonLonLat }]
// public/data/communities.json：[{ id, name, cells: number[] }]
```

**坐标换算只写一处**：`core` 里的 `lonLatToCell()` 和 `cellToLonLat()`，三人都调用它。格子索引统一为 `cell = y * width + x`，y 从北向南递增。

### 约定 2：蔓延参数（C 维护 → A 的 shader 与 C 的 Dijkstra 共用）

```ts
// packages/core/src/params.ts
export const SpreadParams = {
  ph: 0.58, c1: 0.045, c2: 0.131, a: 0.078,          // Alexandridis et al. 2008
  spot: { pBase: 0.02, distMeanPerWindMs: 40, samples: 4 },
  stepMinutes: 5,                                     // C 用 Eaton 回放标定后更新
};
export const TreatmentEffect = {
  break: { fuelMul: 0.05 },
  burn:  { fuelMul: 0.3 },
  thin:  { rosMul: 0.5 },
  zone0: { emberMul: 0.3 },
};
```

### 约定 3：处理方案（A 的笔刷 ↔ C 的规划器 ↔ A 的 GPU 模拟）

```ts
type TreatmentType = "break" | "burn" | "thin" | "zone0";

interface Treatment {
  type: TreatmentType;
  cells: Uint32Array;
  cost: number;
  source: "user" | "greedy" | "mincut";
}
// 运行时统一转成处理掩膜 Uint8Array(width * height)：0 无，1 break，2 burn，3 thin，4 zone0
// A 把掩膜上传为纹理，C 直接读数组
```

C 的 Worker 对外只提供三个函数：

```ts
computeArrival(ignitions: number[], wind: WindField, mask: Uint8Array): Float32Array  // 每格到达时间（分钟）
planTreatments(req: { budget: number; fixed: Treatment[]; scenarios: WindScenario[] }): Treatment[]
evaluate(mask: Uint8Array, scenarios: WindScenario[]): Metrics

interface Metrics { buildingsThreatened: number; burnedAreaHa: number; cost: number; lossPerDollar: number; }
```

### 约定 4：实时消息（B 推送 → A 显示）

```ts
type ServerMsg =
  | { type: "hotspots"; items: { id: string; cell: number; lon: number; lat: number; t: string; frp: number; conf: number; source: "VIIRS" | "MODIS" | "GOES" }[] }
  | { type: "incident"; id: string; hotspotIds: string[]; perimeterCells?: number[] }
  | { type: "wind"; t: string; grid5x5: [speedMs: number, dirFromDeg: number][] }
  | { type: "alert"; communityId: string; level: "watch" | "warning" | "imminent"; etaMin: number }
  | { type: "call_status"; buildingId: string; status: "confirmed" | "no_answer" | "needs_help" };
```

服务器提供 `?mode=live` 和 `?mode=replay&event=eaton` 两种模式，前端代码不区分。

## 四、用假数据解耦

接口确定后，每人先交付一个假实现，让另外两人立即开工：

| 谁 | 先交付的假实现 | 谁受益 |
|---|---|---|
| B | 用几个高斯山包合成的 `grid.bin` 和几栋假建筑；按固定节奏推送假火点的 WebSocket | A 开始渲染和模拟，C 开始写 Dijkstra |
| C | `planTreatments` 返回一条直线防火带，`evaluate` 返回随机数 | A 先做笔刷和方案对比界面 |
| A | 最简页面：加载网格、显示地形、接收并打印 WebSocket 消息 | B 在页面上直接检查推送 |

之后各自把假实现替换为真实现，接口不变，别人无感。

## 五、剩余耦合点

| 耦合点 | 风险 | 处理 |
|---|---|---|
| GPU CA 与 Dijkstra 结果不一致 | 动画与规划器的数字对不上 | 共用 `params.ts`；C 在 `analysis/` 写对比脚本，确认两者到达时间大致吻合 |
| Δt 标定结果 | A 的时间轴与 B 的告警 ETA 都依赖它 | 只存在于 `params.ts` 的 `stepMinutes`，C 更新后两边自动生效 |
| 网格分辨率 | 规划器在 128×128 上跑，渲染在 512×512 上 | 降采样、升采样函数写在 `core` 里，由 C 负责 |
| 整体串联 | 各部分单独能跑，合起来不一定 | 以 `replay=eaton` 作为唯一联调场景，三人都用它自测 |

## 六、Pitch 分工

| 讲者 | 内容 |
|---|---|
| B | 数据来源与 dual-use 商业故事：平日谁付钱，危机时怎么转发和告警 |
| A | 3D 场景与 GPU 集合预报，现场操作 Eaton 回放 |
| C | 防控算法：现场画一条防火带并与算法方案对比；拉风速滑块，展示飞火跳过防火带后预算转向房屋硬化 |
