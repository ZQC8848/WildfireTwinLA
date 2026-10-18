# WildfireTwinLA 10 页 Pitch Deck 制作计划

本计划只说明怎么做；截图、网页取图和搭建 deck 都留到开工后。

**依据：**
- 用户提供的 `WildfireTwinLA-10-Slide-Deck-Brief.md`（下称 brief）；
- 活动 Participant Hub（Google Doc，页面标注最后更新于 2026-10-17，读取时间 2026-10-17 18:58 PDT）；
- 仓库 main `0bcd533` 的代码与数据。

## 1. 交付物

| 交付物 | 形式 | 位置 |
|---|---|---|
| 可编辑 deck | Google Slides（由脚本生成的 .pptx 导入） | Google Drive；本地 `pitch/out/WildfireTwinLA-pitch.pptx` |
| PDF | 从最终版 Google Slides 导出 | `pitch/out/WildfireTwinLA-pitch.pdf` |
| 演讲备注 | 写进每页备注，另存一份 Markdown | `pitch/speaker-notes.md` |
| 证据与来源清单 | 每条上屏说法对应的截图、代码或数据、状态（working / simulated / replay / planned）、来源链接与读取时间 | `pitch/evidence-checklist.md` |
| 内嵌备用演示片段 | 第 4、6 页各一段约 20–30 秒的录屏，不依赖网络 | `pitch/assets/video/` |
| Demo video（独立交付） | 3 分钟以内，主要讲第 2、4、6、9 页的流程 | 由用户录制，我准备脚本和应用状态 |

## 2. 活动要求（Hub 复核结果）

brief 里的要求与 Hub 一致。Hub 另外补充了以下几点，开工时再刷新一次：

- **Deck 规则**：最多 10 页，必须用 Google Slides。Demo video 不超过 3 分钟。如果用了 Retell 或 IBM Bob，视频里要讲到所用的 prompt。
- **Devpost 提交**（周六 10/17 晚上 10 点截止）需要：
  - 名称、lens 和一句话简介；
  - pitch deck、demo video、代码仓库、全体队员；
  - responsible-use note。规则第 7 条要求用两行写清工具可能怎样被滥用、我们怎样限制。
- **决赛**：
  - 入围队伍的最终 deck 周日上午 9 点交。
  - 5 分钟 pitch（含演示）加 5 分钟问答。
  - Hub 建议的结构是：0:30 讲问题 → 先展示能跑的东西 → twist（系统如何扛住） → 下一步与可行性。
- **评分**：五项各 1–5 分：dual-use fit、technical execution、feasibility and impact、adapting to twists、demo and pitch。同分时比 dual-use fit。
- **Twist**：
  - 共三个，分别在周五 23:30、周六 4:30、周六 7:00 发布。Hub 已改为"写进你的方案，最终提交时检查适应能力"。
  - "Best Shift Adapter" 奖按三次 twist 的响应打分：改了什么、为什么改、有没有证据证明它能用。
  - **Hub 里没有写 twist 的具体内容**。Hub 提到"你为 twist 3 做的海报"，说明 twist 3 与海报有关。具体内容需要团队提供。
- **Lens 评审标准**：
  - Resilience Comms（Retell）要求一个能用的语音、短信或消息流程，在网络弱或多语言情况下能工作，能触达现有警报漏掉的人。
  - Crisis Mitigation 要求"检测、预警、响应，而不只是展示数据"。
  - 两条都会影响第 3、9、10 页的侧重。

## 3. 核实结果：brief 的假设与当前代码

