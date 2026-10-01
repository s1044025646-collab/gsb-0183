/** 仓储层：封装传感器/观测/运行的读写与幂等导入。 */

import { DatabaseSync } from 'node:sqlite';
import {
  GroundTruthPoint,
  Observation,
  RunConfig,
  RunSummary,
  Sensor,
  StepRecord,
} from '../core/types.js';
import { validateNoise } from '../core/kalman.js';

export class ConflictError extends Error {}

interface SensorRow {
  id: string;
  name: string;
  default_noise: string;
  created_at: string;
}
interface ObsRow {
  id: string;
  sensor_id: string;
  scenario: string | null;
  observed_at: number;
  received_at: number;
  x: number;
  y: number;
  noise: string;
}

export class Repository {
  constructor(private readonly db: DatabaseSync) {}

  upsertSensor(s: Sensor): 'inserted' | 'unchanged' {
    const noiseJson = JSON.stringify(s.defaultNoise);
    const existing = this.db.prepare('SELECT * FROM sensors WHERE id = ?').get(s.id) as
      | SensorRow
      | undefined;
    if (existing) {
      if (existing.name !== s.name || existing.default_noise !== noiseJson) {
        throw new ConflictError(
          `传感器 ${s.id} 已存在但配置矛盾（name/noise 不一致）`,
        );
      }
      return 'unchanged';
    }
    this.db
      .prepare('INSERT INTO sensors (id, name, default_noise, created_at) VALUES (?,?,?,?)')
      .run(s.id, s.name, noiseJson, s.createdAt);
    return 'inserted';
  }

  getSensor(id: string): Sensor | null {
    const row = this.db.prepare('SELECT * FROM sensors WHERE id = ?').get(id) as SensorRow | undefined;
    return row ? rowToSensor(row) : null;
  }

  listSensors(): Sensor[] {
    const rows = this.db.prepare('SELECT * FROM sensors ORDER BY id').all() as unknown as SensorRow[];
    return rows.map(rowToSensor);
  }

