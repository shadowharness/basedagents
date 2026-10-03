/**
 * Task marketplace routes — the AGENT (AgentSig) route family.
 *
 * State transitions live in tasks/service.ts (one conditional UPDATE each);
 * settlement lives in payments/settle.ts. This file only parses requests,
 * answers 404/403/409 from the row it read, calls the gate, and runs the
 * side effects after a win. The human-owner route family (control/tasks.ts)
 * shares the same service.
 *
 * Payment model. Two flows share one settlement machine (payments/settle.ts):
 *   * ESCROW (Tasks P1, the default): the buyer DEPOSITS the bounty into the
 *     registry's house wallet when posting (the x402 402 handshake happens at
 *     POST /v1/tasks); the task is claimable once the deposit settled; the
 *     house RELEASES it to the deliverer on acceptance (buyer or timer) and
 *     REFUNDS it on cancel. See payments/escrow.ts.
 *   * SIGN-AT-ACCEPT (`escrow: false`, Tasks P0): the bounty is only DECLARED
 *     at creation and AUTHORIZED at accept time — the buyer signs an EIP-3009
 *     transfer to the deliverer's wallet after seeing the work; the registry
 *     never holds the funds. See payments/accept.ts.
 * Payments fail closed: without TASK_PAYMENTS_ENABLED + CDP secrets a bounty
 * task cannot be created and a paid accept answers 503; escrow additionally
 * needs the house key (ESCROW_WALLET_PRIVATE_KEY) or answers 503.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types/index.js';
import { CreateTaskSchema, SubmitDeliverableSchema, DeliverTaskSchema, TaskQuerySchema, BOUNTY_NETWORKS, allowedBountyNetworks, RatingFields, withRatingRule, ratingInputOf, isRatingIssue, RATING_RULE_MESSAGE } from '../types/index.js';
import { agentAuth } from '../middleware/auth.js';
import { bytesToHex } from '../crypto/index.js';
import { generatePublicId } from '../lib/ids.js';
import { captureServerEvent } from '../lib/posthog.js';
import { paymentProviderFor } from '../payments/index.js';
import { buildRequirements, buildPaymentRequired, isNetwork } from '../payments/x402.js';
import { acceptBountyTask, delivererWallet } from '../payments/accept.js';
import { fundEscrowTask, acceptEscrowTask, startEscrowLeg, escrowDepositRequirements } from '../payments/escrow.js';
import { claimBudget, slashBondForDisputedClaim } from '../tasks/governance.js';
import { resolveOpenExpiry } from '../tasks/expiry.js';
import { bountyMinimumRefusal } from '../tasks/bounty-minimum.js';
import { escrowAvailable } from '../payments/house-wallet.js';
import { projectedTaskList, projectedTaskETag, type ProjectionMode } from '../tasks/list-projection.js';
import { settledStats, settledTasks, logSettledWithoutTx, houseAccountIds, parseCursor, DEFAULT_LIMIT, MAX_LIMIT, DEFAULT_WINDOW_DAYS, MAX_WINDOW_DAYS } from '../tasks/settled.js';
import {
  type Actor, type TaskRow, loadTask, creatorMatches, logPaymentEvent, recordFunnel,
  creatorTarget, recomputeReputation, publicTaskShape, paymentView, bountyView, creatorSqlParts, escrowView,
  claimGate, deliverGate, acceptUnpaidGate, revisionGate, disputeGate, cancelGate, cancelRefusal, afterAccept,
  notifyMatchingAgents, writeDeliveryReceipt, MAX_REVISIONS, claimAllowedFor, settleRatingAfterAccept,
} from '../tasks/service.js';

const tasks = new Hono<AppEnv>();

const PAYMENT_HEADER = 'PAYMENT-SIGNATURE';
/** Accepted for one release; logged so the deprecation is visible (D8). */
const LEGACY_PAYMENT_HEADER = 'X-PAYMENT-SIGNATURE';
const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;

const AcceptBodySchema = withRatingRule(z.object({ note: z.string().max(2000).optional(), ...RatingFields }).passthrough());
const RevisionBodySchema = z.object({ note: z.string().min(1).max(2000) }).passthrough();
const DisputeBodySchema = withRatingRule(z.object({ reason: z.string().min(1).max(2000), ...RatingFields }).passthrough());
const CancelBodySchema = z.object({ reason: z.string().max(2000).optional() }).passthrough();

type Ctx = Context<AppEnv>;

async function readJson(c: Ctx): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const text = await c.req.text();
  if (!text.trim()) return { ok: true, body: {} };
  try { return { ok: true, body: JSON.parse(text) }; } catch { return { ok: false }; }
}

function agentSigFromHeader(c: Ctx): string | null {
  const authHeader = c.req.header('Authorization') ?? '';
  return authHeader.startsWith('AgentSig ') ? authHeader.split(':').slice(1).join(':') : null;
}

function paymentHeader(c: Ctx): string | undefined {
  const canonical = c.req.header(PAYMENT_HEADER);
  if (canonical) return canonical;
  const legacy = c.req.header(LEGACY_PAYMENT_HEADER);
  if (legacy) console.warn(`[payments] ${LEGACY_PAYMENT_HEADER} is deprecated; send ${PAYMENT_HEADER}`);
  return legacy;
}

/**
 * POST /v1/tasks — Create a task.
 *
 * With a bounty and escrow ON (the default whenever the registry has escrow
 * enabled, or `escrow: true`): the deposit is paid HERE — the first call
 * answers 402 + PAYMENT-REQUIRED (payTo = the house wallet), the buyer signs
 * and retries with PAYMENT-SIGNATURE, and the task is created funded. With
 * `escrow: false` (or no escrow on this registry) a bounty is only declared
 * here and paid at accept; a payment header is then refused.
 */
