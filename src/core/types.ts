/** 领域类型定义。 */

export interface Sensor {
  id: string;
  name: string;
  /** 默认观测噪声协方差（2x2），可被单条观测覆盖。 */
  defaultNoise: [[number, number], [number, number]];
  createdAt: string;
}

export interface Observation {
  /** 全局唯一观测编号（幂等导入的去重键）。 */
  id: string;
  /** 所属场景；通用导入可为空。 */
  scenario?: string;
  sensorId: string;
  /** 观测发生时间（秒，可与接收时间不同）。 */
  observedAt: number;
  /** 后端接收到该观测的时间（秒）。 */
  receivedAt: number;
  x: number;
  y: number;
  /** 观测噪声协方差（2x2，对称半正定）。 */
  noise: [[number, number], [number, number]];
}

export interface GroundTruthPoint {
  t: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface RunConfig {
  /** 回放排序规则。 */
  replayOrder: 'observed' | 'received';
  /** 门控阈值（马氏距离卡方分位，维度=2）。9.21≈99%，5.99≈95%。 */
  gateThreshold: number;
  /** 连续白噪声加速度功率谱幅值（连续时间过程噪声强度 q）。 */
  processNoise: number;
  /** 初始状态 [x, y, vx, vy]；为空时用首条观测零速度初始化。 */
  initialState?: [number, number, number, number];
  initialCovariance?: number[][];
  /** 回放时间窗（按观测/接收排序所用时间）。 */
  fromTime?: number;
  toTime?: number;
  /** 最大回放步数保护。 */
  maxSteps?: number;
}

export const DEFAULT_CONFIG: RunConfig = {
  replayOrder: 'observed',
  gateThreshold: 9.2103,
  processNoise: 1.0,
  maxSteps: 100000,
};

export type StepStatus = 'predicted_only' | 'updated' | 'rejected';
export type RejectReason = 'none' | 'gated' | 'singular_innovation' | 'invalid_measurement';

export interface StepRecord {
  seq: number;
  t: number;
  observationId: string | null;
  sensorId: string | null;
  status: StepStatus;
  rejectReason: RejectReason;
  /** 马氏距离平方 g = innov^T S^-1 innov；无观测/拒绝时可能为 null。 */
  gateScore: number | null;
  accepted: boolean;
  predicted: { x: number; y: number; vx: number; vy: number };
  predictedCov: number[][];
  posterior: { x: number; y: number; vx: number; vy: number };
  posteriorCov: number[][];
  innovation: { dx: number; dy: number } | null;
  /** 协方差诊断（对后验协方差）。 */
  covDiag: {
    asymmetric: boolean;
    asymmetry: number;
    psd: boolean;
    minEigenvalue: number;
    conditionNumber: number;
  };
}

export interface RunSummary {
  runId: number;
  label?: string;
  scenario?: string;
  config: RunConfig;
  totalSteps: number;
  updated: number;
  rejected: number;
  predictedOnly: number;
  rejectedIds: string[];
  /** 有合成真值时的指标。 */
  metrics?: TruthMetrics;
  createdAt: string;
}

export interface TruthMetrics {
  count: number;
  positionRmse: number;
  velocityRmse: number;
  meanSquaredInnovation: number;
  innovationSamples: number;
}
