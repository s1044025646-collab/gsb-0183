/**
 * 指标计算。
 * - 无真实位置：只报告创新相关的可验证指标（均方新息 NIS 样本），不杜撰定位准确率。
 * - 有合成真值：计算位置/速度 RMSE（在后验步骤时间点最近邻匹配真值）。
 */

import { GroundTruthPoint, StepRecord, TruthMetrics } from './types.js';

export function computeMetrics(steps: StepRecord[], truth: GroundTruthPoint[]): TruthMetrics {
  let nisSum = 0;
  let nisN = 0;
  for (const s of steps) {
    if (s.accepted && s.innovation && s.gateScore !== null) {
      nisSum += s.gateScore; // gateScore 即新息的马氏距离平方（标量 NIS）
      nisN += 1;
    }
  }

  const base: TruthMetrics = {
    count: 0,
    positionRmse: 0,
    velocityRmse: 0,
    meanSquaredInnovation: nisN > 0 ? nisSum / nisN : 0,
    innovationSamples: nisN,
  };

  if (!truth || truth.length === 0) return base;

  let pSum = 0;
  let vSum = 0;
  let n = 0;
  for (const s of steps) {
    const gt = nearestTruth(s.t, truth);
    if (!gt) continue;
    const dx = s.posterior.x - gt.x;
    const dy = s.posterior.y - gt.y;
    const dvx = s.posterior.vx - gt.vx;
    const dvy = s.posterior.vy - gt.vy;
    pSum += dx * dx + dy * dy;
    vSum += dvx * dvx + dvy * dvy;
    n += 1;
  }

  return {
    ...base,
    count: n,
    positionRmse: n > 0 ? Math.sqrt(pSum / n) : 0,
    velocityRmse: n > 0 ? Math.sqrt(vSum / n) : 0,
  };
}

function nearestTruth(t: number, truth: GroundTruthPoint[]): GroundTruthPoint | null {
  let best: GroundTruthPoint | null = null;
  let bestD = Infinity;
  for (const g of truth) {
    const d = Math.abs(g.t - t);
    if (d < bestD) {
      bestD = d;
      best = g;
    }
  }
  return best;
}
