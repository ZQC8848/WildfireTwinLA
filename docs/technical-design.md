# 技术方案

## 一、整体架构

```
[离线预处理 Python]                 [后端 Node 或 FastAPI]              [前端 Three.js]
DEM ────────┐                       FIRMS 轮询 ─┐                      地形 mesh + 状态 shader
Sentinel-2 ─┼→ 对齐到统一网格 →     GOES FDC ───┼→ 火点聚类 → 事件流 ──→ GPU 元胞自动机（预测）
LANDFIRE ───┤   grid.bin            风况轮询 ───┘   (WebSocket/SSE)     防控算法（Web Worker）
建筑轮廓 ───┘                       告警规则 → Retell 外呼               交互：画防火带、时间轴
```

核心原则：**所有地理数据离线对齐到同一张规则网格**，前端只读二进制，不在浏览器里做 GIS 运算。

## 二、统一网格与数据层

**区域与投影**：Altadena 与 Eaton Canyon 一带，约经度 -118.20 至 -118.06、纬度 34.17 至 34.27。投影到 UTM 11N（EPSG:32611），单位为米。网格 512×512，每格约 25 m，覆盖约 12.8 km 见方。

| 图层 | 数据源 | 处理 |
|---|---|---|
| 高程 | AWS Terrain Tiles（Terrarium，z=14）或 USGS 3DEP（`py3dep`） | Terrarium 解码：`h = R*256 + G + B/256 - 32768`；重采样后计算坡度、坡向 |
| 植被绿度 | Sentinel-2 L2A，Planetary Computer STAC（`sentinel-2-l2a`，`eo:cloud_cover < 10`） | NDVI = (B08−B04)/(B08+B04)，10 m |
| 植被含水量 | 同一景 | NDMI = (B8A−B11)/(B8A+B11)，20 m；用 SCL 波段掩掉云、水、建筑 |
| 燃料类型（增强） | LANDFIRE FBFM40 | 分组：GR 草、GS 草灌、SH 灌木、TU/TL 林下；91–99 不可燃 |
| 建筑 | Microsoft US Building Footprints 或 OSM（Overpass） | 栅格化为掩膜，同时保留 polygon 供 3D 显示 |
| 道路、水体 | OSM | 不可燃，天然隔离带 |
| 历史火界 | NIFC WFIGS Interagency Perimeters（Eaton，2025-01） | 回放验证 |

**燃料参数**：

- 无 LANDFIRE：`fuel = clamp((NDVI − 0.15) / 0.6, 0, 1)`，`dryness = clamp((0.3 − NDMI) / 0.5, 0, 1)`
- 有 LANDFIRE：每类燃料对应基础蔓延速率 R0，NDVI、NDMI 作修正项

**输出**：Float32 RGBA 纹理 `grid.bin`（R 高程、G 燃料量、B 干燥度、A 类别：0 不可燃 / 1 植被 / 2 建筑），另存一张坡度坡向纹理。

## 三、火蔓延模型（GPU 元胞自动机）

### 状态纹理

| 通道 | 含义 |
|---|---|
| R | 状态：0 未燃，1 燃烧中，2 已燃尽 |
| G | 已燃烧步数，达到 `burnDuration(fuel)` 后转为燃尽 |
| B | 着火时刻（到达时间），供时间轴与等时线使用 |
| A | 处理标记 |

### 蔓延规则

采用 Alexandridis 等（2008）的元胞自动机模型：

```
p_burn = p_h · (1 + p_veg) · (1 + p_den) · p_w · p_s
p_w = exp(c1·V) · exp(c2·V·(cosθ − 1))   V：风速（m/s），θ：风向与蔓延方向夹角
p_s = exp(a · θ_s)                        θ_s = atan(ΔE / d)，单位为度
论文参数：p_h = 0.58，c1 = 0.045，c2 = 0.131，a = 0.078
```

`p_veg`、`p_den` 替换为由 fuel、dryness 计算的项；对角邻格距离乘 √2；处理过的格子乘处理系数（如防火带 0.05）。处理系数同时作用在燃烧的一侧：防火带、计划烧除里的格子即使烧着，剩下的燃料也少，向邻格蔓延和放出飞火都乘同一系数，火不会贴着地面爬过防火带。

### 飞火（spotting）

采用 gather 写法：每个未燃格每步在**上风方向**随机采样 M=4 个点，采样点若在燃烧，以 `p_spot · fuel · dryness` 的概率点燃当前格。建筑格单设飞火易损系数，Zone 0 处理即降低此系数。飞火分两类：

