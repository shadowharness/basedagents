/**
 * GET /v1/tasks/settled — the paid-work feed + time-to-paid stats.
 *
 * The headline test replays the spec's "Today" fixture (the 8 settled mainnet
 * tasks on 2026-09-23) and asserts the endpoint reproduces the Metrics table to
 * the second. The rest pin the exclusions: testnet, refunded escrow, unsettled,
 * and settled-without-a-tx-hash (a data bug: excluded and logged).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, createTestAgent, createTestApp } from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import { SETTLED_FIXTURE, SETTLED_FIXTURE_NOW } from '../tasks/settled.fixture.js';
import { medianSeconds, explorerTxUrl, type SettledStats, type SettledTask } from '../tasks/settled.js';

interface SettledBody { ok: boolean; stats: SettledStats; tasks: SettledTask[]; next_cursor: string | null }

const TX = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const HOUSE_OWNER = 'ow_house_console_owner';

let db: SQLiteAdapter;
let agents: Record<string, string>;

async function agentFor(name: string): Promise<string> {
  if (!agents[name]) agents[name] = (await createTestAgent(db, { name })).agentId;
  return agents[name];
}

async function insertTask(row: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(row);
  await db.run(`INSERT INTO tasks (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c]));
}

/** A settled task; overrides win. Defaults to a mainnet, non-escrow, 1 USDC task by `poster`. */
async function seedSettled(overrides: Record<string, unknown> = {}, poster = 'Poster', claimer = 'Worker'): Promise<void> {
  await insertTask({
    task_id: `task_${Math.random().toString(36).slice(2, 12)}`,
    creator_agent_id: await agentFor(poster),
    creator_kind: 'agent',
    claimed_by_agent_id: await agentFor(claimer),
    title: 'Seeded paid task',
    description: 'd',
    category: 'code',
    status: 'verified',
    created_at: '2026-09-20T10:00:00.000Z',
    claimed_at: '2026-09-20T11:00:00.000Z',
    submitted_at: '2026-09-20T11:05:00.000Z',
    verified_at: '2026-09-20T12:00:00.000Z',
    settled_at: '2026-09-20T12:00:00.000Z',
    accepted_by: 'creator',
    bounty_amount: '1000000',
    bounty_token: 'USDC',
    bounty_network: 'eip155:8453',
    payment_status: 'settled',
    payment_tx_hash: TX(1),
    ...overrides,
  });
}

async function seedFixture(): Promise<void> {
  for (const f of SETTLED_FIXTURE) {
    const creator = f.creator_kind === 'owner'
      ? { creator_agent_id: null, creator_owner_id: HOUSE_OWNER, creator_kind: 'owner' }
      : { creator_agent_id: await agentFor(f.creator), creator_kind: 'agent' };
    await insertTask({
      task_id: f.task_id,
      ...creator,
      claimed_by_agent_id: await agentFor(f.claimer),
      title: f.title,
      description: 'fixture',
      category: f.category,
      status: 'verified',
      created_at: f.created_at,
      claimed_at: f.claimed_at,
      submitted_at: f.submitted_at,
      verified_at: f.verified_at,
      settled_at: f.settled_at,
      accepted_by: 'creator',
      bounty_amount: f.bounty_amount,
      bounty_token: 'USDC',
      bounty_network: f.bounty_network,
      payment_status: 'settled',
      payment_tx_hash: f.payment_tx_hash,
      escrow: f.escrow,
      escrow_status: f.escrow_status,
      escrow_release_tx_hash: f.escrow_release_tx_hash,
    });
  }
}

function app(extraEnv: Record<string, string> = {}) {
  return createTestApp(db, extraEnv);
}

async function get(path: string, extraEnv: Record<string, string> = {}) {
  const res = await app(extraEnv).request(path);
  return { res, body: (await res.json()) as SettledBody };
}

beforeEach(() => {
  db = setupTestDb();
  agents = {};
  // Freeze the clock at the fixture's "as of" so the 30-day window never drifts.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(SETTLED_FIXTURE_NOW));
});
afterEach(() => { vi.useRealTimers(); });

