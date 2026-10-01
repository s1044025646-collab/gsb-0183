# 多传感器二维单目标卡尔曼跟踪后端

离线二维单目标轨迹估计服务。TypeScript + Node.js + SQLite(`node:sqlite` 内置模块，零原生依赖)，仅提供 API 与 CLI，可在 Windows 本地直接运行，不依赖 Docker / WSL / 外部服务。

## 功能

- 状态向量 `[x, y, vx, vy]`，常速度(CV)模型，变时间步预测
- 过程噪声：连续白噪声加速度模型(CWNA)，谱密度 `q` 可配置
- 多传感器异步观测：区分观测时间 `t_obs` 与接收时间 `t_recv`，回放排序规则为 `(t_obs, t_recv, obs_id)`，与到达顺序无关
- 支持缺测(纯预测步)、长间隔(可配置 `maxGap` 标记)、同一时刻多观测(顺序更新)
- 观测编号唯一：重复导入幂等跳过，矛盾重复报 409 / 非零退出码
- 观测噪声矩阵 R 对称性/半正定诊断；非法 R 直接报错
- 稳定更新：Joseph 形式协方差；创新协方差奇异/病态时报错而非静默置零
- 马氏距离平方门控(默认 chi2=9.21，2 自由度约 99%)；被拒绝观测保留预测值、拒绝理由与门控分数
- 每步输出预测值、后验估计、协方差与实际采用的观测，全部快照入库
- 运行(run)不可变：迟到数据不改写历史；新建 run 即新版本，支持运行间轨迹差异比较
- 指标：始终报告创新/马氏距离/接受拒绝计数；仅当提供真值时才计算位置/速度 RMSE，绝不生成虚假定位精度
- 内置固定种子场景：匀速 `constant`、转向失配 `turn`、传感器离群 `outlier`

## 快速开始

```powershell
npm install
npm run build     # 编译到 dist/
npm test          # 构建并运行全部测试
npm start         # 启动 API 服务 (默认端口 8080)
npm run demo      # 运行演示 (门控对比 + 过程噪声对比)
```

配置项通过环境变量：`KF_PORT`(端口，默认 8080)、`KF_DATA_DIR`(数据目录，默认 `./data`)、`KF_DB`(数据库文件完整路径)。

## CLI

```powershell
node dist/cli.js serve                              # 启动 API
node dist/cli.js sensor radarA                      # 注册传感器
node dist/cli.js import obs.json                    # 幂等导入观测
node dist/cli.js query 0 100                        # 按观测时间段查询
node dist/cli.js run my-run config.json             # 执行跟踪(新版本)
node dist/cli.js runs                               # 列出运行
node dist/cli.js steps 1                            # 查看每步快照
node dist/cli.js gating 1                           # 门控对照
node dist/cli.js export 1 csv out.csv               # 导出 JSON/CSV
node dist/cli.js load-scenario outlier 42           # 加载内置场景(真值写入 data/truth-*.json)
```

观测 JSON 格式：`[{obs_id, sensor|sensor_id, t_obs, t_recv?, zx, zy, rxx, rxy?, ryy}]`。

运行配置(全部可选，有默认值)：

```json
{
  "q": 0.5,
  "gateThreshold": 9.21,
  "init": { "x": [0,0,0,0], "P": [[100,0,0,0],[0,100,0,0],[0,0,100,0],[0,0,0,100]] },
  "from": 0, "to": 1000, "maxGap": 10
}
```

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| POST/GET | `/sensors` | 注册 / 列出传感器 |
| POST | `/observations/import` | 幂等导入(矛盾重复返回 409) |
| GET | `/observations?from=&to=` | 时间段查询 |
| POST | `/runs` | 执行跟踪 `{name, config}`，返回 runId 与指标 |
| GET | `/runs` | 列出运行 |
| GET | `/runs/:id/steps` | 每步预测/后验/协方差/观测 |
| GET | `/runs/:id/gating` | 门控对照(含拒绝理由与分数) |
| GET | `/runs/:id/export?format=json\|csv` | 导出 |
| GET | `/runs/compare/:a/:b` | 两运行轨迹差异(平均/逐点位置差) |

## 数学说明

- 预测：`x' = F(dt)x`，`P' = F P F' + Q(dt)`；`Q` 为 CWNA 离散化：`Q_pos=q·dt³/3, Q_cross=q·dt²/2, Q_vel=q·dt`
- 更新：Joseph 形式 `P=(I-KH)P(I-KH)'+KRK'`，保证对称半正定；每步对 P 做对称化与 Gershgorin PSD 诊断
- 门控：马氏距离平方 `d² = ν'S⁻¹ν > gateThreshold` 时拒绝，状态保持预测值并记录理由
- 负时间差直接抛错；R 非半正定/含非有限值直接抛错；S 奇异或病态(行列式相对量级 < 1e-12)抛错

## 演示结论(`npm run demo`)

1. **离群场景**：无门控 RMSE≈11m，启用 chi2=9.21 门控后 RMSE≈1m，离群观测被记录拒绝理由与马氏分数。
2. **转向场景**：CV 模型假设速度恒定，目标转弯时模型失配；增大 `q` 可让步跟踪转弯但平滑性下降。根治需协调转弯(CT)模型或 IMM 多模型方法，超出本服务范围。

## 测试覆盖

一维可手算标量更新、纯预测、协方差随 q 单调增长、异常点门控、按观测时间回放一致性、负时间差、非法噪声矩阵、单观测、连续缺测/长间隔、幂等导入与矛盾重复、迟到数据不改写历史、服务重启持久化、匀速场景误差有界。

## 限制

- 单目标、仅位置量测；不含目标检测、多目标关联、地图
- CV 模型对机动目标(转弯/加减速)存在固有失配
- `node:sqlite` 为 Node 实验性模块(启动有 ExperimentalWarning)，需 Node ≥ 22.5
- 真值指标需用户自行提供真值文件，服务不会虚构精度数据
