import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const [repository, fixture, output] = process.argv.slice(2);
if (!repository || !fixture || !output) throw new Error('Use repository baseline-fixture new-output-directory');
const require = createRequire(path.join(path.resolve(repository), 'package.json'));
const Database = require('better-sqlite3');
fs.mkdirSync(output, { recursive: false });
const source = new Database(fixture, { readonly: true, fileMustExist: true });
const sourceCounts = Object.fromEntries(['agents', 'tasks', 'verifications'].map(t => [t, source.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));
assert.deepEqual(sourceCounts, { agents: 2000, tasks: 50000, verifications: 100000 });
for (const name of ['idx_tasks_status_created', 'idx_verifications_created', 'idx_tasks_paid_totals']) {
  assert.equal(source.prepare('SELECT COUNT(*) n FROM sqlite_schema WHERE name = ?').get(name).n, 0);
}
const migrations = ['0048_tasks_status_created.sql', '0049_verifications_created.sql', '0050_paid_totals_index.sql'];
const variants = [];
const timed = fn => { const start = performance.now(); fn(); return performance.now() - start; };
const allocation = db => ({ pageCount: db.pragma('page_count', { simple: true }), pageSize: db.pragma('page_size', { simple: true }) });
try {
  for (let level = 0; level <= 3; level++) {
    const filename = path.join(output, `variant-${level}.sqlite`);
    await source.backup(filename);
    const db = new Database(filename);
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    const initialAllocation = allocation(db);
    const applied = [];
    for (const name of migrations.slice(0, level)) {
      const bytes = fs.readFileSync(path.join(repository, 'packages/api/migrations', name));
      const elapsedMs = timed(() => db.transaction(() => db.exec(bytes.toString('utf8')))());
      applied.push({ name, sha256: createHash('sha256').update(bytes).digest('hex'), elapsedMs });
    }
    db.pragma('wal_checkpoint(TRUNCATE)');
    variants.push({ level, db, filename, applied, initialAllocation, indexedAllocation: allocation(db), samples: [] });
  }
  for (let round = 0; round < 5; round++) {
    // Rotate the variant order; no endpoint benchmark runs concurrently.
    const ordered = [...variants.slice(round % 4), ...variants.slice(0, round % 4)];
    for (const variant of ordered) {
      const db = variant.db;
      const taskInsert = db.prepare("INSERT INTO tasks (task_id, creator_agent_id, creator_kind, title, description, status, created_at) VALUES (?, 'ag_benchmark_00000', 'agent', 'Write cost fixture', 'Synthetic local data', 'open', ?)");
      const verificationInsert = db.prepare("INSERT INTO verifications (id, verifier_id, target_id, result, coherence_score, signature, created_at) VALUES (?, 'ag_benchmark_00000', 'ag_benchmark_00001', 'pass', 0.9, 'synthetic', ?)");
      const stateUpdate = db.prepare('UPDATE tasks SET status = ? WHERE task_id = ?');
      const paidUpdate = db.prepare('UPDATE tasks SET escrow_status = ? WHERE task_id = ?');
      const iso = i => new Date(Date.UTC(2026, 1, 1) + (round * 1000 + i) * 1000).toISOString();
      const id = i => `task_benchmark_${String(i).padStart(6, '0')}`;
      const taskMs = timed(() => db.transaction(() => { for (let i = 0; i < 1000; i++) taskInsert.run(`task_write_${round}_${i}`, iso(i)); })());
      const verificationMs = timed(() => db.transaction(() => { for (let i = 0; i < 1000; i++) verificationInsert.run(`write_verification_${round}_${i}`, iso(i)); })());
      const stateMs = timed(() => db.transaction(() => { for (let i = 0; i < 1000; i++) assert.equal(stateUpdate.run(round % 2 ? 'open' : 'claimed', id(i * 5)).changes, 1); })());
      // Seeded paid tasks have indices 8,18,...; alternate leaving/re-entering the partial index.
      const paidMs = timed(() => db.transaction(() => { for (let i = 0; i < 1000; i++) assert.equal(paidUpdate.run(round % 2 ? null : 'refunded', id(8 + i * 10)).changes, 1); })());
      variant.samples.push({ round, operationsPerTransaction: 1000, taskInsertMs: taskMs, verificationInsertMs: verificationMs, taskStateUpdateMs: stateMs, paidEligibilityUpdateMs: paidMs });
    }
  }
  const span = xs => { const sorted = [...xs].sort((a,b) => a-b); return { median: sorted[2], min: sorted[0], max: sorted[4] }; };
  const results = variants.map(({ db, filename, ...variant }) => {
    db.pragma('wal_checkpoint(TRUNCATE)');
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks').get().n, 55000);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM verifications').get().n, 105000);
    return { ...variant, finalAllocation: allocation(db), finalBytes: fs.statSync(filename).size,
      summary: Object.fromEntries(['taskInsertMs','verificationInsertMs','taskStateUpdateMs','paidEligibilityUpdateMs'].map(key => [key, span(variant.samples.map(x=>x[key]))])) };
  });
  const report = { schema: 1, purpose: 'Supplemental index write and storage cost; not endpoint performance evidence',
    runtime: { node: process.version, sqlite: source.prepare('SELECT sqlite_version() version').get().version },
    sourceCounts, rounds: 5, transactionSize: 1000, journalMode: 'WAL', synchronous: 'NORMAL',
    note: 'Four databases cloned from the same baseline. Five rounds rotate variant order. Each timed transaction commits 1000 operations. Repeated rounds grow each database equally; these are synthetic write costs, not production throughput.',
    results };
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ completed: true, variants: results.length, output: path.join(output, 'results.json') }));
} finally {
  for (const variant of variants) variant.db.close();
  source.close();
}
