/**
 * Test helpers for in-memory SQLite database setup and agent creation.
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPublicKey, sign, utils } from '@noble/ed25519';
import { Hono } from 'hono';
import type { AppEnv } from './types/index.js';
import { SQLiteAdapter } from './db/sqlite-adapter.js';
import {
  base58Encode,
  publicKeyToAgentId,
  verifyProofOfWork,
  sha256,
  bytesToHex,
} from './crypto/index.js';

import registerRoutes from './routes/register.js';
import agentRoutes from './routes/agents.js';
import verifyRoutes from './routes/verify.js';
import messageRoutes, { messageActions } from './routes/messages.js';
import eventRoutes from './routes/events.js';
import boardRoutes from './routes/board.js';
import feedRoutes from './routes/feed.js';
import taskRoutes from './routes/tasks.js';
import chainRoutes from './routes/chain.js';
import claimBondRoutes from './routes/claim-bond.js';
import { secp256k1 } from '@noble/curves/secp256k1';
import { freshBindMessage, personalMessageDigest } from './wallets/bind.js';
import { addressFromPrivateKey } from './payments/house-wallet.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const EXTRA_ALTER_STATEMENTS = `
ALTER TABLE agents ADD COLUMN comment TEXT;
ALTER TABLE agents ADD COLUMN organization TEXT;
ALTER TABLE agents ADD COLUMN organization_url TEXT;
ALTER TABLE agents ADD COLUMN logo_url TEXT;
ALTER TABLE agents ADD COLUMN tags TEXT;
ALTER TABLE agents ADD COLUMN version TEXT;
ALTER TABLE agents ADD COLUMN contact_email TEXT;
ALTER TABLE agents ADD COLUMN x_handle TEXT;
ALTER TABLE agents ADD COLUMN skills TEXT;
ALTER TABLE agents ADD COLUMN profile_version INTEGER DEFAULT 1;
ALTER TABLE agents ADD COLUMN safety_flags INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN penalty_score REAL DEFAULT 0.0;
ALTER TABLE agents ADD COLUMN reputation_override REAL;
ALTER TABLE agents ADD COLUMN probe_attempts INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN last_probe_result TEXT;
ALTER TABLE agents ADD COLUMN webhook_url TEXT;
ALTER TABLE agents ADD COLUMN webhook_secret TEXT;
ALTER TABLE verifications ADD COLUMN structured_report TEXT;
ALTER TABLE verifications ADD COLUMN nonce TEXT;
ALTER TABLE chain ADD COLUMN entry_type TEXT DEFAULT 'registration';
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, from_agent_id TEXT NOT NULL, to_agent_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'message', subject TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', callback_url TEXT, reply_to_message_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL, FOREIGN KEY (from_agent_id) REFERENCES agents(id), FOREIGN KEY (to_agent_id) REFERENCES agents(id), FOREIGN KEY (reply_to_message_id) REFERENCES messages(id));
CREATE TABLE IF NOT EXISTS tasks (task_id TEXT PRIMARY KEY, creator_agent_id TEXT REFERENCES agents(id), creator_owner_id TEXT, creator_kind TEXT NOT NULL DEFAULT 'agent' CHECK (creator_kind IN ('agent','owner')), creator_assertion_id TEXT, claimed_by_agent_id TEXT REFERENCES agents(id), title TEXT NOT NULL, description TEXT NOT NULL, category TEXT, required_capabilities TEXT, expected_output TEXT, output_format TEXT DEFAULT 'json', status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','submitted','verified','closed','cancelled','expired')), created_at TEXT NOT NULL, claimed_at TEXT, submitted_at TEXT, verified_at TEXT, accepted_by TEXT CHECK (accepted_by IS NULL OR accepted_by IN ('creator','auto')), review_note TEXT, review_assertion_id TEXT, revision_count INTEGER NOT NULL DEFAULT 0, revision_requested_at TEXT, disputed_at TEXT, cancelled_at TEXT, proposer_signature TEXT, acceptor_signature TEXT, bounty_amount TEXT, bounty_token TEXT, bounty_network TEXT, payment_status TEXT NOT NULL DEFAULT 'none', payment_signature TEXT, payment_requirements TEXT, payment_payer TEXT, payment_nonce TEXT, payment_verified INTEGER NOT NULL DEFAULT 0, payment_settled INTEGER NOT NULL DEFAULT 0, payment_tx_hash TEXT, payment_expires_at TEXT, auto_release_at TEXT, settle_attempts INTEGER NOT NULL DEFAULT 0, settle_broadcast INTEGER NOT NULL DEFAULT 0, settle_started_at TEXT, settle_next_at TEXT, settled_at TEXT, last_settle_error TEXT, last_settle_class TEXT, claim_expires_at TEXT, CHECK ((creator_agent_id IS NULL) <> (creator_owner_id IS NULL)));
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_category ON tasks(category);
CREATE INDEX IF NOT EXISTS idx_tasks_creator ON tasks(creator_agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_claimer ON tasks(claimed_by_agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_claim_expires ON tasks(claim_expires_at);
CREATE TABLE IF NOT EXISTS submissions (submission_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent_id TEXT NOT NULL, submission_type TEXT NOT NULL DEFAULT 'json' CHECK (submission_type IN ('json','link')), content TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL, published_at TEXT, FOREIGN KEY (task_id) REFERENCES tasks(task_id), FOREIGN KEY (agent_id) REFERENCES agents(id));
CREATE INDEX IF NOT EXISTS idx_submissions_task ON submissions(task_id);
CREATE TABLE IF NOT EXISTS delivery_receipts (receipt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent_id TEXT NOT NULL, summary TEXT NOT NULL, artifact_urls TEXT, commit_hash TEXT, pr_url TEXT, submission_type TEXT NOT NULL DEFAULT 'json' CHECK (submission_type IN ('json','link','pr')), submission_content TEXT, completed_at TEXT NOT NULL, chain_sequence INTEGER, chain_entry_hash TEXT, signature TEXT NOT NULL, FOREIGN KEY (task_id) REFERENCES tasks(task_id), FOREIGN KEY (agent_id) REFERENCES agents(id));
CREATE INDEX IF NOT EXISTS idx_receipts_task ON delivery_receipts(task_id);
CREATE INDEX IF NOT EXISTS idx_receipts_agent ON delivery_receipts(agent_id);
CREATE TABLE IF NOT EXISTS used_signatures (signature_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_used_sigs_expires ON used_signatures(expires_at);
CREATE TABLE IF NOT EXISTS verification_assignments (assignment_id TEXT PRIMARY KEY, verifier_agent_id TEXT NOT NULL, target_agent_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, FOREIGN KEY (verifier_agent_id) REFERENCES agents(id), FOREIGN KEY (target_agent_id) REFERENCES agents(id));
CREATE INDEX IF NOT EXISTS idx_assignments_expires ON verification_assignments(expires_at);
ALTER TABLE agents ADD COLUMN wallet_address TEXT;
ALTER TABLE agents ADD COLUMN wallet_network TEXT DEFAULT 'eip155:8453';
CREATE TABLE IF NOT EXISTS skill_cache (id TEXT PRIMARY KEY, registry TEXT NOT NULL, name TEXT NOT NULL, version TEXT, description TEXT, downloads_last_month INTEGER, stars INTEGER, verified INTEGER NOT NULL DEFAULT 0, trust_score REAL NOT NULL DEFAULT 0.0, adoption_score REAL NOT NULL DEFAULT 0.0, last_checked_at DATETIME NOT NULL, UNIQUE(registry, name));
CREATE INDEX IF NOT EXISTS idx_skill_cache_registry ON skill_cache(registry);
CREATE INDEX IF NOT EXISTS idx_skill_cache_verified ON skill_cache(verified);
CREATE TABLE IF NOT EXISTS payment_events (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, event_type TEXT NOT NULL, details TEXT, created_at TEXT NOT NULL, FOREIGN KEY (task_id) REFERENCES tasks(task_id));
CREATE INDEX IF NOT EXISTS idx_payment_events_task ON payment_events(task_id);
CREATE TABLE IF NOT EXISTS rate_limit_log (id TEXT PRIMARY KEY, key TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_rate_limit_key_time ON rate_limit_log(key, created_at);
CREATE TABLE IF NOT EXISTS board_posts (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, author_agent_id TEXT REFERENCES agents(id), author_owner_id TEXT, author_kind TEXT NOT NULL CHECK (author_kind IN ('agent','owner')), assertion_id TEXT, body TEXT NOT NULL, body_sha256 TEXT NOT NULL, reply_to_post_id TEXT REFERENCES board_posts(id), thread_root_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','held','removed')), report_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, deleted_at TEXT, CHECK ((author_agent_id IS NULL) <> (author_owner_id IS NULL)));
CREATE INDEX IF NOT EXISTS idx_board_status_seq ON board_posts(status, seq);
CREATE INDEX IF NOT EXISTS idx_board_author ON board_posts(author_agent_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_board_thread ON board_posts(thread_root_id, seq ASC);
CREATE TABLE IF NOT EXISTS board_reports (post_id TEXT NOT NULL REFERENCES board_posts(id), reporter_agent_id TEXT NOT NULL, reporter_owner_id TEXT, created_at TEXT NOT NULL, PRIMARY KEY (post_id, reporter_agent_id));
ALTER TABLE agents ADD COLUMN name_skeleton TEXT;
CREATE INDEX IF NOT EXISTS idx_agents_skeleton ON agents(name_skeleton);
CREATE INDEX IF NOT EXISTS idx_tasks_payment_status ON tasks(payment_status);
CREATE INDEX IF NOT EXISTS idx_tasks_auto_release ON tasks(auto_release_at);
CREATE INDEX IF NOT EXISTS idx_tasks_creator_owner ON tasks(creator_owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_settle ON tasks(payment_status, settle_next_at);
CREATE INDEX IF NOT EXISTS idx_tasks_payment_settled ON tasks(payment_status, settled_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_payment_nonce ON tasks(payment_nonce) WHERE payment_nonce IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_receipts_task_completed ON delivery_receipts(task_id, completed_at DESC);
ALTER TABLE tasks ADD COLUMN escrow INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN escrow_status TEXT;
ALTER TABLE tasks ADD COLUMN escrow_leg TEXT;
ALTER TABLE tasks ADD COLUMN escrow_leg_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN escrow_wallet TEXT;
ALTER TABLE tasks ADD COLUMN escrow_deposit_payer TEXT;
ALTER TABLE tasks ADD COLUMN escrow_deposit_nonce TEXT;
ALTER TABLE tasks ADD COLUMN escrow_deposit_tx_hash TEXT;
ALTER TABLE tasks ADD COLUMN escrow_funded_at TEXT;
ALTER TABLE tasks ADD COLUMN escrow_release_tx_hash TEXT;
ALTER TABLE tasks ADD COLUMN escrow_released_at TEXT;
ALTER TABLE tasks ADD COLUMN escrow_refund_tx_hash TEXT;
ALTER TABLE tasks ADD COLUMN escrow_refunded_at TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_escrow_sweep ON tasks(escrow_status, status) WHERE escrow = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_escrow_deposit_nonce ON tasks(escrow_deposit_nonce) WHERE escrow_deposit_nonce IS NOT NULL;
CREATE TABLE IF NOT EXISTS funnel_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, funnel_id TEXT, provider TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')));
CREATE INDEX IF NOT EXISTS idx_funnel_events_event ON funnel_events(event, created_at);
CREATE TABLE IF NOT EXISTS agent_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, type TEXT NOT NULL, ref_kind TEXT, ref_id TEXT, actor_id TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT, webhook_state TEXT NOT NULL DEFAULT 'pending' CHECK (webhook_state IN ('pending','sent','failed','skipped')), webhook_attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, delivered_at TEXT);
CREATE INDEX IF NOT EXISTS idx_agent_events_recipient ON agent_events(agent_id, seq);
CREATE INDEX IF NOT EXISTS idx_agent_events_ref ON agent_events(ref_kind, ref_id);
CREATE INDEX IF NOT EXISTS idx_agent_events_unread ON agent_events(agent_id, read_at);
CREATE INDEX IF NOT EXISTS idx_agent_events_outbox ON agent_events(webhook_state, next_attempt_at);
CREATE TABLE IF NOT EXISTS feedback (feedback_id TEXT PRIMARY KEY, agent_id TEXT, scope TEXT NOT NULL CHECK (scope IN ('task','general')), task_id TEXT, environment TEXT NOT NULL, expected_behavior TEXT NOT NULL, actual_behavior TEXT NOT NULL, steps_to_reproduce TEXT NOT NULL, error_codes TEXT, request_ids TEXT, suggested_improvement TEXT, skill_version TEXT, cli_version TEXT, user_agent TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','fixed','wont_fix')), status_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, email_notified_at TEXT, slack_notified_at TEXT, notified_at TEXT);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status, created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_notify ON feedback(notified_at, created_at);
CREATE TABLE IF NOT EXISTS api_usage_daily (day TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT '', cli_version TEXT NOT NULL DEFAULT '', skill_version TEXT NOT NULL DEFAULT '', status INTEGER NOT NULL, error_code TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, agent_id, cli_version, skill_version, status, error_code));
CREATE TABLE IF NOT EXISTS idempotency_keys (scope TEXT NOT NULL, idem_key TEXT NOT NULL, request_hash TEXT NOT NULL, status INTEGER NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (scope, idem_key));
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at);
CREATE TABLE IF NOT EXISTS job_runs (job TEXT NOT NULL, run_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')), attempts INTEGER NOT NULL DEFAULT 1, ran_at TEXT NOT NULL, PRIMARY KEY (job, run_key));
ALTER TABLE tasks ADD COLUMN max_active_claims_per_agent INTEGER;
CREATE TABLE IF NOT EXISTS agent_claim_bonds (agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE, balance_atomic TEXT NOT NULL DEFAULT '0', total_deposited_atomic TEXT NOT NULL DEFAULT '0', total_slashed_atomic TEXT NOT NULL DEFAULT '0', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_claim_bond_events (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('deposit','slash','withdraw','withdraw_reverted')), amount_atomic TEXT NOT NULL, ref TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_bond_events_agent ON agent_claim_bond_events(agent_id, created_at DESC);
CREATE TABLE IF NOT EXISTS agent_claim_bond_withdrawals (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, amount_atomic TEXT NOT NULL, to_address TEXT NOT NULL, to_network TEXT NOT NULL, nonce TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','settled','refunded','failed')), attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, tx_hash TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_bond_withdrawals_due ON agent_claim_bond_withdrawals(state, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_tasks_claimer_status ON tasks(claimed_by_agent_id, status);
ALTER TABLE tasks ADD COLUMN rating INTEGER CHECK (rating BETWEEN 1 AND 5);
ALTER TABLE tasks ADD COLUMN rating_comment TEXT;
ALTER TABLE tasks ADD COLUMN rating_context TEXT CHECK (rating_context IN ('accept', 'dispute'));
ALTER TABLE tasks ADD COLUMN rated_at TEXT;
ALTER TABLE agents ADD COLUMN wallet_verified_at TEXT;
CREATE TABLE IF NOT EXISTS agent_wallet_bindings (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, wallet_address TEXT NOT NULL, wallet_network TEXT NOT NULL, signer_kind TEXT NOT NULL CHECK (signer_kind IN ('eoa', 'erc1271')), message TEXT NOT NULL, signature TEXT NOT NULL, nonce TEXT NOT NULL, bound_at TEXT NOT NULL, unbound_at TEXT, UNIQUE (agent_id, nonce));
CREATE INDEX IF NOT EXISTS idx_wallet_bindings_agent ON agent_wallet_bindings(agent_id, bound_at DESC);
ALTER TABLE tasks ADD COLUMN expires_at TEXT;
ALTER TABLE tasks ADD COLUMN expired_at TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_open_expires ON tasks(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_verifications_created ON verifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_paid_totals ON tasks(payment_status, bounty_network, settled_at, bounty_amount) WHERE payment_status = 'settled' AND bounty_network IN ('eip155:8453') AND settled_at IS NOT NULL AND COALESCE(escrow_status, '') != 'refunded' AND (length(COALESCE(NULLIF(escrow_release_tx_hash, ''), NULLIF(payment_tx_hash, ''))) = 66 AND substr(COALESCE(NULLIF(escrow_release_tx_hash, ''), NULLIF(payment_tx_hash, '')), 1, 2) = '0x' AND NOT (lower(substr(COALESCE(NULLIF(escrow_release_tx_hash, ''), NULLIF(payment_tx_hash, '')), 3)) GLOB '*[^0-9a-f]*'));
`.trim();

/**
 * Create an in-memory SQLite database and return a SQLiteAdapter.
 */
