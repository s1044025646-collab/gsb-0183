/** 纯 Node http 实现的 REST API（无第三方框架）。 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase } from '../db/database.js';
import { Repository, ConflictError } from '../db/repository.js';
import { TrackingService } from '../service/trackingService.js';
import { stepsToCSV, toJSON } from '../service/exporters.js';
import { Observation, RunConfig, Sensor } from '../core/types.js';

interface Context {
  repo: Repository;
  service: TrackingService;
}

function send(res: ServerResponse, status: number, body: unknown, contentType = 'application/json; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(typeof body === 'string' ? body : toJSON(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw) return {};
  return JSON.parse(raw);
}

export function createApp(ctx: Context) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';
    try {
      // ---- 健康检查 ----
      if (path === '/health' && method === 'GET') {
        return send(res, 200, { ok: true });
      }

      // ---- 传感器 ----
      if (path === '/sensors' && method === 'GET') {
        return send(res, 200, ctx.repo.listSensors());
      }
      if (path === '/sensors' && method === 'POST') {
        const body = (await readJson(req)) as Sensor;
        const sensor: Sensor = {
          id: body.id,
          name: body.name ?? body.id,
          defaultNoise: body.defaultNoise,
          createdAt: new Date().toISOString(),
        };
        const r = ctx.repo.upsertSensor(sensor);
        return send(res, r === 'inserted' ? 201 : 200, { status: r, sensor });
      }

      // ---- 观测导入（幂等） ----
      if (path === '/observations' && method === 'POST') {
        const body = await readJson(req);
        const list: Observation[] = Array.isArray(body) ? body : body.observations;
        if (!Array.isArray(list)) return send(res, 400, { error: '需要观测数组或 {observations:[]}' });
        const r = ctx.repo.importObservations(list);
        return send(res, 200, r);
      }

      // ---- 时间段查询 ----
      if (path === '/observations' && method === 'GET') {
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        const sensorId = url.searchParams.get('sensorId');
        const obs = ctx.repo.queryObservations({
          fromObserved: from === null ? undefined : Number(from),
          toObserved: to === null ? undefined : Number(to),
          sensorId: sensorId ?? undefined,
        });
        return send(res, 200, obs);
      }

      const runMatch = path.match(/^\/runs\/(\d+)$/);

      // ---- 执行跟踪（新版本） ----
      if (path === '/runs' && method === 'POST') {
        const body = (await readJson(req)) as {
          config?: Partial<RunConfig>;
          label?: string;
          scenario?: string;
        };
        const result = ctx.service.run({
          config: body.config,
          label: body.label,
          scenario: body.scenario,
        });
        return send(res, 201, { runId: result.runId, summary: result.summary });
      }

      if (path === '/runs' && method === 'GET') {
        return send(res, 200, ctx.service.listRuns());
      }

      if (runMatch && method === 'GET') {
        const runId = Number(runMatch[1]);
        const withSteps = url.searchParams.get('steps') === '1';
        const result = ctx.service.getRun(runId);
        if (!result) return send(res, 404, { error: '运行不存在' });
        return send(res, 200, withSteps ? result : result.summary);
      }

      // ---- 门控对照 ----
      const gateMatch = path.match(/^\/runs\/(\d+)\/gating$/);
      if (gateMatch && method === 'GET') {
        const report = ctx.service.gateReport(Number(gateMatch[1]));
        if (!report) return send(res, 404, { error: '运行不存在' });
        return send(res, 200, report);
      }

      // ---- 导出 JSON / CSV ----
      const exportMatch = path.match(/^\/runs\/(\d+)\/export\.(json|csv)$/);
      if (exportMatch && method === 'GET') {
        const result = ctx.service.getRun(Number(exportMatch[1]));
        if (!result) return send(res, 404, { error: '运行不存在' });
        if (exportMatch[2] === 'csv') {
          return send(res, 200, stepsToCSV(result.steps), 'text/csv; charset=utf-8');
        }
        return send(res, 200, result);
      }

      // ---- 比较 ----
      if (path === '/runs/compare' && method === 'GET') {
        const a = Number(url.searchParams.get('a'));
        const b = Number(url.searchParams.get('b'));
        if (!Number.isFinite(a) || !Number.isFinite(b)) {
          return send(res, 400, { error: '需要 a 与 b 两个运行 id' });
        }
        return send(res, 200, ctx.service.compare(a, b));
      }

      return send(res, 404, { error: '未找到路由', path });
    } catch (e) {
      if (e instanceof ConflictError) return send(res, 409, { error: e.message });
      if (e instanceof SyntaxError) return send(res, 400, { error: '非法 JSON' });
      const msg = e instanceof Error ? e.message : String(e);
      return send(res, 500, { error: msg });
    }
  });
}

const port = Number(process.env.PORT ?? process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? 3000);
const dataDir = process.env.DATA_DIR ?? resolve(process.cwd(), 'data');
const dbPath = process.env.DB_PATH ?? resolve(dataDir, 'tracker.db');

const db = openDatabase(dbPath);
const repo = new Repository(db);
const ctx: Context = { repo, service: new TrackingService(repo) };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createApp(ctx);
  server.listen(port, () => {
    console.log(`卡尔曼跟踪后端已启动: http://localhost:${port}`);
    console.log(`数据库: ${dbPath}`);
  });
}

export { ctx };
