# 地形修正风场

## 为什么需要

研究区横跨 San Gabriel 山脉南麓前缘：Altadena 海拔约 350–600 m，北面约 5 km 就是 Mount Wilson 一线（约 1,740 m）的山脊，中间切着 Eaton Canyon、Arroyo Seco 等峡谷。在这个尺度上，地形会显著改变风：

| 效应 | 位置 | 量级 |
|---|---|---|
| 下坡风暴（背风波） | 北风 / Santa Ana 越过山脊后沿南坡下冲，山脚最强 | 山脚风速可达来流的 1.5–2 倍以上 |
| 峡谷导流 | 南北向峡谷 | 风向被扭向峡谷走向，偏转 30–90° |
| 山脊加速 | 山脊、山嘴 | 约 1.3–2 倍 |
| 背风遮蔽 | 山脊背后的小山谷 | 约 0.3–0.6 倍，可能局部逆向 |

蔓延规则中风的作用是指数形式，飞火距离也与风速成正比，所以单一风向会系统性地低估山脚（社区所在处）的火势。2025 年 1 月 Eaton 火灾正是由沿南坡下冲的强东北风推进 Altadena 的。

## 数据流

```
Open-Meteo 实时风（后端，区域平均来流）
        │
        ▼
WindNinja 风场库（离线预算，按来流风向 × 风速）──► 前端插值 ──► core.WindField（W×H）
        │                                                         │
        └── 不存在时：前端地形启发式（近似）                      ├─ GPU 火势模拟
                                                                  ├─ CPU 参考实现 / 规划器
                                                                  ├─ 烟雾漂移
                                                                  └─ 风场图层（箭头）
```

所有消费者读的都是 core 的 `WindField`，接口不变。

## 坐标约定（所有风场数据都必须遵守）

- 采样网格**行优先、由北向南**：第 0 行在最北，第 0 列在最西。
- 采样点 `(0, 0)` 对齐网格格子 `(0, 0)` 的中心，`(n−1, n−1)` 对齐格子 `(W−1, H−1)` 的中心；中间按比例线性分布。插值在**速度分量**上进行（与 `packages/core/src/spread.ts` 的 `windAt` 一致）。
- 风向用气象惯例：**风的来向**，度，0 = 北风，90 = 东风。

## WindNinja 风场库（数据管线，Tia）

**运行设置**

| 项 | 值 |
|---|---|
| DEM | 与 `grid.json` 相同的范围与 UTM 11N 投影（可直接用管线已下载的 `dem.tif`） |
| 网格分辨率 | 100 m |
| 初始化方式 | domain-average（区域平均风） |
| 输入风高度 | 10 m（与 Open-Meteo `wind_speed_10m` 一致） |
| 输出风高度 | 10 m |
| 植被 | brush（chaparral 为主） |
| 解算器 | 默认质量守恒解算器即可；若时间允许，可对 Santa Ana 方向（0–90°）另跑 momentum solver，背风坡下坡加速更真实 |
| 来流风向 | 0°、22.5°、45° … 337.5°，共 16 个 |
| 来流风速 | 5、12、20 m/s，共 3 档 |

**输出文件**（放在 `web/public/data/wind/`，该目录已被 git 忽略）

`index.json`：

```json
{
  "width": 128,
  "height": 128,
  "directions": [0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5, 180, 202.5, 225, 247.5, 270, 292.5, 315, 337.5],
  "speeds": [5, 12, 20],
  "file": "wind-library.bin",
  "source": "WindNinja 3.x, mass-conserving, 100 m"
}
```

`wind-library.bin`：little-endian Float32，布局为

```
[风向 16][风速 3][行 128，由北向南][列 128，由西向东][分量 2：向东 m/s，向北 m/s]
```

共 16 × 3 × 128 × 128 × 2 个 float（约 6.3 MB）。WindNinja 的输出需要重采样到 128×128，并对齐上面的坐标约定。

**自检**

- 某个风向下，平原区（社区南部）的平均风速应接近来流风速。
- 来流为北风（0°）时，南坡山脚的风速应明显高于来流，峡谷内的风向应接近峡谷走向。
- 前端加载后，HUD 的 Wind 一行会显示 `WindNinja library (...)`，风场图层的箭头应与 WindNinja 输出一致。

## 前端插值与后备（已实现，`web/src/sim/terrainWind.ts`）

- **有风场库时**：按来流风向（环形）与风速做双线性插值；风速超出库的范围时按比例缩放。
- **没有风场库时**：用地形启发式近似，系数未经验证，只用于演示：
  - 地形暴露度 TPI（高程减去周围 800 m 平均高程）：山脊加速、山谷减速；
  - 顺风方向的坡度：背风下坡加速，迎风上坡略减速；
  - 山谷中把风向扭向等高线方向（峡谷导流）。
- 界面：调试面板 **Fire simulation → Wind model** 切换 "Uniform" 与 "Terrain-adjusted"；**Show wind field** 显示风场箭头（Marine 色，减弱处更暗，加速处更亮）。

## 后端实时风的顺序问题（待修正）

`server/app/providers/weather.py` 的 `sampling_grid` 生成的 5×5 采样点是**由南向北**排列的（第 0 行在最南），而 core 的 `WindField` 约定是**由北向南**。直接把后端的风交给模拟，南北会颠倒。另外，`contracts.wind_message` 仍在输出旧格式 `grid5x5`，而 core 的 `WindField` 已改为 `{ width, height, samples: [{ speedMs, dirFromDeg }] }`。建议后端：

1. `sampling_grid` 改为由北向南（`north - row * (north - south) / (size - 1)`）；
2. `wind_message` 改为输出 `{ "width": 5, "height": 5, "samples": [{ "speedMs": …, "dirFromDeg": … }, …] }`，并同步 `docs/team-plan.md` 约定 4；
3. 加一个测试：第一个采样点的纬度等于 bbox 的北界。
