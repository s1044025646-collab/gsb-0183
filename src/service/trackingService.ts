/** 跟踪服务：组装仓储、回放引擎与指标，提供运行/比较/导出能力。 */

import { Repository } from '../db/repository.js';
import { replay } from '../core/tracker.js';
import { computeMetrics } from '../core/metrics.js';
import {
  DEFAULT_CONFIG,
  Observation,
  RunConfig,
  RunSummary,
  StepRecord,
} from '../core/types.js';

export interface RunResult {
  runId: number;
  summary: RunSummary;
  steps: StepRecord[];
}

export class TrackingService {
  constructor(private readonly repo: Repository) {}

  /**
   * 基于当前库中观测执行一次全新回放。
  * 每次运行创建独立滤波器，不读取/改写历史运行，天然版本隔离。
   */
  run(opts: {
    config?: Partial<RunConfig>;
    observations?: Observation[];
    label?: string;
    scenario?: string;
  } = {}): RunResult {
    const cfg: RunConfig = { ...DEFAULT_CONFIG, ...(opts.config ?? {}) };
    if (!(cfg.processNoise >= 0) || !isFinite(cfg.processNoise)) {
      throw new Error('processNoise 必须为非负有限数');
    }
    if (!(cfg.gateThreshold > 0)) throw new Error('gateThreshold 必须为正数');

    const obs =
      opts.observations ??
      this.repo.queryObservations(opts.scenario !== undefined ? { scenario: opts.scenario } : {});
    const { steps, rejectedIds } = replay(obs, cfg);
    const truth = opts.scenario ? this.repo.getGroundTruth(opts.scenario) : [];
    const metrics = truth.length > 0 ? computeMetrics(steps, truth) : computeMetrics(steps, []);
    const runId = this.repo.saveRun(cfg, steps, rejectedIds, metrics, opts.label, opts.scenario);
    const summary = this.repo.getRun(runId)!;
    return { runId, summary, steps };
  }

  getRun(runId: number): RunResult | null {
    const summary = this.repo.getRun(runId);
    if (!summary) return null;
    return { runId, summary, steps: this.repo.getSteps(runId) };
  }

  listRuns(): RunSummary[] {
    return this.repo.listRuns();
  }

  /** 门控对照：列出被拒绝观测及其门控分数/理由。 */
  gateReport(runId: number) {
    const result = this.getRun(runId);
    if (!result) return null;
    return {
      runId,
      threshold: result.summary.config.gateThreshold,
      rejected: result.steps
        .filter((s) => !s.accepted)
        .map((s) => ({
          seq: s.seq,
          t: s.t,
          observationId: s.observationId,
          sensorId: s.sensorId,
          reason: s.rejectReason,
          gateScore: s.gateScore,
        })),
      accepted: result.steps
        .filter((s) => s.accepted)
        .map((s) => ({
          seq: s.seq,
          observationId: s.observationId,
          gateScore: s.gateScore,
        })),
    };
  }

  /**
   * 比较两次运行在共同时间点上的轨迹差异。
   * 迟到数据不改写历史：差异只通过新版本体现。
   */
  compare(runA: number, runB: number) {
    const a = this.getRun(runA);
    const b = this.getRun(runB);
    if (!a || !b) throw new Error('运行不存在');
    const mapB = new Map<number, StepRecord>();
    for (const s of b.steps) mapB.set(s.seq, s);

    let pSum = 0;
    let vSum = 0;
    let n = 0;
    const maxPos: { seq: number; diff: number } = { seq: -1, diff: 0 };
    for (const sa of a.steps) {
      const sb = mapB.get(sa.seq);
      if (!sb) continue;
      const dx = sa.posterior.x - sb.posterior.x;
      const dy = sa.posterior.y - sb.posterior.y;
      const dvx = sa.posterior.vx - sb.posterior.vx;
      const dvy = sa.posterior.vy - sb.posterior.vy;
      const pd = Math.sqrt(dx * dx + dy * dy);
      pSum += dx * dx + dy * dy;
      vSum += dvx * dvx + dvy * dvy;
      n += 1;
      if (pd > maxPos.diff) {
        maxPos.diff = pd;
        maxPos.seq = sa.seq;
      }
    }
    return {
      runA,
      runB,
      commonSteps: n,
      positionRmsDiff: n > 0 ? Math.sqrt(pSum / n) : 0,
      velocityRmsDiff: n > 0 ? Math.sqrt(vSum / n) : 0,
      maxPositionDiff: maxPos,
      rejectedA: a.summary.rejected,
      rejectedB: b.summary.rejected,
      metricsA: a.summary.metrics,
      metricsB: b.summary.metrics,
    };
  }
}
