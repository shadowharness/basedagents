import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const [repository, destination] = process.argv.slice(2);
if (!repository || !destination || fs.existsSync(destination)) throw new Error('Use repository and new output file');
const source = file => import(pathToFileURL(path.resolve(repository, 'packages/api/src', file)));
const { initDatabase, closeDatabase } = await source('db/index.ts');
const { migrationFilesBefore, RUNNER_LOCAL_STATEMENTS } = await source('db/migration-list.ts');
const { SQLiteAdapter } = await source('db/sqlite-adapter.ts');
const { createTestApp } = await source('test-helpers.ts');
const { paidTotals } = await source('tasks/settled.ts');
globalThis.fetch = async () => { throw new Error('External fetch disabled in semantics probe'); };
const migrations = path.resolve(repository, 'packages/api/migrations');
const sql = name => fs.readFileSync(path.join(migrations, name), 'utf8');
function setup(before) {
  const db = initDatabase(':memory:');
  for (const file of migrationFilesBefore(migrations, before)) db.transaction(()=>db.exec(sql(file)))();
  for (const statement of RUNNER_LOCAL_STATEMENTS) db.exec(statement);
  db.prepare("INSERT INTO agents (id, public_key, name, description, capabilities, protocols) VALUES ('ag_semantics', ?, 'Semantics fixture', 'Synthetic local fixture', '[]', '[]')").run(Buffer.alloc(32, 1));
  return db;
}
const tieDb = setup('0048_tasks_status_created.sql');
const insert = tieDb.prepare("INSERT INTO tasks (task_id, creator_agent_id, creator_kind, title, description, status, created_at, expires_at) VALUES (?, 'ag_semantics', 'agent', 'Tied timestamp', 'Synthetic local fixture', 'open', '2026-01-01T00:00:00.000Z', ?)");
for (let i = 0; i < 8; i++) insert.run(`task_tie_${i}`, new Date(Date.UTC(2030,0,1) + (7-i)*1000).toISOString());
const app = createTestApp(new SQLiteAdapter(tieDb));
async function snapshot() {
  const responses = [];
  for (const offset of [0, 2, 3, 6]) {
    const route = `/v1/tasks?status=open&limit=3&offset=${offset}`;
    const result = await app.request(route);
    assert.equal(result.status, 200);
    const body = await result.json();
    responses.push({ route, body, ids: body.tasks.map(t=>t.task_id) });
  }
  const partition = [0,2,3].flatMap(i=>responses[i].ids);
  assert.equal(partition.length, 8);
  assert.equal(new Set(partition).size, 8);
  assert.deepEqual([...partition].sort(), Array.from({length:8},(_,i)=>`task_tie_${i}`));
  return { responses, plan: tieDb.prepare("EXPLAIN QUERY PLAN SELECT * FROM tasks WHERE status='open' ORDER BY created_at DESC LIMIT 3 OFFSET 2").all() };
}
const before = await snapshot();
tieDb.exec(sql('0048_tasks_status_created.sql'));
const after = await snapshot();
tieDb.exec('DROP INDEX idx_tasks_status_created');
assert.deepEqual(await snapshot(), before);
const tie = { before, after, identicalBodies: JSON.stringify(before.responses) === JSON.stringify(after.responses),
  interpretation: 'Equal created_at values have no specified tie-breaker. Each indexed or unindexed snapshot contains exactly the same eight rows across adjacent pages; page ordering is recorded without normalization.' };
closeDatabase();

