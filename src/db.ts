import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export interface SensorRow { id: number; name: string; meta: string }
export interface ObsRow {
  obs_id: string; sensor_id: number; t_obs: number; t_recv: number;
  zx: number; zy: number; rxx: number; rxy: number; ryy: number;
}

export class Store {
  db: DatabaseSync;
  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sensors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        meta TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS observations (
        obs_id TEXT PRIMARY KEY,
        sensor_id INTEGER NOT NULL REFERENCES sensors(id),
        t_obs REAL NOT NULL,
        t_recv REAL NOT NULL,
        zx REAL NOT NULL, zy REAL NOT NULL,
        rxx REAL NOT NULL, rxy REAL NOT NULL, ryy REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_obs_t ON observations(t_obs, t_recv);
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        config TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        status TEXT NOT NULL DEFAULT 'done'
      );
      CREATE TABLE IF NOT EXISTS steps (
        run_id INTEGER NOT NULL REFERENCES runs(id),
        seq INTEGER NOT NULL,
        t REAL NOT NULL,
        kind TEXT NOT NULL,           -- 'predict+update' | 'predict_only' | 'init'
        px REAL NOT NULL, py REAL NOT NULL, pvx REAL NOT NULL, pvy REAL NOT NULL,
        ux REAL, uy REAL, uvx REAL, uvy REAL,
        p_pred TEXT NOT NULL, p_post TEXT,
        obs_ids TEXT NOT NULL DEFAULT '[]',
        gating TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (run_id, seq)
      );
    `);
  }

  addSensor(name: string, meta: object = {}): number {
    const r = this.db.prepare("INSERT INTO sensors(name, meta) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET name=excluded.name RETURNING id").get(name, JSON.stringify(meta)) as { id: number };
    return r.id;
  }
  sensors(): SensorRow[] {
    return this.db.prepare("SELECT * FROM sensors ORDER BY id").all() as unknown as SensorRow[];
  }

  // 幂等导入: 同 obs_id 同内容 -> skipped; 同 obs_id 不同内容 -> conflict
  importObservations(rows: ObsRow[]): { inserted: number; skipped: number; conflicts: string[] } {
    const get = this.db.prepare("SELECT * FROM observations WHERE obs_id = ?");
    const ins = this.db.prepare("INSERT INTO observations VALUES (?,?,?,?,?,?,?,?,?)");
    let inserted = 0, skipped = 0;
    const conflicts: string[] = [];
    for (const r of rows) {
      const ex = get.get(r.obs_id) as unknown as ObsRow | undefined;
      if (ex) {
        const same = ex.sensor_id === r.sensor_id && ex.t_obs === r.t_obs && ex.t_recv === r.t_recv
          && ex.zx === r.zx && ex.zy === r.zy && ex.rxx === r.rxx && ex.rxy === r.rxy && ex.ryy === r.ryy;
        if (same) skipped++;
        else conflicts.push(r.obs_id);
        continue;
      }
      ins.run(r.obs_id, r.sensor_id, r.t_obs, r.t_recv, r.zx, r.zy, r.rxx, r.rxy, r.ryy);
      inserted++;
    }
    return { inserted, skipped, conflicts };
  }

  // 回放排序规则: 观测时间 -> 接收时间 -> obs_id (确定性)
  queryObservations(from?: number, to?: number): ObsRow[] {
    let sql = "SELECT * FROM observations";
    const args: number[] = [];
    if (from !== undefined || to !== undefined) {
      const conds: string[] = [];
      if (from !== undefined) { conds.push("t_obs >= ?"); args.push(from); }
      if (to !== undefined) { conds.push("t_obs <= ?"); args.push(to); }
      sql += " WHERE " + conds.join(" AND ");
    }
    sql += " ORDER BY t_obs, t_recv, obs_id";
    return this.db.prepare(sql).all(...args) as unknown as ObsRow[];
  }

  createRun(name: string, config: object): number {
    const r = this.db.prepare("INSERT INTO runs(name, config) VALUES (?, ?) RETURNING id").get(name, JSON.stringify(config)) as { id: number };
    return r.id;
  }
  insertStep(step: Record<string, unknown>): void {
    this.db.prepare(`INSERT INTO steps(run_id,seq,t,kind,px,py,pvx,pvy,ux,uy,uvx,uvy,p_pred,p_post,obs_ids,gating)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      ...( ["run_id","seq","t","kind","px","py","pvx","pvy","ux","uy","uvx","uvy","p_pred","p_post","obs_ids","gating"]
        .map((k) => step[k] as import("node:sqlite").SQLInputValue) ));
  }
  runs(): unknown[] { return this.db.prepare("SELECT * FROM runs ORDER BY id").all(); }
  steps(runId: number): unknown[] { return this.db.prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY seq").all(runId); }
  gatingSteps(runId: number): unknown[] {
    return (this.steps(runId) as { gating: string }[]).filter((s) => JSON.parse(s.gating).length > 0);
  }
  close(): void { this.db.close(); }
}
