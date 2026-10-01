/**
 * SQLite 持久化（使用 Node 内置 node:sqlite，无需原生编译）。
 * 存储：传感器、原始观测、运行参数、步骤结果快照、真值。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS sensors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    default_noise TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS observations (
    id TEXT PRIMARY KEY,
    sensor_id TEXT NOT NULL REFERENCES sensors(id),
    scenario TEXT,
    observed_at REAL NOT NULL,
    received_at REAL NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    noise TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_obs_time ON observations(observed_at, received_at);

  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config TEXT NOT NULL,
    label TEXT,
    scenario TEXT,
    total_steps INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    rejected INTEGER NOT NULL,
    predicted_only INTEGER NOT NULL,
    rejected_ids TEXT NOT NULL,
    metrics TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS run_steps (
    run_id INTEGER NOT NULL REFERENCES runs(id),
    seq INTEGER NOT NULL,
    t REAL NOT NULL,
    observation_id TEXT,
    sensor_id TEXT,
    status TEXT NOT NULL,
    reject_reason TEXT NOT NULL,
    gate_score REAL,
    accepted INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (run_id, seq)
  );

  CREATE TABLE IF NOT EXISTS ground_truth (
    scenario TEXT NOT NULL,
    t REAL NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    vx REAL NOT NULL,
    vy REAL NOT NULL,
    PRIMARY KEY (scenario, t)
  );
  `);
}
