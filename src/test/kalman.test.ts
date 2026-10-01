import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FilterState,
  predict,
  processNoiseCov,
  update,
  validateNoise,
  initFromObservation,
} from '../core/kalman.js';
import { replay } from '../core/tracker.js';
import { makeCtx, SENSOR, obs } from './helpers.js';

test('一维可手算标量更新（方差与增益）', () => {
  // 位置标量：先验方差 p=2，测量方差 r=1 -> K = p/(p+r) = 2/3
  // 先验 x=0，测量 z=3 -> 后验 x = 2，后验方差 = (1-K)p = 2/3
  const state: FilterState = {
    t: 0,
    x: [[0], [0], [0], [0]],
    P: [
      [2, 0, 0, 0],
      [0, 9, 0, 0],
      [0, 0, 9, 0],
      [0, 0, 0, 9],
    ],
  };
  const pred = predict(state, 0, 0); // dt=0，不改变位置方差
  const att = update(
    pred,
    obs({ id: 'm1', observedAt: 0, x: 3, y: 0, noise: [[1, 0], [0, 1e12]] }),
  );
  assert.equal(att.ok, true);
  const post = att.result!.state;
  assert.ok(Math.abs(post.x[0]![0]! - 2) < 1e-9, `后验位置应为2，实得 ${post.x[0]![0]}`);
  assert.ok(Math.abs(post.P[0]![0]! - 2 / 3) < 1e-9, `后验方差应为2/3，实得 ${post.P[0]![0]}`);
  // y 通道噪声极大，几乎无信息，方差基本保持
  assert.ok(Math.abs(post.P[1]![1]! - 9) < 1e-6);
});

test('无观测纯预测：协方差随 dt 按 CWNA 解析增长', () => {
  const q = 1;
  const P0 = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  const st: FilterState = { t: 0, x: [[0], [0], [1], [0]], P: P0.map((r) => r.slice()) };
  const dt = 2;
  const p = predict(st, dt, q);
  // 位置方差 = q*dt^3/3 = 8/3；速度方差 = q*dt = 2；交叉 = q*dt^2/2 = 2
  assert.ok(Math.abs(p.P[0]![0]! - 8 / 3) < 1e-12);
  assert.ok(Math.abs(p.P[2]![2]! - 2) < 1e-12);
  assert.ok(Math.abs(p.P[0]![2]! - 2) < 1e-12);
  // 状态位置 = v*dt = 2
  assert.ok(Math.abs(p.x[0]![0]! - 2) < 1e-12);
});

test('过程噪声越大，预测不确定度越大', () => {
  const st: FilterState = {
    t: 0,
    x: [[0], [0], [0], [0]],
    P: [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ],
  };
  const low = predict(st, 1, 0.01);
  const high = predict(st, 1, 10);
  assert.ok(high.P[0]![0]! > low.P[0]![0]!);
  assert.ok(high.P[2]![2]! > low.P[2]![2]!);
});

test('Q 矩阵随 dt 单调且零 dt 时为零', () => {
  assert.deepEqual(processNoiseCov(0, 5).flat().every((v) => v === 0), true);
  assert.ok(processNoiseCov(2, 1)[0]![0]! > processNoiseCov(1, 1)[0]![0]!);
});

test('异常点被门控拒绝且保留预测', () => {
  const { repo, service, db } = makeCtx();
  repo.upsertSensor(SENSOR);
  const list = [
    obs({ id: 'a', observedAt: 0, receivedAt: 0, x: 0, y: 0 }),
    obs({ id: 'b', observedAt: 1, receivedAt: 1, x: 1, y: 0 }),
    obs({ id: 'c', observedAt: 2, receivedAt: 2, x: 2, y: 0 }),
    obs({ id: 'out', observedAt: 3, receivedAt: 3, x: 40, y: 40 }),
    obs({ id: 'd', observedAt: 4, receivedAt: 4, x: 4, y: 0 }),
  ];
  repo.importObservations(list);
  const r = service.run({ config: { gateThreshold: 5.9915, processNoise: 0.1 } });
  const rejected = r.steps.find((s) => s.observationId === 'out')!;
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.rejectReason, 'gated');
  assert.ok((rejected.gateScore ?? 0) > 5.9915);
  // 拒绝后后验==预测，不被粗色拉偏
  assert.deepEqual(rejected.posterior, rejected.predicted);
  // 下一条正常观测仍被接受
  assert.equal(r.steps.find((s) => s.observationId === 'd')!.accepted, true);
  db.close();
});

