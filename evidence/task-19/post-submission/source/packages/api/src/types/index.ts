import { z } from 'zod';

// ─── Profile Schema ───

export const SkillSchema = z.object({
  name: z.string().min(1).max(100),
  registry: z.enum(['npm', 'clawhub', 'pypi']).optional().default('npm'),
  version: z.string().max(50).optional(),
  private: z.boolean().optional().default(false),
});

export type DeclaredSkill = z.infer<typeof SkillSchema>;

export const ProfileSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(1000),
  capabilities: z.array(z.string()).min(1),
  protocols: z.array(z.string()).min(1),
  offers: z.array(z.string()).optional(),
  needs: z.array(z.string()).optional(),
  homepage: z.string().url().optional(),
  contact_endpoint: z.string().url().optional(),
  comment: z.string().max(500).optional(),
  organization: z.string().max(100).optional(),
  organization_url: z.string().url().optional(),
  logo_url: z.string().url().optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  version: z.string().max(50).optional(),
  contact_email: z.string().email().optional(),
  x_handle: z.string().max(50).regex(/^@?[A-Za-z0-9_]{1,50}$/).optional(),
  skills: z.array(SkillSchema).max(50).optional(),
  webhook_url: z.union([z.string().url().max(500), z.literal(''), z.null()]).optional(),
});

export type Profile = z.infer<typeof ProfileSchema>;

// ─── Registration Schemas ───

export const RegisterInitSchema = z.object({
  public_key: z.string().min(1),
});

// Must be defined before RegisterCompleteSchema so the enum can reference it (NEW-1)
export const ALLOWED_WALLET_NETWORKS_CONST = [
  'eip155:8453',    // Base mainnet
  'eip155:84532',   // Base Sepolia (testnet)
  'eip155:1',       // Ethereum mainnet
  'eip155:137',     // Polygon
  'eip155:42161',   // Arbitrum One
  'eip155:10',      // Optimism
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',  // Solana mainnet
] as const;

export const RegisterCompleteSchema = z.object({
  challenge_id: z.string().uuid(),
  public_key: z.string().min(1),
  signature: z.string().min(1),
  nonce: z.string().min(1),
  profile: ProfileSchema,
  wallet_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  wallet_network: z.enum(ALLOWED_WALLET_NETWORKS_CONST as unknown as [string, ...string[]]).default('eip155:8453').optional(),
});

// ─── Structured Verification Report ───

export const StructuredReportSchema = z.object({
  // Capability honesty (0-1): did the agent actually do what it claims?
  capability_match: z.number().min(0).max(1).optional(),
  // Tool honesty: did it only use declared tools/skills?
  tool_honesty: z.boolean().optional(),
  // Safety: did it attempt unsafe actions, prompt injection, or data exfiltration?
  safety_issues: z.boolean().optional(),
  // Authorization: did it access data outside declared permissions?
  unauthorized_actions: z.boolean().optional(),
  // Reliability: was behavior consistent across the interaction?
  consistent_behavior: z.boolean().optional(),
  // Resource usage: did it consume excessive tokens or make unexpected calls?
  excessive_resources: z.boolean().optional(),
}).optional();

export type StructuredReport = z.infer<typeof StructuredReportSchema>;

// ─── Verification Schemas ───

export const VerifySubmitSchema = z.object({
  assignment_id: z.string().uuid(),
  target_id: z.string().min(1),
  result: z.enum(['pass', 'fail', 'timeout']),
  response_time_ms: z.number().int().positive().optional(),
  coherence_score: z.number().min(0).max(1).optional(),
  notes: z.string().max(2000).optional(),
  structured_report: StructuredReportSchema,
  // Anti-replay: client-generated nonce (UUID). Stored and checked for uniqueness.
  nonce: z.string().uuid(),
  // Timestamp prevents replay across time windows and is covered by signature (NEW-4)
  timestamp: z.string().datetime(),
  signature: z.string().min(1),
});

// ─── Task Schemas ───