export function setupTestDb(): SQLiteAdapter {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  // Run base schema
  const schemaPath = join(__dirname, 'db', 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  db.exec(schema);

  // Run ALTER TABLE statements for columns added after initial schema.
  // Each is wrapped in a try/catch at DB level — we run them one by one.
  for (const stmt of EXTRA_ALTER_STATEMENTS.split('\n')) {
    const s = stmt.trim();
    if (!s) continue;
    try {
      db.exec(s);
    } catch {
      // Column already exists — ignore
    }
  }

  return new SQLiteAdapter(db);
}

export interface TestKeypair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  agentId: string;
  publicKeyB58: string;
}

/**
 * Generate an Ed25519 keypair for testing.
 */
export async function createTestKeypair(): Promise<TestKeypair> {
  const privateKey = utils.randomPrivateKey();
  const publicKey = await getPublicKey(privateKey);
  const publicKeyB58 = base58Encode(publicKey);
  const agentId = publicKeyToAgentId(publicKey);
  return { publicKey, privateKey, agentId, publicKeyB58 };
}

export interface TestAgentOptions {
  name?: string;
  status?: 'pending' | 'active' | 'suspended';
  reputationScore?: number;
  reputationOverride?: number | null;
  webhookUrl?: string | null;
  capabilities?: string[];
  protocols?: string[];
  /** Override registered_at timestamp (ISO string). Defaults to now. */
  registeredAt?: string;
}

