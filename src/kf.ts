// 二维常速度(CV)卡尔曼滤波器，状态 [x, y, vx, vy]
// 过程噪声: 连续白噪声加速度模型 (CWNA), 谱密度 q (m^2/s^3)

export type Vec4 = [number, number, number, number];
export type Mat4 = number[][]; // 4x4
export interface Noise2D { rxx: number; rxy: number; ryy: number }

export interface DiagIssue { code: string; message: string }

export function zeros(n: number, m: number): number[][] {
  return Array.from({ length: n }, () => new Array(m).fill(0));
}
export function eye(n: number): number[][] {
  const a = zeros(n, n);
  for (let i = 0; i < n; i++) a[i][i] = 1;
  return a;
}
export function matMul(a: number[][], b: number[][]): number[][] {
  const n = a.length, k = b.length, m = b[0].length;
  const out = zeros(n, m);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++) {
      let s = 0;
      for (let p = 0; p < k; p++) s += a[i][p] * b[p][j];
      out[i][j] = s;
    }
  return out;
}
export function matAdd(a: number[][], b: number[][], sign = 1): number[][] {
  return a.map((row, i) => row.map((v, j) => v + sign * b[i][j]));
}
export function matT(a: number[][]): number[][] {
  return a[0].map((_, j) => a.map((r) => r[j]));
}
export function matVec(a: number[][], v: number[]): number[] {
  return a.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));
}
export function symmetrize(a: number[][]): number[][] {
  const n = a.length;
  const out = zeros(n, n);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) out[i][j] = 0.5 * (a[i][j] + a[j][i]);
  return out;
}

// 2x2 协方差诊断: 对称性 + 半正定(特征值)
export function diag2x2(R: Noise2D, symTol = 1e-9): { ok: boolean; issues: DiagIssue[]; eigenvalues: [number, number] } {
  const issues: DiagIssue[] = [];
  for (const [k, v] of Object.entries(R)) {
    if (!Number.isFinite(v)) issues.push({ code: "R_NON_FINITE", message: `R.${k} 非有限数` });
  }
  const tr = R.rxx + R.ryy;
  const det = R.rxx * R.ryy - R.rxy * R.rxy;
  const disc = Math.sqrt(Math.max(0, (R.rxx - R.ryy) ** 2 + 4 * R.rxy * R.rxy));
  const eig: [number, number] = [(tr + disc) / 2, (tr - disc) / 2];
  const scale = Math.max(Math.abs(R.rxx), Math.abs(R.ryy), 1e-300);
  if (eig[1] < -1e-9 * scale) issues.push({ code: "R_NOT_PSD", message: `R 非半正定, 最小特征值 ${eig[1]}` });
  if (det < 0 && Math.abs(det) > symTol * scale * scale) issues.push({ code: "R_NEG_DET", message: `R 行列式为负: ${det}` });
  return { ok: issues.length === 0, issues, eigenvalues: eig };
}

// 4x4 协方差诊断: 对称偏差 + 最小特征值(幂迭代求最大, 移位反幂求最小近似)
export function diag4x4(P: Mat4): { symmetric: boolean; maxAsym: number; minEigApprox: number; issues: DiagIssue[] } {
  const issues: DiagIssue[] = [];
  let maxAsym = 0;
  for (let i = 0; i < 4; i++)
    for (let j = i + 1; j < 4; j++) maxAsym = Math.max(maxAsym, Math.abs(P[i][j] - P[j][i]));
  const symmetric = maxAsym <= 1e-8;
  if (!symmetric) issues.push({ code: "P_ASYM", message: `P 非对称, 最大偏差 ${maxAsym}` });
  // 用 Gershgorin 下界做保守 PSD 诊断
  let minBound = Infinity;
  for (let i = 0; i < 4; i++) {
    let r = 0;
    for (let j = 0; j < 4; j++) if (j !== i) r += Math.abs(P[i][j]);
    minBound = Math.min(minBound, P[i][i] - r);
  }
  if (minBound < -1e-6) issues.push({ code: "P_MAYBE_NOT_PSD", message: `P 可能非半正定 (Gershgorin 下界 ${minBound})` });
  return { symmetric, maxAsym, minEigApprox: minBound, issues };
}

