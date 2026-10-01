# 多传感器二维目标卡尔曼跟踪后端

离线二维**单目标**轨迹估计服务。状态为 `[x, y, vx, vy]`（位置 + 速度），输入为带时间戳与
测量噪声协方差的多个位置传感器观测。仅提供 **REST API 与 CLI**，不含前端、目标检测、
图像处理、多目标身份关联或外部地图。

技术栈：**TypeScript + Node.js（内置 `node:sqlite`）**，无需 Docker / WSL / 付费服务 / 在线 API。

## 环境要求

- Node.js `>= 22.5`（开发验证版本：`v25.5.0`，`node:sqlite` 内置，免原生编译）
- Windows 本地 PowerShell 直接运行；数据默认写入项目内 `data/` 目录

## 安装

```powershell
npm install
```

## 构建 / 测试 / 启动 / 演示

```powershell
npm run build     # 类型检查并编译到 dist/
npm test          # 运行 node:test 单元测试（20 个）
npm run seed      # 导入固定种子的三套内置场景到 data/tracker.db
npm run demo      # 端到端演示：两套门控/过程噪声对比，生成 data/demo-report.md

# 启动 HTTP 服务（端口可配置）
npm start
$env:PORT=3100; npm start          # 自定义端口
$env:DATA_DIR="D:\kf-data"; npm start   # 自定义数据目录（库文件 tracker.db）
```

## 算法说明

### 状态与变步长常速度模型

状态转移（`dt` 为相邻观测的时间差，可为变长）：

```
F = [ 1 0 dt 0 ; 0 1 0 dt ; 0 0 1 0 ; 0 0 0 1 ]
```

### 过程噪声：连续白噪声加速度（CWNA）

```
Q = q * [ dt^3/3·I2  dt^2/2·I2 ; dt^2/2·I2  dt·I2 ]
```

其中 `q` 为连续时间加速度功率谱强度（`processNoise`，可配置）。`dt=0` 时 `Q=0`，
支持同一时刻多次观测的顺序更新；`dt` 越大位置/速度不确定度增长越快（长间隔、缺测）。

### 更新（稳定形式）

- 新息 `ν = z − H x⁻`，创新协方差 `S = H P⁻ Hᵀ + R`，先做对称化。
- 增益 `K = P⁻ Hᵀ S⁻¹`，`S` 用高斯-若尔当**部分主元求逆**；当 `S` 奇异或条件数过大时，
  **该观测被标记拒绝并保留预测，绝不用零矩阵顶替**。
- 协方差用 **Joseph 稳定形式** `P = (I−KH)P(I−KH)ᵀ + K R Kᵀ`，再对称化。
- 每步对协方差做**对称性与半正定诊断**（雅可比特征值：最小特征值、条件数、非对称度）。

### 门控（马氏距离）

门控分数 `g = νᵀ S⁻¹ ν`（二维新息，服从 χ²(2)）。常用阈值：

| 置信度 | 阈值 |
| --- | --- |
| 95% | 5.9915（严格，拒绝更多） |
| 99% | 9.2103（默认，宽松） |

`g > gateThreshold` 的观测被拒绝：**保留预测**、记录拒绝理由（`gated` / `singular_innovation`
`/ invalid_measurement`）与门控分数，后验快照等于预测且标记未采用该观测。

### 观测时间 vs 接收时间（回放规则）

明确区分 `observedAt`（观测发生时刻）与 `receivedAt`（到达后端时刻）。排序确定且无歧义：

- `replayOrder=observed`（默认）：主键 `observedAt`，次 `receivedAt`，再 `sensorId`、`id`
- `replayOrder=received`：主键 `receivedAt`，次 `observedAt`，再 `sensorId`、`id`

时间倒退（负 `dt`）直接报错而非静默处理；支持缺测、长间隔、同刻多次观测。

### 幂等与版本

- 观测编号 `id` 全局唯一：**相同内容重复导入被忽略（幂等）**；**同 id 内容矛盾报 409 冲突**。
- 每次 `POST /runs` 创建**独立滤波器的新版本**，运行之间不共享内存状态。
- **迟到数据不改写历史结果**：补数据后新建运行重新回放，再用比较接口查看轨迹差异。

### 指标（不杜撰定位准确率）