tasks.post('/', agentAuth, async (c) => {
  const creatorId = c.get('agentId') as string;
  const db = c.get('db');

  const json = await readJson(c);
  if (!json.ok) return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  const parsed = CreateTaskSchema.safeParse(json.body);
  if (!parsed.success) {
    return c.json({ error: 'bad_request', message: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const creator = await db.get<{ id: string; name: string; status: string }>(
    'SELECT id, name, status FROM agents WHERE id = ?', creatorId,
  );
  if (!creator || creator.status !== 'active') {
    return c.json({ error: 'forbidden', message: 'Agent must be active to create tasks' }, 403);
  }

  const bounty = parsed.data.bounty;
  const wantsEscrow = !!bounty && (parsed.data.escrow ?? escrowAvailable(c.env));

  if (paymentHeader(c) && !wantsEscrow) {
    return c.json({
      error: 'payment_not_expected',
      message: bounty
        ? 'This task does not use escrow: the bounty is authorized when you accept the deliverable. Omit the payment header, or post with "escrow": true to deposit it now.'
        : 'Payment is authorized when you accept the deliverable, not when you post the task. Declare the bounty in the body and omit the payment header.',
    }, 400);
  }

  if (bounty && !paymentProviderFor(c.env)) {
    return c.json({
      error: 'payments_unavailable',
      message: 'Bounties are not enabled on this registry yet. Post the task without a bounty, or check GET /v1/status -> payments.',
    }, 503);
  }
  // Production settles real money: reject a bounty on a network this environment
  // won't pay (testnet USDC is staging/dev only) — BEFORE any escrow deposit is taken.
  if (bounty && !allowedBountyNetworks(c.env).includes(bounty.network)) {
    return c.json({
      error: 'bounty_network_not_allowed',
      message: `Bounties on ${bounty.network} are not accepted here; use eip155:8453 (Base mainnet USDC).`,
      network: bounty.network,
    }, 400);
  }
  // D3: free tasks are fine, but a bounty has a floor — checked before any escrow deposit.
  const belowMinimum = bounty ? bountyMinimumRefusal(c.env, 'a2a', bounty.amount) : null;
  if (belowMinimum) return c.json(belowMinimum, 400);

  const taskId = generatePublicId('task');
  const now = new Date().toISOString();
  const reqCaps = parsed.data.required_capabilities ?? null;

  // D13: how long the task stays open unclaimed — default 7 days; only house
  // accounts may exceed the cap or post a never-expiring task (tasks/expiry.ts).
  const expiry = resolveOpenExpiry(c.env, creatorId, parsed.data.expires_in_days, now);
  if (!expiry.ok) {
    return c.json({
      error: 'expiry_window_not_allowed',
      message: `expires_in_days must be between 1 and ${expiry.max} for this poster; omit it for the default window.`,
      max_days: expiry.max,
    }, 400);
  }

  if (wantsEscrow && bounty) {
    const outcome = await fundEscrowTask(db, c.env, {
      kind: 'new',
      funnel: 'agent',
      task: {
        task_id: taskId, creator_agent_id: creatorId, creator_owner_id: null, creator_kind: 'agent', creator_assertion_id: null,
        proposer_signature: agentSigFromHeader(c), title: parsed.data.title, description: parsed.data.description,
        category: parsed.data.category ?? null, required_capabilities: reqCaps, expected_output: parsed.data.expected_output ?? null,
        output_format: parsed.data.output_format, bounty: { amount: bounty.amount, token: bounty.token, network: bounty.network },
        max_active_claims_per_agent: parsed.data.max_active_claims_per_agent ?? null,
        expires_at: expiry.expiresAt,
      },
    }, { rawHeader: paymentHeader(c) ?? null, nowIso: now, actor: { kind: 'agent', agentId: creatorId } });
    for (const [k, v] of Object.entries(outcome.headers ?? {})) c.header(k, v);
    // 200 = the task exists with its deposit taken; the 402 handshake and
    // every refusal create nothing.
    if (outcome.status === 200) {
      await captureServerEvent(c, 'task_created', {
        has_bounty: true, escrow: true, category: parsed.data.category ?? null,
        output_format: parsed.data.output_format, bounty_network: bounty.network,
      });
    }
    return c.json(outcome.body, outcome.status);
  }

  const paymentStatus = bounty ? 'pending' : 'none';

  await db.run(
    `INSERT INTO tasks (task_id, creator_agent_id, creator_kind, title, description, category, required_capabilities,
       expected_output, output_format, status, created_at, proposer_signature,
       bounty_amount, bounty_token, bounty_network, payment_status, max_active_claims_per_agent, expires_at)
     VALUES (?, ?, 'agent', ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`,
    taskId, creatorId, parsed.data.title, parsed.data.description, parsed.data.category ?? null,
    reqCaps ? JSON.stringify(reqCaps) : null, parsed.data.expected_output ?? null, parsed.data.output_format,
    now, agentSigFromHeader(c),
    bounty?.amount ?? null, bounty?.token ?? null, bounty?.network ?? null, paymentStatus,
    parsed.data.max_active_claims_per_agent ?? null, expiry.expiresAt,
  );

  if (bounty) {
    await logPaymentEvent(db, taskId, 'bounty_declared', { amount_atomic: bounty.amount, token: bounty.token, network: bounty.network }, now);
  }
  await recordFunnel(db, 'task_posted', taskId, 'agent');
  await captureServerEvent(c, 'task_created', {
    has_bounty: !!bounty, escrow: false, category: parsed.data.category ?? null,
    output_format: parsed.data.output_format, bounty_network: bounty?.network ?? null,
  });

  const bountyOut = bountyView({ bounty_amount: bounty?.amount ?? null, bounty_token: bounty?.token ?? null, bounty_network: bounty?.network ?? null });

  await notifyMatchingAgents(db, {
    task_id: taskId, title: parsed.data.title, description: parsed.data.description, category: parsed.data.category ?? null,
    required_capabilities: reqCaps, output_format: parsed.data.output_format, bounty: bountyOut,
  }, creatorId);

  const response: Record<string, unknown> = { ok: true, task_id: taskId, status: 'open', payment_status: paymentStatus, escrow: null, expires_at: expiry.expiresAt };
  if (bountyOut) response.bounty = bountyOut;
  return c.json(response);
});

/**
 * POST /v1/tasks/:id/fund — Fund (again) an escrow task whose deposit
 * definitively failed or expired (`escrow.status: unfunded`). Creator only;
 * the same 402 handshake as posting.
 */
tasks.post('/:id/fund', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const taskId = c.req.param('id') as string;
  const db = c.get('db');
  const actor: Actor = { kind: 'agent', agentId };

  const task = await loadTask(db, taskId);
  if (!task) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  if (!creatorMatches(task, actor)) return c.json({ error: 'forbidden', message: 'Only the task creator can fund the escrow' }, 403);
  if (!task.escrow) return c.json({ error: 'invalid_state', message: 'This task does not use escrow; the bounty is paid when you accept the delivery.' }, 409);

  const outcome = await fundEscrowTask(db, c.env, { kind: 'existing', task }, { rawHeader: paymentHeader(c) ?? null, nowIso: new Date().toISOString(), actor });
  for (const [k, v] of Object.entries(outcome.headers ?? {})) c.header(k, v);
  return c.json(outcome.body, outcome.status);
});

/**
 * GET /v1/tasks — Browse/search tasks (public, no auth)
 */
tasks.get('/', async (c) => {
  const db = c.get('db');

  const query = TaskQuerySchema.safeParse({
    status: c.req.query('status'),
    category: c.req.query('category'),
    capability: c.req.query('capability'),
    creator: c.req.query('creator'),
    claimer: c.req.query('claimer'),
    limit: c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined,
    offset: c.req.query('offset') ? parseInt(c.req.query('offset')!, 10) : undefined,
  });

  // An invalid parameter is a 400, never a shrug: dropping the failed query
  // silently served EVERY task (all statuses) to a typo like ?category=nosuch.
  if (!query.success) {
    return c.json({ error: 'bad_request', message: 'Invalid query parameter', details: query.error.flatten() }, 400);
  }
  const q = query.data;
  const limit = Math.min(q.limit ?? 20, 100);
  // ?min_usdc=1.00 — bounty floor in USDC, validated on its own so a malformed
  // value is a 400 instead of silently dropping every other filter.
  const minUsdcRaw = c.req.query('min_usdc');
  let minAtomic: bigint | null = null;
  if (minUsdcRaw !== undefined) {
    if (!/^\d{1,9}(\.\d{1,6})?$/.test(minUsdcRaw)) {
      return c.json({ error: 'invalid_min_usdc', message: 'min_usdc must be a USDC amount with up to 6 decimals, e.g. 1.00' }, 400);
    }
    const [whole, frac = ''] = minUsdcRaw.split('.');
    minAtomic = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
  }
  const offset = q.offset ?? 0;

  const parts = await creatorSqlParts(db);
  let sql = `SELECT ${parts.columns} FROM tasks t ${parts.joins} WHERE 1=1`;
  const params: unknown[] = [];

  if (q.status && q.status !== 'all') {
    sql += ` AND t.status = ?`;
    params.push(q.status);
  }
  // No filter = every status except the swept-away ones (unless explicitly requested)
  if (!q.status) sql += ` AND t.status NOT IN ('cancelled','expired')`;
  if (q.category) { sql += ` AND t.category = ?`; params.push(q.category); }
  if (q.capability) { sql += ` AND t.required_capabilities LIKE ?`; params.push(`%"${q.capability}"%`); }
  if (q.creator) { sql += ` AND t.creator_agent_id = ?`; params.push(q.creator); }
  if (q.claimer) { sql += ` AND t.claimed_by_agent_id = ?`; params.push(q.claimer); }
  if (minAtomic !== null) {
    // bounty_amount is atomic units as a digit string; a few legacy rows hold a
    // decimal display string ("5.00") — scale those so both compare in atomic units.
    sql += ` AND t.bounty_amount IS NOT NULL AND (CASE WHEN t.bounty_amount GLOB '*[^0-9]*' THEN CAST(ROUND(CAST(t.bounty_amount AS REAL) * 1000000) AS INTEGER) ELSE CAST(t.bounty_amount AS INTEGER) END) >= ?`;
    params.push(Number(minAtomic));
  }

  // Public board shows only bounties this environment settles: in production,
  // testnet-bounty tasks are hidden so test USDC never poses as real money.
  // Free tasks (no bounty network) always show. In staging the list is unchanged.
  const allowedNets = allowedBountyNetworks(c.env);
  if (allowedNets.length < BOUNTY_NETWORKS.length) {
    sql += ` AND (t.bounty_network IS NULL OR t.bounty_network IN (${allowedNets.map(() => '?').join(',')}))`;
    params.push(...allowedNets);
  }

  sql += ` ORDER BY t.created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const body = await projectedTaskList(db, c.env?.DB ?? db, sql, params,
    (c.env?.TASK_LIST_PROJECTION_MODE ?? 'off') as ProjectionMode);
  if (body) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (c.env?.TASK_LIST_PROJECTION_MODE === 'rust-u128-etag') headers.ETag = await projectedTaskETag(body);
    return c.body(body, 200, headers);
  }
  const rows = await db.all<Record<string, unknown>>(sql, ...params);
  return c.json({ ok: true, tasks: rows.map(publicTaskShape) });
});

/**
 * GET /v1/tasks/settled — the paid-work feed: the latest settled tasks (each
 * with its Basescan settlement link) plus time-to-paid stats, in one response
 * for the homepage. Mainnet only; testnet, refunded and tx-less rows are out
 * (tasks/settled.ts). Registered before GET /:id so "settled" isn't an id.
 *   ?limit=10 (max 50) · ?cursor=<next_cursor> · ?window_days=30 (max 365, stats only)
 */
tasks.get('/settled', async (c) => {
  const db = c.get('db');
  const intParam = (name: string, dflt: number, max: number): number | null => {
    const raw = c.req.query(name);
    if (raw === undefined || raw === '') return dflt;
    if (!/^[0-9]+$/.test(raw)) return null;
    return Math.min(Math.max(parseInt(raw, 10), 1), max);
  };
  const limit = intParam('limit', DEFAULT_LIMIT, MAX_LIMIT);
  const windowDays = intParam('window_days', DEFAULT_WINDOW_DAYS, MAX_WINDOW_DAYS);
  if (limit === null) return c.json({ error: 'invalid_limit', message: 'limit must be a positive integer (max 50)' }, 400);
  if (windowDays === null) return c.json({ error: 'invalid_window_days', message: 'window_days must be a positive integer (max 365)' }, 400);
  const rawCursor = c.req.query('cursor') || null;
  const cursor = rawCursor ? parseCursor(rawCursor) : null;
  if (rawCursor && !cursor) {
    return c.json({ error: 'invalid_cursor', message: 'cursor is the next_cursor of the previous page (or a settled_at timestamp)' }, 400);
  }

  const nowIso = new Date().toISOString();
  const [stats, page] = await Promise.all([
    settledStats(db, windowDays, nowIso),
    settledTasks(db, { limit, cursor, house: houseAccountIds(c.env?.HOUSE_ACCOUNT_IDS) }),
    logSettledWithoutTx(db),
  ]);
  // 60s at the edge, like /v1/board/feed.atom: the homepage polls this.
  c.header('Cache-Control', 'public, max-age=60');
  return c.json({ ok: true, stats, tasks: page.tasks, next_cursor: page.next_cursor });
});

function parseReceipt(receipt: Record<string, unknown>): Record<string, unknown> {
  if (receipt.artifact_urls && typeof receipt.artifact_urls === 'string') {
    receipt.artifact_urls = JSON.parse(receipt.artifact_urls);
  }
  return receipt;
}

/**
 * The PUBLIC view of a delivery receipt: provenance only. The delivered work
 * product (summary, submission_content, artifact_urls, pr_url, commit_hash) is
 * private to the two parties — the buyer who posted the task (via the owner
 * console) and the delivering agent (via GET /:id/submission, signed). What
 * stays public is enough to independently verify that a signed delivery
 * happened: who delivered, when, its type, the signature and the chain entry.
 */
function publicReceiptShape(receipt: Record<string, unknown>): Record<string, unknown> {
  return {
    receipt_id: receipt.receipt_id,
    task_id: receipt.task_id,
    agent_id: receipt.agent_id,
    submission_type: receipt.submission_type,
    completed_at: receipt.completed_at,
    chain_sequence: receipt.chain_sequence ?? null,
    chain_entry_hash: receipt.chain_entry_hash ?? null,
    signature: receipt.signature ?? null,
    content_private: true,
  };
}

/**
 * A submission the poster chose to PUBLISH as a public sample (0037). The
 * content is intentionally public here — that is the point of publishing — so
 * it carries the deliverable itself plus who delivered it and when. Everything
 * else about a delivery stays provenance-only via publicReceiptShape.
 */
function publicSubmissionShape(s: Record<string, unknown>): Record<string, unknown> {
  return {
    submission_id: s.submission_id,
    task_id: s.task_id,
    agent_id: s.agent_id,
    submission_type: s.submission_type,
    summary: s.summary,
    content: s.content,
    created_at: s.created_at,
    published_at: s.published_at,
  };
}

/**
 * GET /v1/tasks/:id/receipt — Latest delivery receipt (public)
 */
tasks.get('/:id/receipt', async (c) => {
  const taskId = c.req.param('id') as string;
  const db = c.get('db');

  const receipt = await db.get<Record<string, unknown>>(
    'SELECT * FROM delivery_receipts WHERE task_id = ? ORDER BY completed_at DESC LIMIT 1', taskId,
  );
  if (!receipt) {
    return c.json({ error: 'not_found', message: 'No delivery receipt found for this task' }, 404);
  }
  const shaped = publicReceiptShape(receipt);

  // Include agent's public key so the public signature can be independently verified.
  const agent = await db.get<{ public_key: Uint8Array }>('SELECT public_key FROM agents WHERE id = ?', receipt.agent_id);
  if (agent) {
    const pkBytes = agent.public_key instanceof Uint8Array
      ? agent.public_key
      : new Uint8Array(Object.values(agent.public_key as Record<string, number>));
    shaped.agent_public_key = bytesToHex(pkBytes);
  }

  return c.json({ ok: true, receipt: shaped });
});

/**
 * GET /v1/tasks/:id/receipts — Every delivery receipt, newest first (public,
 * provenance only — the payload is private; see GET /:id/submission).
 */
tasks.get('/:id/receipts', async (c) => {
  const taskId = c.req.param('id') as string;
  const db = c.get('db');
  const task = await db.get<{ task_id: string }>('SELECT task_id FROM tasks WHERE task_id = ?', taskId);
  if (!task) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  const rows = await db.all<Record<string, unknown>>(
    'SELECT * FROM delivery_receipts WHERE task_id = ? ORDER BY completed_at DESC', taskId,
  );
  return c.json({ ok: true, receipts: rows.map(publicReceiptShape) });
});

/**
 * GET /v1/tasks/:id/payment — Payment status, audit trail and (when a claimed
 * bounty task is ready to be accepted) the x402 requirements the buyer signs.
 */
tasks.get('/:id/payment', async (c) => {
  const taskId = c.req.param('id') as string;
  const db = c.get('db');

  const task = await loadTask(db, taskId);
  if (!task) return c.json({ error: 'not_found', message: 'Task not found' }, 404);

  const events = await db.all<{ id: string; event_type: string; details: string | null; created_at: string }>(
    'SELECT id, event_type, details, created_at FROM payment_events WHERE task_id = ? ORDER BY created_at ASC', taskId,
  );

  let requirements: ReturnType<typeof buildRequirements> | null = null;
  let paymentRequired: ReturnType<typeof buildPaymentRequired> | null = null;
  let unavailableReason: 'no_bounty' | 'unsupported_network' | 'not_claimed' | 'payee_wallet_missing' | 'escrow_held' | 'escrow_funding' | 'escrow_unavailable' | null = null;
  if (!task.bounty_amount) unavailableReason = 'no_bounty';
  else if (!isNetwork(task.bounty_network)) unavailableReason = 'unsupported_network';
  else if (task.escrow) {
    // Escrow: the only thing a buyer ever signs is the DEPOSIT (payTo = the
    // house wallet), and only while it is not held: at post, or again after a
    // definitive deposit failure (`unfunded`, POST /:id/fund).
    if (task.escrow_status === 'unfunded') {
      requirements = escrowDepositRequirements(c.env, task);
      if (!requirements) unavailableReason = 'escrow_unavailable';
      else paymentRequired = buildPaymentRequired(task, requirements, undefined, { url: `https://api.basedagents.ai/v1/tasks/${taskId}/fund`, description: `BasedAgents escrow deposit for task ${taskId}` });
    } else if (task.escrow_status === 'funding') unavailableReason = 'escrow_funding';
    else unavailableReason = 'escrow_held';
  }
  else if (!task.claimed_by_agent_id) unavailableReason = 'not_claimed';
  else {
    const wallet = await delivererWallet(db, task.claimed_by_agent_id);
    if (!wallet) unavailableReason = 'payee_wallet_missing';
    else {
      requirements = buildRequirements(task, wallet.address, c.env);
      paymentRequired = buildPaymentRequired(task, requirements);
    }
  }

  return c.json({
    ok: true,
    payment: { ...paymentView(task), pay_to: requirements?.payTo ?? null },
    requirements,
    ...(unavailableReason ? { requirements_unavailable_reason: unavailableReason } : {}),
    ...(paymentRequired ? { payment_required: paymentRequired } : {}),
    accept_endpoint: `POST /v1/tasks/${taskId}/accept`,
    ...(task.escrow ? { fund_endpoint: `POST /v1/tasks/${taskId}/fund` } : {}),
    payment_header: PAYMENT_HEADER,
    events: events.map((e) => ({ ...e, details: e.details ? JSON.parse(e.details) : null })),
  });
});