/**
 * Insert a test agent into the database and return the agent ID + keypair.
 */
export async function createTestAgent(
  db: SQLiteAdapter,
  options: TestAgentOptions = {}
): Promise<TestKeypair & { name: string }> {
  const kp = await createTestKeypair();
  const name = options.name ?? `TestAgent-${kp.agentId.slice(3, 10)}`;
  const status = options.status ?? 'active';
  const reputationScore = options.reputationScore ?? 0.5;
  const capabilities = options.capabilities ?? ['code-generation'];
  const protocols = options.protocols ?? ['http'];
  const registeredAt = options.registeredAt ?? new Date().toISOString();

  await db.run(
    `INSERT INTO agents (
      id, public_key, name, description, capabilities, protocols,
      offers, needs, homepage, contact_endpoint,
      comment, organization, organization_url, logo_url, tags, version,
      contact_email, x_handle, skills, webhook_url,
      profile_version, safety_flags, penalty_score,
      reputation_override, probe_attempts, last_probe_result,
      registered_at, status, reputation_score, verification_count
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, ?,
      1, 0, 0.0,
      ?, 0, NULL,
      ?, ?, ?, 0
    )`,
    kp.agentId,
    kp.publicKey,
    name,
    'A test agent',
    JSON.stringify(capabilities),
    JSON.stringify(protocols),
    options.webhookUrl ?? null,
    options.reputationOverride ?? null,
    registeredAt,
    status,
    reputationScore
  );

  return { ...kp, name };
}

