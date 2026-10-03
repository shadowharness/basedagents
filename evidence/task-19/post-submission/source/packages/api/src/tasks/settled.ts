/**
 * The settled-tasks feed + time-to-paid stats (GET /v1/tasks/settled, the
 * homepage "Recently paid" section, and /v1/status → tasks.paid_usdc_total).
 *
 * Population — the one definition every surface shares, so the numbers can't
 * disagree: payment_status = 'settled', a MAINNET bounty network (testnet
 * settlements are real on-chain but not real payments), escrow not refunded,
 * and a settlement tx hash to link to. A settled row without a tx hash is a
 * data bug: excluded here and logged, never rendered without a working link.
 *
 * D1 has no median(): the window's durations come back in one indexed query
 * (idx_tasks_payment_settled) and the medians are computed here.
 */
import type { DBAdapter } from '../db/adapter.js';
import { atomicToDisplay } from '../payments/x402.js';
import { sanitizeDisplayName } from '../lib/display-name.js';

/** Networks whose settlements count as real payments. */
export const PAID_NETWORKS = ['eip155:8453'] as const;

/** Block explorer per network; the client never builds explorer URLs itself. */
export const TX_EXPLORERS: Record<string, string> = {
  'eip155:8453': 'https://basescan.org/tx/',
  'eip155:84532': 'https://sepolia.basescan.org/tx/',
};

export function explorerTxUrl(network: string, txHash: string): string | null {
  const base = TX_EXPLORERS[network];
  return base && /^0x[0-9a-fA-F]{64}$/.test(txHash) ? `${base}${txHash}` : null;
}

/** A median is withheld (null) when its own stage has fewer samples than this in the window: too few to mean anything. */
export const MIN_N_FOR_MEDIANS = 5;
export const DEFAULT_WINDOW_DAYS = 30;
export const MAX_WINDOW_DAYS = 365;
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;

/** Median of seconds; an even n takes the mean of the two middle values. Rounded to the second. */
export function medianSeconds(values: number[]): number | null {
  if (!values.length) return null;
  const xs = [...values].sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  return Math.round(xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2);
}

const TX = `COALESCE(NULLIF(t.escrow_release_tx_hash, ''), NULLIF(t.payment_tx_hash, ''))`;
/** SQL twin of explorerTxUrl's hash check (0x + 64 hex), so a malformed hash is out of the stats AND the feed. */
const TX_VALID = `(length(${TX}) = 66 AND substr(${TX}, 1, 2) = '0x' AND NOT (lower(substr(${TX}, 3)) GLOB '*[^0-9a-f]*'))`;
const NETS = PAID_NETWORKS.map((n) => `'${n}'`).join(',');
/** Settled, mainnet, not refunded — before the tx-hash check (which splits "shown" from "data bug"). */
const SETTLED_BASE = `t.payment_status = 'settled' AND t.bounty_network IN (${NETS}) AND t.settled_at IS NOT NULL
  AND COALESCE(t.escrow_status, '') != 'refunded'`;
/** Every PAID_NETWORKS entry has an explorer, so a valid hash here always renders a working link. */
const PAID_WHERE = `${SETTLED_BASE} AND ${TX_VALID}`;
/** First delivery: a revised task's submitted_at is its LAST delivery; the receipts keep every one. */
const FIRST_SUBMITTED = `COALESCE((SELECT MIN(r.completed_at) FROM delivery_receipts r WHERE r.task_id = t.task_id), t.submitted_at)`;

export interface SettledStats {
  window_days: number;
  n: number;
  min_n_for_medians: number;
  median_time_to_paid_s: number | null;
  median_time_to_claim_s: number | null;
  median_delivery_s: number | null;
  median_review_s: number | null;
  tasks_paid_all_time: number;
  usdc_paid_all_time: string;
  computed_at: string;
}

export interface SettledTask {
  task_id: string;
  title: string;
  category: string | null;
  bounty: { amount_display: string; token: string; network: string };
  agent: { id: string; name: string | null } | null;
  /** Posted by a house account (HOUSE_ACCOUNT_IDS) — the platform paying for work, not an outside buyer. */
  sponsored: boolean;
  created_at: string;
  claimed_at: string | null;
  submitted_at: string | null;
  settled_at: string;
  time_to_paid_s: number;
  delivery_s: number | null;
  tx_hash: string;
  explorer_url: string;
}