| 项目 | brief 的假设 | 当前实际（main `0bcd533`） | 对 deck 的影响 |
|---|---|---|---|
| 数据来源 | 可能是 mock | 加载的是真实 Norte 数据（`web/src/data/loadGrid.ts:35-56`）：<br>• 512×512 网格，25 m 一格，12.8 km 见方；<br>• 50,408 栋 OSM 建筑、7 个社区、7,991 条道路；<br>• LANDFIRE 燃料、USGS 3DEP 高程、Sentinel-2 底图（2026-10-14）。<br>只有带 `?mock` 参数或加载失败时才退回合成地形 | 可以写"真实数据"。概况面板的 "Homes" 统计的是所有建筑，上屏写 "buildings"，不写 "homes" |
| 联络队列 | 第三个 tab，按距离排序 | 不是 tab，是 Respond 模式下地图右侧的 "Emergency contact" 面板。<br>队列按**预计火势到达时间**排序（`server/app/dispatch.py:153-202`）：距离除以按风修正的蔓延速度，与模型给出的到达时间取较早者；有 "Access needs" 标记的住户提前 5 分钟。<br>队列列出名次、打码地址、打码姓名、标签、到达时间。**界面上没有显示距离**，电话只出现在线路卡片上 | 第 4 页的说法和表头要按实际改，见第 4 节问题 3 |
| 距离和到达时间的参照 | 热点、火界或模拟燃烧格 | 前端每 1.5 秒上报的**模拟燃烧格**。回放里，这次模拟以报告的起火点和 VIIRS 热点为种子 | 标注写 "Estimated arrival from the nearest simulated burning cell (simulation seeded from reported ignitions and VIIRS hotspots)" |
| 实时数据 | 可能已接入 | 前端会连 `WS /ws?mode=live`，但后端的抓取默认关闭；没有设置 FIRMS key，`server/.env` 也不存在。live 模式只会显示空快照 | 第 2 页只能用 "Norte replay"，不展示 Live feed 按钮，也不说"实时" |
| 显示的火灾 | Norte，可能还有 Bryson、Peak | 只有 Norte 及其第二个起火点 MIRADA。Bryson、Peak 只在文档里被列为不在范围内 | Bryson、Peak 只能放进 "Regional context — CAL FIRE" 小面板 |
| 回放内容 | — | `server/data/norte-replay.jsonl` 共 23 条事件，时间 2026-10-16 11:32 至 18:00 PDT：<br>• 起火报告 NORTE（T+0），MIRADA（T+0:47）；<br>• 5 条疏散令，T+0:57，标注"OCFA，据 CBS LA 和 KTLA 报道，时间为约数"；<br>• 4 次 VIIRS 过境，T+1:35、2:11、2:31、3:15；<br>• 8 个逐小时 HRRR 风场；<br>• T+6:27 的粗略卫星火区（非官方火界） | 截图配方按这些时刻取（第 6 节） |
| 预防模式 | 四种处理 | Fuel break $100、Prescribed burn $30、Thinning $60、Home hardening $250，均为每格成本。<br>"Compare plans" 比较 None / Yours / Greedy / Min-cut：<br>• 每个方案跑 5 次 GPU 模拟，8 小时，含飞火；<br>• 表格列出 Homes reached、Area burned、Cost、Homes saved per $100k；<br>• 差值小于噪声（max(5, 2·SD/√n)）时显示 "≈ 0"，并提示 "within run-to-run noise"；<br>• 默认预算 $150k | 第 6 页数字一律取自运行结果，保留 "≈ 0" 和噪声提示 |
| 未接听流程 | 计划中 | 模拟已实现：<br>• 未接听 3 分钟后重拨一次，同时这户的短信提前 30 分钟；<br>• 第二次未接听即为最终结果；<br>• 短信状态为排队 → 发送中 → 已发送 → 已送达或失败。<br>**短信回执确认没有实现** | 第 9 页把"重拨 + 短信提前"标为 simulated，"确认回执"标为 planned |
| Retell | 计划中 | 有真实外呼的代码路径（`server/app/retell.py`、webhook），但需要同时开启 `WILDFIRE_DISPATCH_REAL_CALLS`、配置 Retell key、号码和 agent，以及登记过同意的住户。**从未配置，也从未跑过**。仓库里没有 agent prompt 文件 | 一律写 "planned"；备注里可以提"代码路径已在，未测试"。Hub 要求的"视频讲 prompt"目前不适用 |
| 短信服务 | 计划中 | 没有接任何短信服务商，全部是模拟 | 写 "simulated" |
| 虚构号码 | 213-555-01xx | 实际用 +1 (949) 555-0100 至 0199，界面打码为 "(949) 555-01\*\*" | 沿用应用里的号码，与截图一致 |
| 社区边界 | 不能当疏散区 | 7 个社区全部标注 approximate；Genasys 疏散区不公开 | 脚注写 "approximate community areas, not official zones" |
| 数据时效提示 | 第 9 页"过期数据显示时效" | 界面没有显示数据时效 | 第 9 页此项标 planned |
| 风场 | HRRR | 回放用存档的 HRRR（Open-Meteo `gfs_hrrr`，5×5 网格逐小时）；地形风用预计算的 WindNinja 库；live 模式用 Open-Meteo，但未配置 | 第 7 页按此填写 |