const db = setup('0050_paid_totals_index.sql');
const adapter = new SQLiteAdapter(db);
const tx = '0x' + 'ab'.repeat(32);
const rows = [
  { id: 'valid-payment' }, { id: 'valid-release', release: '0x' + 'CD'.repeat(32), payment: 'bad' },
  { id: 'invalid-release', release: 'bad' }, { id: 'empty-release', release: '' },
  { id: 'missing-hash', payment: null }, { id: 'bad-hash', payment: '0x' + 'z'.repeat(64) },
  { id: 'refunded', escrow: 'refunded' }, { id: 'testnet', network: 'eip155:84532' },
  { id: 'null-settled', settled: null }, { id: 'pending', paymentStatus: 'pending' },
  { id: 'empty-settled', settled: '' }, { id: 'empty-escrow', escrow: '' },
].map(row=>({ amount: '2000000', paymentStatus: 'settled', network: 'eip155:8453', settled: '2026-01-01T00:00:00.000Z', escrow: null, release: null, payment: tx, ...row }));
const insertPaid = db.prepare("INSERT INTO tasks (task_id, creator_agent_id, creator_kind, title, description, status, created_at, bounty_amount, payment_status, bounty_network, settled_at, escrow_status, escrow_release_tx_hash, payment_tx_hash) VALUES (?, 'ag_semantics', 'agent', 'Paid semantics', 'Synthetic local fixture', 'verified', '2026-01-01T00:00:00.000Z', ?, ?, ?, ?, ?, ?, ?)");
for (const row of rows) insertPaid.run('task_' + row.id.replaceAll('-','_'), row.amount, row.paymentStatus, row.network, row.settled, row.escrow, row.release, row.payment);
const paidQuery = `SELECT task_id, bounty_amount FROM tasks WHERE payment_status='settled' AND bounty_network IN ('eip155:8453') AND settled_at IS NOT NULL AND COALESCE(escrow_status,'')!='refunded' AND length(COALESCE(NULLIF(escrow_release_tx_hash,''),NULLIF(payment_tx_hash,'')))=66 AND substr(COALESCE(NULLIF(escrow_release_tx_hash,''),NULLIF(payment_tx_hash,'')),1,2)='0x' AND NOT (lower(substr(COALESCE(NULLIF(escrow_release_tx_hash,''),NULLIF(payment_tx_hash,'')),3)) GLOB '*[^0-9a-f]*')`;
const checks = [];
async function compare(label, expectedCount) {
  db.exec('DROP INDEX IF EXISTS idx_tasks_paid_totals');
  const absent = { total: await paidTotals(adapter), ids: db.prepare(paidQuery).all().map(r=>r.task_id).sort() };
  db.exec(sql('0050_paid_totals_index.sql'));
  db.exec(sql('0050_paid_totals_index.sql'));
  const present = { total: await paidTotals(adapter), ids: db.prepare(paidQuery).all().map(r=>r.task_id).sort() };
  assert.deepEqual(present, absent);
  assert.equal(present.total.count, expectedCount);
  assert.equal(present.total.usdc, (expectedCount*2).toFixed(2));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='idx_tasks_paid_totals'").get().n, 1);
  checks.push({ label, expectedCount, absent, present, passed: true });
}
await compare('initial eligibility matrix', 5);
db.prepare("UPDATE tasks SET escrow_release_tx_hash=NULL WHERE task_id='task_invalid_release'").run();
await compare('invalid nonempty release no longer hides valid payment', 6);
db.prepare("UPDATE tasks SET escrow_status='refunded' WHERE task_id='task_valid_payment'").run();
await compare('refund removes existing eligible task', 5);
db.prepare("UPDATE tasks SET bounty_network='eip155:8453' WHERE task_id='task_testnet'").run();
await compare('network update adds an existing task', 6);
db.prepare("UPDATE tasks SET settled_at=NULL WHERE task_id='task_empty_settled'").run();
await compare('null differs from empty settled timestamp', 5);
assert.equal(db.pragma('integrity_check', {simple:true}), 'ok');
assert.deepEqual(db.pragma('foreign_key_check'), []);
const report = { scope: 'Actual API/SQLite semantics checks, separate from the fixed performance workload', node: process.version,
  sqlite: db.prepare('SELECT sqlite_version() version').get().version, tiedTaskPages: tie, paidEligibilityChecks: checks,
  excludedInputs: 'Negative and out-of-range monetary values inserted directly into the database are outside the accepted API schema and are not claimed as covered.' };
closeDatabase();
fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ tiedBodiesIdentical: tie.identicalBodies, adjacentPagesPreserveAllRows: true, paidChecks: checks.length, paidChecksPassed: true }));