const secondsBetween = (from: string | null, to: string | null): number | null => {
  if (!from || !to) return null;
  const d = (Date.parse(to) - Date.parse(from)) / 1000;
  return Number.isFinite(d) && d >= 0 ? d : null;
};

/** Parse HOUSE_ACCOUNT_IDS (comma/space separated agent `ag_…` and owner `ow_…` ids). */
export function houseAccountIds(raw: string | undefined): Set<string> {
  return new Set((raw ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean));
}

/** All-time totals over the shared population (also feeds /v1/status). */
export async function paidTotals(db: DBAdapter): Promise<{ count: number; usdc: string }> {
  const row = await db.get<{ n: number; atomic: number | string | null }>(
    `SELECT COUNT(*) AS n, SUM(CAST(t.bounty_amount AS INTEGER)) AS atomic FROM tasks t WHERE ${PAID_WHERE}`,
  );
  const atomic = row?.atomic == null ? '0' : BigInt(row.atomic).toString();
  return { count: row?.n ?? 0, usdc: atomicToDisplay(atomic) };
}

export async function settledStats(db: DBAdapter, windowDays: number, nowIso: string): Promise<SettledStats> {
  const since = new Date(Date.parse(nowIso) - windowDays * 86_400_000).toISOString();
  const rows = await db.all<{ created_at: string; claimed_at: string | null; first_submitted_at: string | null; verified_at: string | null; settled_at: string }>(
    `SELECT t.created_at, t.claimed_at, ${FIRST_SUBMITTED} AS first_submitted_at, t.verified_at, t.settled_at
       FROM tasks t WHERE ${PAID_WHERE} AND t.settled_at >= ?`,
    since,
  );
  const pick = (f: (r: (typeof rows)[number]) => number | null) =>
    rows.map(f).filter((x): x is number => x !== null);
  // Each stage is withheld below n = 5 on ITS OWN sample (a stage can have
  // fewer valid durations than there are settled rows).
  const med = (xs: number[]) => (xs.length >= MIN_N_FOR_MEDIANS ? medianSeconds(xs) : null);
  const totals = await paidTotals(db);
  return {
    window_days: windowDays,
    n: rows.length,
    min_n_for_medians: MIN_N_FOR_MEDIANS,
    median_time_to_paid_s: med(pick((r) => secondsBetween(r.created_at, r.settled_at))),
    median_time_to_claim_s: med(pick((r) => secondsBetween(r.created_at, r.claimed_at))),
    median_delivery_s: med(pick((r) => secondsBetween(r.claimed_at, r.first_submitted_at))),
    median_review_s: med(pick((r) => secondsBetween(r.first_submitted_at, r.verified_at))),
    tasks_paid_all_time: totals.count,
    usdc_paid_all_time: totals.usdc,
    computed_at: nowIso,
  };
}

/**
 * The page cursor: `<settled_at>|<task_id>` of the last row, so a page boundary
 * inside a group of tasks settled at the same instant doesn't skip the rest of
 * the group. A bare `<settled_at>` is accepted too (strictly older rows).
 */
export function parseCursor(raw: string): { settledAt: string; taskId: string | null } | null {
  const [settledAt, taskId, extra] = raw.split('|');
  if (extra !== undefined || !settledAt || Number.isNaN(Date.parse(settledAt))) return null;
  if (taskId !== undefined && !/^task_[A-Za-z0-9_-]{1,64}$/.test(taskId)) return null;
  // settled_at is stored as toISOString() and compared as TEXT: normalize, so
  // "…T12:00:00+00:00" matches the stored "…T12:00:00.000Z" in the tie-break.
  return { settledAt: new Date(settledAt).toISOString(), taskId: taskId ?? null };
}