## 4. 开工前需要你确定的问题

1. **提交的 lens 是哪个？** Resilience Comms、Crisis Mitigation 还是 Energy？README 里写的是"倾向 Energy"，但这份 brief 的叙事是 Resilience Comms，即"通话线路的夜班主管"。这决定第 3 页的用户设定和第 10 页的侧重。
2. **三个 twist 分别是什么，构建因此改了什么？** 第 9 页的 twist 小卡片只写真实发生过的改动。不提供就不放，也不编。
3. **第 4 页队列的说法**（推荐 A）：
   - **A.** 按实际改写："按预计火势到达时间排序"，表头用应用里的"名次、地址、住户、标签、到达时间"。不改代码，而且比纯距离更有说服力，因为考虑了风向。
   - **B.** 照 brief 用距离排序和距离列。需要改应用代码，在队列里显示 `distanceM`，而 brief 明确说这次任务不授权改代码，所以要你另外同意。
4. **联络相关的颜色**（推荐 A）：
   - **A.** 沿用应用的 Retardant 粉红（#D63A73）表示人的干预，与截图一致；brief 要求的琥珀色只用在第 9 页的 "Unresolved"。
   - **B.** 全部按 brief 用琥珀色，但会和截图里的粉色对不上。
5. **第 10 页和 Devpost 的队员名单**：`docs/team-plan.md` 写的是 Qinchuan、Tia、Lucia，确认可以上屏吗？
6. **演示前会不会真的配置一次 Retell 外呼？** 如果会，第 3、9 页的状态可以改成 "demonstrated"，demo video 也要讲 prompt；如果不会，就全部按 planned 处理。
7. **Google Slides 的导入方式**（推荐 A）：
   - **A.** 我生成 .pptx，你拖进 Google Drive，Drive 会自动转成 Slides。
   - **B.** 用 Drive 连接器上传。连接器要把文件按 base64 传，一个带截图的 deck 有几 MB，不现实。

## 5. 逐页计划

**通用约定：**
- 标题沿用 brief 原文。上屏文字已按第 3 节的事实调整，开工时以截图的实际内容为准再核一遍。
- 状态标签有五种：OBSERVED、MODELLED、REPLAY、SIMULATED CONTACT、PLANNED，样式见第 7 节。
- 第 2、4、6、9 页页脚放 responsible-use 一行：*Experimental, unofficial model outputs. Demo contacts and call outcomes are fictional. Follow official evacuation instructions.*

### 第 1 页：为什么要打电话（20 秒）

- **标题**：A warning sent isn't a person reached.
- **副标题**：WildfireTwinLA — from fire information to prioritized outreach.
- **要点**：
  - Confirm that someone received the message.
  - Let them ask for repetition or help.
  - Keep unanswered contacts visible.
- **视觉**：三张状态卡片，背景是压暗的地图（P9）。
  - 卡片用应用里真实的线路卡截图（P1）："Confirmed safe"、"No answer, retry later"、"Needs help"，对应 brief 的 Acknowledged、No answer、Needs a person。
  - 卡片上方标 SIMULATED CONTACT。如果改用自己画的概念卡，就标 "Concept"。
- **证据**：CAL FIRE Norte 页面上的公众信息热线（W1 局部），说明语音沟通的作用。
- **不说**：电话一定比短信好、断网也能打、能救命。

### 第 2 页：真实的火灾，本地的决策（30 秒）

- **标题**：Real fires. A local decision.
- **主图**：Norte 回放大图（P2）。图下说明：*Norte Fire, Orange County (San Clemente / San Juan Capistrano) — after-the-fact replay of Oct 16, 2026. Public data: NIFC incident records, NASA FIRMS VIIRS, NOAA HRRR wind. Not live.*
- **辅助文字**：Public fire observations, geographic context and experimental spread scenarios.
- **右侧小面板**："Regional context — CAL FIRE"。
  - 列 Bryson（Malibu 一带，LA County）、Peak（Azusa 一带，LA County）、Norte（Orange County）三场火的面积和控制率，数字在开工时刷新。
  - 写明 CAL FIRE 页面的更新时间和我们的读取时间（PDT）。
  - 可以配 1–2 张新闻标题截图（W4）。