/**
 * GET /v1/tasks/:id — Task detail (public, no auth)
 */
tasks.get('/:id', async (c) => {
  const taskId = c.req.param('id') as string;
  const db = c.get('db');

  const parts = await creatorSqlParts(db);
  const row = await db.get<Record<string, unknown>>(`SELECT ${parts.columns} FROM tasks t ${parts.joins} WHERE t.task_id = ?`, taskId);
  if (!row) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  // Hide a testnet-bounty task from the public board in production (see list filter);
  // the owner/claimer still reach it through the authenticated owner/agent routes.
  const detailBountyNet = (row as { bounty_network?: string | null }).bounty_network ?? null;
  if (detailBountyNet && !allowedBountyNetworks(c.env).includes(detailBountyNet)) {
    return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  }
  const task = row as unknown as TaskRow;

  const submission = await db.get<Record<string, unknown>>(
    'SELECT submission_id, task_id, agent_id, submission_type, summary, content, created_at, published_at FROM submissions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1', taskId,
  );
  const receipt = await db.get<Record<string, unknown>>(
    'SELECT * FROM delivery_receipts WHERE task_id = ? ORDER BY completed_at DESC LIMIT 1', taskId,
  );
  const receiptsCount = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM delivery_receipts WHERE task_id = ?', taskId);

  // The delivered work product is PRIVATE by default — the public detail carries
  // only that a submission exists (`has_submission`) and a provenance-only
  // receipt. The exception is a delivery the POSTER chose to publish as a public
  // sample (0037): then its content is public here (`submission_public`). The
  // parties always read the payload through the owner console (buyer) or
  // GET /:id/submission (agent), published or not.
  const published = !!(submission && submission.published_at);
  return c.json({
    ok: true,
    task: publicTaskShape(row),
    submission: published ? publicSubmissionShape(submission as Record<string, unknown>) : null,
    has_submission: !!submission,
    submission_public: published,
    delivery_receipt: receipt ? publicReceiptShape(receipt) : null,
    receipts_count: receiptsCount?.n ?? 0,
    payment: paymentView(task),
  });
});