test('按观测时间回放与接收顺序不同（迟到不改写）', () => {
  const list = [
    obs({ id: 'late', observedAt: 1, receivedAt: 9, x: 1, y: 0 }),
    obs({ id: 'early', observedAt: 2, receivedAt: 2, x: 2, y: 0 }),
  ];
  const byObserved = replay(list, {
    replayOrder: 'observed',
    gateThreshold: 99,
    processNoise: 1,
  } as any);
  const byReceived = replay(list, {
    replayOrder: 'received',
    gateThreshold: 99,
    processNoise: 1,
  } as any);
  assert.deepEqual(byObserved.steps.map((s) => s.observationId), ['late', 'early']);
  assert.deepEqual(byReceived.steps.map((s) => s.observationId), ['early', 'late']);
});

test('同一时刻多次观测：dt=0 顺序更新且不报错', () => {
  const list = [
    obs({ id: 't0a', observedAt: 0, receivedAt: 0, x: 0, y: 0 }),
    obs({ id: 't0b', observedAt: 0, receivedAt: 0.1, x: 0.2, y: 0 }),
    obs({ id: 't1', observedAt: 1, receivedAt: 1, x: 1, y: 0 }),
  ];
  const r = replay(list, { replayOrder: 'observed', gateThreshold: 99, processNoise: 1 } as any);
  assert.equal(r.steps.length, 3);
  assert.ok(r.steps.every((s) => s.accepted));
});

test('连续缺测：预测协方差持续增长', () => {
  const list = [
    obs({ id: 'a', observedAt: 0, x: 0, y: 0 }),
    obs({ id: 'b', observedAt: 5, x: 5, y: 0 }),
  ];
  const r = replay(list, { replayOrder: 'observed', gateThreshold: 99, processNoise: 1 } as any);
  // 仅两个观测点；长间隔 dt=5 的预测位置方差显著大于初始
  const last = r.steps[1]!;
  assert.ok(last.predictedCov[0]![0]! > 1);
});

test('单观测可运行并初始化', () => {
  const r = replay([obs({ id: 'only', observedAt: 3, x: 7, y: -2 })], {
    replayOrder: 'observed',
    gateThreshold: 99,
    processNoise: 1,
  } as any);
  assert.equal(r.steps.length, 1);
  assert.ok(Math.abs(r.steps[0]!.posterior.x - 7) < 1e-9);
});

test('负时间差预测抛错而非静默', () => {
  const st: FilterState = {
    t: 5,
    x: [[0], [0], [0], [0]],
    P: [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ],
  };
  assert.throws(() => predict(st, 4, 1), /负|早于/);
});

test('非法噪声矩阵被拒绝', () => {
  assert.ok(validateNoise([[-1, 0], [0, 1]]) !== null); // 负对角
  assert.ok(validateNoise([[1, 0.5], [0.2, 1]]) !== null); // 不对称
  assert.ok(validateNoise([[1, 2], [2, 1]]) !== null); // 行列式负，非PSD
  assert.equal(validateNoise([[1, 0.3], [0.3, 1]]), null);
});

test('奇异创新协方差：更新报错而非退化为零矩阵', () => {
  const st: FilterState = {
    t: 0,
    x: [[0], [0], [0], [0]],
    P: [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
  };
  const att = update(st, obs({ id: 'z', observedAt: 0, noise: [[0, 0], [0, 0]], x: 1, y: 1 }));
  assert.equal(att.ok, false);
  assert.equal(att.reason, 'singular_innovation');
});

test('初始化函数正确', () => {
  const s = initFromObservation(obs({ id: 'i', observedAt: 2.5, x: 3, y: 4 }));
  assert.equal(s.t, 2.5);
  assert.equal(s.x[0]![0], 3);
  assert.equal(s.x[1]![0], 4);
  assert.equal(s.x[2]![0], 0);
});