- **注意**：
  - Norte 属于 Orange County，不是 LA County。
  - 回放里的 VIIRS 粗略火区（像元合并）比官方面积大，不能当作火场面积上屏。

### 第 3 页：危机时先打给谁（25 秒）

- **标题**：Limited staff. Many households. Who comes first?
- **要点**：
  - User: the overnight call-line supervisor.
  - Decision: prioritize outbound follow-up.
  - Delivery: simulated today; Retell integration planned.
- **视觉**：用原生形状画。
  - 左边是一列无序住户，右边是排好序的队列（可以嵌入队列截图 P3 的局部）。
  - 再用一条虚线箭头指向 "Retell — planned delivery"。
  - 出现的任何数量都标 "Illustrative"。
- **不说**：系统能判断哪个来电者最需要人工。我们排的是火势到达的先后，不是对话紧急度或救援优先级。

### 第 4 页：队列与排序逻辑（40 秒，主要的联络演示）

- **标题**：Nearby homes become a clear outreach queue.
- **流程条**（按问题 3 的方案 A）：House location → fire distance + wind (or model ETA) → estimated arrival → sorted queue → call status
- **小字说明**：Ranked by estimated fire arrival at each home; residents flagged with access needs move up 5 min. Not a complete danger assessment.
- **视觉**：
  - 左：选中房屋的近景（P4），有粉色描边、屋顶标记和火线。
  - 右：面板截图（P3），只保留 6 条线路卡片和不超过 5 行队列。
  - 用同一种颜色圈出选中的房屋和它在队列里的那一行。
  - 再配一张小图：较远住户的那一行（P5），名次更低，到达时间更长。
- **演示顺序**：
  1. 从准备好的回放时刻开始（约 T+1:40，第一次 VIIRS 过境之后）；
  2. 悬停队列第 1 行，地图上那栋房子被描边；
  3. 点击，相机飞过去；
  4. 对比第 N 行较远的一户；
  5. 线路卡片上出现模拟结果（Confirmed / No answer）。这部分是已实现的模拟，可以演示。
- **备注要点**：
  - 号码和通话结果都是虚构的。
  - 离得远不代表安全。
  - 排序依据可以看得到：每户都显示到达时间和标签。

### 第 5 页：平时的用途：预防准备（20 秒）

- **标题**：Before the emergency: where should we prepare?
- **要点**：
  - Intended user: community planner or Fire Safe Council.
  - Explore preventive treatment locations.
  - Compare scenarios before allocating resources.
- **视觉**：Plan 模式的白天主题截图（P6）。画面上能看到处理工具栏和正在刷的防火带，不能和第 2 页撞图。
- **不说**：能防止起火；已有合作方或付费用户。

### 第 6 页：试一种处理，比较模拟结果（40 秒，主要的预防演示）

- **标题**：Test a treatment. Compare the simulated outcome.
- **四种处理**：Fuel break · Prescribed burn · Thinning · Home hardening
- **小字说明**：Experimental scenarios, not operational guarantees. Each plan: 5 simulation runs, 8 h, same ignition and wind.
- **视觉**：
  - 左右两张地图（P7a None，P7b Yours），起火点、风、相机都相同。
  - 下方是对比表截图（P7c），只保留 Homes reached、Area burned、Cost 三行。
  - 只突出一个处理和一个结果。
- **数字**：全部取自实际运行结果。如果 "Yours" 显示 "≈ 0" 或带噪声提示，就照实写并解释"差异在模拟波动以内"。
- **措辞**：说 "simulated reduction in affected homes"，不说 "homes saved"。备注里提醒：飞火可以越过防火带；计划烧除只由授权的专业人员执行。
- **现场演示**：比较需要跑 20 次 GPU 模拟，不现场跑，用预先跑好的截图和录屏，并标明 "recorded"。

### 第 7 页：今天的原型用了哪些数据（25 秒）

- **标题**：What powers today's prototype?
- **表格**（四行，状态如实填写）：

| Input | Function | Source / status |
|---|---|---|
| Terrain, fuels, buildings | Geographic context and home locations | USGS 3DEP, LANDFIRE FBFM40, OSM (50,408 buildings), Sentinel-2 (Oct 14, 2026) — committed real data |
| Satellite fire observations | Reported hotspot locations and times | NASA FIRMS VIIRS — replay (4 passes, Oct 16); live FIRMS/GOES pollers built but not configured |
| Wind | Replay conditions and simulation input | Archived NOAA HRRR (5×5, hourly); WindNinja terrain-wind library |
| Resident contacts | Demonstrate the outreach workflow | Synthetic, one per building; fictional 555-01xx numbers; never dialled |

