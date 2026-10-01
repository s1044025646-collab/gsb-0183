/**
 * 变时间步常速度二维卡尔曼滤波器。
 *
 * 状态 x = [px, py, vx, vy]^T。
 * 过程噪声采用连续白噪声加速度（CWNA）模型：
 *   Q = q * [ dt^3/3 I2   dt^2/2 I2 ]
 *           [ dt^2/2 I2   dt      I2 ]
 * 其中 q 为连续时间加速度功率谱强度（S_a）。
 *
 * 更新使用稳定的“信息形式”：K = P H^T S^{-1}，S 经对称化并做奇异/病态检查；
 * 计算失败时抛出可识别错误或标记拒绝，绝不以零矩阵静默替代。
 * 协方差使用约瑟夫（Joseph）稳定形式 P = (I-KH)P(I-KH)^T + K R K^T。
 */

import {
  Matrix,
  add,
  identity,
  inverse,
  mul,
  scale,
  sub,
  symmetrize,
  transpose,
  spdDiagnostics,
} from './matrix.js';
import { Observation, RunConfig } from './types.js';

export const STATE_DIM = 4;
const MEAS_DIM = 2;

/** 位置观测矩阵 H = [I2 | 0]。 */
const H: Matrix = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
];

export function stateTransition(dt: number): Matrix {
  const F = identity(STATE_DIM);
  F[0]![2] = dt;
  F[1]![3] = dt;
  return F;
}

/** 连续白噪声加速度过程噪声。 */
export function processNoiseCov(dt: number, q: number): Matrix {
  if (dt < 0) throw new Error(`时间差为负 (dt=${dt})，无法预测`);
  const q33 = (dt * dt * dt) / 3;
  const q22 = (dt * dt) / 2;
  const q11 = dt;
  const Q: Matrix = [
    [q33, 0, q22, 0],
    [0, q33, 0, q22],
    [q22, 0, q11, 0],
    [0, q22, 0, q11],
  ];
  return scale(Q, q);
}

export interface FilterState {
  x: Matrix; // 4x1
  P: Matrix; // 4x4
  t: number;
}

export function initFromObservation(obs: Observation): FilterState {
  return {
    t: obs.observedAt,
    x: [[obs.x], [obs.y], [0], [0]],
    // 速度用较大初始不确定度；位置采用首观测噪声放大。
    P: [
      [Math.max(obs.noise[0]![0]!, 1) * 4, 0, 0, 0],
      [0, Math.max(obs.noise[1]![1]!, 1) * 4, 0, 0],
      [0, 0, 100, 0],
      [0, 0, 0, 100],
    ],
  };
}

export function explicitInit(cfg: RunConfig, t0: number): FilterState {
  const s = cfg.initialState!;
  const P =
    cfg.initialCovariance && cfg.initialCovariance.length === 4
      ? cfg.initialCovariance.map((r) => r.slice())
      : [
          [1, 0, 0, 0],
          [0, 1, 0, 0],
          [0, 0, 4, 0],
          [0, 0, 0, 4],
        ];
  return { t: t0, x: [[s[0]], [s[1]], [s[2]], [s[3]]], P };
}

export function predict(state: FilterState, tNext: number, q: number): FilterState {
  const dt = tNext - state.t;
  if (dt < 0) throw new Error(`预测时间早于当前时间: t=${tNext} < t_prev=${state.t}`);
  const F = stateTransition(dt);
  const Q = processNoiseCov(dt, q);
  const xPred = mul(F, state.x);
  // P = F P F^T + Q，随后对称化。
  let Ppred = add(mul(mul(F, state.P), transpose(F)), Q);
  Ppred = symmetrize(Ppred);
  return { x: xPred, P: Ppred, t: tNext };
}

export interface UpdateResult {
  state: FilterState;
  innovation: Matrix; // 2x1
  S: Matrix; // 2x2 创新协方差
  gateScore: number; // 马氏距离平方
}

export interface UpdateAttempt {
  ok: boolean;
  reason: 'none' | 'singular_innovation';
  result?: UpdateResult;
  /** 即便失败也尝试给出的门控分数（用于诊断）。 */
  gateScore?: number;
  innovation?: Matrix;
  S?: Matrix;
}

/**
 * 尝试用观测更新。S 奇异/病态时返回失败而不是返回零矩阵。
 */
export function update(state: FilterState, obs: Observation): UpdateAttempt {
  const z: Matrix = [[obs.x], [obs.y]];
  const R: Matrix = [
    [obs.noise[0]![0]!, obs.noise[0]![1]!],
    [obs.noise[1]![0]!, obs.noise[1]![1]!],
  ];

  const zPred = mul(H, state.x);
  const innov = sub(z, zPred);
  const Ht = transpose(H);
  // S = H P H^T + R，对称化。
  let S = add(mul(mul(H, state.P), Ht), R);
  S = symmetrize(S);

  const diag = spdDiagnostics(S);
  let Sinv: Matrix;
  try {
    Sinv = inverse(S);
  } catch {
    return {
      ok: false,
      reason: 'singular_innovation',
      gateScore: undefined,
      innovation: innov,
      S,
    };
  }

  const gateScore = mul(mul(transpose(innov), Sinv), innov)[0]![0]!;

  if (!isFinite(gateScore) || diag.conditionNumber > 1e14) {
    return { ok: false, reason: 'singular_innovation', gateScore, innovation: innov, S };
  }

  // K = P H^T S^-1
  const K = mul(mul(state.P, Ht), Sinv);
  const xUp = add(state.x, mul(K, innov));

  // Joseph 形式：P = (I-KH) P (I-KH)^T + K R K^T
  const IKH = sub(identity(STATE_DIM), mul(K, H));
  let Pup = add(mul(mul(IKH, state.P), transpose(IKH)), mul(mul(K, R), transpose(K)));
  Pup = symmetrize(Pup);

  return {
    ok: true,
    reason: 'none',
    gateScore,
    innovation: innov,
    S,
    result: { state: { x: xUp, P: Pup, t: state.t }, innovation: innov, S, gateScore },
  };
}

/** 校验 2x2 观测噪声矩阵：对称、对角正、半正定。 */
export function validateNoise(R: number[][]): string | null {
  if (R.length !== 2 || R.some((r) => r.length !== 2)) return '噪声必须是 2x2 矩阵';
  const [[a, b], [c, d]] = R as [[number, number], [number, number]];
  if ([a, b, c, d].some((v) => typeof v !== 'number' || !isFinite(v))) return '噪声含非有限值';
  if (Math.abs(b - c) > 1e-9 * (1 + Math.abs(b))) return '噪声矩阵不对称';
  if (a <= 0 || d <= 0) return '噪声对角元素必须为正';
  // 2x2 对称半正定：a>=0, d>=0, ad - b^2 >= 0
  if (a * d - b * b < -1e-9) return '噪声矩阵不是半正定（行列式为负）';
  return null;
}

export function posteriorDiag(P: Matrix) {
  const d = spdDiagnostics(P);
  return {
    asymmetric: !d.symmetric,
    asymmetry: d.asymmetry,
    psd: d.positiveSemidefinite,
    minEigenvalue: d.minEigenvalue,
    conditionNumber: d.conditionNumber,
  };
}

export function stateToObj(s: FilterState) {
  return {
    x: s.x[0]![0]!,
    y: s.x[1]![0]!,
    vx: s.x[2]![0]!,
    vy: s.x[3]![0]!,
  };
}
