/**
 * 回放引擎：按明确规则排序观测，逐步预测/门控/更新，产出步骤快照。
 * 每个 Run 使用全新滤波器实例，运行之间不共享任何状态。
 */

import {
  FilterState,
  explicitInit,
  initFromObservation,
  posteriorDiag,
  predict,
  stateToObj,
  update,
  validateNoise,
} from './kalman.js';
import { Observation, RunConfig, StepRecord } from './types.js';

export interface ReplayResult {
  steps: StepRecord[];
  rejectedIds: string[];
}

/**
 * 排序规则（明确、确定性）：
 * - observed: 主键 observedAt，其次 receivedAt，再 sensorId、id（保证同刻多次观测稳定有序）
 * - received: 主键 receivedAt，其次 observedAt，再 sensorId、id
 */
export function orderObservations(obs: Observation[], order: 'observed' | 'received'): Observation[] {
  const arr = obs.slice();
  arr.sort((a, b) => {
    const primary = order === 'observed' ? a.observedAt - b.observedAt : a.receivedAt - b.receivedAt;
    if (primary !== 0) return primary;
    const secondary = order === 'observed' ? a.receivedAt - b.receivedAt : a.observedAt - b.observedAt;
    if (secondary !== 0) return secondary;
    if (a.sensorId !== b.sensorId) return a.sensorId < b.sensorId ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return arr;
}

function filterWindow(obs: Observation[], cfg: RunConfig, order: 'observed' | 'received'): Observation[] {
  return obs.filter((o) => {
    const key = order === 'observed' ? o.observedAt : o.receivedAt;
    if (cfg.fromTime !== undefined && key < cfg.fromTime) return false;
    if (cfg.toTime !== undefined && key > cfg.toTime) return false;
    return true;
  });
}

export function replay(allObs: Observation[], cfg: RunConfig): ReplayResult {
  const ordered = orderObservations(filterWindow(allObs, cfg, cfg.replayOrder), cfg.replayOrder);
  const steps: StepRecord[] = [];
  const rejectedIds: string[] = [];
  const maxSteps = cfg.maxSteps ?? 100000;

  let state: FilterState | null = null;

  for (const obs of ordered) {
    if (steps.length >= maxSteps) {
      throw new Error(`超出最大步数限制 maxSteps=${maxSteps}`);
    }
    const t = cfg.replayOrder === 'observed' ? obs.observedAt : obs.receivedAt;

    // 初始化
    if (state === null) {
      state = cfg.initialState ? explicitInit(cfg, t) : initFromObservation(obs);
      // 首步之前不做预测；直接尝试更新（显式初值时）或记录初始观测。
    }

    if (t < state.t) {
      // 确定性排序后不应发生；防御性报错而非回写。
      throw new Error(`回放时间倒退: t=${t} < 上一步 ${state.t}（观测 ${obs.id}）`);
    }

    // 预测到当前观测时间（含 dt=0 的同刻多次观测）。
    const predicted = predict(state, t, cfg.processNoise);

    // 校验观测噪声。
    const noiseErr = validateNoise(obs.noise);
    if (noiseErr) {
      const rec = buildPredOnly(steps.length, t, obs, predicted, 'invalid_measurement', null);
      steps.push(rec);
      rejectedIds.push(obs.id);
      state = predicted; // 保留预测，拒绝该观测
      continue;
    }

    const attempt = update(predicted, obs);
    const gateScore = typeof attempt.gateScore === 'number' ? attempt.gateScore : null;

    if (!attempt.ok) {
      steps.push(buildPredOnly(steps.length, t, obs, predicted, 'singular_innovation', gateScore));
      rejectedIds.push(obs.id);
      state = predicted; // 保留预测，绝不静默用零矩阵
      continue;
    }

    // 门控：马氏距离平方与卡方阈值比较。
    if (gateScore! > cfg.gateThreshold) {
      steps.push(buildPredOnly(steps.length, t, obs, predicted, 'gated', gateScore));
      rejectedIds.push(obs.id);
      state = predicted; // 拒绝离群点，保留预测
      continue;
    }

    const post = attempt.result!.state;
    steps.push({
      seq: steps.length,
      t,
      observationId: obs.id,
      sensorId: obs.sensorId,
      status: 'updated',
      rejectReason: 'none',
      gateScore,
      accepted: true,
      predicted: stateToObj(predicted),
      predictedCov: predicted.P,
      posterior: stateToObj(post),
      posteriorCov: post.P,
      innovation: { dx: attempt.innovation![0]![0]!, dy: attempt.innovation![1]![0]! },
      covDiag: posteriorDiag(post.P),
    });
    state = post;
  }

  return { steps, rejectedIds };
}

function buildPredOnly(
  seq: number,
  t: number,
  obs: Observation,
  predicted: FilterState,
  reason: 'gated' | 'singular_innovation' | 'invalid_measurement',
  gateScore: number | null,
): StepRecord {
  return {
    seq,
    t,
    observationId: obs.id,
    sensorId: obs.sensorId,
    status: reason === 'gated' ? 'rejected' : 'rejected',
    rejectReason: reason,
    gateScore,
    accepted: false,
    predicted: stateToObj(predicted),
    predictedCov: predicted.P,
    // 拒绝时后验=预测（不更新），但明确标记为未采用观测。
    posterior: stateToObj(predicted),
    posteriorCov: predicted.P,
    innovation: null,
    covDiag: posteriorDiag(predicted.P),
  };
}