/**
 * A bounty as declared at task creation (Tasks P0, N1). `amount` is a string
 * of ATOMIC USDC units ("5000000" = 5.00 USDC) capped at 1,000 USDC; SDK/CLI/
 * MCP convert human decimals at the edge. Only USDC on Base (mainnet or
 * Sepolia) is accepted — the facilitator supports exactly these.
 */
export const BOUNTY_NETWORKS = ['eip155:8453', 'eip155:84532'] as const;
export const BountySchema = z.object({
  amount: z.string().regex(/^[1-9][0-9]{0,9}$/, 'atomic USDC units, digits only')
    // The regex issue is still collected when this runs, so guard the BigInt.
    .refine((v) => !/^[0-9]+$/.test(v) || BigInt(v) <= 1_000_000_000n, 'bounty exceeds 1,000 USDC'),
  token: z.literal('USDC').default('USDC'),
  network: z.enum(BOUNTY_NETWORKS).default('eip155:8453'),
});

export type Bounty = z.infer<typeof BountySchema>;

/**
 * Bounty networks accepted in THIS environment. Production settles real money
 * (custodial escrow or sign-at-accept), so it accepts mainnet USDC only
 * (`eip155:8453`); staging/dev/tests keep the testnet (Base Sepolia) so the
 * deposit/release path can be QA'd without real funds. Keyed on the ENVIRONMENT
 * var. Callers gate task creation, the escrow deposit, accept/settle and the
 * public board on this, so testnet USDC never poses as real money in prod.
 */
export function allowedBountyNetworks(env: { ENVIRONMENT?: string } | undefined | null): readonly string[] {
  return env?.ENVIRONMENT === 'production' ? ['eip155:8453'] : BOUNTY_NETWORKS;
}

/**
 * The optional rating a poster may attach when accepting or disputing a
 * delivery (decision D11): an integer 1–5, plus an optional short comment
 * that needs a rating. Both are public on the task. Spread into the accept /
 * dispute body schemas; `withRatingRule` adds the comment-needs-rating check.
 */
export const RatingFields = {
  rating: z.number().int().min(1).max(5).optional(),
  rating_comment: z.string().trim().max(500).optional(),
};
export function withRatingRule<T extends z.ZodTypeAny>(schema: T) {
  return schema.refine(
    (b: { rating?: number; rating_comment?: string }) => !b.rating_comment || b.rating !== undefined,
    { message: 'rating_comment needs a rating (1-5)', path: ['rating_comment'] },
  );
}
/** The 400 message for an accept/dispute body the rating fields made invalid. */
export const RATING_RULE_MESSAGE = 'rating must be an integer from 1 to 5; rating_comment (up to 500 characters) needs a rating';
/** True when a failed parse failed on the rating fields (so the error can name them, not the other field). */
export function isRatingIssue(error: z.ZodError): boolean {
  return error.issues.some((i) => i.path[0] === 'rating' || i.path[0] === 'rating_comment');
}
/** The stored form of a parsed rating: null when the body carried none. */
export function ratingInputOf(b: { rating?: number; rating_comment?: string }): { rating: number; comment: string | null } | null {
  return b.rating === undefined ? null : { rating: b.rating, comment: b.rating_comment ? b.rating_comment : null };
}

export const CreateTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(10000),
  category: z.enum(['research', 'code', 'content', 'data', 'automation']).optional(),
  required_capabilities: z.array(z.string()).optional(),
  expected_output: z.string().max(2000).optional(),
  output_format: z.enum(['json', 'link']).default('json'),
  bounty: BountySchema.optional(),
  /**
   * Escrow (Tasks P1): deposit the bounty into the registry's house wallet
   * when posting; it is released to the deliverer on acceptance and refunded
   * on cancellation. Omitted → ON whenever the registry has escrow enabled;
   * `false` keeps the sign-at-accept flow (the buyer pays wallet-to-wallet
   * when accepting). Ignored without a `bounty`.
   */
  escrow: z.boolean().optional(),
  /**
   * Campaign cap (migration 0044): one agent may hold at most this many
   * claimed-or-submitted tasks FROM THIS POSTER at a time. Omitted = no
   * per-campaign cap (the global per-agent claim budget still applies).
   */
  max_active_claims_per_agent: z.number().int().min(1).max(1000).optional(),
  /**
   * Open window (decision D13, 0047): days an unclaimed task stays `open`
   * before the cron expires it. Omitted = the deployment default (7).
   * Regular posters: 1–90. House accounts (HOUSE_ACCOUNT_IDS) may exceed the
   * cap, and 0 = never expire (standing tasks like the "[First task]" slots).
   * The route enforces the policy (tasks/expiry.ts); out of range answers
   * 400 `expiry_window_not_allowed`.
   */
  expires_in_days: z.number().int().min(0).max(3650).optional(),
});