- **结论句**：Observed data, model outputs and fictional contacts are labelled separately.
- **视觉**：每行配一张小缩略图（P8a 燃料图层、P8b 卫星热点柱、P8c 风箭头、P8d 面板底部的"合成数据"说明）。
- **脚注**：社区范围为近似（approximate），不是官方疏散区；回放中的疏散令时间为约数，来源是 OCFA，据 CBS LA 和 KTLA 报道。

### 第 8 页：真正上线还需要什么（25 秒）

- **标题**：What would an operational deployment need?
- **要点**：
  - Verified, authorized contact records.
  - Agency-approved zones and message sources.
  - Additional observations and independent validation.
- **视觉**：原生形状画三列（Residents、Agency partners、Field observations），用虚线箭头指向产品，每条箭头标 "Proposed"。
- **备注**：
  - 换一个地区不是只改 bbox，还要检查当地数据覆盖、准备地形和燃料、对应坐标、支持语言、签运营协议。
  - 建筑轮廓或产权记录不等于住户电话，也不等于有权拨打。

### 第 9 页：没接听不代表安全（40 秒）

- **标题**：No answer does not mean safe.
- **主图**：原生形状画流程，按实际实现调整：

```text
Call attempted
      ↓
No answer ──→ retry once after 3 min            [SIMULATED]
      ↓
Still no answer → text moved up the queue       [SIMULATED]
      ↓
Text delivered ≠ acknowledged
      ↓
Explicit reply captured?                        [PLANNED]
  Yes → record response
   No → stays unresolved for operator follow-up
```

- **配图**：线路卡片 "No answer, retry later"，以及队列里带 "Retry" 标签的一行（P10），和第 4 页是同一户或同一类。
- **下方一条**（均为 PLANNED 或说明性文字）：
  - Stale fire data → show age (planned)
  - Missing observations → simulation remains an estimate
  - Phone/SMS outage → delivery unavailable
- **Twist 卡片**：只有在第 4 节问题 2 有真实答案时才放，格式为 "Twist → change in the build → demonstrated behavior"。
- **术语**：
  - 写 SMS follow-up，不写 AMBER Alert 或 WEA。
  - 求助标记不等于承诺救援。
  - 疏散令由有权限的人发布。

### 第 10 页：这个设计的不同之处（35 秒）

- **标题**：One workflow from preparation to outreach.
- **副标题**：The map feeds an inspectable next action.
- **视觉**：
  - brief 里的三行类别对比表，只比较类别，不点名竞品；
  - 一张产品小图（P2 的裁剪，或 P4）；
  - 仓库二维码，指向 https://github.com/ZQC8848/WildfireTwinLA（已确认是公开仓库）。
- **收尾**：Prepare before the fire. Prioritize outreach during it.
- **下一步一行**：Next: a consenting-volunteer pilot and verified call/SMS integration.
- **备注**：逐项说清哪些已能运行（真实数据、Norte 回放、模拟器与预报、预防方案比较、模拟联络流水线），哪些是模拟或计划。队员名按问题 5 的答复。

## 6. 截图清单

开工时再拍，这里只定好每张图的应用状态和取景。

### 6.1 项目截图

**拍摄方式：**
- 用现有的无头 Chrome 脚本（scratchpad 里的 `cdp/steps.mjs`），视口 1600×900，`deviceScaleFactor: 2`，输出 3200×1800。
- 计划比较（20 次 GPU 模拟）在软件渲染下很慢；如果太慢，改在你的浏览器里跑，由你截图或录屏。
- 联络画面有随机性，每张多拍几次，挑一张。

**状态缩写**：R = Respond 模式，NR = 数据源选 Norte replay，T+ 为时间轴时刻。

