/**
 * 端到端演示：
 * 1) 写入三套固定种子场景与真值；
 * 2) 在 outlier 场景对比两种门控（95% vs 99%）与两种过程噪声；
 * 3) 在 turning 场景展示常速度模型失配的限制；
 * 输出中文摘要到控制台与 data/demo-report.md。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from '../db/database.js';
import { Repository } from '../db/repository.js';
import { TrackingService } from '../service/trackingService.js';
import { buildScenario } from '../scenarios/seed.js';

const dataDir = resolve(process.cwd(), 'data');
mkdirSync(dataDir, { recursive: true });
const db = openDatabase(resolve(dataDir, 'tracker.db'));
const repo = new Repository(db);
const service = new TrackingService(repo);

for (const kind of ['straight', 'turning', 'outlier'] as const) {
  const data = buildScenario(kind);
  for (const s of data.sensors) repo.upsertSensor(s);
  repo.importObservations(data.observations);
  repo.putGroundTruth(kind, data.truth);
}

const lines: string[] = [];
function out(s = ''): void {
  console.log(s);
  lines.push(s);
}

out('# 卡尔曼跟踪演示报告\n');
out('门限：卡方(2) 5.99≈95%（严格，拒绝更多）；9.21≈99%（宽松）。\n');

// ---- outlier：两套门控策略 ----
out('## 1) 离群场景：门控策略对比（q=1.0）\n');
const gateLoose = service.run({
  config: { gateThreshold: 9.2103, processNoise: 1.0 },
  label: 'outlier-gate99',
  scenario: 'outlier',
});
const gateStrict = service.run({
  config: { gateThreshold: 5.9915, processNoise: 1.0 },
  label: 'outlier-gate95',
  scenario: 'outlier',
});
for (const [name, r] of [
  ['99% 门限 (9.21)', gateLoose],
  ['95% 门限 (5.99)', gateStrict],
] as const) {
  const m = r.summary.metrics!;
  out(`- ${name}: 拒绝 ${r.summary.rejected} 条，位置RMSE=${m.positionRmse.toFixed(3)}，` +
    `速度RMSE=${m.velocityRmse.toFixed(3)}，均方新息(NIS)=${m.meanSquaredInnovation.toFixed(3)}`);
  const report = service.gateReport(r.runId)!;
  for (const rej of report.rejected) {
    out(`    拒绝: ${rej.observationId} 理由=${rej.reason} 门控分数=${rej.gateScore?.toFixed(2)}`);
  }
}

// ---- outlier：两套过程噪声 ----
out('\n## 2) 离群场景：过程噪声对比（99% 门限）\n');
for (const q of [0.05, 4.0]) {
  const r = service.run({
    config: { gateThreshold: 9.2103, processNoise: q },
    label: `outlier-q${q}`,
    scenario: 'outlier',
  });
  const m = r.summary.metrics!;
  out(`- q=${q}: 位置RMSE=${m.positionRmse.toFixed(3)}，速度RMSE=${m.velocityRmse.toFixed(3)}，拒绝 ${r.summary.rejected} 条`);
}

// ---- straight vs turning：模型失配 ----
out('\n## 3) 模型匹配 vs 转向失配（99% 门限, 低过程噪声 q=0.1，失配最明显）\n');
const straight = service.run({
  config: { gateThreshold: 9.2103, processNoise: 0.1 },
  label: 'straight',
  scenario: 'straight',
});
const turning = service.run({
  config: { gateThreshold: 9.2103, processNoise: 0.1 },
  label: 'turning',
  scenario: 'turning',
});
out(`- straight: 位置RMSE=${straight.summary.metrics!.positionRmse.toFixed(3)}，速度RMSE=${straight.summary.metrics!.velocityRmse.toFixed(3)}`);
out(`- turning : 位置RMSE=${turning.summary.metrics!.positionRmse.toFixed(3)}，速度RMSE=${turning.summary.metrics!.velocityRmse.toFixed(3)}`);
out('\n说明：常速度模型假设目标做匀速直线运动；转向时真实速度方向持续变化，');
out('预测沿当前速度切线外推，持续落后于真实轨迹，表现为新息增大、误差随角速度累积。');
out('提高过程噪声 q 可更快跟随但会放大噪声；根本上应使用常转向(CTRV)或交互式多模型(IMM)。\n');

// ---- 版本比较（迟到数据不改写历史，新版本重放） ----
out('## 4) 版本差异比较\n');
const cmp = service.compare(gateLoose.runId, gateStrict.runId);
out(`- 运行 ${cmp.runA} vs ${cmp.runB}：共同步骤 ${cmp.commonSteps}，位置RMS差异=${cmp.positionRmsDiff.toFixed(3)}，` +
  `拒绝数 ${cmp.rejectedA} vs ${cmp.rejectedB}`);

writeFileSync(resolve(dataDir, 'demo-report.md'), lines.join('\n'), 'utf-8');
out(`\n报告已写入 data/demo-report.md（运行 id: ${gateLoose.runId}, ${gateStrict.runId}）`);
db.close();