describe('GET /v1/tasks/settled — the spec fixture', () => {
  it('keeps totals current as an existing settlement enters and leaves the eligible population', async () => {
    await seedSettled({ task_id: 'task_changing', bounty_amount: '3000000' });
    const totals = async () => {
      const { body } = await get('/v1/tasks/settled');
      return [body.stats.tasks_paid_all_time, body.stats.usdc_paid_all_time];
    };
    expect(await totals()).toEqual([1, '3.00']);
    await db.run("UPDATE tasks SET payment_tx_hash = 'bad' WHERE task_id = 'task_changing'");
    expect(await totals()).toEqual([0, '0.00']);
    await db.run('UPDATE tasks SET escrow_release_tx_hash = ? WHERE task_id = ?', TX(2), 'task_changing');
    expect(await totals()).toEqual([1, '3.00']);
    await db.run("UPDATE tasks SET escrow_status = 'refunded' WHERE task_id = 'task_changing'");
    expect(await totals()).toEqual([0, '0.00']);
    await db.run("UPDATE tasks SET escrow_status = NULL, bounty_network = 'eip155:84532' WHERE task_id = 'task_changing'");
    expect(await totals()).toEqual([0, '0.00']);
    await db.run("UPDATE tasks SET bounty_network = 'eip155:8453', bounty_amount = '4000000', settled_at = NULL WHERE task_id = 'task_changing'");
    expect(await totals()).toEqual([0, '0.00']);
    await db.run("UPDATE tasks SET settled_at = '2026-09-20T12:00:00.000Z' WHERE task_id = 'task_changing'");
    expect(await totals()).toEqual([1, '4.00']);
    await db.run("UPDATE tasks SET payment_status = 'pending' WHERE task_id = 'task_changing'");
    expect(await totals()).toEqual([0, '0.00']);
  });

  it('reproduces the Metrics table "Today" column to the second', async () => {
    await seedFixture();
    const { res, body } = await get('/v1/tasks/settled');
    expect(res.status).toBe(200);
    expect(body.stats).toEqual({
      window_days: 30,
      n: 8,
      min_n_for_medians: 5,
      median_time_to_paid_s: 12438,   // 3 h 27 min 18 s
      median_time_to_claim_s: 8186,   // 2 h 16 min 26 s
      median_delivery_s: 167,         // 2 min 47 s
      median_review_s: 3427,          // 57 min 7 s
      tasks_paid_all_time: 8,
      usdc_paid_all_time: '4.90',
      computed_at: SETTLED_FIXTURE_NOW,
    });
  });

  it('lists the last 10 settled tasks newest-first, each with a Basescan link', async () => {
    await seedFixture();
    const { body } = await get('/v1/tasks/settled');
    expect(body.tasks.map((t: { task_id: string }) => t.task_id)).toEqual(SETTLED_FIXTURE.map((f) => f.task_id));
    expect(body.next_cursor).toBeNull();
    const [first] = body.tasks;
    expect(first).toMatchObject({
      task_id: 'task_cCvO29iqPgPsOtpLTSxMF',
      category: 'code',
      bounty: { amount_display: '1.00', token: 'USDC', network: 'eip155:8453' },
      agent: { id: agents['codex-agent-ade77a'], name: 'codex-agent-ade77a' },
      time_to_paid_s: 724,  // the 12-minute VisiData fix
      delivery_s: 177,
    });
    // escrow release hash preferred; explorer URL built server-side from the network map
    const f = SETTLED_FIXTURE[0];
    expect(first.tx_hash).toBe(f.escrow_release_tx_hash);
    expect(first.explorer_url).toBe(`https://basescan.org/tx/${f.escrow_release_tx_hash}`);
    for (const t of body.tasks) expect(t.explorer_url).toMatch(/^https:\/\/basescan\.org\/tx\/0x[0-9a-f]{64}$/);
    // the buyer is not in the row (the detail page shows it)
    expect(first).not.toHaveProperty('creator');
  });

  it('labels house-account tasks `sponsored` (agents and console owners), others not', async () => {
    await seedFixture();
    const house = [agents.Hans, agents['BasedAgents Bounties'], HOUSE_OWNER].join(',');
    const { body } = await get('/v1/tasks/settled', { HOUSE_ACCOUNT_IDS: house });
    const byId = Object.fromEntries(body.tasks.map((t: { task_id: string; sponsored: boolean }) => [t.task_id, t.sponsored]));
    expect(byId.task_cCvO29iqPgPsOtpLTSxMF).toBe(true);   // Hans
    expect(byId.task_BwGWDKa44UJHSKlS25HSx).toBe(true);   // console owner
    expect(byId.task_HsRZZWw01h84hPv60us9F).toBe(false);  // usura_marketing — not in this list
    const none = await get('/v1/tasks/settled');
    expect(none.body.tasks.every((t: { sponsored: boolean }) => t.sponsored === false)).toBe(true);
  });

  it('is edge-cacheable for 60s', async () => {
    const { res } = await get('/v1/tasks/settled');
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
  });
});

