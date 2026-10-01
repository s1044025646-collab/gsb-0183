/**
 * 内置固定种子场景：
 * - straight：匀速直线（模型匹配）
 * - turning：转向（常速度模型失配）
 * - outlier：含传感器粗差/离群点（用于门控）
 * 每个场景产出传感器、带时间戳观测（含观测时间/接收时间差异）与合成真值。
 */

import { GroundTruthPoint, Observation, Sensor } from '../core/types.js';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 由 2x2 协方差生成相关高斯噪声（Cholesky）。 */
function gaussian2(rng: () => number, sxx: number, syy: number, sxy: number) {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const z1 = Math.sqrt(-2 * Math.log(u1)) * Math.sin(2 * Math.PI * u2);
  const l00 = Math.sqrt(sxx);
  const l10 = sxy / l00;
  const l11 = Math.sqrt(Math.max(syy - l10 * l10, 0));
  return { nx: l00 * z0, ny: l10 * z0 + l11 * z1 };
}

export interface ScenarioData {
  scenario: string;
  sensors: Sensor[];
  observations: Observation[];
  truth: GroundTruthPoint[];
}

const SENSORS: Sensor[] = [
  {
    id: 'radar',
    name: '高精度雷达',
    defaultNoise: [
      [0.5, 0],
      [0, 0.5],
    ],
    createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
  },
  {
    id: 'cam',
    name: '噪声较大相机',
    defaultNoise: [
      [2.0, 0.3],
      [0.3, 2.0],
    ],
    createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
  },
];

interface TrajPoint {
  t: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

function straightTrajectory(dt: number, n: number): TrajPoint[] {
  const pts: TrajPoint[] = [];
  for (let i = 0; i < n; i++) {
    const t = +(i * dt).toFixed(3);
    pts.push({ t, x: 1 * t, y: 0.5 * t, vx: 1, vy: 0.5 });
  }
  return pts;
}

function turningTrajectory(dt: number, n: number): TrajPoint[] {
  const pts: TrajPoint[] = [];
  const omega = 0.6; // 角速度 rad/s（较大转向，突出常速度模型失配）
  const speed = 2;
  let x = 0;
  let y = 0;
  let theta = 0;
  for (let i = 0; i < n; i++) {
    const t = +(i * dt).toFixed(3);
    const vx = speed * Math.cos(theta);
    const vy = speed * Math.sin(theta);
    pts.push({ t, x, y, vx, vy });
    theta += omega * dt;
    x += speed * Math.cos(theta) * dt;
    y += speed * Math.sin(theta) * dt;
  }
  return pts;
}

export function buildScenario(kind: 'straight' | 'turning' | 'outlier', seed = 20260101): ScenarioData {
  const rng = mulberry32(seed + (kind === 'straight' ? 1 : kind === 'turning' ? 2 : 3));
  const dt = 1;
  const n = 30;
  const traj = kind === 'turning' ? turningTrajectory(dt, n) : straightTrajectory(dt, n);

  const observations: Observation[] = [];
  let counter = 0;
  traj.forEach((p, i) => {
    // 两个传感器交替到达；制造迟到（receive 延迟）与个别缺测。
    const sensorIds = i % 3 === 0 ? ['radar'] : i % 3 === 1 ? ['cam'] : ['radar', 'cam'];
    for (const sid of sensorIds) {
      const sensor = SENSORS.find((s) => s.id === sid)!;
      // outlier 场景在指定时刻注入粗差；turning/straight 也跳过个别时刻模拟缺测。
      const missing = kind === 'outlier' && (i === 7 || i === 8); // 连续缺测
      if (missing) continue;

      const [[sxx, sxy], [, syy]] = sensor.defaultNoise;
      const noise = gaussian2(rng, sxx!, syy!, sxy!);
      let measX = p.x + noise.nx;
      let measY = p.y + noise.ny;

      const isHardOutlier = kind === 'outlier' && sid === 'cam' && i === 14;
      const isSoftOutlier = kind === 'outlier' && sid === 'cam' && i === 20;
      const isOutlier = isHardOutlier || isSoftOutlier;
      if (isOutlier) {
        if (isHardOutlier) {
          measX += 18; // 粗差，远超门限，95%/99% 均拒绝
          measY -= 15;
        } else {
          // 中等离群：马氏距离落在 95%(5.99) 与 99%(9.21) 之间，仅严格门控拒绝
          measX += 3.6;
          measY += 3.6;
        }
      }

      const receiveLag = 0.2 + rng() * 1.5 + (sid === 'cam' ? 0.5 : 0);
      observations.push({
        id: `${kind}-${String(counter++).padStart(4, '0')}`,
        scenario: kind,
        sensorId: sid,
        observedAt: p.t,
        receivedAt: +(p.t + receiveLag).toFixed(3),
        x: +measX.toFixed(4),
        y: +measY.toFixed(4),
        noise: sensor.defaultNoise as [[number, number], [number, number]],
      });
    }
  });

  // 同刻多次观测：straight 场景在 t=10 再插入一条同刻雷达观测（不同 id）。
  if (kind === 'straight') {
    const p = traj[10]!;
    observations.push({
      id: `${kind}-dup-t10`,
      scenario: kind,
      sensorId: 'radar',
      observedAt: p.t,
      receivedAt: +(p.t + 0.1).toFixed(3),
      x: +(p.x + 0.05).toFixed(4),
      y: +(p.y - 0.05).toFixed(4),
      noise: [
        [0.5, 0],
        [0, 0.5],
      ],
    });
    observations.sort((a, b) => a.observedAt - b.observedAt || a.receivedAt - b.receivedAt);
  }

  return {
    scenario: kind,
    sensors: SENSORS.map((s) => ({ ...s })),
    observations,
    truth: traj.map((p) => ({ t: p.t, x: p.x, y: p.y, vx: p.vx, vy: p.vy })),
  };
}
