import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/database.js';
import { Repository } from '../db/repository.js';
import { TrackingService } from '../service/trackingService.js';
import { Observation, Sensor } from '../core/types.js';

export function makeCtx() {
  const dir = mkdtempSync(join(tmpdir(), 'kf-test-'));
  const db = openDatabase(join(dir, 't.db'));
  const repo = new Repository(db);
  const service = new TrackingService(repo);
  return { dir, db, repo, service };
}

export const SENSOR: Sensor = {
  id: 's1',
  name: '测试传感器',
  defaultNoise: [
    [1, 0],
    [0, 1],
  ],
  createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
};

export function obs(p: Partial<Observation> & { id: string; observedAt: number }): Observation {
  return {
    sensorId: 's1',
    receivedAt: p.observedAt,
    x: 0,
    y: 0,
    noise: [
      [1, 0],
      [0, 1],
    ],
    ...p,
  } as Observation;
}
