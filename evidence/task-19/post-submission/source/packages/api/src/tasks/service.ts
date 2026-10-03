/**
 * Task lifecycle service — the ONE place every task state transition lives.
 *
 * Rules (CONTROL_PLANE.md "single atomic conditional writes"):
 *   * A transition is ONE `UPDATE … WHERE status = <expected>` whose
 *     `changes === 1` is the gate. The SELECT a route does beforehand only
 *     serves 404/403 and webhook targets — it is NEVER the gate. Two callers
 *     racing for the same transition get exactly one winner (D1 has no
 *     transactions, so this is the only concurrency primitive we have).
 *   * Side effects (chain entries, webhooks, reputation, funnel) run only
 *     after the gate reports a win, and are best-effort: a webhook that fails
 *     never rolls back a state change that already committed.
 *   * `tasks.status` is written ONLY by the T-transitions below; the payment
 *     side (`payment_status`, see payments/settle.ts) never writes `status`.
 *
 * Two creator families share this file: agent creators (AgentSig routes in
 * routes/tasks.ts) and human owners (cookie-session routes in control/). The
 * `Actor` discriminant carries which one is acting; `creatorMatches` is the
 * single authorization predicate both route families use.
 */
import type { DBAdapter } from '../db/adapter.js';
import type { PaymentStatus, TaskStatus } from '../types/index.js';
import { computeChainHash, GENESIS_HASH, sha256, bytesToHex, canonicalJsonStringify } from '../crypto/index.js';
import { fireWebhook, type WebhookEvent } from '../lib/webhooks.js';
import { gateWithEvent, recordEvent } from '../events/service.js';
import { claimBudget, claimGovernanceConfig, claimWindowMsForBounty } from './governance.js';
import { computeReputation } from '../reputation/calculator.js';
import { generatePublicId } from '../lib/ids.js';
import { atomicToDisplay } from '../payments/x402.js';
import { sanitizeDisplayName } from '../lib/display-name.js';
import { certificationTablesPresent, certifiedExistsSql, ownerCertifiedExistsSql } from '../control/certification.js';

export type Actor = { kind: 'agent'; agentId: string } | { kind: 'owner'; ownerId: string };

/** The tasks row after migration 0035. */
export interface TaskRow {
  task_id: string;
  creator_agent_id: string | null;
  creator_owner_id: string | null;
  creator_kind: 'agent' | 'owner';
  creator_assertion_id: string | null;
  claimed_by_agent_id: string | null;
  title: string;
  description: string;
  category: string | null;
  required_capabilities: string | null;
  expected_output: string | null;
  output_format: string;
  status: TaskStatus;
  created_at: string;
  claimed_at: string | null;
  submitted_at: string | null;
  verified_at: string | null;
  accepted_by: 'creator' | 'auto' | null;
  review_note: string | null;
  review_assertion_id: string | null;
  revision_count: number;
  revision_requested_at: string | null;
  disputed_at: string | null;
  cancelled_at: string | null;
  proposer_signature: string | null;
  acceptor_signature: string | null;
  bounty_amount: string | null;
  bounty_token: string | null;
  bounty_network: string | null;
  payment_status: PaymentStatus;
  payment_signature: string | null;
  payment_requirements: string | null;
  payment_payer: string | null;
  payment_nonce: string | null;
  payment_verified: number;
  payment_settled: number;
  payment_tx_hash: string | null;
  payment_expires_at: string | null;
  auto_release_at: string | null;
  /** Claim-delivery timer: a `claimed` task past this returns to `open` (cron). Cleared on delivery/cancel. */
  claim_expires_at: string | null;
  /** Campaign cap (migration 0044): max claimed+submitted per agent across this poster's tasks; NULL = uncapped. */
  max_active_claims_per_agent: number | null;
  /** Open window (0047, decision D13): an `open` task past this expires (cron). NULL = never (house standing tasks). */
  expires_at: string | null;
  expired_at: string | null;
  // ─── Optional rating (0045, decision D11) — public, see recordRating ───
  /** 1–5, given by the poster when accepting or disputing; NULL = not rated. */
  rating: number | null;
  rating_comment: string | null;
  /** Which judgment the rating belongs to. */
  rating_context: 'accept' | 'dispute' | null;
  rated_at: string | null;
  settle_attempts: number;
  settle_broadcast: number;
  settle_started_at: string | null;
  settle_next_at: string | null;
  settled_at: string | null;
  last_settle_error: string | null;
  /** Structured outcome class of the last settle attempt (payments/settle.ts SettleClass); the re-auth guard reads THIS, never the free-text error. */
  last_settle_class: string | null;
  // ─── Escrow (0039) — see payments/escrow.ts ───
  /** 1 when the bounty is held by the house wallet between posting and acceptance. */
  escrow: number;
  escrow_status: EscrowStatus | null;
  /** Which transfer the payment_* / settle_* columns currently describe. */
  escrow_leg: EscrowLeg | null;
  escrow_leg_attempts: number;
  escrow_wallet: string | null;
  escrow_deposit_payer: string | null;
  escrow_deposit_nonce: string | null;
  escrow_deposit_tx_hash: string | null;
  escrow_funded_at: string | null;
  escrow_release_tx_hash: string | null;
  escrow_released_at: string | null;
  escrow_refund_tx_hash: string | null;
  escrow_refunded_at: string | null;
}

/**
 * Custody state of an escrow task (tasks.escrow_status):
 *   funding    the buyer's deposit is authorized/settling into the house wallet — not claimable yet
 *   unfunded   the deposit definitively failed or expired; the buyer re-funds (POST /fund) or cancels
 *   funded     the house holds the bounty; the task is claimable / in progress / delivered
 *   releasing  accepted; the house→deliverer transfer is authorized/settling
 *   released   the deliverer was paid (escrow_release_tx_hash)
 *   refunding  cancelled; the house→buyer transfer is authorized/settling
 *   refunded   the buyer got the deposit back (escrow_refund_tx_hash)
 */