/**
 * GET /v1/tasks/:id/submission — the PRIVATE delivered work product (signed).
 * Only the two parties may read it: the delivering agent (claimed_by_agent_id)
 * or the agent that posted the task (creator_agent_id). Human buyers read the
 * same content through the owner console (GET /v1/owner/tasks/:id). Everyone
 * else gets 403 — the public task detail exposes provenance only.
 */
tasks.get('/:id/submission', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const taskId = c.req.param('id') as string;
  const db = c.get('db');

  const task = await loadTask(db, taskId);
  if (!task) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  const isParty = task.claimed_by_agent_id === agentId || task.creator_agent_id === agentId;
  if (!isParty) {
    return c.json({ error: 'forbidden', message: 'Only the task poster or the delivering agent can read the submission' }, 403);
  }

  const submission = await db.get<Record<string, unknown>>(
    'SELECT * FROM submissions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1', taskId,
  );
  const rows = await db.all<Record<string, unknown>>(
    'SELECT * FROM delivery_receipts WHERE task_id = ? ORDER BY completed_at DESC', taskId,
  );
  return c.json({ ok: true, submission: submission ?? null, receipts: rows.map(parseReceipt) });
});

/**
 * POST /v1/tasks/:id/submission/publish — publish the latest delivery as a
 * PUBLIC sample; POST …/unpublish reverts it to private. Only the agent that
 * POSTED the task (creator_agent_id) may decide — the payload embeds the
 * poster's own inputs, so publishing is the poster's call, never the deliverer's.
 * Human posters do the same through the owner console. Publishing cannot un-cache
 * whatever a viewer already saw, but it flips public access off going forward.
 */
