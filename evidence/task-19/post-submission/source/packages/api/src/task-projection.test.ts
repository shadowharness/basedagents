import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerMigrationFiles, RUNNER_LOCAL_STATEMENTS } from './db/migration-list.js';
import { SQLiteAdapter } from './db/sqlite-adapter.js';
import { createTestApp } from './test-helpers.js';
import { clearTaskProjections, installTaskProjectionModule, projectedTaskList, projectedTaskETag, taskProjectionStats } from './tasks/list-projection.js';
import { Hono } from 'hono';
import { etag } from 'hono/etag';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const install = readFileSync(resolve(root, 'optional/task-projection/install.sql'), 'utf8');
installTaskProjectionModule(new WebAssembly.Module(readFileSync(resolve(root, 'optional/task-projection/task_projection.wasm'))));
afterEach(() => { vi.useRealTimers(); clearTaskProjections(); });
function fixture() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  const migrations = resolve(root, 'packages/api/migrations');
  for (const name of runnerMigrationFiles(migrations)) db.transaction(() => db.exec(readFileSync(resolve(migrations, name), 'utf8')))();
  for (const sql of RUNNER_LOCAL_STATEMENTS) db.exec(sql);
  db.transaction(() => db.exec(install))();
  for (const id of ['ag_author', 'ag_claimed']) db.prepare("INSERT INTO agents (id,public_key,name,description,capabilities,protocols) VALUES (?,?,?,'fixture','[]','[]')").run(id, Buffer.from(id.padEnd(32, 'x')), id);
  const insert = db.prepare("INSERT INTO tasks (task_id,creator_agent_id,claimed_by_agent_id,title,description,category,required_capabilities,status,created_at,expires_at,bounty_amount,bounty_network,payment_signature) VALUES (?,'ag_author',?,'A \"title\" ☃',?,?,?,'open','2026-01-01T00:00:00.000Z',?,? ,?,'PRIVATE_SIGNATURE')");
  for (let i = 0; i < 120; i++) insert.run(`task_${i}`, i % 2 ? 'ag_claimed' : null, 'Newline\nUnicode 😃 <script> ', i % 2 ? 'code' : 'research', i % 2 ? '["code"]' : 'not-json', '2028-01-01T00:00:00.000Z', i % 3 ? '2000000' : null, i % 3 ? 'eip155:8453' : null);
  return db;
}
for (const mode of ['js', 'rust-fresh', 'rust-reuse', 'rust-u128', 'rust-u128-etag'] as const) describe(`public projection ${mode}`, () => {
  it('matches SQL for 120 equal timestamps, filters, pagination and live mutations', async () => {
    const db = fixture();
    try {
      const adapter = new SQLiteAdapter(db);
      const a = createTestApp(adapter), b = createTestApp(adapter, { TASK_LIST_PROJECTION_MODE: mode });
      const urls = ['?status=all&limit=100', '?status=open&limit=50', '?status=open&limit=50&offset=50', '?status=open&limit=50&offset=100', '?category=code', '?capability=code', '?creator=ag_author', '?claimer=ag_claimed', '?min_usdc=1.50', '?status=verified', '?status=bad', '?min_usdc=x'];
      const compare = async () => {
        for (const q of urls) {
          const expected = await a.request('/v1/tasks' + q), actual = await b.request('/v1/tasks' + q);
          expect(actual.status).toBe(expected.status); expect(await actual.json()).toEqual(await expected.json());
        }
      };
      await compare(); await compare();
      const ids: string[] = [];
      for (const offset of [0, 50, 100]) ids.push(...(await (await b.request(`/v1/tasks?status=open&limit=50&offset=${offset}`)).json() as any).tasks.map((t: any) => t.task_id));
      expect(new Set(ids).size).toBe(120); expect(ids.length).toBe(120);
      db.exec("UPDATE tasks SET status='verified' WHERE task_id='task_0'; DELETE FROM tasks WHERE task_id='task_1'; UPDATE agents SET name='Changed ' || id WHERE id IN ('ag_author','ag_claimed')");
      await compare(); clearTaskProjections(); await compare();
      const body = await (await b.request('/v1/tasks?limit=100')).text(); expect(body).not.toContain('PRIVATE_SIGNATURE');
    } finally { db.close(); }
  });
  it('recomputes claimable on expiry without any database write and owns each response buffer', async () => {
    const db = fixture();
    try {
      vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2027-12-31T23:59:59.000Z'));
      const adapter = new SQLiteAdapter(db), app = createTestApp(adapter, { TASK_LIST_PROJECTION_MODE: mode });
      const first = await app.request('/v1/tasks?status=open&limit=100');
      const epoch = db.prepare('SELECT version FROM task_projection_epoch').get();
      vi.setSystemTime(new Date('2028-01-01T00:00:00.000Z'));
      const second = await app.request('/v1/tasks?status=open&limit=100');
      expect((await first.json() as any).tasks.every((t: any) => t.claimable)).toBe(true);
      expect((await second.json() as any).tasks.every((t: any) => !t.claimable)).toBe(true);
      vi.setSystemTime(new Date('2027-12-31T23:59:58.000Z'));
      expect((await (await app.request('/v1/tasks?status=open&limit=100')).json() as any).tasks.every((t: any) => t.claimable)).toBe(true);
      expect(db.prepare('SELECT version FROM task_projection_epoch').get()).toEqual(epoch);
    } finally { db.close(); }
  });
  it('bounds retained pages, falls back above the limit, and rejects a changed rebuild', async () => {
    const db = fixture();
    try {
      const adapter = new SQLiteAdapter(db);
      const sql = 'SELECT * FROM tasks WHERE task_id = ?';
      for (let i = 0; i < 12; i++) expect(await projectedTaskList(adapter, adapter, sql, [`task_${i}`], mode, 12000, 3)).not.toBeNull();
      const stats = taskProjectionStats(adapter) as any[];
      expect(stats[0].pages).toBeLessThanOrEqual(3); expect(stats[0].retainedBytes).toBeLessThanOrEqual(12000); expect(stats[0].evictions).toBeGreaterThan(0);
      expect(await projectedTaskList(adapter, adapter, sql, ['task_0'], mode, 1, 3)).toBeNull();
      const all = adapter.all.bind(adapter);
      adapter.all = async (...args: any[]) => { const rows = await (all as any)(...args); db.exec("UPDATE tasks SET title='new' WHERE task_id='task_2'"); return rows; };
      clearTaskProjections();
      expect(await projectedTaskList(adapter, adapter, sql, ['task_2'], mode)).toBeNull();
    } finally { db.close(); }
  });
  it('preserves legacy expiry ordering, backwards clock changes, and outstanding response ownership', async () => {
    const db = fixture();
    try {
      const expiries = ['', 'zz-legacy', '2028-01-01T00:00:00.000Z', '2027-12-31T23:59:59.999Z', '+010000-01-01T00:00:00.000Z'];
      const update = db.prepare('UPDATE tasks SET expires_at=? WHERE task_id=?');
      expiries.forEach((e, i) => update.run(e, `task_${i}`));
      vi.useFakeTimers({ toFake: ['Date'] });
      const adapter = new SQLiteAdapter(db), app = createTestApp(adapter, { TASK_LIST_PROJECTION_MODE: mode }), control = createTestApp(adapter);
      const delayed: Array<{ response: Response; expected: unknown }> = [];
      for (const time of ['2027-12-31T23:59:59.999Z', '2028-01-01T00:00:00.000Z', '2027-12-31T23:59:58.000Z']) {
        vi.setSystemTime(new Date(time));
        for (const offset of [0, 100]) {
          const url = `/v1/tasks?status=open&limit=100&offset=${offset}`;
          const expected = await (await control.request(url)).json();
          delayed.push({ response: await app.request(url), expected });
        }
      }
      db.exec("UPDATE tasks SET description=printf('%10000s','changed')");
      await app.request('/v1/tasks?status=open&limit=100');
      for (const { response, expected } of delayed) expect(await response.json()).toEqual(expected);
    } finally { db.close(); }
  });
  it('reflects each certification revocation and the owner display name on the next read', async () => {
    const db = fixture();
    try {
      db.exec("INSERT INTO owners (id,status,display_name) VALUES ('ow_test','active','Original owner')");
      db.prepare("INSERT INTO owner_webauthn_credentials (id,owner_id,credential_id,public_key,status) VALUES ('cred','ow_test','credid',?,'active')").run(Buffer.from([1,2,3]));
      db.exec("INSERT INTO action_assertions (id,owner_id,credential_id,action_type,action_hash,authenticator_data,client_data_json,signature,sequence,prev_hash,entry_hash) VALUES ('assert','ow_test','credid','agent.delegate','hash','ad','cdj','sig',1,'prev','entry')");
      db.exec("INSERT INTO delegations (id,owner_id,agent_id,status,authorizing_assertion_id) VALUES ('del','ow_test','ag_author','active','assert')");
      db.exec("UPDATE tasks SET creator_kind='owner',creator_owner_id='ow_test',creator_agent_id=NULL WHERE task_id='task_0'");
      const adapter = new SQLiteAdapter(db), app = createTestApp(adapter, { TASK_LIST_PROJECTION_MODE: mode });
      const read = async () => (await (await app.request('/v1/tasks?status=open&limit=100')).json() as any).tasks;
      const readAll = async () => [...await read(), ...(await (await app.request('/v1/tasks?status=open&limit=100&offset=100')).json() as any).tasks];
      expect((await read()).some((t: any) => t.creator.cert === 'certified_agent')).toBe(true);
      for (const [table, id] of [['delegations','del'], ['owners','ow_test'], ['owner_webauthn_credentials','cred']]) {
        db.prepare(`UPDATE ${table} SET status=? WHERE id=?`).run(table === 'owners' ? 'suspended' : 'revoked', id);
        expect((await read()).filter((t: any) => t.creator.kind === 'agent').every((t: any) => t.creator.cert === 'none')).toBe(true);
        db.prepare(`UPDATE ${table} SET status='active' WHERE id=?`).run(id);
        expect((await read()).some((t: any) => t.creator.cert === 'certified_agent')).toBe(true);
      }
      db.exec("UPDATE owners SET display_name='Changed owner' WHERE id='ow_test'");
      expect((await readAll()).find((t: any) => t.task_id === 'task_0').creator.name).toBe('Changed owner');
    } finally { db.close(); }
  });
  it('isolates databases and falls back when the generation table is unavailable', async () => {
    const first = fixture(), second = fixture();
    try {
      second.exec("UPDATE tasks SET title='Different database'");
      const a = new SQLiteAdapter(first), b = new SQLiteAdapter(second);
      const sql = "SELECT * FROM tasks WHERE task_id='task_0'";
      const text = (bytes: Uint8Array | null) => new TextDecoder().decode(bytes!);
      expect(text(await projectedTaskList(a, a, sql, [], mode))).not.toContain('Different database');
      expect(text(await projectedTaskList(b, b, sql, [], mode))).toContain('Different database');
      first.exec('DROP TABLE task_projection_epoch');
      expect(await projectedTaskList(a, a, sql, [], mode)).toBeNull();
    } finally { first.close(); second.close(); }
  });
});
it('generation triggers preserve changes(), conditional outbox writes and transaction rollback', async () => {
  const db = fixture();
  try {
    db.exec('CREATE TABLE probe_outbox (id TEXT PRIMARY KEY)');
    const adapter = new SQLiteAdapter(db);
    const batch = [ { sql: "UPDATE tasks SET status='claimed' WHERE task_id='task_0' AND status='open'", params: [] },
      { sql: "INSERT INTO probe_outbox SELECT 'event' WHERE changes()=1", params: [] } ];
    expect(await adapter.batch(batch)).toEqual([{ changes: 1 }, { changes: 1 }]);
    expect(await adapter.batch(batch)).toEqual([{ changes: 0 }, { changes: 0 }]);
    const before = db.prepare('SELECT version FROM task_projection_epoch').get();
    await expect(adapter.batch([{ sql: "UPDATE tasks SET title='rolled back' WHERE task_id='task_0'", params: [] },
      { sql: "INSERT INTO probe_outbox VALUES ('event')", params: [] }])).rejects.toThrow();
    expect(db.prepare('SELECT version FROM task_projection_epoch').get()).toEqual(before);
    expect(db.prepare("SELECT title FROM tasks WHERE task_id='task_0'").get()).not.toEqual({ title: 'rolled back' });
  } finally { db.close(); }
});
it('cached tags match the actual Hono middleware across chunk boundaries and preserve conditional requests', async () => {
  for (const size of [1, 166921, 262144, 262145, 700000]) {
    const bytes = new Uint8Array(size);
    for (let i=0;i<size;i++) bytes[i] = i % 251;
    const tag = await projectedTaskETag(bytes);
    const app = new Hono(); app.use('*', etag());
    app.get('/reference', c => c.body(bytes, 200));
    app.get('/cached', c => c.body(bytes, 200, { ETag: tag }));
    expect((await app.request('/reference')).headers.get('ETag')).toBe(tag);
    expect((await app.request('/cached')).headers.get('ETag')).toBe(tag);
    for (const value of [tag, `W/${tag}`, `"another", ${tag}`, '*']) {
      const response = await app.request('/cached', { headers: { 'If-None-Match': value } });
      expect(response.status).toBe(304); expect(await response.text()).toBe('');
    }
    expect((await app.request('/cached', { headers: { 'If-None-Match': '"different"' } })).status).toBe(200);
    const changed = bytes.slice(); changed[0] ^= 1;
    expect(await projectedTaskETag(changed)).not.toBe(tag);
  }
});
