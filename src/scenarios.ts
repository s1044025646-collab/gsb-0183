// 内置场景: 固定种子, 可复现
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rng: () => number): number {
  const u = Math.max(rng(), 1e-12), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface SimObs { obs_id: string; sensor: string; t_obs: number; t_recv: number; zx: number; zy: number; rxx: number; rxy: number; ryy: number }
export interface Truth { t: number; x: number; y: number; vx: number; vy: number }

export interface Scenario {
  name: string;
  sensors: { name: string; r: number }[];
  observations: SimObs[];
  truth: Truth[];
}

export function buildScenario(kind: "constant" | "turn" | "outlier", seed = 42): Scenario {
  const rng = mulberry32(seed);
  const sensors = [
    { name: "radarA", r: 1.0 },
    { name: "radarB", r: 4.0 },
  ];
  const observations: SimObs[] = [];
  const truth: Truth[] = [];
  const dt = 1, N = 40;
  let x = 0, y = 0, vx = 10, vy = 0;
  let n = 0;
  for (let k = 0; k < N; k++) {
    const t = k * dt;
    if (kind === "turn" && k >= 20) {
      // 0.05 rad/s 转弯, CV 模型失配
      const w = 0.05;
      const nvx = vx * Math.cos(w * dt) - vy * Math.sin(w * dt);
      const nvy = vx * Math.sin(w * dt) + vy * Math.cos(w * dt);
      vx = nvx; vy = nvy;
    }
    x += vx * dt; y += vy * dt;
    truth.push({ t, x, y, vx, vy });
    for (const s of sensors) {
      if (k % (s.name === "radarA" ? 1 : 2) !== 0) continue; // 不同到达率
      if (kind === "outlier" && s.name === "radarB" && k === 25) continue; // 缺测示例
      const isOutlier = kind === "outlier" && s.name === "radarA" && (k === 15 || k === 30);
      const zx = x + gauss(rng) * Math.sqrt(s.r) + (isOutlier ? 60 : 0);
      const zy = y + gauss(rng) * Math.sqrt(s.r) + (isOutlier ? -40 : 0);
      observations.push({
        obs_id: `${kind}-${n++}`, sensor: s.name, t_obs: t,
        t_recv: t + 0.05 + rng() * 0.1,
        zx, zy, rxx: s.r, rxy: 0, ryy: s.r,
      });
    }
  }
  return { name: kind, sensors, observations, truth };
}