- 无真值时只报告可验证的**均方新息（NIS / 门控分数样本）**。
- 有合成真值时额外计算**位置 RMSE**与**速度 RMSE**（后验时间点最近邻匹配真值）。

## 内置场景（固定种子）

| 场景 | 含义 |
| --- | --- |
| `straight` | 匀速直线，模型匹配；含同刻多次观测 |
| `turning` | 定半径转向，常速度模型**失配** |
| `outlier` | 含连续缺测与两类离群点（粗差 / 中等离群） |

噪声由固定种子的相关高斯采样生成；观测带接收延迟（模拟迟到）。

## REST API

启动后默认 `http://localhost:3000`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| GET/POST | `/sensors` | 列表 / 幂等创建传感器 |
| POST | `/observations` | 幂等导入观测（数组或 `{observations:[]}`） |
| GET | `/observations?from=&to=&sensorId=` | 按观测时间窗口查询 |
| POST | `/runs` | 执行跟踪，产生新版本。body：`{config,label,scenario}` |
| GET | `/runs` | 列出所有运行版本 |
| GET | `/runs/:id?steps=1` | 运行汇总（或含每步快照） |
| GET | `/runs/:id/gating` | 门控对照（接受/拒绝、理由、门控分数） |
| GET | `/runs/:id/export.json` `/export.csv` | JSON / CSV 导出 |
| GET | `/runs/compare?a=&b=` | 比较两个版本轨迹差异 |

`config` 字段：`gateThreshold`、`processNoise`、`replayOrder`、`fromTime`、`toTime`、
`initialState:[x,y,vx,vy]`、`initialCovariance(4x4)`、`maxSteps`。

示例：

```powershell
# 建传感器（seed 已内置，可跳过）
Invoke-RestMethod -Method Post http://localhost:3000/sensors -ContentType 'application/json' `
  -Body '{"id":"radar","name":"雷达","defaultNoise":[[0.5,0],[0,0.5]]}'

# 导入 + 执行（99% 门限, q=1）
Invoke-RestMethod -Method Post http://localhost:3000/runs -ContentType 'application/json' `
  -Body '{"scenario":"outlier","config":{"gateThreshold":9.2103,"processNoise":1}}'
```

## CLI

```powershell
npm run cli -- seed --force
npm run cli -- sensors
npm run cli -- import examples/observations.example.json
npm run cli -- query --from 0 --to 2
npm run cli -- run --q 1 --gate 5.9915 --order observed --scenario outlier --label run95
npm run cli -- runs
npm run cli -- show 1 --steps
npm run cli -- gating 1
npm run cli -- compare 1 2
npm run cli -- export 1 out.csv
```

也可使用编译产物：`npm run build` 后 `node dist/cli/index.js <命令>`（全局 `bin` 名 `tracker`）。

## 项目结构

```
src/
  core/       矩阵运算、卡尔曼滤波、回放引擎、指标、类型
  db/         SQLite 建表迁移与仓储（幂等/冲突）
  service/    跟踪服务编排、版本比较、JSON/CSV 导出
  scenarios/  固定种子场景生成
  server/     HTTP API（node:http）
  cli/        命令行
  demo/       端到端演示
  test/       node:test 测试
```

## 测试覆盖

- 一维可手算更新（`K=2/3`、后验 `x=2`、方差 `2/3`）
- 无观测纯预测、协方差随过程噪声 / `dt` 的解析变化
- 异常点门控拒绝且保留预测；门控分数正确
- 按观测时间 vs 接收时间回放一致性、同刻多次观测
- 负时间差、非法噪声矩阵、奇异创新协方差、单观测、连续缺测
- 导入幂等、矛盾重复报错、服务重启持久化与结果可复现、运行间状态隔离

运行：`npm test`。

## 常速度模型在转向场景的限制

常速度（CV）模型假设目标做匀速直线运动。转向时真实速度方向持续变化，滤波器仍沿当前
速度做切线外推，预测持续偏离真实轨迹，表现为新息增大、位置/速度误差随转角累积。
调低过程噪声 `q` 时滤波平滑但跟不上转向；调高 `q` 能更快跟随却放大测量噪声。
根本解决应改用**常转向速率模型（CTRV）**或**交互式多模型（IMM）**，超出本后端范围。
演示中 `turning` 场景在 `q=0.1` 下位置 RMSE 约 `10.2`，而 `straight` 约 `1.0`，直观体现失配。