/**
 * Make a test agent eligible to be a verifier by satisfying sybil guards:
 * - Set registered_at to 25 hours ago
 * - Insert a dummy received verification (FK disabled for bootstrap verifier)
 */
export async function makeEligibleVerifier(db: SQLiteAdapter, agentId: string): Promise<void> {
  const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  await db.run('UPDATE agents SET registered_at = ? WHERE id = ?', twentyFiveHoursAgo, agentId);
  // Temporarily disable FK to insert a bootstrap verification from a non-existent verifier
  await db.exec('PRAGMA foreign_keys = OFF');
  await db.run(
    `INSERT INTO verifications (id, verifier_id, target_id, result, coherence_score, notes, signature, nonce, created_at)
     VALUES (?, ?, ?, 'pass', 0.9, NULL, 'bootstrap-sig', ?, ?)`,
    `bootstrap-${agentId}`, 'ag_bootstrap', agentId, `bootstrap-nonce-${agentId}`, twentyFiveHoursAgo
  );
  await db.exec('PRAGMA foreign_keys = ON');
}

/**
 * Create a properly signed AgentSig request.
 * Returns headers { Authorization, 'X-Timestamp', 'X-Nonce' }.
 * Includes a random nonce to make signatures non-deterministic (L1).
 */
export async function signRequest(
  keypair: TestKeypair,
  method: string,
  path: string,
  body: string = ''
): Promise<{ Authorization: string; 'X-Timestamp': string; 'X-Nonce': string }> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();
  const bodyHash = bytesToHex(sha256(new TextEncoder().encode(body)));
  const message = `${method}:${path}:${timestamp}:${bodyHash}:${nonce}`;
  const messageBytes = new TextEncoder().encode(message);
  const sigBytes = await sign(messageBytes, keypair.privateKey);
  const base64Sig = btoa(String.fromCharCode(...sigBytes));
  return {
    Authorization: `AgentSig ${keypair.publicKeyB58}:${base64Sig}`,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
  };
}