export async function settledTasks(
  db: DBAdapter,
  opts: { limit: number; cursor?: { settledAt: string; taskId: string | null } | null; house: Set<string> },
): Promise<{ tasks: SettledTask[]; next_cursor: string | null }> {
  const params: unknown[] = [];
  let where = PAID_WHERE;
  if (opts.cursor?.taskId) {
    where += ` AND (t.settled_at < ? OR (t.settled_at = ? AND t.task_id < ?))`;
    params.push(opts.cursor.settledAt, opts.cursor.settledAt, opts.cursor.taskId);
  } else if (opts.cursor) {
    where += ` AND t.settled_at < ?`;
    params.push(opts.cursor.settledAt);
  }
  const rows = await db.all<{
    task_id: string; title: string; category: string | null; bounty_amount: string; bounty_token: string | null; bounty_network: string;
    claimed_by_agent_id: string | null; claimer_name: string | null; creator_kind: string | null; creator_agent_id: string | null; creator_owner_id: string | null;
    created_at: string; claimed_at: string | null; first_submitted_at: string | null; settled_at: string; tx_hash: string;
  }>(
    `SELECT t.task_id, t.title, t.category, t.bounty_amount, t.bounty_token, t.bounty_network,
            t.claimed_by_agent_id, cl.name AS claimer_name, t.creator_kind, t.creator_agent_id, t.creator_owner_id,
            t.created_at, t.claimed_at, ${FIRST_SUBMITTED} AS first_submitted_at, t.settled_at, ${TX} AS tx_hash
       FROM tasks t LEFT JOIN agents cl ON cl.id = t.claimed_by_agent_id
      WHERE ${where}
      ORDER BY t.settled_at DESC, t.task_id DESC
      LIMIT ?`,
    ...params, opts.limit,
  );
  const tasks: SettledTask[] = [];
  for (const r of rows) {
    const explorer = explorerTxUrl(r.bounty_network, r.tx_hash);
    if (!explorer) {
      // A hash the explorer can't show is the same data bug as a missing one.
      console.error(`[settled] ${r.task_id}: settlement tx ${JSON.stringify(r.tx_hash)} on ${r.bounty_network} has no explorer link — excluded`);
      continue;
    }
    const creatorId = r.creator_kind === 'owner' ? r.creator_owner_id : r.creator_agent_id;
    tasks.push({
      task_id: r.task_id,
      title: r.title,
      category: r.category,
      bounty: {
        amount_display: /^[0-9]+$/.test(r.bounty_amount) ? atomicToDisplay(r.bounty_amount) : r.bounty_amount,
        token: r.bounty_token ?? 'USDC',
        network: r.bounty_network,
      },
      agent: r.claimed_by_agent_id ? { id: r.claimed_by_agent_id, name: sanitizeDisplayName(r.claimer_name ?? null) } : null,
      sponsored: !!creatorId && opts.house.has(creatorId),
      created_at: r.created_at,
      claimed_at: r.claimed_at,
      submitted_at: r.first_submitted_at,
      settled_at: r.settled_at,
      time_to_paid_s: Math.round(secondsBetween(r.created_at, r.settled_at) ?? 0),
      delivery_s: (() => { const d = secondsBetween(r.claimed_at, r.first_submitted_at); return d === null ? null : Math.round(d); })(),
      tx_hash: r.tx_hash,
      explorer_url: explorer,
    });
  }
  const last = rows[rows.length - 1];
  return { tasks, next_cursor: rows.length === opts.limit ? `${last.settled_at}|${last.task_id}` : null };
}

/** Settled rows with a missing or malformed tx hash — a data bug. Logged on every feed read so it can't hide. */
export async function logSettledWithoutTx(db: DBAdapter): Promise<string[]> {
  const bad = await db.all<{ task_id: string }>(
    `SELECT t.task_id FROM tasks t WHERE ${SETTLED_BASE} AND NOT COALESCE(${TX_VALID}, 0) LIMIT 20`,
  );
  const ids = bad.map((b) => b.task_id);
  if (ids.length) console.error(`[settled] DATA BUG: settled task(s) without a valid settlement tx hash, excluded from the feed and the stats: ${ids.join(', ')}`);
  return ids;
}