- **轻飞火**（草、灌丛，占绝大多数）：距离服从对数正态分布（σ = 0.6），均值 `12 m × V`；空中约 16 s 燃尽，落点超过 `16 m × V` 的不算。8.5 m/s 时平均约 100 m、最远 136 m，所以 150 m 宽的防火带在 10 m/s 以下能挡住；Santa Ana 级风速（13 m/s 以上）时最远超过 200 m，开始越过防火带。
- **重飞火**（房屋、棕榈、被抬升的灌丛）：很少，但大风时能飞一两公里，例如 Norte 的 MIRADA 起火点在下风 2.4 km 外。占采样的比例从 5 m/s 时的 0 线性升到 10 m/s 时的 0.2%，距离为对数正态（σ = 1.0），均值 `160 m × V`，不设上限。

最初的版本只有一类飞火，均值 `40 m × V`、无上限：8.5 m/s 时平均 340 m，绝大多数落点都在 150 m 防火带之外，画了防火带也挡不住（方案比较里节省的房屋一直是 0）。

### 实现

- 随机数：shader 内 PCG hash，输入为格子坐标、步数、种子，种子每步更新。
- `GPUComputationRenderer`（WebGL2）ping-pong 两张状态纹理。
- 风场：5×5 采样点的风速风向打包为低分辨率纹理，双线性插值。地形风修正可后续接 WindNinja。

### 时间标定

用 Eaton 回放标定每步对应的真实时间：FIRMS 记录了每个热点的探测时间，搜索系数 `Δt` 使模拟到达时间与 FIRMS 探测时间误差最小。

### 集合预报

64 次模拟拼成 4096×4096 图集（8×8 个 tile），每个 tile 使用不同种子与风况扰动，邻格查找限制在 tile 内，一次 draw call 推进全部模拟。加法混合累加到统计纹理，得到：

- 燃烧概率图
- 到达时间分布（P50、P90 等时线）

性能对比（CPU 串行 vs GPU 并行跑 64 次）作为 README 中的 benchmark。

### 验证

Eaton 回放：以 2025-01-07 的 FIRMS 火点为起点、当天风况为输入，模拟结果与官方火界叠加，计算 IoU。

## 四、防控算法

### 问题定义

- **起火源 S**：野地格子，按历史起火频率（CAL FIRE FRAP）加权；无数据时按离道路距离加权。
- **保护目标 T**：建筑格子，按价值加权，登记的弱势住户权重更高。
- **风况情景 W**：如 Santa Ana 东北风 40%、海风西南风 30%、静风 30%，权重可由历史风况统计。
- **处理手段**：

| 手段 | 效果 | 成本 | 约束 |
|---|---|---|---|
| 机械清理 / 防火带 | fuel × 0.05 | 随坡度、离道路距离递增 | 保护区内禁止 |
| 计划烧除 | fuel × 0.3 | 低 | 仅在燃烧窗口（风小、湿度高）内，用天气预报标出可执行日期 |
| 疏伐 | 蔓延速率 × 0.5 | 中 | — |
| 房屋 Zone 0 硬化 | 建筑飞火易损系数 × 0.3 | 按户 | 仅建筑格 |

- **目标函数**：预算 B 内最小化期望损失 `Σ_w Σ_s P(w)·P(s)·Σ_t value_t·[t 在 H 小时内被烧到]`

### 第一层：确定性规划器（Web Worker，128×128 或 256×256）

1. 网格视为图，边权为传播时间 `d / ROS`；ROS 为简化 Rothermel 形式 `R0(fuel) · (1 + φ_w) · (1 + φ_s)`，风与坡度按方向计算。
2. 每个风况从超级源点跑 Dijkstra，得到到达时间图与最短路径树。
3. **路径流量**：沿最短路径树从叶向根累加目标权重，累加值高的格子即火流咽喉。
4. **贪心**：每轮选 `流量 / 成本` 最高的位置，以垂直于火流方向、3–5 格宽的条带为单位处理；处理后重算，直到预算用完。
5. **最小割基线**：128×128 上做节点容量最小割（容量 = 处理成本），得到完全隔断野地与社区的最便宜屏障，与贪心结果对比。

### 第二层：随机验证器

GPU 集合预报（含飞火）分别跑处理前、处理后，以真实期望损失下降为准，因为确定性规划器忽略了飞火。

**输出指标**：受威胁建筑数变化、燃烧面积变化、总成本、每美元减少的损失。

### 人机协作

- **手动画**：3D 场景中用笔刷画处理区并选择手段；Worker 先给近似损失变化，GPU 集合预报随后给出准确值。
- **算法补全**：用户固定必须处理的位置，算法在剩余预算内贪心补全。
- **方案对比**：人工方案、贪心方案、最小割方案并排显示指标。
- **风速滑块**：拉到 Santa Ana 级风速，飞火跳过防火带，算法自动把预算转向 Zone 0 硬化。

