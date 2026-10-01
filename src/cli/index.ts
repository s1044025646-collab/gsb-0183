#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from '../db/database.js';
import { Repository, ConflictError } from '../db/repository.js';
import { TrackingService } from '../service/trackingService.js';
import { stepsToCSV, toJSON } from '../service/exporters.js';
import { buildScenario } from '../scenarios/seed.js';
import { Observation, RunConfig } from '../core/types.js';

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string | boolean>; rest: string[] } {
  const [cmd = 'help', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const eq = key.indexOf('=');
      if (eq >= 0) flags[key.slice(0, eq)] = key.slice(eq + 1);
      else if (rest[i + 1] && !rest[i + 1]!.startsWith('--')) flags[key] = rest[++i]!;
      else flags[key] = true;
    } else {
      positional.push(a);
    }
  }
  return { cmd, flags, rest: positional };
}

function bootstrap() {
  const dataDir = resolve(process.cwd(), (getFlag('data-dir') as string) ?? 'data');
  mkdirSync(dataDir, { recursive: true });
  const dbPath = resolve(dataDir, 'tracker.db');
  const db = openDatabase(dbPath);
  const repo = new Repository(db);
  const service = new TrackingService(repo);
  return { db, repo, service, dataDir, dbPath };
}

let FLAGS: Record<string, string | boolean> = {};
function getFlag(name: string): string | boolean | undefined {
  return FLAGS[name];
}

function parseConfig(flags: Record<string, string | boolean>): Partial<RunConfig> {
  const cfg: Partial<RunConfig> = {};
  if (flags.gate !== undefined) cfg.gateThreshold = Number(flags.gate);
  if (flags.q !== undefined) cfg.processNoise = Number(flags.q);
  if (flags.order !== undefined) {
    if (flags.order !== 'observed' && flags.order !== 'received') {
      throw new Error('--order 只能是 observed 或 received');
    }
    cfg.replayOrder = flags.order;
  }
  if (flags.from !== undefined) cfg.fromTime = Number(flags.from);
  if (flags.to !== undefined) cfg.toTime = Number(flags.to);
  return cfg;
}

const HELP = `
卡尔曼二维目标跟踪 CLI

用法:
  tracker seed [--force]                  导入固定种子场景（straight/turning/outlier）
  tracker sensors                         列出传感器
  tracker import <file.json>              幂等导入观测（JSON 数组）
  tracker query [--from T] [--to T] [--sensor ID]   按观测时间窗口查询
  tracker run [--q Q] [--gate G] [--order observed|received] [--scenario NAME] [--label L]
  tracker runs                            列出所有运行版本
  tracker show <runId> [--steps]          查看运行汇总/步骤
  tracker gating <runId>                  门控对照（拒绝记录与门控分数）
  tracker compare <a> <b>                 比较两个运行版本轨迹差异
  tracker export <runId> <out.json|out.csv>  导出 JSON 或 CSV
  tracker help
`;

function main(): void {
  const { cmd, flags, rest } = parseArgs(process.argv.slice(2));
  FLAGS = flags;
  const ctx = bootstrap();

  try {
    switch (cmd) {
      case 'seed': {
        for (const kind of ['straight', 'turning', 'outlier'] as const) {
          const data = buildScenario(kind);
          for (const s of data.sensors) ctx.repo.upsertSensor(s);
          // seed 默认幂等：重复运行不变；--force 仅重新写入真值（观测仍幂等）
          const r = ctx.repo.importObservations(data.observations);
          ctx.repo.putGroundTruth(kind, data.truth);
          console.log(`[${kind}] 观测插入 ${r.inserted}，已存在 ${r.unchanged}`);
        }
        if (flags.force) console.log('（--force：场景与真值已刷新；重复观测仍保持幂等）');
        break;
      }
      case 'sensors':
        console.log(toJSON(ctx.repo.listSensors()));
        break;
      case 'import': {
        if (!rest[0]) throw new Error('需要 JSON 文件路径');
        const raw = JSON.parse(readFileSync(resolve(rest[0]), 'utf-8'));
        const list: Observation[] = Array.isArray(raw) ? raw : raw.observations;
        const r = ctx.repo.importObservations(list);
        console.log(toJSON(r));
        break;
      }
      case 'query': {
        const obs = ctx.repo.queryObservations({
          fromObserved: flags.from === undefined ? undefined : Number(flags.from),
          toObserved: flags.to === undefined ? undefined : Number(flags.to),
          sensorId: typeof flags.sensor === 'string' ? flags.sensor : undefined,
        });
        console.log(toJSON(obs));
        break;
      }
      case 'run': {
        const result = ctx.service.run({
          config: parseConfig(flags),
          label: typeof flags.label === 'string' ? flags.label : undefined,
          scenario: typeof flags.scenario === 'string' ? flags.scenario : undefined,
        });
        console.log(toJSON({ runId: result.runId, summary: result.summary }));
        break;
      }
      case 'runs':
        console.log(toJSON(ctx.service.listRuns()));
        break;
      case 'show': {
        const runId = Number(rest[0]);
        const result = ctx.service.getRun(runId);
        if (!result) throw new Error('运行不存在');
        console.log(toJSON(flags.steps ? result : result.summary));
        break;
      }
      case 'gating': {
        const report = ctx.service.gateReport(Number(rest[0]));
        if (!report) throw new Error('运行不存在');
        console.log(toJSON(report));
        break;
      }
      case 'compare': {
        console.log(toJSON(ctx.service.compare(Number(rest[0]), Number(rest[1]))));
        break;
      }
      case 'export': {
        const runId = Number(rest[0]);
        const out = rest[1];
        if (!out) throw new Error('需要输出文件路径（.json 或 .csv）');
        const result = ctx.service.getRun(runId);
        if (!result) throw new Error('运行不存在');
        const content = out.endsWith('.csv') ? stepsToCSV(result.steps) : toJSON(result);
        writeFileSync(resolve(out), content, 'utf-8');
        console.log(`已导出 ${result.steps.length} 步到 ${out}`);
        break;
      }
      case 'help':
      default:
        console.log(HELP);
    }
  } catch (e) {
    if (e instanceof ConflictError) {
      console.error('冲突错误（幂等性校验失败）:', e.message);
    } else {
      console.error('错误:', e instanceof Error ? e.message : String(e));
    }
    process.exitCode = 1;
  } finally {
    ctx.db.close();
  }
}

main();
