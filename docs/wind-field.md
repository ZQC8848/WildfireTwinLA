# 地形修正风场

## 为什么需要

当前研究区位于 San Juan Capistrano / San Clemente 的海岸丘陵。Santa Ana 风越过山脊、
沟谷和城市边缘时会发生加速、遮蔽和导流；在 12.8 km 的模拟域内不能只用一个均匀风向量。

| 效应 | 位置 | 量级 |
|---|---|---|
| 下坡风与背风加速 | Santa Ana 越过海岸丘陵后的背风坡 | 局地高于区域平均来流 |
| 峡谷导流 | 南北向峡谷 | 风向被扭向峡谷走向，偏转 30–90° |
| 山脊加速 | 山脊、山嘴 | 约 1.3–2 倍 |
| 背风遮蔽 | 山脊背后的小山谷 | 约 0.3–0.6 倍，可能局部逆向 |

蔓延规则中风的作用是指数形式，飞火距离也与风速成正比，所以单一风向会系统性地低估
丘陵背风坡和沟谷出口附近的火势。Norte 事件中的 ENE Santa Ana 来流正是需要离线地形修正的主情景。

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

`index.json`（已生成并提交）：

```json
{
  "width": 128,
  "height": 128,
  "directions": [0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5, 180, 202.5, 225, 247.5, 270, 292.5, 315, 337.5],
  "speeds": [5, 12, 20],
  "file": "wind-library.bin",
  "source": "WindNinja mass-conserving C API, brush, 10 m, resampled to 100 m"
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

## 后端实时风的顺序问题（已修正）

`server/app/providers/weather.py` 现在从北界开始生成 5×5 采样点，
`contracts.wind_message` 直接输出 core 的 `{ width, height, samples }` 格式。测试同时断言
首点纬度等于 bbox 北界，并验证 0° 北风转换后的 north 分量为负值。

离线库由 `wildfire-wind-library` 可重复生成。它执行 48 个真实 WindNinja
domain-average 算例、将原生网格双线性重采样到 128×128、翻转为北到南行序并打包为
little-endian Float32 east/north 分量。