export type EscrowStatus = 'funding' | 'unfunded' | 'funded' | 'releasing' | 'released' | 'refunding' | 'refunded';
export type EscrowLeg = 'deposit' | 'release' | 'refund';

// ─── Restricted tasks (task_claim_allowlist, 0042) ───
//
// A task that has rows in task_claim_allowlist is claimable only by a listed
// agent. Generic marketplace feature: any creator-side policy can populate the
// table; tasks with no rows behave exactly as before. The check lives INSIDE
// the atomic claim UPDATE, so eligibility is re-verified at the claim boundary,
// not just at read time. Deploys without the table (pre-0042) skip the
// fragment via the same lazy per-isolate probe pattern as certification.

let allowlistPresent: boolean | null = null;

export async function claimAllowlistTablePresent(db: DBAdapter): Promise<boolean> {
  if (allowlistPresent !== null) return allowlistPresent;
  const row = await db.get<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_claim_allowlist'`,
  );
  allowlistPresent = row !== null;
  return allowlistPresent;
}

/** Test-only: reset the per-isolate probe (fresh in-memory DBs per test). */
export function resetClaimAllowlistProbeForTests(): void {
  allowlistPresent = null;
}

/**
 * Whether `agentId` may claim `taskId` under the allowlist: true when the
 * task is unrestricted (no rows) or the agent is listed. Read-side helper for
 * friendly route errors — the authoritative check is inside claimGate.
 */
export async function claimAllowedFor(db: DBAdapter, taskId: string, agentId: string): Promise<boolean> {
  if (!(await claimAllowlistTablePresent(db))) return true;
  const restricted = await db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM task_claim_allowlist WHERE task_id = ?', taskId,
  );
  if (!restricted || restricted.n === 0) return true;
  const listed = await db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM task_claim_allowlist WHERE task_id = ? AND agent_id = ?', taskId, agentId,
  );
  return (listed?.n ?? 0) > 0;
}

/** Buyer review window: a delivered task is auto-accepted after this long (N3). */
export const REVIEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Claim window: a claimed task with no delivery is returned to `open` after this long (cron). */
export const CLAIM_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Max "request changes" rounds per task (D4). */
export const MAX_REVISIONS = 3;

/** Columns that never leave the server (encrypted payload, facilitator bookkeeping, owner ids). */
const PRIVATE_COLUMNS = new Set([
  'payment_signature', 'payment_requirements', 'payment_payer', 'payment_nonce', 'creator_owner_id',
  'creator_assertion_id', 'review_assertion_id',
  'settle_attempts', 'settle_broadcast', 'settle_started_at', 'settle_next_at', 'last_settle_class',
  // escrow bookkeeping folded into `escrow` by publicTaskShape (the buyer's refund address stays private)
  'escrow_status', 'escrow_leg', 'escrow_leg_attempts', 'escrow_wallet', 'escrow_deposit_payer', 'escrow_deposit_nonce',
  'escrow_deposit_tx_hash', 'escrow_funded_at', 'escrow_release_tx_hash', 'escrow_released_at',
  'escrow_refund_tx_hash', 'escrow_refunded_at',
  // JOIN outputs folded into `creator` by publicTaskShape
  'creator_name', 'creator_owner_name', 'creator_certified', 'creator_owner_certified',
  // JOIN output folded into `claimed_by` by publicTaskShape
  'claimer_name',
]);

/**
 * SELECT fragments that resolve the creator (agent or human) with a display
 * name and a LIVE certification badge — the board's authorSqlParts pattern.
 * Without the proprietary control-plane tables (OSS deploys) the owner name
 * and both cert fragments degrade to constants.
 */
export async function creatorSqlParts(db: DBAdapter): Promise<{ columns: string; joins: string }> {
  const present = await certificationTablesPresent(db);
  return {
    columns: `t.*, a.name AS creator_name,
      cl.name AS claimer_name,
      ${present ? 'ow.display_name' : 'NULL'} AS creator_owner_name,
      ${present ? certifiedExistsSql('t.creator_agent_id') : '0'} AS creator_certified,
      ${present ? ownerCertifiedExistsSql('t.creator_owner_id') : '0'} AS creator_owner_certified`,
    joins: `LEFT JOIN agents a ON a.id = t.creator_agent_id LEFT JOIN agents cl ON cl.id = t.claimed_by_agent_id${present ? ' LEFT JOIN owners ow ON ow.id = t.creator_owner_id' : ''}`,
  };
}

export function isoPlus(nowIso: string, ms: number): string {
  return new Date(Date.parse(nowIso) + ms).toISOString();
}

export async function loadTask(db: DBAdapter, taskId: string): Promise<TaskRow | null> {
  return db.get<TaskRow>('SELECT * FROM tasks WHERE task_id = ?', taskId);
}

/** The single creator-authorization predicate for both route families. */
export function creatorMatches(
  task: Pick<TaskRow, 'creator_kind' | 'creator_agent_id' | 'creator_owner_id'>,
  actor: Actor,
): boolean {
  if (actor.kind === 'agent') return task.creator_kind === 'agent' && task.creator_agent_id === actor.agentId;
  return task.creator_kind === 'owner' && task.creator_owner_id === actor.ownerId;
}

export function actorId(actor: Actor): string {
  return actor.kind === 'agent' ? actor.agentId : actor.ownerId;
}

// ─── Audit / telemetry ───

