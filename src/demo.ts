// 演示: 两套配置在 outlier 与 turn 场景下的误差与拒绝记录对比
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store } from "./db.js";
import { executeRun, defaultConfig, computeMetrics } from "./service.js";
import { buildScenario } from "./scenarios.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kf-demo-"));
const store = new Store(path.join(tmp, "demo.db"));

function load(kind: "turn" | "outlier") {
  const sc = buildScenario(kind, 42);
  for (const s of sc.sensors) store.addSensor(`${kind}-${s.name}`);
  store.importObservations(sc.observations.map((o) => ({
    obs_id: o.obs_id, sensor_id: store.addSensor(`${kind}-${o.sensor}`),
    t_obs: o.t_obs, t_recv: o.t_recv, zx: o.zx, zy: o.zy, rxx: o.rxx, rxy: o.rxy, ryy: o.ryy,
  })));
  return sc;
}

const truthMap = (sc: ReturnType<typeof buildScenario>) =>
  new Map(sc.truth.map((t) => [t.t, { x: t.x, y: t.y, vx: t.vx, vy: t.vy }]));

console.log("=== 场景 1: 传感器离群 (outlier) — 门控策略对比 ===");
const scOut = load("outlier");
for (const [label, gate] of [["无门控", Infinity], ["门控 chi2=9.21", 9.21]] as const) {
  const cfg = { ...defaultConfig(), gateThreshold: gate };
  const { steps } = executeRun(store, `demo-outlier-gate=${gate}`, cfg);
  const m = computeMetrics(steps, truthMap(scOut));
  console.log(`[${label}] 位置RMSE=${m.positionRmse?.toFixed(3)}m 速度RMSE=${m.velocityRmse?.toFixed(3)}m/s 接受=${m.accepted} 拒绝=${m.rejected}`);
  const rej = steps.flatMap((s) => s.observations.filter((o) => !o.accepted).map((o) => ({ t: s.t, obs: o.obs_id, maha: o.mahalanobis.toFixed(1), reason: o.reason })));
  if (rej.length) console.log("  拒绝记录:", rej);
}

console.log("\n=== 场景 2: 转向失配 (turn) — 过程噪声对比 ===");
const scTurn = load("turn");
for (const q of [0.5, 5.0]) {
  const cfg = { ...defaultConfig(), q };
  const { steps } = executeRun(store, `demo-turn-q=${q}`, cfg);
  const m = computeMetrics(steps, truthMap(scTurn));
  console.log(`[q=${q}] 位置RMSE=${m.positionRmse?.toFixed(3)}m 速度RMSE=${m.velocityRmse?.toFixed(3)}m/s`);
}
console.log("\n说明: 常速度(CV)模型假设速度恒定, 目标转弯时模型失配; 增大 q 可让步跟踪转弯但平滑性下降、噪声增大。");
console.log("      根治需换用协调转弯(CT)或多模型(IMM)方法, 超出本服务范围。");
store.close();
fs.rmSync(tmp, { recursive: true, force: true });
