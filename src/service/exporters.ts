/** JSON / CSV 导出。 */

import { StepRecord } from '../core/types.js';

export function toJSON(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function stepsToCSV(steps: StepRecord[]): string {
  const header = [
    'seq',
    't',
    'observation_id',
    'sensor_id',
    'status',
    'accepted',
    'reject_reason',
    'gate_score',
    'pred_x',
    'pred_y',
    'pred_vx',
    'pred_vy',
    'post_x',
    'post_y',
    'post_vx',
    'post_vy',
    'pos_var_x',
    'pos_var_y',
    'vel_var_x',
    'vel_var_y',
    'innov_dx',
    'innov_dy',
  ];
  const lines = [header.join(',')];
  for (const s of steps) {
    lines.push(
      [
        s.seq,
        fmt(s.t),
        s.observationId ?? '',
        s.sensorId ?? '',
        s.status,
        s.accepted ? 1 : 0,
        s.rejectReason,
        s.gateScore === null ? '' : fmt(s.gateScore),
        fmt(s.predicted.x),
        fmt(s.predicted.y),
        fmt(s.predicted.vx),
        fmt(s.predicted.vy),
        fmt(s.posterior.x),
        fmt(s.posterior.y),
        fmt(s.posterior.vx),
        fmt(s.posterior.vy),
        fmt(s.posteriorCov[0]![0]),
        fmt(s.posteriorCov[1]![1]),
        fmt(s.posteriorCov[2]![2]),
        fmt(s.posteriorCov[3]![3]),
        s.innovation ? fmt(s.innovation.dx) : '',
        s.innovation ? fmt(s.innovation.dy) : '',
      ]
        .map((v) => csvCell(String(v)))
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}

function fmt(v: number | undefined): string {
  if (v === undefined) return '';
  return Number.isInteger(v) ? String(v) : v.toPrecision(10);
}

function csvCell(v: string): string {
  if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}
