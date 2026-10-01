import path from "node:path";
import fs from "node:fs";
import { Store } from "./db.js";
import { executeRun, defaultConfig, computeMetrics, RunConfig } from "./service.js";
import { createServer, toCsv } from "./api.js";
import { buildScenario } from "./scenarios.js";

const DATA_DIR = process.env.KF_DATA_DIR ?? path.join(process.cwd(), "data");
const DB_PATH = process.env.KF_DB ?? path.join(DATA_DIR, "tracker.db");
const PORT = Number(process.env.KF_PORT ?? 8080);

function print(x: unknown): void { console.log(JSON.stringify(x, null, 2)); }

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const store = new Store(DB_PATH);
  try {
    switch (cmd) {
      case "serve": {
        createServer(store, PORT);
        return; // 保持进程
      }
      case "sensor": {
        print({ id: store.addSensor(rest[0], rest[1] ? JSON.parse(rest[1]) : {}) });
        break;
      }
      case "import": {
        // import <file.json>  [{obs_id, sensor|sensor_id, t_obs, t_recv?, zx, zy, rxx, rxy?, ryy}]
        const rows = JSON.parse(fs.readFileSync(rest[0], "utf-8"));
        const list = Array.isArray(rows) ? rows : rows.observations;
        const mapped = list.map((o: any) => ({
          obs_id: String(o.obs_id),
          sensor_id: o.sensor_id ?? store.addSensor(o.sensor ?? "default"),
          t_obs: Number(o.t_obs), t_recv: Number(o.t_recv ?? o.t_obs),
          zx: Number(o.zx), zy: Number(o.zy),
          rxx: Number(o.rxx), rxy: Number(o.rxy ?? 0), ryy: Number(o.ryy),
        }));
        const r = store.importObservations(mapped);
        print(r);
        if (r.conflicts.length) process.exitCode = 2;
        break;
      }
      case "query": {
        const from = rest[0] !== undefined ? Number(rest[0]) : undefined;
        const to = rest[1] !== undefined ? Number(rest[1]) : undefined;
        print(store.queryObservations(from, to));
        break;
      }
      case "run": {
        // run <name> [config.json]
        const cfg: RunConfig = { ...defaultConfig(), ...(rest[1] ? JSON.parse(fs.readFileSync(rest[1], "utf-8")) : {}) };
        const { runId, steps } = executeRun(store, rest[0] ?? `run-${Date.now()}`, cfg);
        print({ runId, metrics: computeMetrics(steps) });
        break;
      }
      case "runs": print(store.runs()); break;
      case "steps": print(store.steps(Number(rest[0]))); break;
      case "gating": print(store.gatingSteps(Number(rest[0]))); break;
      case "export": {
        // export <runId> [json|csv] [outfile]
        const fmt = rest[1] ?? "json";
        const steps = store.steps(Number(rest[0])) as Record<string, unknown>[];
        const out = fmt === "csv" ? toCsv(steps) : JSON.stringify(steps, null, 2);
        if (rest[2]) fs.writeFileSync(rest[2], out);
        else console.log(out);
        break;
      }
      case "load-scenario": {
        // load-scenario <constant|turn|outlier> [seed]
        const sc = buildScenario(rest[0] as any, rest[1] ? Number(rest[1]) : 42);
        for (const s of sc.sensors) store.addSensor(s.name, { r: s.r });
        const mapped = sc.observations.map((o) => ({
          obs_id: o.obs_id, sensor_id: store.addSensor(o.sensor),
          t_obs: o.t_obs, t_recv: o.t_recv, zx: o.zx, zy: o.zy, rxx: o.rxx, rxy: o.rxy, ryy: o.ryy,
        }));
        print(store.importObservations(mapped));
        fs.writeFileSync(path.join(DATA_DIR, `truth-${sc.name}.json`), JSON.stringify(sc.truth, null, 2));
        console.log(`真值已写入 data/truth-${sc.name}.json`);
        break;
      }
      default:
        console.log(`用法: kf <command>
  serve                        启动 API 服务 (KF_PORT 配置端口, 默认 8080)
  sensor <name> [metaJson]     注册传感器
  import <file.json>           幂等导入观测
  query [from] [to]            按观测时间段查询
  run <name> [config.json]     执行跟踪回放(新版本)
  runs / steps <id> / gating <id>
  export <runId> [json|csv] [file]
  load-scenario <constant|turn|outlier> [seed]
  demo                         运行演示 (见 npm run demo)`);
    }
  } finally {
    if (cmd !== "serve") store.close();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  main(process.argv.slice(2)).catch((e) => { console.error("错误:", e.message); process.exit(1); });
}