  /**
   * 幂等导入观测：
   * - 相同 id 且内容完全一致 -> 忽略（unchanged）
   * - 相同 id 但内容矛盾 -> ConflictError
   */
  importObservation(o: Observation): 'inserted' | 'unchanged' {
    const noiseErr = validateNoise(o.noise);
    if (noiseErr) throw new Error(`观测 ${o.id} 噪声非法: ${noiseErr}`);
    if (![o.observedAt, o.receivedAt, o.x, o.y].every(Number.isFinite)) {
      throw new Error(`观测 ${o.id} 含非有限数值`);
    }
    const sensor = this.getSensor(o.sensorId);
    if (!sensor) throw new Error(`观测 ${o.id} 引用了不存在的传感器 ${o.sensorId}`);

    const existing = this.db.prepare('SELECT * FROM observations WHERE id = ?').get(o.id) as
      | ObsRow
      | undefined;
    if (existing) {
      const same =
        existing.sensor_id === o.sensorId &&
        (existing.scenario ?? null) === (o.scenario ?? null) &&
        existing.observed_at === o.observedAt &&
        existing.received_at === o.receivedAt &&
        existing.x === o.x &&
        existing.y === o.y &&
        existing.noise === JSON.stringify(o.noise);
      if (!same) throw new ConflictError(`观测编号 ${o.id} 重复且内容矛盾`);
      return 'unchanged';
    }
    this.db
      .prepare(
        `INSERT INTO observations (id, sensor_id, scenario, observed_at, received_at, x, y, noise)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        o.id,
        o.sensorId,
        o.scenario ?? null,
        o.observedAt,
        o.receivedAt,
        o.x,
        o.y,
        JSON.stringify(o.noise),
      );
    return 'inserted';
  }

  importObservations(list: Observation[]): { inserted: number; unchanged: number } {
    let inserted = 0;
    let unchanged = 0;
    this.db.exec('BEGIN');
    try {
      for (const o of list) {
        this.importObservation(o) === 'inserted' ? inserted++ : unchanged++;
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { inserted, unchanged };
  }

  /** 按观测时间窗口查询（也可按接收时间过滤）。 */
  queryObservations(opts: {
    fromObserved?: number;
    toObserved?: number;
    sensorId?: string;
    scenario?: string;
  }): Observation[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.fromObserved !== undefined) {
      where.push('observed_at >= ?');
      params.push(opts.fromObserved);
    }
    if (opts.toObserved !== undefined) {
      where.push('observed_at <= ?');
      params.push(opts.toObserved);
    }
    if (opts.sensorId) {
      where.push('sensor_id = ?');
      params.push(opts.sensorId);
    }
    if (opts.scenario !== undefined) {
      where.push('scenario IS ?');
      params.push(opts.scenario);
    }
    const sql =
      'SELECT * FROM observations' +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY observed_at, received_at, id';
    const rows = this.db.prepare(sql).all(...(params as never[])) as unknown as ObsRow[];
    return rows.map(rowToObs);
  }

  getObservation(id: string): Observation | null {
    const row = this.db.prepare('SELECT * FROM observations WHERE id = ?').get(id) as
      | ObsRow
      | undefined;
    return row ? rowToObs(row) : null;
  }

  saveRun(
    cfg: RunConfig,
    steps: StepRecord[],
    rejectedIds: string[],
    metrics: RunSummary['metrics'],
    label?: string,
    scenario?: string,
  ): number {
    const info = this.db
      .prepare(
        `INSERT INTO runs (config, label, scenario, total_steps, updated, rejected, predicted_only, rejected_ids, metrics)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        JSON.stringify(cfg),
        label ?? null,
        scenario ?? null,
        steps.length,
        steps.filter((s) => s.status === 'updated').length,
        steps.filter((s) => s.status === 'rejected').length,
        steps.filter((s) => s.status === 'predicted_only').length,
        JSON.stringify(rejectedIds),
        metrics ? JSON.stringify(metrics) : null,
      );
    const runId = Number(info.lastInsertRowid);
    const stmt = this.db.prepare(
      `INSERT INTO run_steps (run_id, seq, t, observation_id, sensor_id, status, reject_reason, gate_score, accepted, payload)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const s of steps) {
      stmt.run(
        runId,
        s.seq,
        s.t,
        s.observationId,
        s.sensorId,
        s.status,
        s.rejectReason,
        s.gateScore,
        s.accepted ? 1 : 0,
        JSON.stringify(s),
      );
    }
    return runId;
  }

  listRuns(): RunSummary[] {
    const rows = this.db.prepare('SELECT * FROM runs ORDER BY id').all() as unknown as RunRow[];
    return rows.map(rowToSummary);
  }

  getRun(runId: number): RunSummary | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as
      | RunRow
      | undefined;
    return row ? rowToSummary(row) : null;
  }

  getSteps(runId: number): StepRecord[] {
    const rows = this.db
      .prepare('SELECT payload FROM run_steps WHERE run_id = ? ORDER BY seq')
      .all(runId) as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload) as StepRecord);
  }

  putGroundTruth(scenario: string, pts: GroundTruthPoint[]): void {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO ground_truth (scenario,t,x,y,vx,vy) VALUES (?,?,?,?,?,?)',
    );
    for (const p of pts) stmt.run(scenario, p.t, p.x, p.y, p.vx, p.vy);
  }

  getGroundTruth(scenario: string): GroundTruthPoint[] {
    const rows = this.db
      .prepare('SELECT * FROM ground_truth WHERE scenario = ? ORDER BY t')
      .all(scenario) as unknown as GroundTruthRow[];
    return rows.map((r) => ({ t: r.t, x: r.x, y: r.y, vx: r.vx, vy: r.vy }));
  }
}

interface RunRow {
  id: number;
  config: string;
  label: string | null;
  scenario: string | null;
  total_steps: number;
  updated: number;
  rejected: number;
  predicted_only: number;
  rejected_ids: string;
  metrics: string | null;
  created_at: string;
}
interface GroundTruthRow {
  t: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

function rowToSensor(r: SensorRow): Sensor {
  return {
    id: r.id,
    name: r.name,
    defaultNoise: JSON.parse(r.default_noise),
    createdAt: r.created_at,
  };
}

function rowToObs(r: ObsRow): Observation {
  return {
    id: r.id,
    sensorId: r.sensor_id,
    scenario: r.scenario ?? undefined,
    observedAt: r.observed_at,
    receivedAt: r.received_at,
    x: r.x,
    y: r.y,
    noise: JSON.parse(r.noise),
  };
}

function rowToSummary(r: RunRow): RunSummary {
  return {
    runId: r.id,
    config: JSON.parse(r.config),
    totalSteps: r.total_steps,
    updated: r.updated,
    rejected: r.rejected,
    predictedOnly: r.predicted_only,
    rejectedIds: JSON.parse(r.rejected_ids),
    metrics: r.metrics ? JSON.parse(r.metrics) : undefined,
    createdAt: r.created_at,
    label: r.label ?? undefined,
    scenario: r.scenario ?? undefined,
  };
}
