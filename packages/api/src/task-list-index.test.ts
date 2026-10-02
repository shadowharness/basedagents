import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrationFilesBefore, RUNNER_LOCAL_STATEMENTS } from './db/migration-list.js';
import { SQLiteAdapter } from './db/sqlite-adapter.js';
import { createTestApp } from './test-helpers.js';

const migrations = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
const name = '0048_tasks_status_created.sql';
const sql = readFileSync(join(migrations, name), 'utf8');

describe('task listing on an existing database after the ordered index migration', () => {
  it('preserves filters, pagination and responses through updates and a repeated migration', async () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    try {
      for (const file of migrationFilesBefore(migrations, name)) {
        sqlite.transaction(() => sqlite.exec(readFileSync(join(migrations, file), 'utf8')))();
      }
      for (const statement of RUNNER_LOCAL_STATEMENTS) sqlite.exec(statement);
      for (const id of ['ag_creator', 'ag_claimer']) {
        sqlite.prepare("INSERT INTO agents (id, public_key, name, description, capabilities, protocols) VALUES (?, ?, ?, 'index fixture', ?, ?)")
          .run(id, Buffer.from(id.padEnd(32, 'x')), id, '["code"]', '["https"]');
      }
      const insert = sqlite.prepare(`INSERT INTO tasks
        (task_id, creator_agent_id, claimed_by_agent_id, title, description, category,
         required_capabilities, status, created_at, bounty_amount, bounty_network)
        VALUES (?, 'ag_creator', ?, ?, 'index migration fixture', ?, ?, ?, ?, ?, ?)`);
      for (let i = 0; i < 60; i++) {
        insert.run(`task_index_${i}`, i % 2 ? 'ag_claimer' : null, `Task ${i}`,
          i % 2 ? 'code' : 'research', i % 2 ? '["code"]' : '["testing"]',
          ['open', 'claimed', 'submitted', 'verified', 'cancelled', 'expired'][i % 6],
          new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(), i % 3 ? '2000000' : null,
          i % 3 ? 'eip155:8453' : null);
      }
      const app = createTestApp(new SQLiteAdapter(sqlite));
      const queries = ['', '?status=all', '?status=open', '?status=verified', '?status=expired',
        '?status=open&limit=3&offset=2', '?status=all&category=code', '?capability=testing',
        '?creator=ag_creator', '?claimer=ag_claimer', '?min_usdc=1.50',
        '?status=all&category=code&min_usdc=1.50&limit=2&offset=1', '?status=not-a-status'];
      const snapshot = async () => Promise.all(queries.map(async query => {
        const response = await app.request('/v1/tasks' + query);
        return { status: response.status, body: await response.json() };
      }));
      const before = await snapshot();
      expect((before[2].body as { tasks: unknown[] }).tasks).toHaveLength(10);
      expect(before.at(-1)?.status).toBe(400);
      sqlite.exec(sql);
      expect(await snapshot()).toEqual(before);
      // Check that the index stays correct when rows move between states and
      // dates, without relying on an unspecified ordering for equal dates.
      sqlite.exec("UPDATE tasks SET status = 'verified', created_at = '2027-01-01T00:00:00.000Z' WHERE task_id = 'task_index_0'");
      sqlite.exec("DELETE FROM tasks WHERE task_id = 'task_index_6'");
      const indexedAfterMutation = await snapshot();
      sqlite.exec('DROP INDEX idx_tasks_status_created');
      expect(await snapshot()).toEqual(indexedAfterMutation);
      sqlite.exec(sql);
      sqlite.exec(sql);
      expect(await snapshot()).toEqual(indexedAfterMutation);
      expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally { sqlite.close(); }
  });
});