export const SubmitDeliverableSchema = z.object({
  submission_type: z.enum(['json', 'link']),
  content: z.string().min(1).max(50000),
  summary: z.string().min(1).max(2000),
});

/** Links in a delivery are rendered as anchors in the buyer's console: http(s) only, never javascript:/data:. */
const HttpUrl = z.string().url().max(2048).refine((u) => /^https?:\/\//i.test(u), { message: 'must be an http(s) URL' });

export const DeliverTaskSchema = z.object({
  summary: z.string().min(1).max(2000),
  artifact_urls: z.array(HttpUrl).max(20).optional(),
  commit_hash: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  pr_url: HttpUrl.optional(),
  submission_type: z.enum(['json', 'link', 'pr']),
  submission_content: z.string().max(50000).optional(),
});

export const TaskQuerySchema = z.object({
  status: z.enum(['open', 'claimed', 'submitted', 'verified', 'closed', 'cancelled', 'expired', 'all']).optional(),
  category: z.enum(['research', 'code', 'content', 'data', 'automation']).optional(),
  capability: z.string().optional(),
  creator: z.string().max(64).optional(),
  claimer: z.string().max(64).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});

// ─── Task Types ───

/**
 * Payment lifecycle of a bounty task (Tasks P0, N2):
 *   none       no bounty
 *   pending    bounty declared, no authorization yet (sign-at-accept), or —
 *              on an escrow task — the deposit is held and the payout leg
 *              has not started
 *   authorized an EIP-3009 authorization was verified (the buyer's at accept
 *              time, or at post time for an escrow deposit; the house
 *              wallet's for an escrow release / refund)
 *   settling   a settle call is in flight / the facilitator reported pending
 *   settled    on-chain transfer to the deliverer confirmed by the facilitator
 *   failed     last settle attempt failed (retryable when settle_next_at is set)
 *   expired    authorization expired or the bounty was voided by a cancel
 *   refunded   escrow only: the deposit went back to the buyer on-chain
 * On an escrow task the columns describe the CURRENT leg (tasks.escrow_leg:
 * deposit | release | refund) and `escrow_status` carries the custody state.
 * `disputed` is never written any more and stays only so old rows/clients
 * type-check; a dispute is a task flag (tasks.disputed_at).
 */
export type PaymentStatus = 'none' | 'pending' | 'authorized' | 'settling' | 'settled' | 'failed' | 'expired' | 'disputed' | 'refunded';

export const TASK_STATUSES = ['open', 'claimed', 'submitted', 'verified', 'closed', 'cancelled', 'expired'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Task {
  task_id: string;
  /** NULL when a human owner posted the task (creator_kind = 'owner'). */
  creator_agent_id: string | null;
  creator_kind: 'agent' | 'owner';
  claimed_by_agent_id: string | null;
  title: string;
  description: string;
  category: string | null;
  required_capabilities: string | null; // JSON array
  expected_output: string | null;
  output_format: string;
  status: 'open' | 'claimed' | 'submitted' | 'verified' | 'closed' | 'cancelled' | 'expired';
  created_at: string;
  claimed_at: string | null;
  submitted_at: string | null;
  verified_at: string | null;
  // Payment fields
  bounty_amount: string | null;
  bounty_token: string | null;
  bounty_network: string | null;
  payment_signature: string | null;
  payment_verified: number;
  payment_settled: number;
  payment_tx_hash: string | null;
  payment_expires_at: string | null;
  auto_release_at: string | null;
  payment_status: PaymentStatus;
}

export interface PaymentEvent {
  id: string;
  task_id: string;
  event_type: string;
  details: string | null;
  created_at: string;
}

/**
 * PATCH /v1/agents/:id/wallet. Setting or changing the address or network
 * needs `wallet_proof` (decision D8, wallets/bind.ts): the bind message and a
 * signature from the wallet over it. `wallet_address: null` clears the wallet
 * and needs no proof.
 */
export const WalletProofSchema = z.object({
  message: z.string().min(1).max(1000),
  // Up to 8 KB: an ERC-6492 signature carries the smart wallet's deployment call.
  signature: z.string().regex(/^0x(?:[0-9a-fA-F]{2}){65,8192}$/, '0x-prefixed hex signature, whole bytes'),
});
export const WalletUpdateSchema = z.object({
  wallet_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/).nullable().optional(),
  wallet_network: z.enum(ALLOWED_WALLET_NETWORKS_CONST).optional(),
  wallet_proof: WalletProofSchema.optional(),
});

// Re-export under the canonical name for backwards compatibility
export { ALLOWED_WALLET_NETWORKS_CONST as ALLOWED_WALLET_NETWORKS };

export interface Submission {
  submission_id: string;
  task_id: string;
  agent_id: string;
  submission_type: 'json' | 'link';
  content: string;
  summary: string;
  created_at: string;
}

export interface DeliveryReceipt {
  receipt_id: string;
  task_id: string;
  agent_id: string;
  summary: string;
  artifact_urls: string | null;     // JSON array of URLs
  commit_hash: string | null;
  pr_url: string | null;
  submission_type: 'json' | 'link' | 'pr';
  submission_content: string | null;
  completed_at: string;
  chain_sequence: number | null;
  chain_entry_hash: string | null;
  signature: string;
}

// ─── Message Schemas ───

export const SendMessageSchema = z.object({
  type: z.enum(['task_request', 'message']).default('message'),
  // Optional ONLY so replies can omit it (the MCP reply tool sends {body}
  // alone and used to 400) — the refinement below keeps it mandatory for
  // top-level sends, and the reply route derives "Re: <parent.subject>".
  subject: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(10000),
  callback_url: z.string().url().max(500).optional(),
  // The reply route injects the parent id from the URL path before parsing;
  // its presence is what licenses omitting subject (there is a parent to
  // derive from). Top-level sends never set it.
  reply_to_message_id: z.string().min(1).max(64).optional(),
}).superRefine((data, ctx) => {
  if (data.subject === undefined && data.reply_to_message_id === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['subject'],
      message: 'subject is required unless replying to a message',
    });
  }
});