async function setPublished(c: Context<AppEnv>, publish: boolean) {
  const agentId = c.get('agentId') as string;
  const taskId = c.req.param('id') as string;
  const db = c.get('db');

  const task = await loadTask(db, taskId);
  if (!task) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  if (task.creator_agent_id !== agentId) {
    return c.json({ error: 'forbidden', message: 'Only the agent that posted the task can publish its delivery' }, 403);
  }
  const submission = await db.get<{ submission_id: string }>(
    'SELECT submission_id FROM submissions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1', taskId,
  );
  if (!submission) return c.json({ error: 'not_found', message: 'No delivery to publish yet' }, 404);

  const publishedAt = publish ? new Date().toISOString() : null;
  await db.run('UPDATE submissions SET published_at = ? WHERE submission_id = ?', publishedAt, submission.submission_id);
  await captureServerEvent(c, publish ? 'task_submission_published' : 'task_submission_unpublished');
  return c.json({ ok: true, task_id: taskId, submission_public: publish, published_at: publishedAt });
}
tasks.post('/:id/submission/publish', agentAuth, (c) => setPublished(c, true));
tasks.post('/:id/submission/unpublish', agentAuth, (c) => setPublished(c, false));

/**
 * POST /v1/tasks/:id/claim — Claim a task (T2)
 */