| ID | 用于 | 应用状态 | 取景与裁剪 | 标注 |
|---|---|---|---|---|
| P1 | 第 1 页 | R + NR，约 T+1:40 起联络已运行；等线路上依次出现 "Confirmed safe"、"No answer, retry later"、"Needs help"（需要帮助列表卡片也可以） | 分别裁出三张线路卡 | SIMULATED CONTACT |
| P2 | 第 2、10 页 | R + NR，第一次 VIIRS 过境后（约 T+1:40）；视角预设 1（Overview）或 2（Fire front）；打开卫星热点和冒泡；联络面板收起，让地图更宽 | 地图主体加左栏 Data source 上半部分；顶栏的 "Norte replay, simulation T + …" 要入镜 | ① 卫星热点 ② 模型火线 ③ 报告起火点；REPLAY |
| P3 | 第 3、4 页 | R + NR，约 T+1:40–2:00；面板展开，6 条线路正忙，队列在 Calls 标签页 | 面板：线路区加队列前 5 行 | ① 线路 ② 队列名次 ③ 到达时间；SIMULATED CONTACT |
| P4 | 第 4 页 | 同 P3；悬停或点击队列第 1 行，相机飞到那户 | 房屋近景：粉色描边、屋顶标记、附近火线 | 与 P3 的那一行用同色圈出 |
| P5 | 第 4 页 | 同 P3；悬停队列中较靠后的一行 | 队列行加地图上这户的位置 | 名次与到达时间的对比 |
| P6 | 第 5 页 | Plan 模式（白天主题），选 Fuel break，在 Norte 起火点下风向刷一段防火带 | 地图加左栏 Treatments 工具区 | ① 处理工具 ② 刷出的区域 |
| P7a/b/c | 第 6 页 | Plan 模式；起火点沿用回放起火点，或在 Norte 起火处放测试火；风用默认值 75°、8.5 m/s（HRRR 正午均值）；预算 $150k；点 "Suggest plans and compare"；点列头切换 None 和 Yours | a/b 两张相机完全相同的地图；c 是对比表加噪声提示 | 只突出一个结果；保留 "≈ 0" |
| P8a–d | 第 7 页 | a 燃料图层（Fuel 图例）；b 卫星热点柱的近景；c 风箭头；d 面板底部的合成数据说明 | 小缩略图 | — |
| P9 | 第 1 页背景 | P2 的压暗版本 | 全幅背景 | — |
| P10 | 第 9 页 | 联络运行中，等出现 "No answer, retry later" 的线路卡，以及带 Retry 标签的队列行 | 线路卡加队列行 | SIMULATED CONTACT |

### 6.2 网页截图

开工时用 WebSearch 找候选页面，再用无头 Chrome 截取。

**规则：**
- 每张都记下 URL、页面更新时间、读取时间（PDT）。
- 新闻只截标题、媒体名和日期，不截正文，并在页面上注明来源。
- 用到的只是小幅引用。

| ID | 用于 | 来源 | 截取范围 |
|---|---|---|---|
| W1 | 第 1、2 页 | CAL FIRE Norte 事件页：https://www.fire.ca.gov/incidents/2026/10/16/norte-fire | 页头的面积、控制率、更新时间；公众信息热线那一栏 |
| W2 | 第 2 页 | CAL FIRE Bryson：https://www.fire.ca.gov/incidents/2026/10/15/bryson-fire | 页头数字和更新时间 |
| W3 | 第 2 页 | CAL FIRE Peak：https://www.fire.ca.gov/incidents/2026/10/15/peak-fire | 页头数字和更新时间 |
| W4 | 第 2 页 | 关于 Norte 的新闻报道。优先找回放数据引用过的 CBS Los Angeles 和 KTLA 的疏散令报道，备选 OC Register、LA Times | 标题、媒体名、日期 |
| W5 | 备用 | 关于洛杉矶地区 Bryson 或 Peak 的新闻（如果第 2 页面板需要配图） | 标题、媒体名、日期 |

如果在开工时某场火已经不再活跃，就标 "recent"，或者不放。

## 7. 视觉规范

- **画幅**：16:9（13.33 × 7.5 in）。
- **配色**：取自应用的 `tokens.css`，与截图保持一致：

| 用途 | 颜色 |
|---|---|
| 底色 | Smoke #2B231F，Respond 模式的深色；或深炭色 #1E1A17 |
| 文字 | Ash #E5E7E1 |
| 火 | Ember #F26A1B |
| 观测、风 | Marine #6F9DBF |
| 人的干预、联络 | Retardant #D63A73（按问题 4 的方案 A） |
| Unresolved | 琥珀色 #E8A33A，只在第 9 页使用 |

  颜色一律同时配文字或图标，不单靠颜色区分。