/**
 * Solve proof-of-work for a public key at given difficulty.
 */
export function solvePoW(publicKey: Uint8Array, difficulty: number): string {
  let nonce = 0n;
  while (true) {
    // Convert nonce to hex string
    const hexNonce = nonce.toString(16).padStart(16, '0');
    if (verifyProofOfWork(publicKey, hexNonce, difficulty)) {
      return hexNonce;
    }
    nonce++;
  }
}

/**
 * Create a Hono app for testing with an injected in-memory DB.
 *
 * `extraEnv` overlays additional env bindings (e.g. the board's
 * BOARD_UNCERT_VALVE_HOURLY dial) — tests that exercise env-driven behavior
 * pass a tiny threshold instead of generating production-scale traffic.
 */
export function createTestApp(db: SQLiteAdapter, extraEnv: Partial<AppEnv['Bindings']> = {}) {
  const app = new Hono<AppEnv>();

  // Inject DB + env bindings via middleware
  app.use('*', async (c, next) => {
    c.set('db', db);
    // Provide env bindings so c.env.* doesn't crash
    (c.env as AppEnv['Bindings']) = {
      ...(c.env ?? {}),
      PAYMENT_ENCRYPTION_KEY: 'a'.repeat(64), // test key for payment encryption
      // Bond-backed bounty claims are ON in production; the harness turns them
      // off so suites about other mechanics need no bond fixtures. Governance
      // tests re-enable with CLAIM_BOND_REQUIRED: '1'.
      CLAIM_BOND_REQUIRED: '0',
      ...extraEnv,
    };
    await next();
  });

  app.route('/v1/register', registerRoutes);
  app.route('/v1/agents', claimBondRoutes);
  app.route('/v1/agents', agentRoutes);
  app.route('/v1/verify', verifyRoutes);
  app.route('/v1/agents', messageRoutes);
  app.route('/v1/agents', eventRoutes);
  app.route('/v1/messages', messageActions);
  app.route('/v1/board', boardRoutes);
  app.route('/v1/board', feedRoutes);
  app.route('/v1/tasks', taskRoutes);
  app.route('/v1/chain', chainRoutes);

  return app;
}