tasks.post('/:id/claim', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const taskId = c.req.param('id') as string;
  const db = c.get('db');
  const actor: Actor = { kind: 'agent', agentId };

  const agent = await db.get<{ id: string; name: string; status: string }>('SELECT id, name, status FROM agents WHERE id = ?', agentId);
  if (!agent || agent.status !== 'active') {
    return c.json({ error: 'forbidden', message: 'Agent must be active to claim tasks' }, 403);
  }

  const task = await loadTask(db, taskId);
  if (!task) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  if (creatorMatches(task, actor)) return c.json({ error: 'bad_request', message: 'Cannot claim your own task' }, 400);
  if (task.status !== 'open') return c.json({ error: 'conflict', message: 'Task is not open for claiming' }, 409);
  // Restricted task (task_claim_allowlist): friendly refusal here; the
  // authoritative re-check is inside the atomic claim gate below.
  if (!(await claimAllowedFor(db, taskId, agentId))) {
    return c.json({ error: 'worker_ineligible', message: 'This task is restricted to a pre-approved worker pool.' }, 403);
  }
  if (task.escrow && task.escrow_status !== 'funded') {
    return c.json({
      error: 'escrow_not_funded',
      message: task.escrow_status === 'funding'
        ? "This task's bounty deposit is still settling into escrow; try again in a moment."
        : "This task's bounty deposit has not settled into escrow; it cannot be claimed until the buyer funds it.",
      escrow: escrowView(task),
    }, 409);
  }

  // A bounty is paid to the claimer's wallet at accept time — require it now,
  // so a buyer never faces a deliverer who cannot be paid.
  if (task.bounty_amount) {
    const wallet = await db.get<{ wallet_address: string | null; wallet_network: string | null }>(
      'SELECT wallet_address, wallet_network FROM agents WHERE id = ?', agentId,
    );
    if (!wallet?.wallet_address || !WALLET_RE.test(wallet.wallet_address)) {
      return c.json({
        error: 'wallet_required',
        message: 'This task pays a USDC bounty to your wallet. Set one before claiming.',
        help: {
          set_wallet: `PATCH /v1/agents/${agentId}/wallet`,
          body: { wallet_address: '0x...', wallet_network: task.bounty_network, wallet_proof: { message: '<sign_this from the first PATCH>', signature: '0x...' } },
          cli: `npx basedagents wallet set 0x... --network ${task.bounty_network}`,
        },
      }, 409);
    }
    if (wallet.wallet_network && wallet.wallet_network !== task.bounty_network) {
      return c.json({
        error: 'wallet_network_mismatch',
        message: `Your wallet is on ${wallet.wallet_network}; this bounty settles on ${task.bounty_network}.`,
      }, 409);
    }
  }

  // Claim governance advisories (friendly, with numbers); the authoritative
  // enforcement is inside the atomic claim gate below.
  const gov = await claimBudget(db, c.env, agentId);
  if (gov.active_claims >= gov.budget) {
    return c.json({
      error: 'claim_budget_exhausted',
      message: `You hold ${gov.active_claims} active claims of a budget of ${gov.budget}. Deliver (and get accepted) to raise it, let go of stale claims, or post a refundable claim bond.`,
      budget: gov,
      help: { budget: 'GET /v1/agents/me/claim-budget', bond: 'POST /v1/agents/me/claim-bond' },
    }, 429);
  }
  if (task.max_active_claims_per_agent != null) {
    const held = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM tasks p WHERE p.claimed_by_agent_id = ?
         AND p.status IN ('claimed','submitted')
         AND ((? IS NOT NULL AND p.creator_agent_id = ?) OR (? IS NOT NULL AND p.creator_owner_id = ?))`,
      agentId, task.creator_agent_id, task.creator_agent_id, task.creator_owner_id, task.creator_owner_id,
    );
    if ((held?.n ?? 0) >= task.max_active_claims_per_agent) {
      return c.json({
        error: 'campaign_claim_cap',
        message: `This poster caps each agent at ${task.max_active_claims_per_agent} active claim${task.max_active_claims_per_agent === 1 ? '' : 's'} across their tasks; deliver or release one first.`,
        cap: task.max_active_claims_per_agent,
        held: held?.n ?? 0,
      }, 409);
    }
  }
  // Bounty claims put capital at risk: each concurrent bounty claim (claimed
  // or submitted) must be backed by one bonded slot. Advisory here; the
  // authoritative predicate is inside the atomic claim gate.
  if (task.bounty_amount && Number(task.bounty_amount) > 0 && gov.bond_required_for_bounty
      && gov.bounty_claims_active >= gov.bond_slots) {
    return c.json({
      error: 'claim_bond_required',
      message: `Claiming a bounty task requires a refundable claim bond: 1 bonded USDC backs 1 bounty claim, held while the task is claimed or submitted. You have ${gov.bond_slots} bonded slot${gov.bond_slots === 1 ? '' : 's'} and ${gov.bounty_claims_active} bounty claim${gov.bounty_claims_active === 1 ? '' : 's'} in flight. The bond is returned in full when you deliver honestly; it is slashed if you abandon a claim or a deliverable is disputed.`,
      bond_slots: gov.bond_slots,
      bounty_claims_active: gov.bounty_claims_active,
      bond_balance_atomic: gov.bond_balance_atomic,
      help: { bond: 'POST /v1/agents/me/claim-bond', budget: 'GET /v1/agents/me/claim-budget' },
    }, 409);
  }

  const now = new Date().toISOString();
  // Notify the creator's inbox atomically with winning the claim (transactional outbox).
  const creator = await creatorTarget(db, task);
  const claimed = await claimGate(db, taskId, agentId, agentSigFromHeader(c), now, {
    recipientAgentId: creator?.id ?? null,
    event: { type: 'task.claimed', agent_id: creator?.id ?? '', task_id: taskId, claimed_by: { agent_id: agentId, name: agent.name } },
  }, c.env);
  if (!claimed) {
    return c.json({ error: 'conflict', message: 'Task is not open for claiming' }, 409);
  }
  await recordFunnel(db, 'task_claimed', taskId, null);
  await captureServerEvent(c, 'task_claimed', {
    has_bounty: !!task.bounty_amount, escrow: !!task.escrow, category: task.category ?? null,
  });

  return c.json({ ok: true, task_id: taskId, status: 'claimed' });
});

/**
 * POST /v1/tasks/:id/deliver — Deliver with a signed receipt (T3)
 */
tasks.post('/:id/deliver', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const taskId = c.req.param('id') as string;
  const db = c.get('db');

  const json = await readJson(c);
  if (!json.ok) return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  const parsed = DeliverTaskSchema.safeParse(json.body);
  if (!parsed.success) {
    return c.json({ error: 'bad_request', message: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const task = await loadTask(db, taskId);
  if (!task) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  if (task.claimed_by_agent_id !== agentId) {
    return c.json({ error: 'forbidden', message: 'Only the assigned agent can deliver' }, 403);
  }
  if (task.status !== 'claimed') {
    return c.json({ error: 'conflict', message: 'Task must be in claimed status to deliver', status: task.status }, 409);
  }

  const now = new Date().toISOString();
  // Pre-generate the receipt id so the creator's task.delivered inbox event can
  // be committed atomically with the deliver gate (transactional outbox), then
  // reused by the receipt write below.
  const receiptId = generatePublicId('rcpt');
  const creator = await creatorTarget(db, task);
  const deliverer = await db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', agentId);
  const delivered = await deliverGate(db, taskId, agentId, now, {
    recipientAgentId: creator?.id ?? null,
    event: {
      type: 'task.delivered', agent_id: creator?.id ?? '', task_id: taskId,
      delivered_by: { agent_id: agentId, name: deliverer?.name ?? '' }, summary: parsed.data.summary, receipt_id: receiptId,
    },
  });
  if (!delivered) {
    return c.json({ error: 'conflict', message: 'Task is no longer claimed by you', status: task.status }, 409);
  }

  const { chain: chainEntry } = await writeDeliveryReceipt(db, taskId, agentId, parsed.data, agentSigFromHeader(c) ?? '', now, receiptId);
  await recordFunnel(db, 'task_delivered', taskId, null);
  await captureServerEvent(c, 'task_delivered', {
    via: 'deliver', submission_type: parsed.data.submission_type,
    has_bounty: !!task.bounty_amount, revision_round: task.revision_count,
  });

  return c.json({
    ok: true,
    receipt_id: receiptId,
    task_id: taskId,
    chain_sequence: chainEntry?.sequence ?? null,
    chain_entry_hash: chainEntry?.entry_hash ?? null,
    status: 'submitted',
    revision_count: task.revision_count,
  });
});

/**
 * POST /v1/tasks/:id/submit — Submit deliverable (legacy, still supported; T3)
 */
tasks.post('/:id/submit', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const taskId = c.req.param('id') as string;
  const db = c.get('db');

  const json = await readJson(c);
  if (!json.ok) return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  const parsed = SubmitDeliverableSchema.safeParse(json.body);
  if (!parsed.success) {
    return c.json({ error: 'bad_request', message: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const task = await loadTask(db, taskId);
  if (!task) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  if (task.claimed_by_agent_id !== agentId) {
    return c.json({ error: 'forbidden', message: 'Only the assigned agent can submit deliverables' }, 403);
  }
  if (task.status !== 'claimed') {
    return c.json({ error: 'conflict', message: 'Task must be in claimed status to submit', status: task.status }, 409);
  }

  const now = new Date().toISOString();
  const creator = await creatorTarget(db, task);
  const submitter = await db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', agentId);
  const submitted = await deliverGate(db, taskId, agentId, now, {
    recipientAgentId: creator?.id ?? null,
    event: {
      type: 'task.submitted', agent_id: creator?.id ?? '', task_id: taskId,
      submitted_by: { agent_id: agentId, name: submitter?.name ?? '' }, summary: parsed.data.summary,
    },
  });
  if (!submitted) {
    return c.json({ error: 'conflict', message: 'Task is no longer claimed by you', status: task.status }, 409);
  }

  const submissionId = generatePublicId('sub');
  try {
    await db.run(
      `INSERT INTO submissions (submission_id, task_id, agent_id, submission_type, content, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      submissionId, taskId, agentId, parsed.data.submission_type, parsed.data.content, parsed.data.summary, now,
    );
  } catch (err) {
    console.error(`[tasks] submission write failed for ${taskId} after the status gate:`, err);
  }
  await recordFunnel(db, 'task_delivered', taskId, null);
  await captureServerEvent(c, 'task_delivered', {
    via: 'submit', submission_type: parsed.data.submission_type,
    has_bounty: !!task.bounty_amount, revision_round: task.revision_count,
  });

  return c.json({ ok: true, submission_id: submissionId, task_id: taskId, status: 'submitted', revision_count: task.revision_count });
});