## 五、实时火情转发

### 数据接入

| 源 | 接口 | 频率 | 说明 |
|---|---|---|---|
| NASA FIRMS | `/api/area/csv/{MAP_KEY}/VIIRS_SNPP_NRT/{w,s,e,n}/1`，另加 `VIIRS_NOAA20_NRT`、`MODIS_NRT` | 5 分钟 | 375 m，含 FRP 与置信度 |
| GOES-18 FDC | AWS `noaa-goes18` bucket，`ABI-L2-FDCC` | 5 分钟 | 2 km，最快发现新火点 |
| 风况 | Open-Meteo `hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,relative_humidity_2m`，5×5 采样点 | 1 小时 | 历史用 `archive-api.open-meteo.com` |
| 官方事件 | CAL FIRE 事件列表（非正式接口，需验证）、NIFC 实时火界 | 15 分钟 | 有官方火界时优先 |

### 处理流程

1. **归一化**：统一为 `{source, lat, lon, time, frp, confidence}`，存入 SQLite（或 PostGIS）。
2. **聚类**：DBSCAN（半径 750 m）归并为火灾事件，维护火点历史。
3. **同化**：新探测格设为燃烧中，旧探测点凹包内设为已燃尽；有官方火界时直接栅格化替代。
4. **预测**：以最新状态与风况跑 64 次集合预报，输出未来 1、3、6 小时概率等时线。
5. **转发**：WebSocket 按区域频道推送新事件、新热点、更新后的预测（压缩到达时间纹理或等时线 GeoJSON）；另提供 REST 与 webhook 订阅供物业、电力公司、媒体接入。

### 告警规则

| 级别 | 条件 | 动作 |
|---|---|---|
| Watch | 6 小时内到达概率 > 30% | 推送通知 |
| Warning | 3 小时内到达概率 > 50% | 推送通知，触发 AI 外呼 |
| Imminent | 1 小时内到达概率 > 50% | 最高级别，外呼优先弱势住户 |

**电力接口**：若能获取线路地理数据（SCE 公开过高火险区地图，线路级数据待核实），将预测火线与线路求交，输出未来 3 小时内受威胁线路，作为精准断电建议。

## 六、3D 渲染

- **地形**：`PlaneGeometry(…, 511, 511)`，vertex shader 读高程纹理位移，法线由高程差计算。
- **地表 ShaderMaterial**（可切换图层）：
  - 底色：卫星真彩色或 NDVI 燃料热力图
  - 燃烧中：橙红自发光 + noise 闪烁 + `UnrealBloomPass`
  - 已燃尽：焦黑加灰烬噪点
  - 燃烧概率：半透明红色渐变
  - 等时线：`fract(arrival / Δ)` 配合 `fwidth` 画抗锯齿等值线，每小时一条
  - 处理区：斜线纹理，按手段区分颜色
- **建筑**：`InstancedMesh` 挤出块，白色安全、琥珀色受威胁、闪烁红色预测被烧到。
- **烟雾**：燃烧格生成实例化 billboard 粒子，按风场平流，透明度随高度衰减。
- **时间轴**：到达时间已在纹理中，拖动时间轴只改 uniform `currentTime`，`arrival < currentTime` 即显示为已烧，无需重跑模拟。
- **Google 3D Tiles（可选）**：`3d-tiles-renderer` + `GoogleCloudAuthPlugin`，ECEF→ENU 变换对齐；拉近到社区时切换为真实建筑与树木。模拟只在 DEM 网格上进行。

## 七、AI 外呼（Feature）

- **登记表**：`{name, phone, language, address → 栅格坐标, vulnerable, consent_at}`，仅收录主动登记住户。
- **触发**：告警升至 Warning 时调用 Retell create-phone-call，dynamic variables 传入社区名、预计到达时间、撤离路线、最近避难所、语言。
- **回执**：通话结束 webhook 回写（已接通确认 / 未接通 / 需要协助）。未接通自动重拨并补发短信；"需要协助"在 3D 地图对应建筑上标红。

## 八、技术栈

| 层 | 选型 |
|---|---|
| 离线预处理 | Python：rasterio、pystac-client、planetary-computer、geopandas、numpy |
| 后端 | Node（Fastify）或 Python（FastAPI）；SQLite / PostGIS；WebSocket / SSE |
| 前端 | Three.js（GPUComputationRenderer、EffectComposer）、3d-tiles-renderer、Web Worker |
| 语音 | Retell AI |
| 离线 | PWA + Service Worker 缓存情景库 |