/** Public test keys (Hardhat accounts #0 and #1) for payout-wallet proofs. */
export const TEST_WALLET_KEYS = {
  a: 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  b: '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
} as const;

/** EIP-191 personal_sign of `message` with a hex secp256k1 key (0x-prefixed, v = 27/28). */
export function personalSign(message: string, pkHex: string): string {
  const sig = secp256k1.sign(personalMessageDigest(message), pkHex.replace(/^0x/, ''), { lowS: true });
  const rs = Array.from(sig.toCompactRawBytes(), (b) => b.toString(16).padStart(2, '0')).join('');
  return '0x' + rs + (27 + sig.recovery).toString(16);
}

/**
 * A PATCH /v1/agents/:id/wallet body that proves control of `pkHex`'s address
 * (decision D8): the fresh bind message, signed by that key.
 */
export function walletBindBody(agentId: string, pkHex: string = TEST_WALLET_KEYS.a, network = 'eip155:8453', now?: Date) {
  const address = addressFromPrivateKey(Uint8Array.from(pkHex.replace(/^0x/, '').match(/../g)!.map((h) => parseInt(h, 16))));
  const message = freshBindMessage(agentId, address, network, now);
  return { wallet_address: address, wallet_network: network, wallet_proof: { message, signature: personalSign(message, pkHex) } };
}
