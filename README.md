# WildfireTwinLA：洛杉矶山火数字孪生

在浏览器里用 Three.js 构建洛杉矶山地的 3D 数字孪生：用卫星数据持续更新植被燃料状态，在 GPU 上模拟火势蔓延，用算法辅助人工决定在哪里做燃料处理（防火带、计划烧除、房屋硬化）最能保护社区；火灾发生时实时转发火情、推演蔓延，火线逼近时通知社区住户。

- 活动：The Dual-Use Hackathon（InnovateLA × USC Viterbi，LA Tech Week 2026 闭幕活动，2026-10-16 至 10-18）
- 详细技术方案：[docs/technical-design.md](docs/technical-design.md)

## 核心功能

| 模块 | 内容 | 地位 |
|---|---|---|
| 3D 场景 | DEM 地形 mesh、卫星底图、燃料热力图、建筑、火焰与烟雾、等时线、时间轴 | 必须 |
| 火势蔓延 | GPU 元胞自动机（坡度、风、燃料、飞火），64 路集合预报给出燃烧概率与到达时间 | 核心 |
| 实时火情转发 | 轮询 NASA FIRMS、GOES-18 和风况，聚类成火灾事件，同化进模拟，通过 WebSocket/SSE 和 webhook 推送 | 核心 |
| 人工防控算法 | 风险图、火流咽喉点、预算约束下的燃料处理优化；用户可手动画处理区并与算法方案对比 | 核心 |
| AI 外呼 | 火线预计到达社区时，通过 Retell 给主动登记的住户打电话，回写通话结果 | Feature |

## 数据源

| 用途 | 数据源 | 说明 |
|---|---|---|
| 地形 | AWS Terrain Tiles（Terrarium）、USGS 3DEP | 用于分析和模拟 |
| 视觉增强 | Google Photorealistic 3D Tiles | 只做显示；Google 条款限制从中提取数据做分析 |
| 植被燃料 | Copernicus Sentinel-2 L2A（NDVI、NDMI），LANDFIRE FBFM40 | Sentinel-2 约 5 天重访一次，是周期更新而非实时 |
| 实时火点 | NASA FIRMS（VIIRS/MODIS）、GOES-18 ABI FDC | FIRMS 约 3 小时内、375 m；GOES 每 5 分钟、2 km |
| 风况 | Open-Meteo、NWS api.weather.gov | 免费，无需 key |
| 建筑 | Microsoft US Building Footprints、OpenStreetMap | — |
| 验证 | NIFC WFIGS 历史火界（2025 年 1 月 Eaton 火灾） | 回放与 IoU 验证 |

## 对现实的几点认识

1. **洛杉矶山地以灌木丛（chaparral）和草地为主**，燃料建模要看类型、连续性和含水量，不能只看"树的密度"。
2. **Santa Ana 大风下，飞火（ember）会跳过防火带**。2025 年 Palisades、Eaton 火灾中，房屋多由飞火点燃。所以算法必须模拟飞火，并把房屋 Zone 0 硬化纳入处理手段。
3. **计划烧除只能由 CAL FIRE 等机构执行**，本系统是决策辅助工具，不下达指令。
4. **告警以转达和放大官方疏散令为主**，自身的蔓延预测标注为"非官方参考"。
5. **住户联系方式只来自主动登记（opt-in）**。AI 语音外呼受 TCPA 约束（FCC 2024 年裁定 AI 语音属于人工语音），紧急用途豁免是否适用需法律确认。

## 现有产品

| 产品 | 做什么 | 与本项目的关系 |
|---|---|---|
| Watch Duty | 非营利实时火情 App | 实时转发的参照；本项目的差异在 3D 推演与防控规划 |
| Technosylva | CAL FIRE 使用的专业蔓延预测 | 专业版蔓延模型 |
| FlamMap / TOM | 燃料处理优化工具 | 防控算法的专业参照，界面不面向大众 |
| Genasys Protect、Alert LA County | 官方疏散分区与警报 | 告警的权威来源 |
| ALERTCalifornia、Pano AI | 摄像头加 AI 早期发现 | 发现环节 |

## Dual-Use 定位

黑客松的第一条评分是 dual-use 契合度，并要求回答三道自检题。

| 测试 | 回答 |
|---|---|
| 平日（谁付钱） | 防控规划工具：电力公司植被管理（SCE 等负有法定清理义务）、LA County Fire brush clearance、Fire Safe Council、保险公司 |
| 危机（凌晨 3 点、网络断了） | 平日积累的集合预报构成"风况 × 起火区"情景库，PWA 离线缓存；断网时按当前风况调出最接近的情景 |
| 迁移（预算只有十分之一） | Sentinel-2、FIRMS、Copernicus DEM 均为全球免费数据，换地区只需换 bbox；Google 只负责视觉 |

**赛道倾向：Energy**（合作方 BASE；SCE 为赞助方）。蔓延推演可以输出"哪几条线路受威胁"，用精准断电代替大面积 PSPS，回答"如何让最需要的人保住电"。最终以赛事公布的详细 prompt 为准。

## 黑客松要点

- 主题：Preparing for Disaster。做 dual-use 方案，避免危机中的系统停摆；强调韧性、效率与成本。
- 赛道：Marine、Energy（BASE）、Communications（Retell）、Ports。
- 评分（各 1–5 分）：dual-use 契合度、技术执行与 MVP、可行性与影响、对 twist 的适应、demo 与 pitch。
- 三次 twist，每次 6 小时响应窗口，鼓励但不强制采纳。
- 前三名：$1,000 / $500 / $200，并进入 DAS Family InnovateLA 孵化器，春季争夺 $30K。
- 每队 2–4 人，至少一名 USC 学生；IBM Bob 单独设奖；IBM 与 NASA 在 Hugging Face 开放了地理空间模型（含火烧迹地 burn scar）。
- 入口：innovatelosangeles.com/dual-use；提交：innovatela.devpost.com。

## 待确认

- [ ] 赛事详细 prompt 与最终赛道
- [ ] SCE 线路级地理数据是否公开可得
- [ ] CAL FIRE 事件接口与 Genasys 疏散分区数据是否可程序化获取
- [ ] Google Maps Platform 3D Tiles 的免费额度
