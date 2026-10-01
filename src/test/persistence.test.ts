import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openDatabase } from '../db/database.js';
import { Repository, ConflictError } from '../db/repository.js';
import { TrackingService } from '../service/trackingService.js';
import { makeCtx, SENSOR, obs } from './helpers.js';

test('观测导入幂等：重复内容不新增', () => {
  const { repo, db } = makeCtx();
  repo.upsertSensor(SENSOR);
  const o = obs({ id: 'x1', observedAt: 0, x: 1, y: 2 });
  assert.deepEqual(repo.importObservations([o]), { inserted: 1, unchanged: 0 });
  assert.deepEqual(repo.importObservations([o]), { inserted: 0, unchanged: 1 });
  assert.equal(repo.queryObservations({}).length, 1);
  db.close();
});

test('矛盾重复导入报错（同 id 不同内容）', () => {
  const { repo, db } = makeCtx();
  repo.upsertSensor(SENSOR);
  repo.importObservation(obs({ id: 'x1', observedAt: 0, x: 1, y: 2 }));
  assert.throws(
    () => repo.importObservation(obs({ id: 'x1', observedAt: 0, x: 9, y: 2 })),
    ConflictError,
  );
  db.close();
});

test('传感器矛盾重复报错', () => {
  const { repo, db } = makeCtx();
  repo.upsertSensor(SENSOR);
  assert.throws(
    () => repo.upsertSensor({ ...SENSOR, name: '改名后的冲突传感器' }),
    ConflictError,
  );
  db.close();
});

test('服务重启后数据仍在，且新版本结果可复现', () => {
  const { repo, db, dir } = makeCtx();
  repo.upsertSensor(SENSOR);
  repo.importObservations([
    obs({ id: 'a', observedAt: 0, x: 0, y: 0 }),
    obs({ id: 'b', observedAt: 1, x: 1, y: 0.1 }),
    obs({ id: 'c', observedAt: 2, x: 2, y: -0.1 }),
  ]);
  const run1 = new TrackingService(repo).run({ config: { processNoise: 1, gateThreshold: 99 } });
  const firstX = run1.steps.map((s) => s.posterior.x);
  db.close();

  // 重新打开同一数据库文件，模拟服务重启
  const db2 = openDatabase(join(dir, 't.db'));
  const repo2 = new Repository(db2);
  assert.equal(repo2.queryObservations({}).length, 3);
  const run2 = new TrackingService(repo2).run({ config: { processNoise: 1, gateThreshold: 99 } });
  assert.deepEqual(run2.steps.map((s) => s.posterior.x), firstX);
  assert.notEqual(run1.runId, run2.runId);
  // 历史运行未被改写
  const historical = repo2.getSteps(run1.runId);
  assert.deepEqual(historical.map((s) => s.posterior.x), firstX);
  db2.close();
});

test('不同运行之间不串状态（独立滤波器）', () => {
  const { repo, service, db } = makeCtx();
  repo.upsertSensor(SENSOR);
  repo.importObservations([
    obs({ id: 'a', observedAt: 0, x: 0, y: 0 }),
    obs({ id: 'b', observedAt: 1, x: 1, y: 0 }),
  ]);
  const r1 = service.run({ config: { processNoise: 0.01 } });
  const r2 = service.run({ config: { processNoise: 5 } });
  // 第二次运行不应受第一次影响：初始后验位置相同
  assert.ok(Math.abs(r1.steps[0]!.posterior.x - r2.steps[0]!.posterior.x) < 1e-9);
  // 但预测协方差因 q 不同而不同
  assert.notEqual(
    r1.steps[1]!.predictedCov[0]![0],
    r2.steps[1]!.predictedCov[0]![0],
  );
  db.close();
});

test('时间窗口查询生效', () => {
  const { repo, db } = makeCtx();
  repo.upsertSensor(SENSOR);
  repo.importObservations([
    obs({ id: 'a', observedAt: 0 }),
    obs({ id: 'b', observedAt: 5 }),
    obs({ id: 'c', observedAt: 10 }),
  ]);
  assert.deepEqual(
    repo.queryObservations({ fromObserved: 1, toObserved: 8 }).map((o) => o.id),
    ['b'],
  );
  db.close();
});

test('非法观测噪声在导入边界即报错', () => {
  const { repo, db } = makeCtx();
  repo.upsertSensor(SENSOR);
  assert.throws(
    () => repo.importObservation(obs({ id: 'bad', observedAt: 0, noise: [[-1, 0], [0, 1]] })),
    /非法/,
  );
  db.close();
});
