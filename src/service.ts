import { Store, ObsRow } from "./db.js";
import { predict, update, Vec4, Mat4, Noise2D, diag4x4, eye } from "./kf.js";

export interface RunConfig {
  q: number;                 // 过程噪声谱密度
  gateThreshold: number;     // 马氏距离平方门限 (chi2, 2dof; 9.21 ≈ 99%)
  init: { x: Vec4; P: Mat4 };
  from?: number; to?: number;
  maxGap?: number;           // 超过视为长间隔(仅标记)
}

export interface StepRecord {
  seq: number; t: number; kind: string;
  predicted: { x: Vec4; P: Mat4 };
  updated: { x: Vec4; P: Mat4 } | null;
  observations: { obs_id: string; z: [number, number]; R: Noise2D; accepted: boolean; mahalanobis: number; reason?: string }[];
  diagnostics: { code: string; message: string }[];
  longGap: boolean;
}

export const defaultConfig = (): RunConfig => ({
  q: 0.5,
  gateThreshold: 9.21,
  init: { x: [0, 0, 0, 0], P: eye(4).map((r) => r.map((v) => v * 100)) },
});

// 执行一次跟踪回放。迟到数据不影响已存 runs —— 每次 run 重新读取当前观测集合并独立计算。
export function executeRun(store: Store, name: string, cfg: RunConfig): { runId: number; steps: StepRecord[] } {
  const obs = store.queryObservations(cfg.from, cfg.to);
  const runId = store.createRun(name, cfg);
  const steps: StepRecord[] = [];
  let x = [...cfg.init.x] as Vec4;
  let P = cfg.init.P.map((r) => [...r]);
  let tPrev: number | null = null;
  let seq = 0;

  const persist = (s: StepRecord) => {
    store.insertStep({
      run_id: runId, seq: s.seq, t: s.t, kind: s.kind,
      px: s.predicted.x[0], py: s.predicted.x[1], pvx: s.predicted.x[2], pvy: s.predicted.x[3],
      ux: s.updated?.x[0] ?? null, uy: s.updated?.x[1] ?? null,
      uvx: s.updated?.x[2] ?? null, uvy: s.updated?.x[3] ?? null,
      p_pred: JSON.stringify(s.predicted.P), p_post: s.updated ? JSON.stringify(s.updated.P) : null,
      obs_ids: JSON.stringify(s.observations.map((o) => o.obs_id)),
      gating: JSON.stringify(s.observations.map((o) => ({ obs_id: o.obs_id, accepted: o.accepted, mahalanobis: o.mahalanobis, reason: o.reason ?? null }))),
    });
  };

  // 同一观测时刻的多次观测分组顺序更新
  let i = 0;
  while (i < obs.length) {
    const t = obs[i].t_obs;
    const group: ObsRow[] = [];
    while (i < obs.length && obs[i].t_obs === t) group.push(obs[i++]);

    const dt = tPrev === null ? 0 : t - tPrev;
    if (dt < 0) throw new Error(`观测时间回退: dt=${dt} (排序规则失效)`);
    const longGap = cfg.maxGap !== undefined && dt > cfg.maxGap;
    let diagnostics: StepRecord["diagnostics"] = [];
    let pred: { x: Vec4; P: Mat4 };
    if (tPrev === null) {
      pred = { x, P };
    } else {
      pred = predict(x, P, dt, cfg.q);
    }
    diagnostics = diagnostics.concat(diag4x4(pred.P).issues);

    const usedObs: StepRecord["observations"] = [];
    let xu = pred.x, Pu = pred.P, anyAccepted = false;
    for (const o of group) {
      const R: Noise2D = { rxx: o.rxx, rxy: o.rxy, ryy: o.ryy };
      const res = update(xu, Pu, [o.zx, o.zy], R, { gateThreshold: cfg.gateThreshold });
      usedObs.push({ obs_id: o.obs_id, z: [o.zx, o.zy], R, accepted: res.accepted, mahalanobis: res.mahalanobis, reason: res.reason });
      if (res.accepted) { xu = res.x; Pu = res.P; anyAccepted = true; }
    }
    const step: StepRecord = {
      seq, t, kind: tPrev === null ? "init" : anyAccepted ? "predict+update" : "predict_only",
      predicted: pred, updated: anyAccepted ? { x: xu, P: Pu } : null,
      observations: usedObs, diagnostics, longGap,
    };
    if (anyAccepted) { x = xu; P = Pu; } else { x = pred.x; P = pred.P; }
    tPrev = t;
    steps.push(step);
    persist(step);
    seq++;
  }
  return { runId, steps };
}

export interface Metrics {
  count: number; accepted: number; rejected: number;
  meanMahalanobis: number;
  positionRmse?: number; velocityRmse?: number; // 仅有真值时
}

export function computeMetrics(steps: StepRecord[], truth?: Map<number, { x: number; y: number; vx: number; vy: number }>): Metrics {
  let accepted = 0, rejected = 0, mahaSum = 0, mahaN = 0;
  let posSE = 0, velSE = 0, truthN = 0;
  for (const s of steps) {
    for (const o of s.observations) {
      mahaSum += o.mahalanobis; mahaN++;
      if (o.accepted) accepted++; else rejected++;
    }
    if (truth) {
      const g = truth.get(s.t);
      const est = s.updated ?? s.predicted;
      if (g) {
        posSE += (est.x[0] - g.x) ** 2 + (est.x[1] - g.y) ** 2;
        velSE += (est.x[2] - g.vx) ** 2 + (est.x[3] - g.vy) ** 2;
        truthN++;
      }
    }
  }
  const m: Metrics = {
    count: steps.length, accepted, rejected,
    meanMahalanobis: mahaN ? mahaSum / mahaN : 0,
  };
  if (truth && truthN > 0) {
    m.positionRmse = Math.sqrt(posSE / truthN);
    m.velocityRmse = Math.sqrt(velSE / truthN);
  }
  return m;
}
