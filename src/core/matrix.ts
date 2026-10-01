/**
 * 轻量矩阵工具（以行优先二维数组表示）。
 * 仅实现本项目卡尔曼滤波所需运算，不依赖第三方数值库。
 */

export type Matrix = number[][];

export function rows(a: Matrix): number {
  return a.length;
}

export function cols(a: Matrix): number {
  return a.length === 0 ? 0 : a[0]!.length;
}

export function zeros(r: number, c: number): Matrix {
  return Array.from({ length: r }, () => new Array<number>(c).fill(0));
}

export function identity(n: number): Matrix {
  const m = zeros(n, n);
  for (let i = 0; i < n; i++) m[i]![i] = 1;
  return m;
}
export function clone(a: Matrix): Matrix {
  return a.map((row) => row.slice());
}

export function add(a: Matrix, b: Matrix): Matrix {
  const r = rows(a);
  const c = cols(a);
  const out = zeros(r, c);
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < c; j++) {
      out[i]![j] = a[i]![j]! + b[i]![j]!;
    }
  }
  return out;
}

export function sub(a: Matrix, b: Matrix): Matrix {
  const r = rows(a);
  const c = cols(a);
  const out = zeros(r, c);
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < c; j++) {
      out[i]![j] = a[i]![j]! - b[i]![j]!;
    }
  }
  return out;
}

export function mul(a: Matrix, b: Matrix): Matrix {
  const r = rows(a);
  const n = cols(a);
  if (rows(b) !== n) throw new Error(`矩阵维度不匹配: (${r}x${n}) * (${rows(b)}x${cols(b)})`);
  const k = cols(b);
  const out = zeros(r, k);
  for (let i = 0; i < r; i++) {
    for (let t = 0; t < n; t++) {
      const aik = a[i]![t]!;
      if (aik === 0) continue;
      for (let j = 0; j < k; j++) {
        out[i]![j]! += aik * b[t]![j]!;
      }
    }
  }
  return out;
}

export function transpose(a: Matrix): Matrix {
  const r = rows(a);
  const c = cols(a);
  const out = zeros(c, r);
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < c; j++) {
      out[j]![i] = a[i]![j]!;
    }
  }
  return out;
}

export function scale(a: Matrix, s: number): Matrix {
  return a.map((row) => row.map((v) => v * s));
}

/**
 * 强制（近似）对称：P <- (P + P^T) / 2，抵消浮点累积的非对称误差。
 */
export function symmetrize(a: Matrix): Matrix {
  const n = rows(a);
  const out = zeros(n, n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      out[i]![j] = (a[i]![j]! + a[j]![i]!) / 2;
    }
  }
  return out;
}

/** 对称偏差 Frobenius 范数 ||P - P^T||_F。 */
export function asymmetry(a: Matrix): number {
  const n = rows(a);
  let s = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const d = a[i]![j]! - a[j]![i]!;
      s += d * d;
    }
  }
  return Math.sqrt(s);
}

/**
 * 高斯-若尔当消元求逆，带部分主元。
 * 奇异时抛出错误（调用方据此处理，而不是退化为零矩阵）。
 */
export function inverse(a: Matrix): Matrix {
  const n = rows(a);
  if (cols(a) !== n) throw new Error('求逆要求方阵');
  const m = zeros(n, 2 * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) m[i]![j] = a[i]![j]!;
    m[i]![n + i] = 1;
  }

  for (let col = 0; col < n; col++) {
    let pivot = col;
    let pivotAbs = Math.abs(m[col]![col]!);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(m[r]![col]!);
      if (v > pivotAbs) {
        pivotAbs = v;
        pivot = r;
      }
    }
    if (pivotAbs < 1e-15) {
      throw new Error(`矩阵奇异，无法求逆（主元 ${pivotAbs.toExponential(2)}）`);
    }
    if (pivot !== col) {
      const tmp = m[col]!;
      m[col] = m[pivot]!;
      m[pivot] = tmp;
    }
    const piv = m[col]![col]!;
    for (let j = 0; j < 2 * n; j++) m[col]![j] = m[col]![j]! / piv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = m[r]![col]!;
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) {
        m[r]![j] = m[r]![j]! - factor * m[col]![j]!;
      }
    }
  }

  const inv = zeros(n, n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) inv[i]![j] = m[i]![n + j]!;
  }
  return inv;
}

export interface SpdDiagnostics {
  symmetric: boolean;
  asymmetry: number;
  positiveSemidefinite: boolean;
  minEigenvalue: number;
  conditionNumber: number;
}

/**
 * 对称矩阵特征分解（雅可比旋转），仅用于诊断：
 * 校验对称性、最小特征值（半正定）与条件数。
 */
export function spdDiagnostics(a: Matrix): SpdDiagnostics {
  const n = rows(a);
  const asym = asymmetry(a);
  const s = symmetrize(a);
  const eigen = jacobiEigenvalues(s);
  let min = Infinity;
  let max = -Infinity;
  for (const v of eigen) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const eps = 1e-9 * Math.max(1, Math.abs(max));
  return {
    symmetric: asym < 1e-8,
    asymmetry: asym,
    positiveSemidefinite: min >= -eps,
    minEigenvalue: min,
    conditionNumber: max === 0 || min === 0 ? Infinity : Math.abs(max / min),
  };
}

/** 雅可比法求实对称矩阵全部特征值。 */
function jacobiEigenvalues(a: Matrix): number[] {
  const n = rows(a);
  const m = clone(a);
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) off += Math.abs(m[i]![j]!);
    }
    if (off < 1e-14) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = m[p]![q]!;
        if (Math.abs(apq) < 1e-18) continue;
        const app = m[p]![p]!;
        const aqq = m[q]![q]!;
        const tau = (aqq - app) / (2 * apq);
        const t = tau >= 0 ? 1 / (tau + Math.sqrt(1 + tau * tau)) : 1 / (tau - Math.sqrt(1 + tau * tau));
        const c = 1 / Math.sqrt(1 + t * t);
        const sn = t * c;
        m[p]![p] = app - t * apq;
        m[q]![q] = aqq + t * apq;
        m[p]![q] = 0;
        m[q]![p] = 0;
        for (let k = 0; k < n; k++) {
          if (k === p || k === q) continue;
          const akp = m[k]![p]!;
          const akq = m[k]![q]!;
          m[k]![p] = c * akp - sn * akq;
          m[p]![k] = m[k]![p]!;
          m[k]![q] = sn * akp + c * akq;
          m[q]![k] = m[k]![q]!;
        }
      }
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(m[i]![i]!);
  return out;
}
