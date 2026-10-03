import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [label, mode = 'full'] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(label || '') || !['full','smoke','tasks'].includes(mode)) throw new Error('Use run.mjs label [full|smoke|tasks]');
const workloadBytes = fs.readFileSync(path.join(root, 'bench/workload.json'));
const workload = JSON.parse(workloadBytes);
const output = path.resolve(root, '../runs', label);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.mkdirSync(output); // Refuse an existing run before writing any evidence.
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = { at: new Date().toISOString(), mode, upstreamHead: execFileSync('git', ['rev-parse','HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  projectionMode: process.env.TASK_LIST_PROJECTION_MODE ?? 'off',
  platform: process.platform, arch: process.arch, node: process.version, cpu: os.cpus()[0].model, availableParallelism: os.availableParallelism(),
  workload, workloadSha256: sha(workloadBytes), sourceSha256: {} };
for (const filename of ['bench/server.ts','bench/run.mjs','packages/api/src/index.ts','packages/api/src/db/sqlite-adapter.ts','packages/api/src/tasks/service.ts','packages/api/src/tasks/settled.ts','packages/api/src/tasks/list-projection.ts','optional/task-projection/install.sql','optional/task-projection/task_projection.wasm']) metadata.sourceSha256[filename] = sha(fs.readFileSync(path.join(root, filename)));
fs.writeFileSync(path.join(output, 'metadata.json'), JSON.stringify(metadata, null, 2));
const log = fs.openSync(path.join(output, 'server.log'), 'wx');
const child = spawn(process.execPath, ['--import', 'tsx', 'bench/server.ts'], { cwd: root, stdio: ['ignore',log,log,'ipc'],
  env: { PATH: process.env.PATH, HOME: process.env.HOME, BENCH_OUTPUT: output, NODE_ENV: 'production', TASK_LIST_PROJECTION_MODE: process.env.TASK_LIST_PROJECTION_MODE ?? 'off' } });
function waitFor(type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${type}`)); }, 120000);
    const exit = code => { cleanup(); reject(new Error(`Server exited ${code} waiting for ${type}`)); };
    const message = data => { if (data.type === type) { cleanup(); resolve(data); } else if (data.type === 'error') { cleanup(); reject(new Error(data.message)); } };
    function cleanup() { clearTimeout(timer); child.off('message', message); child.off('exit', exit); }
    child.on('message', message); child.on('exit', exit);
  });
}
const agent = new http.Agent({ keepAlive: true, maxSockets: workload.concurrency });
let port;
const fingerprints = new Map();
function request(endpoint) {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: endpoint.path, method: 'GET', agent }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const ms = performance.now() - start, body = Buffer.concat(chunks);
        try {
          if (response.statusCode !== 200) throw new Error(`Unexpected status ${response.statusCode}: ${body}`);
          const parsed = JSON.parse(body.toString());
          // These two status diagnostics vary with wall time, not API behavior.
          if (endpoint.name === 'status') { delete parsed.checked_at; delete parsed.db_latency_ms; }
          const fingerprint = sha(JSON.stringify(parsed));
          if (fingerprints.has(endpoint.name) && fingerprints.get(endpoint.name) !== fingerprint) throw new Error(`Response changed during fixed run: ${endpoint.name}`);
          if (!fingerprints.has(endpoint.name)) fs.writeFileSync(path.join(output, `${endpoint.name}.response.json`), JSON.stringify(parsed, null, 2));
          fingerprints.set(endpoint.name, fingerprint); resolve(ms);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error('HTTP request timed out')));
    req.on('error', reject); req.end();
  });
}
async function load(endpoint, count) {
  const times = []; let next = 0;
  const start = performance.now();
  await Promise.all(Array.from({ length: workload.concurrency }, async () => {
    while (next++ < count) times.push(await request(endpoint));
  }));
  const elapsedMs = performance.now() - start;
  const sorted = [...times].sort((a,b) => a-b);
  const quantile = p => sorted[Math.ceil(p * sorted.length) - 1];
  return { count: times.length, elapsedMs, requestsPerSecond: count * 1000 / elapsedMs, p50: quantile(.5), p99: quantile(.99), timesMs: times };
}
try {
  ({ port } = await waitFor('ready'));
  const results = [];
  for (const endpoint of workload.endpoints.filter(e => mode !== 'tasks' || e.name.startsWith('tasks-'))) {
    await load(endpoint, mode === 'smoke' ? 8 : workload.warmupRequests);
    const runs = [];
    for (let run = 0; run < (mode === 'smoke' ? 1 : workload.runs); run++) runs.push(await load(endpoint, mode === 'smoke' ? 12 : workload.measuredRequests));
    const med = xs => [...xs].sort((a,b) => a-b)[Math.floor(xs.length/2)];
    const item = { endpoint, runs, medianP50: med(runs.map(r=>r.p50)), medianP99: med(runs.map(r=>r.p99)), responseSha256: fingerprints.get(endpoint.name) };
    results.push(item);
    if (mode !== 'smoke') {
      const started = waitFor('profile-started'); child.send({ type: 'profile-start' }); await started;
      await load(endpoint, workload.profileRequests);
      const stopped = waitFor('profile-stopped'); child.send({ type: 'profile-stop', name: endpoint.name }); await stopped;
    }
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ endpoint: endpoint.name, p50: item.medianP50, p99: item.medianP99, responseSha256: item.responseSha256 }));
  }
  fs.writeFileSync(path.join(output, 'complete.json'), JSON.stringify({ completedAt: new Date().toISOString(), endpoints: results.length, requestsFailed: 0 }));
} finally {
  agent.destroy(); child.send({ type: 'stop' });
  setTimeout(() => child.kill('SIGTERM'), 5000).unref();
}
