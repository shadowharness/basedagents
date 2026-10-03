import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import inspector from 'node:inspector';
import { serve } from '@hono/node-server';
import { initDatabase } from '../packages/api/src/db/index.js';
import { runnerMigrationFiles, RUNNER_LOCAL_STATEMENTS } from '../packages/api/src/db/migration-list.js';
import { SQLiteAdapter } from '../packages/api/src/db/sqlite-adapter.js';
import app, { setNodeAdapter } from '../packages/api/src/index.js';
import { installTaskProjectionModule, taskProjectionStats } from '../packages/api/src/tasks/list-projection.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.env.BENCH_OUTPUT;
if (!output || !process.send) throw new Error('Use bench/run.mjs; IPC and output directory required');
fs.mkdirSync(output, { recursive: true });
const dbFile = path.join(output, 'fixture.sqlite');
if (fs.existsSync(dbFile)) throw new Error('Do not overwrite an existing run fixture');
const sqlite = initDatabase(dbFile);
for (const name of runnerMigrationFiles(path.join(root, 'packages/api/migrations'))) {
  sqlite.transaction(() => sqlite.exec(fs.readFileSync(path.join(root, 'packages/api/migrations', name), 'utf8')))();
}
for (const sql of RUNNER_LOCAL_STATEMENTS) sqlite.exec(sql);
const workload = JSON.parse(fs.readFileSync(path.join(root, 'bench/workload.json'), 'utf8'));
const id = (i: number) => `ag_benchmark_${String(i).padStart(5, '0')}`;
const iso = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const agentInsert = sqlite.prepare(`INSERT INTO agents (id, public_key, name, description, capabilities, protocols, status, registered_at, reputation_score) VALUES (?,?,?,?,?,?,?,?,?)`);
const taskInsert = sqlite.prepare(`INSERT INTO tasks (task_id, creator_agent_id, creator_kind, claimed_by_agent_id, title, description, category, required_capabilities, output_format, status, created_at, claimed_at, submitted_at, verified_at, accepted_by, bounty_amount, bounty_token, bounty_network, payment_status, payment_settled, payment_tx_hash, settled_at, rating, rating_context, rated_at) VALUES (${Array(25).fill('?').join(',')})`);
const verificationInsert = sqlite.prepare(`INSERT INTO verifications (id, verifier_id, target_id, result, coherence_score, signature, created_at) VALUES (?,?,?,?,?,?,?)`);
const chainInsert = sqlite.prepare(`INSERT INTO chain (entry_hash, previous_hash, agent_id, public_key, nonce, profile_hash, timestamp) VALUES (?,?,?,?,?,?,?)`);
sqlite.transaction(() => {
  for (let i = 0; i < workload.dataset.agents; i++) {
    const key = Buffer.from(digest(`public-fixture-${i}`), 'hex');
    agentInsert.run(id(i), key, `Benchmark-${String(i).padStart(4, '0')}`, `Synthetic benchmark agent ${i}`, '["code","testing"]', '["https"]', i % 10 ? 'active' : 'pending', iso(i), (i % 100) / 100);
    chainInsert.run(digest(`entry-${i}`), digest(`entry-${i - 1}`), id(i), key, `fixture-${i}`, digest(`profile-${i}`), iso(i));
  }
  for (let i = 0; i < workload.dataset.tasks; i++) {
    const status = ['open', 'claimed', 'submitted', 'verified', 'cancelled'][i % 5];
    const paid = status === 'verified' && i % 2 === 0;
    const claimed = status !== 'open';
    const submitted = status === 'submitted' || status === 'verified';
    const verified = status === 'verified';
    taskInsert.run(`task_benchmark_${String(i).padStart(6, '0')}`, id(i % 2000), 'agent', claimed ? id((i + 1) % 2000) : null,
      `Synthetic task ${i}`, 'Deterministic public-only performance fixture. '.repeat(10), i % 2 ? 'code' : 'research', '["code"]', 'json', status,
      iso(i), claimed ? iso(i + 10) : null, submitted ? iso(i + 20) : null, verified ? iso(i + 30) : null, verified ? 'creator' : null,
      paid ? '1000000' : null, paid ? 'USDC' : null, paid ? 'eip155:8453' : null, paid ? 'settled' : 'none', paid ? 1 : 0,
      paid ? `0x${digest(`local-only-tx-${i}`)}` : null, paid ? iso(i + 40) : null, verified ? (i % 5) + 1 : null, verified ? 'accept' : null, verified ? iso(i + 30) : null);
  }
  for (let i = 0; i < workload.dataset.verifications; i++) {
    verificationInsert.run(`fixture-verification-${i}`, id(i % 2000), id((i + 1) % 2000), 'pass', 0.9, 'public-fixture-not-a-real-signature', iso(i));
  }
})();
sqlite.pragma('wal_checkpoint(TRUNCATE)');
const projectionMode = process.env.TASK_LIST_PROJECTION_MODE ?? 'off';
sqlite.transaction(() => sqlite.exec(fs.readFileSync(path.join(root, 'optional/task-projection/install.sql'), 'utf8')))();
if (projectionMode.startsWith('rust')) {
  installTaskProjectionModule(new WebAssembly.Module(fs.readFileSync(path.join(root, 'optional/task-projection/task_projection.wasm'))));
}
const adapter = new SQLiteAdapter(sqlite);
let profiling = false;
let queries = new Map<string, { method: string; sql: string; count: number; totalMs: number; maxMs: number; params: unknown[] }>();
for (const method of ['get', 'all', 'run'] as const) {
  const original = adapter[method].bind(adapter);
  (adapter as any)[method] = (sql: string, ...params: unknown[]) => {
    if (!profiling) return original(sql, ...params);
    const start = performance.now();
    // SQLiteAdapter executes prepare/step synchronously before returning its Promise.
    // Time that invocation, excluding unrelated requests' microtask scheduling.
    try { return original(sql, ...params); }
    finally {
      const ms = performance.now() - start, key = method + ':' + sql;
      const item = queries.get(key) || { method, sql, count: 0, totalMs: 0, maxMs: 0, params };
      item.count++; item.totalMs += ms; item.maxMs = Math.max(item.maxMs, ms); queries.set(key, item);
    }
  };
}
setNodeAdapter(adapter);
// All data is synthetic. No networked payment, analytics, webhook or email environment is passed.
const env = { TASK_PAYMENTS_ENABLED: '0', TASK_ESCROW_ENABLED: '0', TASK_LIST_PROJECTION_MODE: projectionMode as any };
globalThis.fetch = (async () => { throw new Error('Benchmark server external fetch is disabled'); }) as typeof fetch;
const session = new inspector.Session(); session.connect();
let resources = { cpu: process.cpuUsage(), memory: process.memoryUsage(), at: performance.now() };
const post = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => session.post(method as any, params, (error, result) => error ? reject(error) : resolve(result)));
const server = serve({ fetch: req => app.fetch(req, env), hostname: '127.0.0.1', port: 0 }, info => process.send?.({ type: 'ready', port: info.port, dataset: workload.dataset }));
// Do not retain an orphan HTTP server if the measurement driver exits.
process.on('disconnect', () => server.close(() => { session.disconnect(); sqlite.close(); process.exit(1); }));
process.on('message', async (message: any) => {
  try {
    if (message.type === 'profile-start') {
      queries = new Map();
      resources = { cpu: process.cpuUsage(), memory: process.memoryUsage(), at: performance.now() };
      await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 100 });
      await post('Profiler.start'); profiling = true;
      process.send?.({ type: 'profile-started' });
    } else if (message.type === 'profile-stop') {
      profiling = false;
      const { profile } = await post('Profiler.stop');
      const entries = [...queries.values()].sort((a, b) => b.totalMs - a.totalMs).map(entry => {
        let plan: unknown;
        try { plan = sqlite.prepare('EXPLAIN QUERY PLAN ' + entry.sql).all(...entry.params); } catch { plan = null; }
        return { ...entry, plan };
      });
      fs.writeFileSync(path.join(output, `${message.name}.cpuprofile`), JSON.stringify(profile));
      fs.writeFileSync(path.join(output, `${message.name}.sql.json`), JSON.stringify(entries, null, 2));
      fs.writeFileSync(path.join(output, `${message.name}.resources.json`), JSON.stringify({
        projectionMode, cpuMicroseconds: process.cpuUsage(resources.cpu), elapsedMs: performance.now() - resources.at,
        memoryBefore: resources.memory, memoryAfter: process.memoryUsage(), projection: taskProjectionStats(adapter),
      }, null, 2));
      process.send?.({ type: 'profile-stopped' });
    } else if (message.type === 'stop') {
      server.close(() => { session.disconnect(); sqlite.close(); process.exit(0); });
    }
  } catch (error) { process.send?.({ type: 'error', message: String(error) }); }
});