describe('GET /v1/tasks/settled — exclusions', () => {
  it('never shows testnet, refunded, unsettled or no-bounty tasks, in the feed or the stats', async () => {
    await seedSettled({ task_id: 'task_real', title: 'Real' });
    await seedSettled({ task_id: 'task_testnet', bounty_network: 'eip155:84532' });
    await seedSettled({ task_id: 'task_refunded', escrow: 1, escrow_status: 'refunded', escrow_release_tx_hash: null });
    await seedSettled({ task_id: 'task_due', payment_status: 'pending', settled_at: null, payment_tx_hash: null, accepted_by: 'auto' });
    await seedSettled({ task_id: 'task_free', bounty_amount: null, bounty_network: null, payment_status: 'none', payment_tx_hash: null, settled_at: null });
    const { body } = await get('/v1/tasks/settled');
    expect(body.tasks.map((t: { task_id: string }) => t.task_id)).toEqual(['task_real']);
    expect(body.stats.tasks_paid_all_time).toBe(1);
    expect(body.stats.usdc_paid_all_time).toBe('1.00');
  });

  it('excludes a settled row with no tx hash and logs it as a data bug', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await seedSettled({ task_id: 'task_ok' });
    await seedSettled({ task_id: 'task_notx', payment_tx_hash: null, settled_at: '2026-09-21T12:00:00.000Z' });
    await seedSettled({ task_id: 'task_badtx', payment_tx_hash: 'not-a-hash', settled_at: '2026-09-21T12:00:00.000Z' });
    await seedSettled({ task_id: 'task_shorttx', payment_tx_hash: '0x1234', settled_at: '2026-09-21T12:00:00.000Z' });
    await seedSettled({ task_id: 'task_nonhex', payment_tx_hash: `0x${'z'.repeat(64)}`, settled_at: '2026-09-21T12:00:00.000Z' });
    const { body } = await get('/v1/tasks/settled?limit=1');
    expect(body.tasks.map((t: { task_id: string }) => t.task_id)).toEqual(['task_ok']); // limit applies after the filter
    expect(body.stats.tasks_paid_all_time).toBe(1);
    expect(body.stats.usdc_paid_all_time).toBe('1.00');
    const logged = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('task_notx');
    expect(logged).toContain('task_badtx');
    expect(logged).toContain('task_shorttx');
    expect(logged).toContain('task_nonhex');
    log.mockRestore();
  });
});

describe('GET /v1/tasks/settled — stats rules', () => {
  it('withholds the medians below n = 5 but keeps the counts', async () => {
    for (let i = 0; i < 4; i++) await seedSettled({ task_id: `task_s${i}` });
    const { body } = await get('/v1/tasks/settled');
    expect(body.stats).toMatchObject({
      n: 4, median_time_to_paid_s: null, median_time_to_claim_s: null, median_delivery_s: null, median_review_s: null,
      tasks_paid_all_time: 4, usdc_paid_all_time: '4.00',
    });
    await seedSettled({ task_id: 'task_s5' });
    expect((await get('/v1/tasks/settled')).body.stats.median_time_to_paid_s).toBe(7200);
  });

  it('withholds a stage below n = 5 on its own sample, even when enough tasks settled', async () => {
    for (let i = 0; i < 4; i++) await seedSettled({ task_id: `task_noclaim${i}`, claimed_at: null });
    await seedSettled({ task_id: 'task_claimed' });
    const { body } = await get('/v1/tasks/settled');
    expect(body.stats.n).toBe(5);
    expect(body.stats.median_time_to_paid_s).toBe(7200);   // 5 samples
    expect(body.stats.median_review_s).toBe(3300);         // 5 samples
    expect(body.stats.median_time_to_claim_s).toBeNull();  // 1 sample
    expect(body.stats.median_delivery_s).toBeNull();       // 1 sample
  });

  it('windows the medians (window_days) but never the all-time counts or the feed', async () => {
    for (let i = 0; i < 5; i++) await seedSettled({ task_id: `task_new${i}` });
    await seedSettled({ task_id: 'task_old', created_at: '2026-06-01T00:00:00.000Z', claimed_at: '2026-06-01T01:00:00.000Z', submitted_at: '2026-06-01T01:01:00.000Z', verified_at: '2026-06-01T02:00:00.000Z', settled_at: '2026-06-01T02:00:00.000Z' });
    const d30 = (await get('/v1/tasks/settled')).body;
    expect(d30.stats.n).toBe(5);
    expect(d30.stats.tasks_paid_all_time).toBe(6);
    expect(d30.tasks).toHaveLength(6);
    const d365 = (await get('/v1/tasks/settled?window_days=365')).body;
    expect(d365.stats).toMatchObject({ window_days: 365, n: 6 });
  });

  it('measures delivery from the FIRST delivery of a revised task; time to paid still ends at settlement', async () => {
    for (let i = 0; i < 4; i++) await seedSettled({ task_id: `task_plain${i}` });
    await seedSettled({ task_id: 'task_revised', revision_count: 1, submitted_at: '2026-09-20T11:50:00.000Z' });
    const worker = agents.Worker;
    for (const at of ['2026-09-20T11:02:00.000Z', '2026-09-20T11:50:00.000Z']) {
      await db.run(
        `INSERT INTO delivery_receipts (receipt_id, task_id, agent_id, summary, submission_type, completed_at, signature) VALUES (?, 'task_revised', ?, 's', 'json', ?, 'sig')`,
        `rcpt_${at}`, worker, at,
      );
    }
    const { body } = await get('/v1/tasks/settled');
    const revised = body.tasks.find((t) => t.task_id === 'task_revised')!;
    expect(revised.submitted_at).toBe('2026-09-20T11:02:00.000Z');
    expect(revised.delivery_s).toBe(120);
    expect(revised.time_to_paid_s).toBe(7200);
  });
});

