import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/db.js";
import { executeRun, defaultConfig, computeMetrics } from "../src/service.js";
import { buildScenario } from "../src/scenarios.js";

function tmpStore(): { store: Store; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kf-test-"));
  return { store: new Store(path.join(dir, "t.db")), dir };
}

function loadScenario(store: Store, kind: "constant" | "turn" | "outlier") {
  const sc = buildScenario(kind, 42);
  store.importObservations(sc.observations.map((o) => ({
    obs_id: o.obs_id, sensor_id: store.addSensor(`${kind}-${o.sensor}`),
    t_obs: o.t_obs, t_recv: o.t_recv, zx: o.zx, zy: o.zy, rxx: o.rxx, rxy: o.rxy, ryy: o.ryy,
  })));
  return sc;
}

test("幂等导入与矛盾重复", () => {
  const { store } = tmpStore();
  const sid = store.addSensor("s1");
  const row = { obs_id: "a", sensor_id: sid, t_obs: 1, t_recv: 1, zx: 0, zy: 0, rxx: 1, rxy: 0, ryy: 1 };
  assert.deepEqual(store.importObservations([row]), { inserted: 1, skipped: 0, conflicts: [] });
  assert.deepEqual(store.importObservations([row]), { inserted: 0, skipped: 1, conflicts: [] });
  const bad = store.importObservations([{ ...row, zx: 5 }]);
  assert.deepEqual(bad.conflicts, ["a"]);
  store.close();
});

test("按观测时间回放, 与接收时间无关", () => {
  const { store } = tmpStore();
  const sid = store.addSensor("s");
  // 乱序到达: t=2 先到, t=1 后到
  store.importObservations([
    { obs_id: "late", sensor_id: sid, t_obs: 1, t_recv: 5, zx: 1, zy: 0, rxx: 1, rxy: 0, ryy: 1 },
    { obs_id: "early", sensor_id: sid, t_obs: 2, t_recv: 2, zx: 2, zy: 0, rxx: 1, rxy: 0, ryy: 1 },
  ]);
  const { steps } = executeRun(store, "order", defaultConfig());
  assert.deepEqual(steps.map((s) => s.t), [1, 2]);
  assert.equal(steps[0].observations[0].obs_id, "late");
  store.close();
});

test("同一时刻多次观测顺序更新", () => {
  const { store } = tmpStore();
  const sid = store.addSensor("s");
  store.importObservations([
    { obs_id: "o1", sensor_id: sid, t_obs: 0, t_recv: 0, zx: 10, zy: 0, rxx: 1, rxy: 0, ryy: 1 },
    { obs_id: "o2", sensor_id: sid, t_obs: 0, t_recv: 0.1, zx: 12, zy: 0, rxx: 1, rxy: 0, ryy: 1 },
  ]);
  const { steps } = executeRun(store, "same-t", defaultConfig());
  assert.equal(steps.length, 1);
  assert.equal(steps[0].observations.length, 2);
  assert.ok(steps[0].updated!.x[0] > 10); // 第二次更新把估计拉向 12
  store.close();
});

test("单观测与连续缺测(长间隔标记)", () => {
  const { store } = tmpStore();
  const sid = store.addSensor("s");
  store.importObservations([
    { obs_id: "o1", sensor_id: sid, t_obs: 0, t_recv: 0, zx: 5, zy: 5, rxx: 1, rxy: 0, ryy: 1 },
    { obs_id: "o2", sensor_id: sid, t_obs: 100, t_recv: 100, zx: 5, zy: 5, rxx: 1, rxy: 0, ryy: 1 },
  ]);
  const cfg = { ...defaultConfig(), maxGap: 10 };
  const { steps } = executeRun(store, "gap", cfg);
  assert.equal(steps.length, 2);
  assert.equal(steps[1].longGap, true);
  store.close();
});

test("离群场景: 门控显著降低误差", () => {
  const { store } = tmpStore();
  const sc = loadScenario(store, "outlier");
  const truth = new Map(sc.truth.map((t) => [t.t, { x: t.x, y: t.y, vx: t.vx, vy: t.vy }]));
  const noGate = computeMetrics(executeRun(store, "ng", { ...defaultConfig(), gateThreshold: Infinity }).steps, truth);
  const gated = computeMetrics(executeRun(store, "g", { ...defaultConfig(), gateThreshold: 9.21 }).steps, truth);
  assert.ok(gated.rejected >= 2);
  assert.ok(gated.positionRmse! < noGate.positionRmse!);
  store.close();
});

test("迟到数据不改写历史运行; 新运行独立", () => {
  const { store } = tmpStore();
  const sid = store.addSensor("s");
  store.importObservations([{ obs_id: "a", sensor_id: sid, t_obs: 0, t_recv: 0, zx: 0, zy: 0, rxx: 1, rxy: 0, ryy: 1 }]);
  const r1 = executeRun(store, "v1", defaultConfig());
  assert.equal(r1.steps.length, 1);
  // 迟到数据
  store.importObservations([{ obs_id: "b", sensor_id: sid, t_obs: 1, t_recv: 9, zx: 1, zy: 0, rxx: 1, rxy: 0, ryy: 1 }]);
  assert.equal((store.steps(r1.runId) as unknown[]).length, 1); // 历史不变
  const r2 = executeRun(store, "v2", defaultConfig());
  assert.equal(r2.steps.length, 2);
  store.close();
});

test("服务重启后数据持久", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kf-test-"));
  const dbp = path.join(dir, "t.db");
  const s1 = new Store(dbp);
  s1.addSensor("persist");
  s1.importObservations([{ obs_id: "x", sensor_id: 1, t_obs: 0, t_recv: 0, zx: 0, zy: 0, rxx: 1, rxy: 0, ryy: 1 }]);
  s1.close();
  const s2 = new Store(dbp);
  assert.equal(s2.queryObservations().length, 1);
  s2.close();
});

test("匀速场景跟踪误差有界且速度收敛", () => {
  const { store } = tmpStore();
  const sc = loadScenario(store, "constant");
  const truth = new Map(sc.truth.map((t) => [t.t, { x: t.x, y: t.y, vx: t.vx, vy: t.vy }]));
  const m = computeMetrics(executeRun(store, "cv", defaultConfig()).steps, truth);
  assert.ok(m.positionRmse! < 3);
  assert.ok(m.velocityRmse! < 3);
  store.close();
});