export function transition(dt: number): Mat4 {
  return [
    [1, 0, dt, 0],
    [0, 1, 0, dt],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
}

// CWNA 过程噪声协方差
export function processNoise(dt: number, q: number): Mat4 {
  const d2 = dt * dt, d3 = d2 * dt;
  const qx = q * d3 / 3, qv = q * dt, qc = q * d2 / 2;
  return [
    [qx, 0, qc, 0],
    [0, qx, 0, qc],
    [qc, 0, qv, 0],
    [0, qc, 0, qv],
  ];
}

export const H: number[][] = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
];

export interface PredictResult { x: Vec4; P: Mat4 }
export function predict(x: Vec4, P: Mat4, dt: number, q: number): PredictResult {
  if (!(dt >= 0)) throw new Error(`负时间差 dt=${dt}，拒绝预测`);
  const F = transition(dt);
  const Q = processNoise(dt, q);
  const xp = matVec(F, x) as Vec4;
  const Pp = symmetrize(matAdd(matMul(matMul(F, P), matT(F)), Q));
  return { x: xp, P: Pp };
}

export interface UpdateResult {
  x: Vec4; P: Mat4; innovation: [number, number]; S: number[][];
  mahalanobis: number; accepted: boolean; reason?: string;
}

export interface UpdateOptions { gateThreshold?: number } // 马氏距离平方门限 (chi2, 2dof)

// 稳定更新: Joseph 形式协方差; 2x2 创新协方差求逆带病态检测
export function update(x: Vec4, P: Mat4, z: [number, number], R: Noise2D, opts: UpdateOptions = {}): UpdateResult {
  const rd = diag2x2(R);
  if (!rd.ok) throw new Error(`非法观测噪声矩阵: ${rd.issues.map((i) => i.message).join("; ")}`);
  const PHt = matMul(P, matT(H)); // 4x2
  const S2 = matAdd(matMul(H, PHt), [[R.rxx, R.rxy], [R.rxy, R.ryy]]);
  const a = S2[0][0], b = S2[0][1], c = S2[1][0], d = S2[1][1];
  const det = a * d - b * c;
  const scale = Math.max(Math.abs(a), Math.abs(d), 1e-300);
  const cond = (Math.abs(a) + Math.abs(d)) ** 2 / Math.max(Math.abs(det), 1e-300);
  if (!Number.isFinite(det) || Math.abs(det) <= 1e-12 * scale * scale) {
    throw new Error(`创新协方差奇异或病态 (det=${det}, cond≈${cond})，无法安全求逆；请检查 R 与 P`);
  }
  const Sinv = [[d / det, -b / det], [-c / det, a / det]];
  const innov: [number, number] = [z[0] - x[0], z[1] - x[1]];
  const maha2 = innov[0] * (Sinv[0][0] * innov[0] + Sinv[0][1] * innov[1])
              + innov[1] * (Sinv[1][0] * innov[0] + Sinv[1][1] * innov[1]);
  const gate = opts.gateThreshold ?? Infinity;
  if (maha2 > gate) {
    return { x, P, innovation: innov, S: S2, mahalanobis: maha2, accepted: false, reason: `马氏距离平方 ${maha2.toFixed(3)} 超过门限 ${gate}` };
  }
  const K = matMul(PHt, Sinv); // 4x2
  const dx = matVec(K, innov);
  const xu = x.map((v, i) => v + dx[i]) as Vec4;
  // Joseph 形式: P = (I-KH)P(I-KH)' + K R K'
  const IKH = matAdd(eye(4), matMul(K, H), -1);
  const Rm = [[R.rxx, R.rxy], [R.rxy, R.ryy]];
  const Pu = symmetrize(matAdd(matMul(matMul(IKH, P), matT(IKH)), matMul(matMul(K, Rm), matT(K))));
  return { x: xu, P: Pu, innovation: innov, S: S2, mahalanobis: maha2, accepted: true };
}