describe('GET /v1/tasks/settled — paging and params', () => {
  it('never skips tasks settled at the same instant across a page boundary', async () => {
    const at = '2026-09-22T12:00:00.000Z';
    for (const id of ['task_t1', 'task_t2', 'task_t3', 'task_t4', 'task_t5']) await seedSettled({ task_id: id, settled_at: at, verified_at: at });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const q: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const page: SettledBody = (await get(`/v1/tasks/settled?limit=2${q}`)).body;
      seen.push(...page.tasks.map((t) => t.task_id));
      cursor = page.next_cursor;
    } while (cursor);
    expect(seen).toEqual(['task_t5', 'task_t4', 'task_t3', 'task_t2', 'task_t1']);
    // the same instant written another way still hits the tie-break
    const alt = (await get(`/v1/tasks/settled?limit=2&cursor=${encodeURIComponent('2026-09-22T12:00:00+00:00|task_t4')}`)).body;
    expect(alt.tasks.map((t) => t.task_id)).toEqual(['task_t3', 'task_t2']);
  });

  it('pages with the settled_at cursor', async () => {
    for (let i = 0; i < 5; i++) {
      await seedSettled({ task_id: `task_p${i}`, settled_at: `2026-09-2${i}T12:00:00.000Z`, verified_at: `2026-09-2${i}T12:00:00.000Z` });
    }
    const p1 = (await get('/v1/tasks/settled?limit=2')).body;
    expect(p1.tasks.map((t: { task_id: string }) => t.task_id)).toEqual(['task_p4', 'task_p3']);
    expect(p1.next_cursor).toBe('2026-09-23T12:00:00.000Z|task_p3');
    const p2 = (await get(`/v1/tasks/settled?limit=2&cursor=${encodeURIComponent(p1.next_cursor!)}`)).body;
    expect(p2.tasks.map((t: { task_id: string }) => t.task_id)).toEqual(['task_p2', 'task_p1']);
    const p3 = (await get(`/v1/tasks/settled?limit=2&cursor=${encodeURIComponent(p2.next_cursor!)}`)).body;
    expect(p3.tasks.map((t: { task_id: string }) => t.task_id)).toEqual(['task_p0']);
    expect(p3.next_cursor).toBeNull();
  });

  it('clamps limit to 50 and window_days to 365; rejects junk', async () => {
    expect((await get('/v1/tasks/settled?window_days=9999')).body.stats.window_days).toBe(365);
    expect((await get('/v1/tasks/settled?limit=abc')).res.status).toBe(400);
    expect((await get('/v1/tasks/settled?window_days=-3')).res.status).toBe(400);
    expect((await get('/v1/tasks/settled?cursor=yesterday')).res.status).toBe(400);
    expect((await get(`/v1/tasks/settled?cursor=${encodeURIComponent("2026-09-22T12:00:00.000Z|'; DROP")}`)).res.status).toBe(400);
    // a bare settled_at still works (strictly older rows)
    expect((await get(`/v1/tasks/settled?cursor=${encodeURIComponent('2026-09-22T12:00:00.000Z')}`)).res.status).toBe(200);
  });

  it('is not captured by GET /v1/tasks/:id', async () => {
    const { res, body } = await get('/v1/tasks/settled');
    expect(res.status).toBe(200);
    expect(body).toHaveProperty('stats');
  });
});

describe('settled helpers', () => {
  it('median: odd n takes the middle, even n the rounded mean of the middle two', () => {
    expect(medianSeconds([])).toBeNull();
    expect(medianSeconds([3, 1, 2])).toBe(2);
    expect(medianSeconds([1, 2, 3, 4])).toBe(3); // 2.5 → 3
    expect(medianSeconds([10.4, 20.2])).toBe(15);
  });

  it('explorer URLs come from the network map, only for well-formed hashes', () => {
    expect(explorerTxUrl('eip155:8453', TX(7))).toBe(`https://basescan.org/tx/${TX(7)}`);
    expect(explorerTxUrl('eip155:84532', TX(7))).toBe(`https://sepolia.basescan.org/tx/${TX(7)}`);
    expect(explorerTxUrl('eip155:1', TX(7))).toBeNull();
    expect(explorerTxUrl('eip155:8453', '0x123')).toBeNull();
  });
});