- **字体**：Barlow，应用用的也是它，Google Slides 里自带。
  - 标题 36 pt，正文 24–28 pt，脚注 12–14 pt。
  - 本地用 Keynote 预览需要先安装 Barlow（免费的 OFL 字体）；也可以导入 Google Slides 后在那里预览。
- **状态标签**：圆角小标签，大写 13 pt。

| 标签 | 样式 |
|---|---|
| OBSERVED | 蓝色描边 |
| MODELLED | 橙色描边 |
| REPLAY | 灰色描边 |
| SIMULATED CONTACT | 粉色描边 |
| PLANNED | 虚线描边 |

- **版式**：
  - 每页一个标题加一个主视觉，正文大约 35–50 个词。
  - 截图要裁剪，最多配 3 个编号标注。
  - 流程图和对比图用原生形状，在 Google Slides 里可以直接编辑。
- **原型标注**：不是真实截图的设计稿标 "Prototype"，不和真实截图拼在一起。

## 8. 工具与制作步骤

**工具：**
- **生成 deck**：`pitch/build_deck.py`，用 python-pptx，通过 `uv run --with python-pptx` 临时安装，不改项目依赖。脚本可以反复运行，改文案或换截图后重新生成。
- **二维码**：用 `segno`（纯 Python）生成 PNG。
- **PDF**：最终从 Google Slides 导出，保证字体和版式与提交版一致。本地预览可以用 Keynote 打开 .pptx 导出。
- **视频**：录屏由你用 QuickTime 完成（真 GPU 才流畅），QuickTime 也能剪辑；本机没有 ffmpeg。
  - .pptx 可以内嵌视频，但导入 Google Slides 后不会保留。需要在 Slides 里另外从 Drive 插入视频。

**目录：**

```
pitch/
  build_deck.py
  assets/app/      项目截图 P*
  assets/web/      网页截图 W*
  assets/video/    备用演示片段
  out/             pptx、pdf、每页预览 png
  speaker-notes.md
  evidence-checklist.md
```

**步骤：**
1. 读你对第 4 节问题的答复；刷新 Hub 和三个 CAL FIRE 页面，记录读取时间。
2. 准备应用状态（后端联络调度 ×10、回放倍速），拍项目截图 P1–P10。
3. 搜索并截取网页图 W1–W5，同步写进来源清单。
4. 写 `build_deck.py`，生成第 1 版 .pptx，导出每页预览图，我逐页检查字号、裁剪和标签。
5. 写演讲备注：按每页时长控制字数（约每秒 2.3 个英文词），合计 300 秒。
6. 写证据清单：每条上屏说法对应截图编号、代码或数据路径、状态、来源。
7. 你把 .pptx 拖进 Google Drive 转成 Slides，插入 Drive 视频，导出 PDF。
8. 按 brief 的 14 项和 Hub 要求做最终检查，并计时预演一次。

**提交范围**：仓库里提交 `build_deck.py`、两份 Markdown 和截图；.pptx、.pdf、视频是否入库到时再定（文件较大）。

## 9. 交付前检查

**brief 的 14 项：**
1. 正好 10 页，顺序与本计划一致。
2. 第 2 页写的是 replay，并有时间戳；不出现 "live"。
3. 每个数字都来自截图中的配置；"≈ 0" 和噪声提示保留。
4. 联络面板是真实截图；如果用了设计稿，标 "Prototype"。
5. 号码全部是 555-01xx 虚构号段；没有密钥，没有真实住户数据。
6. 通话和短信都标 simulated。
7. 不写 AMBER Alert，不写 WEA。
8. 排序依据写成"预计火势到达时间"，不写成完整的危险评估。
9. 政府数据和合作方一律写 proposed。
10. 官方疏散令与模型预测在页面上区分清楚。
11. responsible-use 一行出现在相关页面的页脚和备注里。
12. CAL FIRE 数字和读取时间在导出前刷新，时区写 PDT。
13. 二维码、链接、字号、内嵌视频和离线备份都检查过。
14. 只说"已生成"或"已导入"；没有实际分享，就不说已分享。

**Hub 补充的两项：**
- Devpost 的 responsible-use 两行（可能怎样被滥用、我们怎样限制）与 deck 措辞一致。
- 如果 demo video 用到了 Retell，要讲到所用的 prompt。