export async function logPaymentEvent(
  db: DBAdapter,
  taskId: string,
  eventType: string,
  details?: Record<string, unknown>,
  nowIso: string = new Date().toISOString(),
): Promise<void> {
  await db.run(
    `INSERT INTO payment_events (id, task_id, event_type, details, created_at) VALUES (?, ?, ?, ?, ?)`,
    generatePublicId('pev'), taskId, eventType, details ? JSON.stringify(details) : null, nowIso,
  );
}

/**
 * Server-side funnel emission (N10). Telemetry never fails a route, and an
 * OSS deploy may not have applied 0028 — hence the swallow.
 */
export async function recordFunnel(db: DBAdapter, event: string, funnelId?: string | null, provider?: string | null): Promise<void> {
  try {
    await db.run('INSERT INTO funnel_events (event, funnel_id, provider) VALUES (?, ?, ?)', event, funnelId ?? null, provider ?? null);
  } catch {
    // telemetry only
  }
}

// ─── Chain ───

function toBytes(pk: unknown): Uint8Array {
  return pk instanceof Uint8Array ? pk : new Uint8Array(Object.values(pk as Record<string, number>));
}

export function hashCanonical(obj: Record<string, unknown>): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJsonStringify(obj))));
}

/**
 * Append a task event to the registry chain, attributed to `agentId`'s key.
 * Retries ×3 on a primary-key collision (two writers computed the same next
 * sequence), re-reading `previous_hash` and the sequence each attempt so the
 * hash link stays intact (N5).
 */
