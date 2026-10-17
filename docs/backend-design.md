# 数据与实时后端设计

本文定义 B 模块的可实施边界。目标不是把外部数据源直接转发给浏览器，而是把它们转换成一个可回放、可去重、可审计的事件流。

## 1. 技术选型

- **服务端**：Python 3.11 + FastAPI。离线 GIS 与在线服务使用同一种语言，减少类型和部署成本。
- **MVP 存储**：SQLite（WAL）；生产环境切换 PostgreSQL + PostGIS。
- **定时任务**：进程内 `asyncio` 调度器用于黑客松演示；生产环境使用独立 worker/队列，避免多副本重复轮询。
- **实时通道**：WebSocket；REST 提供快照、登记和 Retell webhook。
- **数据契约**：所有时间为 UTC ISO 8601；坐标为 WGS84；网格索引由 `packages/core` 负责换算。

## 2. 组件与数据流

```text
FIRMS ─────┐
GOES-18 ───┼─> provider adapters ─> normalize/dedupe ─> hotspots ─> cluster incidents
Open-Meteo ┘                                               │              │
                                                           └──── WebSocket ┤
deterministic arrival grid ─> alert evaluator ─> alert transitions ───────┤
resident opt-in registry ───────────────────────> Retell call dispatcher ─┘
```

每一层只做一件事：provider adapter 负责下载和解析；归一化层负责统一字段；聚类层不访问网络；告警层只消费预测结果和社区配置；外呼层只响应已落库的告警状态迁移。

## 3. 目录设计

```text
server/
├── app/
│   ├── main.py              # HTTP/WS 入口与生命周期
│   ├── config.py            # 环境变量
│   ├── schemas.py           # API 和事件契约
│   ├── store.py             # SQLite repository
│   ├── clustering.py        # 空间/时间聚类（纯函数）
│   ├── alerts.py            # 告警状态机（纯函数）
│   ├── realtime.py          # WebSocket 频道与广播
│   └── providers/
│       ├── firms.py
│       └── weather.py
├── tests/
└── pyproject.toml
```

离线预处理留在 `data-pipeline/`，输出已冻结的 `grid.json`、`grid.bin`、`buildings.json` 和 `communities.json`。在线后端不做重投影或大栅格计算。

## 4. 数据模型

### Hotspot

`id` 使用 `sha256(source, satellite, acquired_at, rounded_lat, rounded_lon)`，使重复轮询天然幂等。保留原始置信度文本，同时提供 0–1 的归一化值。

关键字段：`source`、`lat`、`lon`、`acquired_at`、`frp`、`confidence`、`incident_id`、`raw_json`。

### Incident

火点在 **750 m 空间半径 + 6 小时时间窗口**内使用 DBSCAN 聚合。事件 ID 稳定：新聚类若与活跃事件存在共同火点或质心在阈值内，沿用旧 ID。事件超过 24 小时无新火点后关闭。

### Resident

保存 `name`、E.164 电话、语言、地址匹配后的 `building_id/community_id/cell`、`vulnerable`、`consent_at`、`consent_source` 与撤回时间。API 响应和日志永不返回完整电话号码；数据库生产环境需字段级加密。

### Alert / CallAttempt

`Alert` 以 `(incident_id, community_id)` 唯一，记录当前级别、ETA、概率、触发依据和时间。每次等级变化写入不可变 `alert_events`。`CallAttempt` 使用 `(alert_event_id, resident_id)` 唯一，防止任务重试导致重复外呼。