/**
 * Accept — records acceptance (T4) and, for a bounty task, runs the x402
 * challenge/verify/settle sequence of spec section 2, steps 4-7.
 */
async function handleAccept(c: Ctx, deprecatedAlias: boolean): Promise<Response> {
  const agentId = c.get('agentId') as string;
  const taskId = c.req.param('id') as string;
  const db = c.get('db');
  const actor: Actor = { kind: 'agent', agentId };
  if (deprecatedAlias) c.header('Deprecation', 'true');

  const json = await readJson(c);
  if (!json.ok) return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  const parsed = AcceptBodySchema.safeParse(json.body);
  if (!parsed.success) {
    return c.json({ error: 'bad_request', message: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  const note = parsed.data.note ?? null;
  // D11: an optional rating, stored only once the accept has gone through
  // (a 402 challenge writes nothing; the signed retry carries it again).
  const rating = ratingInputOf(parsed.data);

  const task = await loadTask(db, taskId);
  if (!task) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  if (!creatorMatches(task, actor)) {
    return c.json({
      error: 'forbidden',
      message: task.creator_kind === 'owner'
        ? 'This task is reviewed by the person who posted it'
        : 'Only the task creator can accept deliverables',
    }, 403);
  }
  if (task.status !== 'submitted' && task.status !== 'verified') {
    return c.json({ error: 'invalid_state', message: `Task is ${task.status}; only a submitted task can be accepted`, status: task.status }, 409);
  }

  // A fresh acceptance always starts from `submitted`; a task already
  // `verified` here is an idempotent re-accept (or a payment retry) and must
  // not count as a second acceptance in analytics.
  const wasSubmitted = task.status === 'submitted';
  const acceptedProps = {
    has_bounty: !!task.bounty_amount, escrow: !!task.escrow, revision_count: task.revision_count,
  };

  const now = new Date().toISOString();

  // ─── Escrow task ─── the deposit is already held; the house pays the deliverer (payments/escrow.ts).
  if (task.escrow) {
    if (paymentHeader(c)) {
      return c.json({ error: 'payment_not_expected', message: 'This task is in escrow: the bounty was deposited when it was posted and is released to the deliverer when you accept. Omit the payment header.' }, 400);
    }
    const outcome = await acceptEscrowTask(db, c.env, task, { note, actor, nowIso: now });
    for (const [k, v] of Object.entries(outcome.headers ?? {})) c.header(k, v);
    if (outcome.status !== 200) return c.json(outcome.body, outcome.status);
    const rated = await settleRatingAfterAccept(db, taskId, rating, now);
    if (wasSubmitted) await captureServerEvent(c, 'task_accepted', acceptedProps);
    return c.json({ ...(outcome.body as Record<string, unknown>), ...rated }, 200);
  }

  const alreadyPaidOrInFlight = ['authorized', 'settling', 'settled'].includes(task.payment_status);

  // Idempotent re-accept: nothing to do, nothing to charge (a rating sent with it is still stored).
  if (task.status === 'verified' && (!task.bounty_amount || alreadyPaidOrInFlight)) {
    const rated = await settleRatingAfterAccept(db, taskId, rating, now);
    const body: Record<string, unknown> = { ok: true, task_id: taskId, status: 'verified', accepted_by: task.accepted_by, ...rated };
    if (task.bounty_amount) {
      body.payment_status = task.payment_status;
      if (task.payment_tx_hash) body.payment_tx_hash = task.payment_tx_hash;
    } else {
      body.payment_status = 'none';
    }
    return c.json(body);
  }

  // ─── Unpaid task ───
  if (!task.bounty_amount) {
    if (!(await acceptUnpaidGate(db, taskId, note, null, now))) {
      return c.json({ error: 'conflict', message: 'Task was accepted or cancelled by another action' }, 409);
    }
    const fresh = (await loadTask(db, taskId)) as TaskRow;
    const side = await afterAccept(db, fresh, { acceptedBy: 'creator', by: actor, nowIso: now, paymentStatus: 'none' });
    const rated = await settleRatingAfterAccept(db, taskId, rating, now);
    await captureServerEvent(c, 'task_accepted', acceptedProps);
    return c.json({
      ok: true, task_id: taskId, status: 'verified', accepted_by: 'creator', payment_status: 'none',
      chain_sequence: side.chain?.sequence ?? null, chain_entry_hash: side.chain?.entry_hash ?? null, ...rated,
    });
  }

  // ─── Bounty task ─── (shared money path — see payments/accept.ts)
  const outcome = await acceptBountyTask(db, c.env, task, {
    note, rawHeader: paymentHeader(c) ?? null, actor, nowIso: now,
  });
  for (const [k, v] of Object.entries(outcome.headers ?? {})) c.header(k, v);
  if (outcome.status !== 200) return c.json(outcome.body, outcome.status);
  const rated = await settleRatingAfterAccept(db, taskId, rating, now);
  if (wasSubmitted) await captureServerEvent(c, 'task_accepted', acceptedProps);
  return c.json({ ...(outcome.body as Record<string, unknown>), ...rated }, 200);
}

tasks.post('/:id/accept', agentAuth, (c) => handleAccept(c, false));
/** Deprecated alias of /accept (D5). */
tasks.post('/:id/verify', agentAuth, (c) => handleAccept(c, true));

/**
 * POST /v1/tasks/:id/revision — Creator asks for changes (T6)
 */
tasks.post('/:id/revision', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const taskId = c.req.param('id') as string;
  const db = c.get('db');
  const actor: Actor = { kind: 'agent', agentId };

  const json = await readJson(c);
  if (!json.ok) return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  const parsed = RevisionBodySchema.safeParse(json.body);
  if (!parsed.success) return c.json({ error: 'bad_request', message: 'A note describing the requested changes is required', details: parsed.error.flatten() }, 400);

  const task = await loadTask(db, taskId);
  if (!task) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  if (!creatorMatches(task, actor)) return c.json({ error: 'forbidden', message: 'Only the task creator can request changes' }, 403);
  if (task.status !== 'submitted') return c.json({ error: 'invalid_state', message: 'Only a submitted task can be sent back for changes', status: task.status }, 409);
  if (task.revision_count >= MAX_REVISIONS) return c.json({ error: 'max_revisions', message: `This task already had ${MAX_REVISIONS} revision rounds; accept, dispute or cancel it.` }, 409);

  const now = new Date().toISOString();
  const revisionCount = task.revision_count + 1;
  const revised = await revisionGate(db, taskId, parsed.data.note, now, {
    recipientAgentId: task.claimed_by_agent_id,
    event: { type: 'task.revision_requested', agent_id: task.claimed_by_agent_id ?? '', task_id: taskId, note: parsed.data.note, revision_count: revisionCount },
  });
  if (!revised) {
    return c.json({ error: 'conflict', message: 'Task changed while you were reviewing it' }, 409);
  }
  await recordFunnel(db, 'task_revision_requested', taskId, null);
  await captureServerEvent(c, 'task_revision_requested', {
    revision_count: revisionCount, has_bounty: !!task.bounty_amount,
  });

  return c.json({ ok: true, task_id: taskId, status: 'claimed', review_state: 'revision_requested', revision_count: revisionCount });
});

/**
 * POST /v1/tasks/:id/dispute — Creator disputes the deliverable (T7): freezes
 * auto-accept; resolved by the creator's next action (accept or cancel).
 */
tasks.post('/:id/dispute', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const taskId = c.req.param('id') as string;
  const db = c.get('db');
  const actor: Actor = { kind: 'agent', agentId };

  const json = await readJson(c);
  if (!json.ok) return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  const parsed = DisputeBodySchema.safeParse(json.body);
  if (!parsed.success) return c.json({ error: 'bad_request', message: isRatingIssue(parsed.error) ? RATING_RULE_MESSAGE : 'A reason is required to dispute a deliverable', details: parsed.error.flatten() }, 400);

  const task = await loadTask(db, taskId);
  if (!task) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  if (!creatorMatches(task, actor)) return c.json({ error: 'forbidden', message: 'Only the task creator can dispute deliverables' }, 403);
  if (task.status !== 'submitted') return c.json({ error: 'invalid_state', message: 'Only a submitted task can be disputed', status: task.status }, 409);
  if (task.disputed_at) return c.json({ error: 'already_disputed', message: 'This deliverable is already disputed', disputed_at: task.disputed_at }, 409);

  const now = new Date().toISOString();
  const rating = ratingInputOf(parsed.data);
  const disputed = await disputeGate(db, taskId, parsed.data.reason, now, {
    recipientAgentId: task.claimed_by_agent_id,
    event: { type: 'task.disputed', agent_id: task.claimed_by_agent_id ?? '', task_id: taskId, reason: parsed.data.reason },
  }, rating);
  if (!disputed) {
    return c.json({ error: 'conflict', message: 'Task changed while you were reviewing it' }, 409);
  }
  await logPaymentEvent(db, taskId, 'disputed', { reason: parsed.data.reason, disputed_by: agentId, payment_status: task.payment_status }, now);
  await recordFunnel(db, 'task_disputed', taskId, null);

  // A disputed BOUNTY deliverable slashes the worker's claim bond (once per
  // task, min(balance, configured slash)); an empty bond never blocks the dispute.
  let bondSlashed = '0';
  if (task.claimed_by_agent_id && task.bounty_amount && Number(task.bounty_amount) > 0) {
    bondSlashed = await slashBondForDisputedClaim(db, c.env, task.claimed_by_agent_id, taskId, now);
  }

  await captureServerEvent(c, 'task_disputed', {
    has_bounty: !!task.bounty_amount, escrow: !!task.escrow,
    revision_count: task.revision_count, bond_slashed: bondSlashed !== '0',
  });

  return c.json({ ok: true, task_id: taskId, status: 'submitted', review_state: 'disputed', disputed_at: now, payment_status: task.payment_status, bond_slashed_atomic: bondSlashed, ...(rating ? { rating: rating.rating } : {}) });
});

/**
 * POST /v1/tasks/:id/cancel — Creator cancels (T8)
 */
tasks.post('/:id/cancel', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const taskId = c.req.param('id') as string;
  const db = c.get('db');
  const actor: Actor = { kind: 'agent', agentId };

  const json = await readJson(c);
  if (!json.ok) return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  const parsed = CancelBodySchema.safeParse(json.body);
  const reason = parsed.success ? parsed.data.reason ?? null : null;

  const task = await loadTask(db, taskId);
  if (!task) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  if (!creatorMatches(task, actor)) return c.json({ error: 'forbidden', message: 'Only the task creator can cancel tasks' }, 403);

  const refusal = cancelRefusal(task);
  if (refusal) {
    const messages: Record<string, string> = {
      already_accepted: 'Accepted work cannot be cancelled',
      dispute_first: 'Delivered work can only be cancelled after a dispute (POST /v1/tasks/:id/dispute)',
      payment_in_flight: 'A payment is authorized or settling for this task; it cannot be cancelled',
      conflict: 'Task cannot be cancelled in its current state',
    };
    return c.json({ error: refusal, message: messages[refusal], status: task.status, payment_status: task.payment_status }, 409);
  }

  const now = new Date().toISOString();
  const cancelled = await cancelGate(db, taskId, now, {
    recipientAgentId: task.claimed_by_agent_id,
    event: { type: 'task.cancelled', agent_id: task.claimed_by_agent_id ?? '', task_id: taskId },
  });
  if (!cancelled) {
    return c.json({ error: 'conflict', message: 'Task changed while you were cancelling it' }, 409);
  }

  if (task.escrow && task.escrow_status === 'funded') {
    // The deposit goes back to the wallet that paid it (house-signed; the cron retries).
    await logPaymentEvent(db, taskId, 'escrow_refund_requested', { reason: 'task_cancelled', cancel_reason: reason }, now);
    await startEscrowLeg(db, c.env, taskId, 'refund', 'cancel', now);
  } else if (task.bounty_amount && ['pending', 'failed'].includes(task.payment_status)) {
    await logPaymentEvent(db, taskId, 'expired', { reason: 'task_cancelled', cancel_reason: reason, ...(task.escrow ? { escrow: true } : {}) }, now);
  }
  if (task.disputed_at && task.claimed_by_agent_id) await recomputeReputation(db, task.claimed_by_agent_id);
  await recordFunnel(db, 'task_cancelled', taskId, null);
  await captureServerEvent(c, 'task_cancelled', {
    status_before: task.status, has_bounty: !!task.bounty_amount,
    escrow: !!task.escrow, was_disputed: !!task.disputed_at,
  });

  const after = await loadTask(db, taskId);
  const body: Record<string, unknown> = { ok: true, task_id: taskId, status: 'cancelled', payment_status: after?.payment_status ?? task.payment_status };
  if (after?.escrow) {
    body.escrow = escrowView(after);
    if (after.escrow_refund_tx_hash) body.refund_tx_hash = after.escrow_refund_tx_hash;
  }
  return c.json(body);
});

export default tasks;
