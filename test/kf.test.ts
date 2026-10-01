import test from "node:test";
import assert from "node:assert/strict";
import { predict, update, eye, Noise2D, Vec4, Mat4, diag2x2 } from "../src/kf.js";

const P0: Mat4 = eye(4).map((r) => r.map((v) => v * 100));

test("一维可手算更新: 静止目标, 标量卡尔曼增益", () => {
  // 状态 [x,y,vx,vy], 只看 x: P=100, R=25 -> K=0.8
  const x: Vec4 = [0, 0, 0, 0];
  const res = update(x, P0, [10, 0], { rxx: 25, rxy: 0, ryy: 25 });
  assert.ok(res.accepted);
  assert.ok(Math.abs(res.x[0] - 8) < 1e-9);       // 0 + 0.8*10
  assert.ok(Math.abs(res.x[1] - 0) < 1e-9);
  assert.ok(Math.abs(res.P[0][0] - 20) < 1e-9);   // (1-0.8)*100
  assert.ok(Math.abs(res.mahalanobis - (100 / 125 + 0)) < 1e-9); // 10^2/125
});

test("无观测纯预测: 位置按速度推进, 协方差增长", () => {
  const x: Vec4 = [0, 0, 2, 3];
  const r = predict(x, P0, 2, 0.5);
  assert.deepEqual(r.x, [4, 6, 2, 3]);
  assert.ok(r.P[0][0] > P0[0][0]);
});

test("协方差随过程噪声 q 单调增大", () => {
  const x: Vec4 = [0, 0, 1, 0];
  const p1 = predict(x, P0, 1, 0.1).P[0][0];
  const p2 = predict(x, P0, 1, 10).P[0][0];
  assert.ok(p2 > p1);
});

test("负时间差报错", () => {
  assert.throws(() => predict([0, 0, 0, 0], P0, -1, 1), /负时间差/);
});

test("非法噪声矩阵: 负方差与非对称相关被拒绝", () => {
  assert.throws(() => update([0, 0, 0, 0], P0, [0, 0], { rxx: -1, rxy: 0, ryy: 1 }), /非法观测噪声/);
  assert.throws(() => update([0, 0, 0, 0], P0, [0, 0], { rxx: 1, rxy: 5, ryy: 1 }), /非法观测噪声/);
  assert.equal(diag2x2({ rxx: 1, rxy: 0, ryy: 1 } as Noise2D).ok, true);
});

test("异常点被门控拒绝且保留预测与理由", () => {
  const x: Vec4 = [0, 0, 0, 0];
  const res = update(x, P0, [1000, 1000], { rxx: 1, rxy: 0, ryy: 1 }, { gateThreshold: 9.21 });
  assert.equal(res.accepted, false);
  assert.ok(res.reason?.includes("门限"));
  assert.deepEqual(res.x, x); // 状态不变
  assert.ok(res.mahalanobis > 9.21);
});

test("正常观测在门控内被接受", () => {
  const res = update([0, 0, 0, 0], P0, [1, 1], { rxx: 1, rxy: 0, ryy: 1 }, { gateThreshold: 9.21 });
  assert.equal(res.accepted, true);
});
