import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { projectedTaskList, installTaskProjectionModule, clearTaskProjections, type ProjectionMode } from '../packages/api/src/tasks/list-projection.js';
const root = process.cwd();
installTaskProjectionModule(new WebAssembly.Module(fs.readFileSync(path.join(root, 'optional/task-projection/task_projection.wasm'))));
const result = JSON.parse(fs.readFileSync(path.resolve(root, '../runs/follow-js-a/tasks-open.response.json'), 'utf8'));
const rows = result.tasks.map((t: any, i: number) => ({ ...t,
  task_id: t.task_id, creator_agent_id: 'ag_benchmark', creator_kind: 'agent',
  required_capabilities: '["code"]', status: 'open', expires_at: '2099-01-01T00:00:00.000Z',
  created_at: `2026-01-01T00:00:${String(i % 60).padStart(2,'0')}.000Z`,
}));
// Isolate the projection itself. DB promises remain but perform no SQL or I/O.
// The real SQL + network path is measured separately by the unchanged HTTP driver.
const db = { get: async () => ({ epoch: 'ffffffffffffffffffffffffffffffff:9007199254740993' }), all: async () => rows } as any;
const sql = 'SELECT public task page WHERE status = ? LIMIT ? OFFSET ?';
const params = ['open', 100, 0];
const records: any[] = [];
let expected: string | undefined, checksum = 0;
async function main() {
for (const mode of ['js','rust-reuse','rust-u128','rust-u128','rust-reuse','js'] as ProjectionMode[]) {
  clearTaskProjections();
  const first = (await projectedTaskList(db, db, sql, params, mode))!;
  const hash = createHash('sha256').update(first).digest('hex');
  if (expected && hash !== expected) throw Error('Body mismatch');
  expected = hash;
  for (let i=0;i<2000;i++) await projectedTaskList(db,db,sql,params,mode);
  const batches = [];
  for (let b=0;b<5;b++) {
    const cpu = process.cpuUsage(), start = performance.now();
    for (let i=0;i<10000;i++) {
      const body = (await projectedTaskList(db,db,sql,params,mode))!;
      checksum += body[body.length-1];
    }
    batches.push({count:10000,elapsedMs:performance.now()-start,cpuMicroseconds:process.cpuUsage(cpu)});
  }
  records.push({mode,bodyBytes:first.length,responseSha256:hash,batches});
}
const output = path.resolve(root,'../runs/projection-inner.json');
fs.writeFileSync(output,JSON.stringify({node:process.version,scope:'Projection only, synthetic promise DB, 100 public rows, stable epoch, all expiry checks live',records,checksum},null,2));
console.log(JSON.stringify(records.map(r=>({mode:r.mode,microsecondsPerCall:r.batches.map((b:any)=>b.elapsedMs*1000/b.count)}))));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