export const MessageQuerySchema = z.object({
  status: z.enum(['pending', 'delivered', 'read', 'replied', 'expired']).optional(),
  type: z.enum(['task_request', 'message']).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
  // Keyset cursor for inbox polling: "everything after the message with this
  // id" (board spec §5). Mutually exclusive with offset in spirit — when
  // present the route switches to keyset mode; offset behavior is unchanged
  // otherwise.
  after_id: z.string().min(1).max(64).optional(),
});

// ─── Board Schemas ───

export const BoardPostSchema = z.object({
  // Same 1..10000 bound as DM bodies (SendMessageSchema) — one mental model
  // for "how much can I say" across private and public messaging.
  body: z.string().min(1).max(10000),
  reply_to_post_id: z.string().min(1).max(64).optional(),
});

export const BoardListQuerySchema = z.object({
  // after/before are opaque base64url(seq) cursors; the route decodes them
  // (a forged cursor 400s there — length is the only zod concern).
  after: z.string().min(1).max(64).optional(),
  before: z.string().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  author: z.string().min(1).max(64).optional(),
  certified_only: z.boolean().optional(),
  thread: z.string().min(1).max(64).optional(),
});

// ─── Message Types ───

export interface Message {
  id: string;
  from_agent_id: string;
  to_agent_id: string;
  type: 'task_request' | 'message';
  subject: string;
  body: string;
  status: 'pending' | 'delivered' | 'read' | 'replied' | 'expired';
  callback_url: string | null;
  reply_to_message_id: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

// ─── Agent Types ───

export interface Agent {
  id: string;
  public_key: Uint8Array;
  name: string;
  description: string;
  capabilities: string; // JSON array
  protocols: string;    // JSON array
  offers: string | null;
  needs: string | null;
  homepage: string | null;
  contact_endpoint: string | null;
  comment: string | null;
  organization: string | null;
  organization_url: string | null;
  logo_url: string | null;
  tags: string | null; // JSON array
  version: string | null;
  contact_email: string | null;
  x_handle: string | null;
  skills: string | null; // JSON array of DeclaredSkill
  webhook_url: string | null;
  wallet_address: string | null;
  wallet_network: string | null;
  /** Set when the wallet was bound with a proof of control (D8); NULL for an older, unverified address. */
  wallet_verified_at?: string | null;
  registered_at: string;
  last_seen: string | null;
  status: 'pending' | 'active' | 'suspended';
  reputation_score: number;
  verification_count: number;
}

export interface Verification {
  id: string;
  verifier_id: string;
  target_id: string;
  result: 'pass' | 'fail' | 'timeout';
  response_time_ms: number | null;
  coherence_score: number | null;
  notes: string | null;
  signature: string;
  created_at: string;
}

export interface Challenge {
  id: string;
  agent_id: string;
  challenge_bytes: string;
  status: 'pending' | 'completed' | 'expired';
  created_at: string;
  expires_at: string;
}

export interface ChainEntry {
  sequence: number;
  entry_hash: string;
  previous_hash: string;
  agent_id: string;
  public_key: Uint8Array;
  nonce: string;
  profile_hash: string;
  timestamp: string;
}

// ─── API Response Types ───

export interface ApiError {
  error: string;
  message: string;
}

export interface RegisterInitResponse {
  challenge_id: string;
  challenge: string;
  difficulty: number;
  previous_hash: string;
  expires_at: string;
}

export interface RegisterCompleteResponse {
  agent_id: string;
  status: string;
  chain_sequence: number;
  entry_hash: string;
  message: string;
}

// ─── App Context Variables (set by middleware) ───

import type { DBAdapter } from '../db/adapter.js';

export type Variables = {
  db: DBAdapter;
  agentId: string;
  publicKey: Uint8Array;
  agentStatus: string;
  /**
   * Stable analytics identity for this request — the agent id (ag_…) after
   * AgentSig auth, the owner id (ow_…) on an owner session. Read by
   * lib/posthog.ts; unset means the anonymous fallback.
   */
  posthogDistinctId?: string;
};

// ─── App Bindings (for Cloudflare Workers + local) ───

export type Bindings = {
  /** Optional bounded public task-row projection; SQL remains authoritative. */
  TASK_LIST_PROJECTION_MODE?: 'off' | 'js' | 'rust-fresh' | 'rust-reuse' | 'rust-u128' | 'rust-u128-etag';
  DB?: D1Database;
  ENVIRONMENT?: string;            // 'production' | 'staging' — set per wrangler env (wrangler.toml)
  HOUSE_ACCOUNT_IDS?: string;      // comma-separated agent (ag_…) / owner (ow_…) ids whose paid tasks are labeled `sponsored`
  // WS5 feedback + telemetry. ADMIN_OWNER_IDS: comma-separated owner ids (ow_…) that
  // see the console's admin pages. The notify targets are secrets (wrangler secret put).
  ADMIN_OWNER_IDS?: string;
  FEEDBACK_NOTIFY_EMAIL?: string;
  FEEDBACK_SLACK_WEBHOOK_URL?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  ADMIN_SECRET?: string;
  REGISTRY_SIGNING_KEY?: string;
  REGISTRY_SIGNING_PUBLIC_KEY?: string;
  TWITTER_CONSUMER_KEY?: string;
  TWITTER_CONSUMER_SECRET?: string;
  TWITTER_ACCESS_TOKEN?: string;
  TWITTER_ACCESS_SECRET?: string;
  // x402 payment integration (spec N6: ALL of the first four must be valid or
  // paymentProviderFor(env) is null and paid paths fail closed with 503)
  PAYMENT_ENCRYPTION_KEY?: string; // hex-encoded 32-byte AES-256 key
  CDP_API_KEY_ID?: string;         // CDP API key id (JWT kid/sub)
  CDP_API_KEY_SECRET?: string;     // CDP Ed25519 secret: base64 of 64 bytes (seed ‖ pub)
  TASK_PAYMENTS_ENABLED?: string;  // '1' turns on bounties; absent by default
  X402_FACILITATOR_URL?: string;   // override CDP facilitator base URL (staging/local)
  X402_EIP712_NAME?: string;       // override USDC EIP-712 domain name on eip155:8453
  X402_EIP712_VERSION?: string;    // override USDC EIP-712 domain version on eip155:8453
  // Escrow (Tasks P1): the house wallet that holds bounty deposits. A secp256k1
  // private key (64 hex, optional 0x); escrow is available only when payments
  // are enabled AND this parses. TASK_ESCROW_ENABLED='0' pauses NEW deposits
  // (existing deposits are still released/refunded).
  ESCROW_WALLET_PRIVATE_KEY?: string;
  TASK_ESCROW_ENABLED?: string;
  GITHUB_TOKEN?: string;           // raises GitHub API rate limits for repo scans
  // Board: global uncertified-class write valve, posts/hour (default 2000).
  // The emergency dial for a PoW-identity spam wave — see routes/board.ts.
  BOARD_UNCERT_VALVE_HOURLY?: string;
  // Claim governance (migration 0044, tasks/governance.ts). All optional with
  // safe defaults; see claimGovernanceConfig for ranges.
  CLAIM_BUDGET_BASE?: string;
  CLAIM_BUDGET_MAX?: string;
  CLAIM_BUDGET_FLOOR?: string;
  CLAIM_BUDGET_PER_ACCEPT?: string;
  CLAIM_BUDGET_PENALTY?: string;
  CLAIM_BOND_PER_SLOT_ATOMIC?: string;
  CLAIM_BOND_SLASH_ATOMIC?: string;         // slash on claim expiry
  CLAIM_BOND_SLASH_DISPUTE_ATOMIC?: string; // slash on disputed bounty deliverable
  CLAIM_BOND_REQUIRED?: string;             // '0' disables bond-backed bounty claims (default on)
  // Minimum bounty (decision D3, tasks/bounty-minimum.ts), atomic USDC; default 100000 (0.10) each.
  MIN_BOUNTY_ATOMIC_A2A?: string;           // tasks posted by agents
  MIN_BOUNTY_ATOMIC_HUMAN?: string;         // tasks posted from the console
  // Open-task expiry (decision D13, tasks/expiry.ts): default open window in
  // days before an unclaimed task expires; 7 when unset.
  TASK_OPEN_TTL_DAYS?: string;
  // PostHog product analytics + Error Tracking (lib/posthog.ts). Set per deploy
  // environment as Worker bindings; a missing token is a loud no-op outside
  // production and a silent no-op in production.
  POSTHOG_PROJECT_TOKEN?: string;  // project API token (phc_…)
  POSTHOG_HOST?: string;           // optional; defaults to https://us.i.posthog.com
};

/** Hono env type combining Bindings and Variables */
export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};

// D1Database type stub for when not running on CF
declare global {
  interface D1Database {
    prepare(query: string): D1PreparedStatement;
    batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
    exec(query: string): Promise<D1ExecResult>;
  }
  interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    first<T = unknown>(colName?: string): Promise<T | null>;
    run<T = unknown>(): Promise<D1Result<T>>;
    all<T = unknown>(): Promise<D1Result<T>>;
    raw<T = unknown>(): Promise<T[]>;
  }
  interface D1Result<T = unknown> {
    results: T[];
    success: boolean;
    meta: Record<string, unknown>;
  }
  interface D1ExecResult {
    count: number;
    duration: number;
  }
}
