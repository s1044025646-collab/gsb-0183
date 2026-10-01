import http from "node:http";
import { Store } from "./db.js";
import { executeRun, defaultConfig, computeMetrics, RunConfig } from "./service.js";

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(s);
}
async function body(req: http.IncomingMessage): Promise<any> {
  let s = "";
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

export function createServer(store: Store, port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    try {
      if (req.method === "GET" && p === "/health") return json(res, 200, { ok: true });
      if (req.method === "POST" && p === "/sensors") {
        const b = await body(req);
        return json(res, 200, { id: store.addSensor(b.name, b.meta ?? {}) });
      }
      if (req.method === "GET" && p === "/sensors") return json(res, 200, store.sensors());
      if (req.method === "POST" && p === "/observations/import") {
        const b = await body(req);
        const rows = (b.observations ?? []).map((o: any) => ({
          obs_id: String(o.obs_id), sensor_id: Number(o.sensor_id),
          t_obs: Number(o.t_obs), t_recv: Number(o.t_recv ?? o.t_obs),
          zx: Number(o.zx), zy: Number(o.zy),
          rxx: Number(o.rxx), rxy: Number(o.rxy ?? 0), ryy: Number(o.ryy),
        }));
        const r = store.importObservations(rows);
        return json(res, r.conflicts.length ? 409 : 200, r);
      }
      if (req.method === "GET" && p === "/observations") {
        const from = url.searchParams.get("from"), to = url.searchParams.get("to");
        return json(res, 200, store.queryObservations(from === null ? undefined : +from, to === null ? undefined : +to));
      }
      if (req.method === "POST" && p === "/runs") {
        const b = await body(req);
        const cfg: RunConfig = { ...defaultConfig(), ...(b.config ?? {}) };
        const { runId, steps } = executeRun(store, b.name ?? `run-${Date.now()}`, cfg);
        return json(res, 200, { runId, metrics: computeMetrics(steps) });
      }
      if (req.method === "GET" && p === "/runs") return json(res, 200, store.runs());
      const mSteps = p.match(/^\/runs\/(\d+)\/steps$/);
      if (req.method === "GET" && mSteps) return json(res, 200, store.steps(+mSteps[1]));
      const mGate = p.match(/^\/runs\/(\d+)\/gating$/);
      if (req.method === "GET" && mGate) return json(res, 200, store.gatingSteps(+mGate[1]));
      const mExp = p.match(/^\/runs\/(\d+)\/export$/);
      if (req.method === "GET" && mExp) {
        const steps = store.steps(+mExp[1]) as Record<string, unknown>[];
        if (url.searchParams.get("format") === "csv") {
          res.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
          return res.end(toCsv(steps));
        }
        return json(res, 200, steps);
      }
      const mCmp = p.match(/^\/runs\/compare\/(\d+)\/(\d+)$/);
      if (req.method === "GET" && mCmp) {
        const a = store.steps(+mCmp[1]) as any[], b = store.steps(+mCmp[2]) as any[];
        const bByT = new Map(b.map((s) => [s.t, s]));
        const diffs = a.filter((s) => bByT.has(s.t)).map((s) => {
          const o = bByT.get(s.t);
          const ax = s.ux ?? s.px, ay = s.uy ?? s.py, bx = o.ux ?? o.px, by = o.uy ?? o.py;
          return { t: s.t, posDiff: Math.hypot(ax - bx, ay - by) };
        });
        const mean = diffs.length ? diffs.reduce((s, d) => s + d.posDiff, 0) / diffs.length : 0;
        return json(res, 200, { points: diffs.length, meanPosDiff: mean, diffs });
      }
      json(res, 404, { error: "not found" });
    } catch (e: any) {
      json(res, 400, { error: e.message });
    }
  });
  server.listen(port, () => console.log(`API 服务已启动: http://localhost:${port}`));
  return server;
}