## 5. 对外 API

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/healthz` | 存活检查 |
| `GET` | `/readyz` | 数据库和最近轮询状态 |
| `GET` | `/api/v1/incidents` | 当前事件快照 |
| `GET` | `/api/v1/incidents/{id}` | 事件和火点历史 |
| `GET` | `/api/v1/wind/latest` | 最新 5×5 风场 |
| `WS` | `/ws?mode=live` | 实时事件流 |
| `WS` | `/ws?mode=replay&event=eaton` | 与 live 同契约的回放流 |
| `POST` | `/api/v1/residents` | 明示同意登记 |
| `DELETE` | `/api/v1/residents/{id}` | 撤回同意并停止后续外呼 |
| `POST` | `/api/v1/risks/evaluate` | 接收单个社区到达风险并推进告警状态机 |
| `POST` | `/api/v1/risks/evaluate-batch` | 接收 C 模块批量情景结果 |
| `GET/POST` | `/api/v1/official-orders` | 查询或受保护地写入官方命令 |
| `POST` | `/webhooks/retell` | 通话状态回写（验签） |
| `GET` | `/metrics` | Prometheus 格式运行指标 |

WebSocket 连接成功后先发 `snapshot`，随后发送带单调递增 `sequence` 的消息。客户端发现序号缺口时重新请求 REST 快照，而不是猜测丢失状态。

## 6. 告警状态机

输入是 C 模块输出的社区到达时间分布，不把单次模拟当作事实：

| 等级 | 进入条件 | 退出条件（迟滞） | 动作 |
|---|---|---|---|
| Watch | 6h 内到达概率 ≥ 0.30 | 连续 2 次低于 0.20 | WS 推送 |
| Warning | 3h 内到达概率 ≥ 0.50 | 连续 2 次低于 0.35 | 推送；仅在升级时外呼 |
| Imminent | 1h 内到达概率 ≥ 0.50 | 连续 2 次低于 0.35 | 优先外呼弱势住户 |

等级只能由规则计算，不允许 provider 直接触发。官方疏散令使用单独的 `official_order` 字段并在 UI 中明确高于模型预测。每条消息标注 `prediction: non_official`。

外呼必须满足：住户未撤回同意、社区匹配、告警是升级事件、同一告警事件没有成功创建过 call。电话号码只发送给 Retell，不进入 WebSocket。

## 7. 轮询与容错

- FIRMS：5 分钟；同一周期拉取 SNPP、NOAA-20、NOAA-21 和 MODIS，并记录轮询状态。
- GOES：既支持 FIRMS `GOES_NRT`，也支持直接列出 NOAA GOES-18 S3 的最新 `ABI-L2-FDCC` NetCDF，解码固定网格、火点掩膜、FRP 与置信度后裁剪到项目 bbox。
- 风况：60 分钟；Open-Meteo 5×5 点批量请求，并直接请求 m/s 单位。
- 所有 provider 使用超时、有限重试、带 provider 名的指标；某个源失败不会清空现有事件。
- 只有持有数据库 advisory lock 的 worker 执行轮询。SQLite MVP 强制单 worker。

## 8. 安全、合规与可观测性

- FIRMS map key、Retell key 和 webhook secret 只从环境变量读取。
- 登记和 webhook 端点限流；Retell webhook 必须验签并拒绝过期时间戳。
- 结构化日志中对电话、姓名、地址做删除或散列；原始 provider payload 设置保留期。
- 指标至少包括：轮询延迟/错误、最后成功时间、火点新增数、WS 连接数、告警迁移数、外呼成功/失败数。
- 本系统转发官方信息并展示非官方预测，不生成或伪装官方撤离令。

## 9. 交付顺序

1. 合成网格 + WebSocket 假火点 + Eaton replay，解除 A/C 的联调阻塞。
2. FIRMS + Open-Meteo 实时 adapter、SQLite 去重、DBSCAN 聚类。
3. 接入 C 的 arrival grid，启用告警状态机。
4. 住户 opt-in、Retell sandbox、验签 webhook。
5. PostGIS 与独立 worker；按分析需求增加 NOAA ABI-L2-FDCC 原始云产品解码。

## 10. 当前实现状态

`server/` 已实现真实 provider adapter、SQLite 幂等存储、事件聚类、后台调度、契约化 REST/WS、Eaton 回放、CAP 官方命令、告警迟滞、Retell 幂等外呼与验签回调。`data-pipeline/` 已实现 USGS/OSM 下载、Sentinel-2 场景发现，以及 DEM、B04/B08/B8A/B11、SCL、建筑与社区的统一投影和二进制网格导出。FIRMS 与 Retell 的真实在线运行仍需部署方提供凭据。

## 11. 关键决策

- **不让浏览器直接访问 FIRMS/Retell**：避免泄露 key，并确保去重、回放和审计。
- **不在在线服务做 GIS 重处理**：大栅格全部预生成，保证黑客松环境中的响应稳定。
- **不把告警绑定在 GPU 前端**：浏览器关闭时告警仍能工作；后端消费 C 的确定性预测。
- **先 SQLite 后 PostGIS**：MVP 数据量很小，repository 边界使迁移不影响 API。