export async function taskChainEntry(
  db: DBAdapter,
  agentId: string,
  entryType: string,
  dataHash: string,
): Promise<{ sequence: number; entry_hash: string }> {
  const agent = await db.get<{ public_key: unknown }>('SELECT public_key FROM agents WHERE id = ?', agentId);
  if (!agent) throw new Error(`chain: agent ${agentId} not found`);
  const pub = toBytes(agent.public_key);
  let lastErr: unknown = new Error('chain: no attempt made');
  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = await db.get<{ sequence: number; entry_hash: string }>(
      'SELECT sequence, entry_hash FROM chain ORDER BY sequence DESC LIMIT 1',
    );
    const previousHash = latest?.entry_hash ?? GENESIS_HASH;
    const nextSeq = (latest?.sequence ?? -1) + 1;
    const now = new Date().toISOString();
    const entryHash = computeChainHash(previousHash, pub, '', dataHash, now);
    try {
      await db.run(
        `INSERT INTO chain (sequence, entry_hash, previous_hash, agent_id, public_key, nonce, profile_hash, timestamp, entry_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        nextSeq, entryHash, previousHash, agentId, pub, '', dataHash, now, entryType,
      );
      return { sequence: nextSeq, entry_hash: entryHash };
    } catch (err) {
      lastErr = err; // PK collision — another writer won this sequence; re-read and retry
    }
  }
  throw lastErr;
}

// ─── Webhooks ───

export interface WebhookTarget { id: string; name: string; webhook_url: string | null; webhook_secret: string | null }

export async function agentTarget(db: DBAdapter, agentId: string | null | undefined): Promise<WebhookTarget | null> {
  if (!agentId) return null;
  return db.get<WebhookTarget>('SELECT id, name, webhook_url, webhook_secret FROM agents WHERE id = ?', agentId);
}

/** Fire-and-forget; `fireWebhook` never throws. Human creators have no webhook. */
export function sendWebhook(target: WebhookTarget | null, event: WebhookEvent): void {
  if (target?.webhook_url) void fireWebhook(target.webhook_url, event, target.webhook_secret);
}

/** Webhook target for the creator — only agent creators can receive one. */
export async function creatorTarget(db: DBAdapter, task: Pick<TaskRow, 'creator_kind' | 'creator_agent_id'>): Promise<WebhookTarget | null> {
  return task.creator_kind === 'agent' ? agentTarget(db, task.creator_agent_id) : null;
}

export async function recomputeReputation(db: DBAdapter, agentId: string | null | undefined): Promise<void> {
  if (!agentId) return;
  try {
    const rep = await computeReputation(agentId, db);
    await db.run('UPDATE agents SET reputation_score = ? WHERE id = ?', rep.final_score, agentId);
  } catch {
    // best-effort
  }
}

// ─── Read shapes (N13) ───

export interface BountyView { amount_atomic: string; amount_display: string; token: string; network: string }

export function bountyView(t: Pick<TaskRow, 'bounty_amount' | 'bounty_token' | 'bounty_network'>): BountyView | null {
  if (!t.bounty_amount) return null;
  return {
    amount_atomic: t.bounty_amount,
    amount_display: /^[0-9]+$/.test(t.bounty_amount) ? atomicToDisplay(t.bounty_amount) : t.bounty_amount,
    token: t.bounty_token ?? 'USDC',
    network: t.bounty_network ?? 'eip155:8453',
  };
}

export function reviewState(t: Pick<TaskRow, 'status' | 'revision_requested_at' | 'disputed_at'>): 'revision_requested' | 'disputed' | null {
  if (t.status === 'claimed' && t.revision_requested_at) return 'revision_requested';
  if (t.status === 'submitted' && t.disputed_at) return 'disputed';
  return null;
}

/**
 * Accepted bounty task still waiting on the BUYER's signature. Never true on an
 * escrow task: the deposit is already held and the house pays out by itself.
 */
export function paymentDue(t: Pick<TaskRow, 'status' | 'payment_status' | 'bounty_amount' | 'escrow'>): boolean {
  if (t.escrow) return false;
  return !!t.bounty_amount && t.status === 'verified' && ['pending', 'failed', 'expired'].includes(t.payment_status);
}

/** The public custody record of an escrow task (null when the task does not use escrow). */
export interface EscrowView {
  status: EscrowStatus;
  /** Which transfer `payment_status` currently describes. */
  leg: EscrowLeg | null;
  /** The house wallet holding (or that held) the deposit. */
  wallet: string | null;
  deposit_tx_hash: string | null;
  funded_at: string | null;
  release_tx_hash: string | null;
  released_at: string | null;
  refund_tx_hash: string | null;
  refunded_at: string | null;
}

export function escrowView(t: TaskRow): EscrowView | null {
  if (!t.escrow) return null;
  return {
    status: t.escrow_status ?? 'funding',
    leg: t.escrow_leg,
    wallet: t.escrow_wallet,
    deposit_tx_hash: t.escrow_deposit_tx_hash,
    funded_at: t.escrow_funded_at,
    release_tx_hash: t.escrow_release_tx_hash,
    released_at: t.escrow_released_at,
    refund_tx_hash: t.escrow_refund_tx_hash,
    refunded_at: t.escrow_refunded_at,
  };
}

/**
 * An open task an agent may claim right now: an escrow task only once its
 * deposit has settled, and never past its open window (the claim gate refuses
 * a lapsed task before the sweep marks it, so the shown value must agree).
 */
export function claimable(t: Pick<TaskRow, 'status' | 'escrow' | 'escrow_status'> & { expires_at?: string | null }): boolean {
  return t.status === 'open' && (!t.escrow || t.escrow_status === 'funded')
    && (!t.expires_at || t.expires_at > new Date().toISOString());
}

/** The public shape of a task row: internals stripped, derived fields added. */
export function publicTaskShape(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!PRIVATE_COLUMNS.has(k)) out[k] = v;
  }
  const t = row as unknown as TaskRow;
  try {
    out.required_capabilities = t.required_capabilities ? JSON.parse(t.required_capabilities) : null;
  } catch {
    out.required_capabilities = null;
  }
  const kind = t.creator_kind ?? 'agent';
  const creatorId = kind === 'owner' ? null : t.creator_agent_id;
  const joined = row as { creator_name?: string | null; creator_owner_name?: string | null; creator_certified?: number; creator_owner_certified?: number };
  out.creator = {
    kind,
    id: creatorId,
    // Truncated display id for cards; the full id (agents only) is `id`.
    short_id: creatorId ? (creatorId.length > 12 ? `${creatorId.slice(0, 12)}…` : creatorId) : null,
    // Sanitized so a display name can never forge the cert badge next to it.
    name: sanitizeDisplayName((kind === 'owner' ? joined.creator_owner_name : joined.creator_name) ?? null),
    cert: kind === 'owner'
      ? (joined.creator_owner_certified === 1 ? 'certified_human' : 'none')
      : (joined.creator_certified === 1 ? 'certified_agent' : 'none'),
  };
  // The agent that claimed the task (claimer/deliverer), shown on the board once
  // a task leaves `open`. `claimed_by_agent_id` is already public; this adds the name.
  const claimerId = t.claimed_by_agent_id ?? null;
  out.claimed_by = claimerId
    ? {
        id: claimerId,
        short_id: claimerId.length > 12 ? `${claimerId.slice(0, 12)}…` : claimerId,
        name: sanitizeDisplayName((row as { claimer_name?: string | null }).claimer_name ?? null),
      }
    : null;
  out.bounty = bountyView(t);
  out.review_state = reviewState(t);
  out.payment_due = paymentDue(t);
  out.escrow = escrowView(t);
  out.claimable = claimable(t);
  return out;
}

export function paymentView(t: TaskRow): Record<string, unknown> {
  return {
    task_id: t.task_id,
    bounty: bountyView(t),
    status: t.payment_status,
    verified: !!t.payment_verified,
    settled: !!t.payment_settled,
    tx_hash: t.payment_tx_hash,
    settled_at: t.settled_at,
    expires_at: t.payment_expires_at,
    auto_release_at: t.auto_release_at,
    accepted_by: t.accepted_by,
    payer: t.payment_payer,
    last_error: t.last_settle_error,
    settle_attempts: t.settle_attempts,
    next_settle_at: t.settle_next_at,
    payment_due: paymentDue(t),
    escrow: escrowView(t),
  };
}

// ─── Gates (one conditional UPDATE each) ───
//
// The five agent-route lifecycle gates accept an optional `notify`: when
// present, the gate UPDATE and the recipient's inbox event are committed in ONE
// transaction (transactional outbox, events/service.ts gateWithEvent) so the
// event exists iff the transition won. Callers that omit `notify` (owner routes,
// cron, the E2E seeder) get the identical bare conditional UPDATE.

/** A recipient agent id + the event to drop in its inbox atomically with the gate. */
export interface GateNotify { recipientAgentId: string | null; event: WebhookEvent | null }

/**
 * T2: open → claimed. The creator can never claim their own task. Arms the
 * claim-delivery timer. When the task is restricted (task_claim_allowlist has
 * rows for it), only a listed agent wins the gate — checked inside the same
 * atomic UPDATE so a revoked listing loses the race, not just the pre-read.
 */
export async function claimGate(db: DBAdapter, taskId: string, agentId: string, acceptorSig: string | null, nowIso: string, notify?: GateNotify, env?: unknown): Promise<boolean> {
  const restrictable = await claimAllowlistTablePresent(db);
  const allowlistPredicate = restrictable
    ? ` AND (NOT EXISTS (SELECT 1 FROM task_claim_allowlist w WHERE w.task_id = tasks.task_id)
         OR EXISTS (SELECT 1 FROM task_claim_allowlist w WHERE w.task_id = tasks.task_id AND w.agent_id = ?))`
    : '';
  // Claim governance (migration 0044): the window scales with the bounty (a
  // $0.10 task is not lockable for a week), the agent's GLOBAL budget bounds
  // how many 'claimed' tasks they hold at once, and the poster's per-campaign
  // cap bounds claimed+submitted across THIS creator's tasks. The counts run
  // inside this single UPDATE, so racing claims cannot both squeeze under a
  // cap. The budget VALUE is read just before — a stale read only ever errs
  // by the one in-flight reputational event, never by concurrent claims.
  const task = await db.get<{ bounty_amount: string | null }>(
    'SELECT bounty_amount FROM tasks WHERE task_id = ?', taskId,
  );
  const budget = (await claimBudget(db, env, agentId)).budget;
  const budgetPredicate =
    ` AND (SELECT COUNT(*) FROM tasks b WHERE b.claimed_by_agent_id = ? AND b.status = 'claimed') < ?`;
  const campaignPredicate =
    ` AND (tasks.max_active_claims_per_agent IS NULL OR (
         SELECT COUNT(*) FROM tasks p WHERE p.claimed_by_agent_id = ?
           AND p.status IN ('claimed','submitted')
           AND ((tasks.creator_agent_id IS NOT NULL AND p.creator_agent_id = tasks.creator_agent_id)
             OR (tasks.creator_owner_id IS NOT NULL AND p.creator_owner_id = tasks.creator_owner_id))
       ) < tasks.max_active_claims_per_agent)`;
  // Capital at risk for BOUNTY claims: one bonded bondPerSlotAtomic backs one
  // concurrent bounty claim, occupied through claimed AND submitted (so a
  // junk-submit does not free the slot — only acceptance or resolution does).
  // Applied only when THIS task pays a bounty; free tasks stay bond-free.
  // Counted inside the same atomic UPDATE for the same race-safety reasons.
  const cfg = claimGovernanceConfig(env);
  const targetHasBounty = !!task?.bounty_amount && /^[0-9]{1,15}$/.test(task.bounty_amount) && Number(task.bounty_amount) > 0;
  const bondPredicate = cfg.bondRequiredForBounty && targetHasBounty
    ? ` AND ((SELECT COUNT(*) FROM tasks bb WHERE bb.claimed_by_agent_id = ?
           AND bb.status IN ('claimed','submitted')
           AND bb.bounty_amount IS NOT NULL AND CAST(bb.bounty_amount AS INTEGER) > 0)
         < (CAST(COALESCE((SELECT balance_atomic FROM agent_claim_bonds WHERE agent_id = ?), '0') AS INTEGER) / CAST(? AS INTEGER)))`
    : '';
  const expiresAt = isoPlus(nowIso, claimWindowMsForBounty(task?.bounty_amount ?? null));
  const params: unknown[] = [agentId, nowIso, expiresAt, acceptorSig, taskId, agentId, nowIso];
  if (restrictable) params.push(agentId);
  params.push(agentId, budget, agentId);
  if (bondPredicate) params.push(agentId, agentId, cfg.bondPerSlotAtomic);
  return gateWithEvent(db, {
    sql: `UPDATE tasks SET claimed_by_agent_id = ?, status = 'claimed', claimed_at = ?, claim_expires_at = ?, acceptor_signature = ?
     WHERE task_id = ? AND status = 'open' AND claimed_by_agent_id IS NULL
       AND (creator_agent_id IS NULL OR creator_agent_id <> ?)
       AND (escrow = 0 OR escrow_status = 'funded')
       AND (expires_at IS NULL OR expires_at > ?)${allowlistPredicate}${budgetPredicate}${campaignPredicate}${bondPredicate}`,
    params,
  }, notify?.recipientAgentId ?? null, notify?.event ?? null, nowIso);
}

/** T3: claimed → submitted, arming the 7-day auto-accept and clearing the claim timer (N3). */
export async function deliverGate(db: DBAdapter, taskId: string, agentId: string, nowIso: string, notify?: GateNotify): Promise<boolean> {
  return gateWithEvent(db, {
    sql: `UPDATE tasks SET status = 'submitted', submitted_at = ?, auto_release_at = ?, claim_expires_at = NULL
     WHERE task_id = ? AND status = 'claimed' AND claimed_by_agent_id = ?`,
    params: [nowIso, isoPlus(nowIso, REVIEW_WINDOW_MS), taskId, agentId],
  }, notify?.recipientAgentId ?? null, notify?.event ?? null, nowIso);
}

/** T4-U: submitted → verified by the creator (unpaid task, or paid task without settlement). */
export async function acceptUnpaidGate(
  db: DBAdapter, taskId: string, note: string | null, assertionId: string | null, nowIso: string,
): Promise<boolean> {
  const res = await db.run(
    `UPDATE tasks SET status = 'verified', verified_at = ?, accepted_by = 'creator',
       review_note = COALESCE(?, review_note), review_assertion_id = ?, auto_release_at = NULL
     WHERE task_id = ? AND status = 'submitted'`,
    nowIso, note, assertionId, taskId,
  );
  return res.changes === 1;
}

/**
 * T5: submitted → verified by the timer; a dispute freezes it. The timer is
 * part of the predicate: a re-delivery made after the cron's SELECT re-arms
 * `auto_release_at` and must get its own 7 days.
 */
export async function autoAcceptGate(db: DBAdapter, taskId: string, nowIso: string): Promise<boolean> {
  const res = await db.run(
    `UPDATE tasks SET status = 'verified', verified_at = ?, accepted_by = 'auto', auto_release_at = NULL
     WHERE task_id = ? AND status = 'submitted' AND disputed_at IS NULL
       AND auto_release_at IS NOT NULL AND auto_release_at <= ?`,
    nowIso, taskId, nowIso,
  );
  return res.changes === 1;
}

/**
 * T6: submitted → claimed (request changes), capped at MAX_REVISIONS. Re-arms the claim timer for the re-delivery.
 * Asking for changes withdraws a dispute, and with it any rating given at dispute time (a submitted task has no other).
 */
export async function revisionGate(db: DBAdapter, taskId: string, note: string, nowIso: string, notify?: GateNotify): Promise<boolean> {
  return gateWithEvent(db, {
    sql: `UPDATE tasks SET status = 'claimed', review_note = ?, revision_count = revision_count + 1,
       revision_requested_at = ?, auto_release_at = NULL, claim_expires_at = ?, disputed_at = NULL,
       rating = NULL, rating_comment = NULL, rating_context = NULL, rated_at = NULL
     WHERE task_id = ? AND status = 'submitted' AND revision_count < ?`,
    params: [note, nowIso, isoPlus(nowIso, CLAIM_WINDOW_MS), taskId, MAX_REVISIONS],
  }, notify?.recipientAgentId ?? null, notify?.event ?? null, nowIso);
}

/**
 * T7: dispute flag on a submitted task; freezes auto-accept, touches no payment column.
 * D11: a rating given with the dispute is written by the same UPDATE, so it can't
 * land after a concurrent revision request has withdrawn the dispute.
 */
export async function disputeGate(
  db: DBAdapter, taskId: string, reason: string, nowIso: string, notify?: GateNotify, rating?: RatingInput | null,
): Promise<boolean> {
  const rated = rating
    ? { sql: `, rating = ?, rating_comment = ?, rating_context = 'dispute', rated_at = ?`, params: [rating.rating, rating.comment, nowIso] }
    : { sql: '', params: [] };
  return gateWithEvent(db, {
    sql: `UPDATE tasks SET disputed_at = ?, review_note = ?, auto_release_at = NULL${rated.sql}
     WHERE task_id = ? AND status = 'submitted' AND disputed_at IS NULL`,
    params: [nowIso, reason, ...rated.params, taskId],
  }, notify?.recipientAgentId ?? null, notify?.event ?? null, nowIso);
}

/** D11: the poster's optional rating of a delivery. Validated by the routes (integer 1–5, comment ≤ 500 chars). */
export interface RatingInput {
  rating: number;
  comment: string | null;
}

const RATING_NOT_SAVED = "The accept went through, but the rating wasn't saved. Send it again with a repeat accept.";
const RATING_NOT_CLEARED = 'The accept went through, but a rating given with the dispute may still show. Accept again to remove it.';

/**
 * After the creator accepts: a rating sent with the accept is stored; an
 * accept without one clears a rating left at dispute time (the dispute is
 * over). A rating given at an earlier accept stays. Ratings are public, like
 * `review_note`, and the agent profile averages them. Called only from the
 * creator's accept routes, never from the auto-accept timer.
 *
 * Never throws: the accept has already happened (and may have paid), so a
 * failed rating write is logged and reported instead of turning a completed
 * accept into an error. Returns the response fields: `{ rating }` when the
 * rating was stored, `{ rating_saved: false, rating_error }` when the rating
 * sent wasn't stored or a dispute-time rating couldn't be removed.
 */
export async function settleRatingAfterAccept(
  db: DBAdapter, taskId: string, input: RatingInput | null, nowIso: string,
): Promise<Record<string, unknown>> {
  try {
    if (!input) {
      await db.run(
        `UPDATE tasks SET rating = NULL, rating_comment = NULL, rating_context = NULL, rated_at = NULL
         WHERE task_id = ? AND status = 'verified' AND rating_context = 'dispute'`,
        taskId,
      );
      return {};
    }
    const res = await db.run(
      `UPDATE tasks SET rating = ?, rating_comment = ?, rating_context = 'accept', rated_at = ?
       WHERE task_id = ? AND status = 'verified'`,
      input.rating, input.comment, nowIso, taskId,
    );
    if (res.changes === 1) return { rating: input.rating };
  } catch (err) {
    console.error(`[tasks] rating write failed for ${taskId} after the accept:`, err);
  }
  return { rating_saved: false, rating_error: input ? RATING_NOT_SAVED : RATING_NOT_CLEARED };
}

/** Ratings an agent received on tasks it delivered: `{ count, average }` (average to one decimal; null when unrated). */
export async function ratingSummary(db: DBAdapter, agentId: string): Promise<{ count: number; average: number | null }> {
  const row = await db.get<{ n: number; avg: number | null }>(
    'SELECT COUNT(rating) AS n, AVG(rating) AS avg FROM tasks WHERE claimed_by_agent_id = ? AND rating IS NOT NULL',
    agentId,
  );
  const count = row?.n ?? 0;
  return { count, average: count && row?.avg != null ? Math.round(row.avg * 10) / 10 : null };
}

/**
 * T8: open|claimed|submitted(disputed) → cancelled (N4). Delivered work can only
 * be cancelled after a dispute; accepted work never; money in flight never.
 * A never-settled bounty is voided (`expired`).
 *
 * Escrow: a FUNDED task keeps its payment columns — the caller starts the
 * refund leg after the gate wins (payments/escrow.ts). A deposit that is
 * still authorized/settling, or that was broadcast and is not yet resolved,
 * blocks the cancel (the money may be landing in the house); a deposit that
 * failed before any broadcast is voided with the task (`unfunded`, no retry).
 */
export async function cancelGate(db: DBAdapter, taskId: string, nowIso: string, notify?: GateNotify): Promise<boolean> {
  return gateWithEvent(db, {
    sql: `UPDATE tasks SET status = 'cancelled', cancelled_at = ?, auto_release_at = NULL, claim_expires_at = NULL,
       payment_status = CASE
         WHEN escrow = 1 AND escrow_status = 'funded' THEN payment_status
         WHEN payment_status IN ('pending','failed','expired') THEN 'expired' ELSE payment_status END,
       escrow_status = CASE WHEN escrow = 1 AND escrow_status = 'funding' THEN 'unfunded' ELSE escrow_status END,
       settle_next_at = CASE WHEN escrow = 1 AND escrow_status = 'funding' THEN NULL ELSE settle_next_at END
     WHERE task_id = ? AND status IN ('open','claimed','submitted')
       AND (status <> 'submitted' OR disputed_at IS NOT NULL)
       AND payment_status NOT IN ('authorized','settling','settled')
       AND NOT (escrow = 1 AND escrow_status = 'funding' AND settle_broadcast = 1)`,
    params: [nowIso, taskId],
  }, notify?.recipientAgentId ?? null, notify?.event ?? null, nowIso);
}

/**
 * T9: claimed → open when the claimer never delivered within the claim window.
 * Returns the task to the pool for anyone to re-claim and clears the previous
 * claimer's context (claim timestamps, acceptor signature, and the review round
 * counters so the next claimer starts fresh). Never touches payment columns —
 * nothing is authorized at claim time, so a bounty stays `pending`. The timer is
 * part of the predicate so a delivery made after the cron's SELECT is not clobbered.
 *
 * `newOpenExpiresAt` re-arms the OPEN window (0047): a week spent claimed by a
 * no-show must not expire the task the moment it returns. A NULL window
 * (never-expiring house task, or a pre-0047 row) stays NULL.
 */
export async function claimExpiryGate(db: DBAdapter, taskId: string, nowIso: string, newOpenExpiresAt: string): Promise<boolean> {
  const res = await db.run(
    `UPDATE tasks SET status = 'open', claimed_by_agent_id = NULL, claimed_at = NULL, acceptor_signature = NULL,
       claim_expires_at = NULL, revision_count = 0, review_note = NULL, revision_requested_at = NULL,
       expires_at = CASE WHEN expires_at IS NULL THEN NULL ELSE ? END
     WHERE task_id = ? AND status = 'claimed'
       AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?`,
    newOpenExpiresAt, taskId, nowIso,
  );
  return res.changes === 1;
}

/**
 * T10 (0047): open → expired when nobody claimed within the open window
 * (cron). Money handling mirrors cancelGate: a FUNDED escrow keeps its
 * payment columns (the caller starts the refund leg), a deposit that was
 * broadcast and is still moving in blocks the sweep until it resolves, a
 * broadcast-less funding deposit is voided (`unfunded`), and a never-settled
 * declared bounty is voided (payment_status `expired`). The window is part of
 * the predicate so a claim racing the sweep wins cleanly.
 */
export async function openExpiryGate(db: DBAdapter, taskId: string, nowIso: string, notify?: GateNotify): Promise<boolean> {
  return gateWithEvent(db, {
    sql: `UPDATE tasks SET status = 'expired', expired_at = ?,
       payment_status = CASE
         WHEN escrow = 1 AND escrow_status = 'funded' THEN payment_status
         WHEN payment_status IN ('pending','failed','expired') THEN 'expired' ELSE payment_status END,
       escrow_status = CASE WHEN escrow = 1 AND escrow_status = 'funding' THEN 'unfunded' ELSE escrow_status END,
       settle_next_at = CASE WHEN escrow = 1 AND escrow_status = 'funding' THEN NULL ELSE settle_next_at END
     WHERE task_id = ? AND status = 'open'
       AND expires_at IS NOT NULL AND expires_at <= ?
       AND payment_status NOT IN ('authorized','settling','settled')
       AND NOT (escrow = 1 AND escrow_status = 'funding' AND settle_broadcast = 1)`,
    params: [nowIso, taskId, nowIso],
  }, notify?.recipientAgentId ?? null, notify?.event ?? null, nowIso);
}

/** Why a cancel would be refused, from the row the route read (maps to 409 codes). */
export function cancelRefusal(
  t: Pick<TaskRow, 'status' | 'disputed_at' | 'payment_status' | 'escrow' | 'escrow_status' | 'settle_broadcast'>,
): 'already_accepted' | 'dispute_first' | 'payment_in_flight' | 'conflict' | null {
  if (t.status === 'verified') return 'already_accepted';
  if (t.status === 'cancelled' || t.status === 'closed' || t.status === 'expired') return 'conflict';
  if (t.escrow) {
    // A funded deposit is refundable; one still moving in is not cancellable until it resolves.
    if (t.escrow_status === 'funding' && (['authorized', 'settling'].includes(t.payment_status) || t.settle_broadcast === 1)) return 'payment_in_flight';
  } else if (['authorized', 'settling', 'settled'].includes(t.payment_status)) {
    return 'payment_in_flight';
  }
  if (t.status === 'submitted' && !t.disputed_at) return 'dispute_first';
  return null;
}

// ─── Side effects after acceptance (shared by route, owner route and cron) ───

export interface AcceptSideEffects {
  chain: { sequence: number; entry_hash: string } | null;
}

/**
 * Runs after a T4/T5 gate won: chain entry attributed to the DELIVERER's key
 * (N5 — owners and the cron have no agent key), deliverer reputation,
 * `task.verified` webhook, funnel. Every step is best-effort.
 */
export async function afterAccept(
  db: DBAdapter,
  task: TaskRow,
  opts: { acceptedBy: 'creator' | 'auto'; by: Actor | { kind: 'auto' }; nowIso: string; paymentStatus: PaymentStatus },
): Promise<AcceptSideEffects> {
  let chain: AcceptSideEffects['chain'] = null;
  const deliverer = task.claimed_by_agent_id;
  if (deliverer) {
    try {
      const dataHash = hashCanonical({
        task_id: task.task_id,
        verified_at: opts.nowIso,
        accepted_by: opts.acceptedBy,
        verified_by_kind: opts.by.kind,
        verified_by_id: opts.by.kind === 'auto' ? null : actorId(opts.by),
      });
      chain = await taskChainEntry(db, deliverer, 'task_verified', dataHash);
    } catch (err) {
      console.error(`[tasks] chain entry failed for ${task.task_id}:`, err);
    }
    await recomputeReputation(db, deliverer);
    await recordEvent(db, deliverer, {
      type: 'task.verified',
      agent_id: deliverer,
      task_id: task.task_id,
      chain_sequence: chain?.sequence ?? null,
      chain_entry_hash: chain?.entry_hash ?? null,
      payment_settled: false,
      payment_tx_hash: null,
      payment_status: opts.paymentStatus,
      accepted_by: opts.acceptedBy,
    }, opts.nowIso);
  }
  await recordFunnel(db, 'task_accepted', task.task_id, opts.acceptedBy);
  return { chain };
}

// ─── Shared write helpers (used by the agent routes, the owner routes and the E2E seeder) ───

export interface NewTaskNotice {
  task_id: string;
  title: string;
  description: string;
  category: string | null;
  required_capabilities: string[] | null;
  output_format: string;
  bounty: BountyView | null;
}

/**
 * `task.available` fan-out to active agents whose capabilities overlap (exact
 * string match). The event is written to each match's inbox regardless of
 * whether it has a webhook_url — an agent no longer has to run an endpoint to
 * be matched to work (the old `webhook_url IS NOT NULL` filter silently
 * excluded webhook-less agents from the marketplace entirely). The cron outbox
 * drainer pushes the webhook for those that do have a URL.
 */
export async function notifyMatchingAgents(db: DBAdapter, task: NewTaskNotice, excludeAgentId: string | null): Promise<void> {
  const reqCaps = task.required_capabilities;
  if (!reqCaps || reqCaps.length === 0) return;
  const nowIso = new Date().toISOString();
  const agents = await db.all<{ id: string; capabilities: string }>(
    `SELECT id, capabilities FROM agents WHERE status = 'active' AND id != ?`,
    excludeAgentId ?? '',
  );
  for (const agent of agents) {
    try {
      const caps: string[] = JSON.parse(agent.capabilities);
      if (reqCaps.some((rc) => caps.includes(rc))) {
        await recordEvent(db, agent.id, {
          type: 'task.available',
          agent_id: agent.id,
          task: {
            task_id: task.task_id,
            title: task.title,
            description: task.description,
            category: task.category,
            required_capabilities: reqCaps,
            output_format: task.output_format,
            bounty: task.bounty,
          },
        }, nowIso);
      }
    } catch {
      // skip agents with invalid capabilities JSON
    }
  }
}

export interface DeliveryFields {
  summary: string;
  artifact_urls?: string[];
  commit_hash?: string;
  pr_url?: string;
  submission_type: 'json' | 'link' | 'pr';
  submission_content?: string;
}

/**
 * After deliverGate won: chain entry (best-effort), receipt row, and the
 * backward-compatible submission row. D1 has no transactions — a failure here
 * leaves `submitted` without a receipt, logged and tolerated by the readers.
 */
export async function writeDeliveryReceipt(
  db: DBAdapter,
  taskId: string,
  agentId: string,
  fields: DeliveryFields,
  signature: string,
  nowIso: string,
  receiptId: string = generatePublicId('rcpt'),
): Promise<{ receipt_id: string; chain: { sequence: number; entry_hash: string } | null }> {
  const receiptPayload: Record<string, unknown> = {
    receipt_id: receiptId,
    task_id: taskId,
    agent_id: agentId,
    summary: fields.summary,
    artifact_urls: fields.artifact_urls ?? null,
    commit_hash: fields.commit_hash ?? null,
    pr_url: fields.pr_url ?? null,
    submission_type: fields.submission_type,
    submission_content: fields.submission_content ?? null,
    completed_at: nowIso,
  };
  let chain: { sequence: number; entry_hash: string } | null = null;
  try {
    chain = await taskChainEntry(db, agentId, 'task_delivered', hashCanonical(receiptPayload));
  } catch (err) {
    console.error(`[tasks] chain entry failed for delivery of ${taskId}:`, err);
  }
  try {
    await db.run(
      `INSERT INTO delivery_receipts (receipt_id, task_id, agent_id, summary, artifact_urls, commit_hash, pr_url, submission_type, submission_content, completed_at, chain_sequence, chain_entry_hash, signature)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      receiptId, taskId, agentId, fields.summary,
      fields.artifact_urls ? JSON.stringify(fields.artifact_urls) : null,
      fields.commit_hash ?? null, fields.pr_url ?? null, fields.submission_type,
      fields.submission_content ?? null, nowIso, chain?.sequence ?? null, chain?.entry_hash ?? null, signature,
    );
    await db.run(
      `INSERT INTO submissions (submission_id, task_id, agent_id, submission_type, content, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      generatePublicId('sub'), taskId, agentId,
      fields.submission_type === 'pr' ? 'link' : fields.submission_type,
      fields.submission_content ?? fields.pr_url ?? fields.summary,
      fields.summary, nowIso,
    );
  } catch (err) {
    console.error(`[tasks] receipt write failed for ${taskId} after the status gate:`, err);
  }
  return { receipt_id: receiptId, chain };
}
