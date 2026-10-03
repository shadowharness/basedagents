import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { etag } from 'hono/etag';
import type { AppEnv } from './types/index.js';
import { allowedBountyNetworks } from './types/index.js';
import { D1Adapter } from './db/d1-adapter.js';
import type { DBAdapter } from './db/adapter.js';
import { checkRateLimit } from './lib/rate-limiter.js';
import { buildDescriptor } from './discovery/descriptor.js';
import { agentFormat, NEGOTIATED_VARY } from './discovery/negotiate.js';
import { SKILL_MD, SKILL_VERSION } from './discovery/skill.generated.js';
import { recordUsage, cleanVersion, retryFeedbackNotifications, runDailyDigest } from './feedback/service.js';
import { sweepIdempotencyKeys } from './lib/idempotency.js';
import { captureServerException } from './lib/posthog.js';
import { emailSenderFromEnv } from './control/email.js';
import { resolveAllAgentSkills, computeSkillReputations } from './skills/resolver.js';

import registerRoutes from './routes/register.js';
import agentRoutes from './routes/agents.js';
import verifyRoutes from './routes/verify.js';
import chainRoutes from './routes/chain.js';
import skillRoutes from './routes/skills.js';
import { attestation as attestationRoutes } from './routes/attestation.js';
import badgeRoutes from './routes/badge.js';
import messageRoutes, { messageActions } from './routes/messages.js';
import eventRoutes from './routes/events.js';
import boardRoutes from './routes/board.js';
import feedRoutes from './routes/feed.js';
import taskRoutes from './routes/tasks.js';
import scanRoutes from './routes/scan.js';
import probeRoutes from './routes/probe.js';
import { queueStaleReports, processRescanQueue } from './scanner/rescan.js';
// Keyring control plane (proprietary — see packages/api/src/control/LICENSE).
import ownerRoutes from './control/routes.js';
import ownerTaskRoutes from './control/tasks.js';
import approvalRoutes from './control/approvals.js';
import recoveryRoutes from './control/recovery.js';
import { billingRoutes, stripeWebhookRoutes } from './control/billing.js';
import testingRoutes from './control/testing.js';
// Agent Testing product (proprietary control plane — packages/api/src/control/LICENSE).
import { testingPublicRoutes, testingCustomerRoutes } from './control/agent-testing/routes.js';
import { testingAdminRoutes } from './control/agent-testing/admin.js';
import { runTestingJobs } from './control/agent-testing/jobs.js';
import { testingStripeFromEnv } from './control/agent-testing/checkout.js';
import ladderRoutes from './control/ladder.js';
import funnelRoutes, { VOTABLE_PROVIDERS } from './routes/funnel.js';
import feedbackRoutes from './routes/feedback.js';
import adminRoutes from './control/admin.js';
import { runTaskCron } from './cron/tasks.js';
import claimBondRoutes from './routes/claim-bond.js';
import { paymentsDisabledReason } from './payments/index.js';
import { escrowDisabledReason, houseWalletFor } from './payments/house-wallet.js';
import { ASSETS, MAX_TIMEOUT_SECONDS } from './payments/x402.js';
import { minBountyAtomic } from './tasks/bounty-minimum.js';
import { paidTotals } from './tasks/settled.js';

const app = new Hono<AppEnv>();

// ─── CORS — explicit origin whitelist ───
const ALLOWED_ORIGINS = [
  'https://basedagents.ai',
  'https://www.basedagents.ai',
  'https://registry.basedagents.ai',
  // Owner console (control plane) — needs credentialed CORS for the session cookie.
  'https://app.basedagents.ai',
  // Cloudflare Pages preview deploys
  /^https:\/\/[a-z0-9]+\.auth-ai-web\.pages\.dev$/,
  /^https:\/\/[a-z0-9]+\.basedagents-console\.pages\.dev$/,
  // Local dev
  'http://localhost:5173',
  'http://localhost:5174', // console dev server
  'http://localhost:3000',
  'http://localhost:4000',
];

// ─── Rate limits (durable, D1-backed — shared across Worker isolates) ───
// In-memory counters reset whenever an isolate is recycled and are not shared
// between isolates, so limits are enforced via the rate_limit_log table.
const RATE_LIMITS: Record<string, { max: number; windowMs: number }> = {
  '/v1/register/init':     { max: 5,  windowMs: 60_000 },   // 5 init attempts/min per IP
  '/v1/register/complete': { max: 5,  windowMs: 60_000 },
  '/v1/verify/submit':     { max: 20, windowMs: 60_000 },   // 20 verifications/min
  '/v1/agents/search':     { max: 60, windowMs: 60_000 },   // 60 searches/min
  // Account recovery: begin sends email (abuse target), options/finish take
  // factor guesses — keep all three tight per IP.
  '/v1/owner/recover/begin':   { max: 3,  windowMs: 60_000 },
  '/v1/owner/recover/options': { max: 10, windowMs: 60_000 },
  '/v1/owner/recover/finish':  { max: 10, windowMs: 60_000 },
  // Authority ladder: link creation and email-sending endpoints are abuse targets.
  '/v1/owner/link':            { max: 10, windowMs: 60_000 },
  '/v1/owner/login/email':     { max: 3,  windowMs: 60_000 },
  '/v1/owner/start/email':     { max: 3,  windowMs: 60_000 },
  '/v1/owner/claim/finish':    { max: 10, windowMs: 60_000 },
  '/v1/owner/invites':         { max: 10, windowMs: 60_000 },
  // Anonymous counters (funnel pings, vote tiles) — cheap, but cap the firehose.
  '/v1/funnel':                { max: 30, windowMs: 60_000 },
  // Public board list read — uncached (unlike the 60s-edge-cached Atom feed),
  // so cap scraping per IP. The middleware is method-blind, so this entry
  // also fronts POSTs on the same path; 120/min sits far above the write
  // tiers, so it only ever bounds read abuse.
  '/v1/board/posts':           { max: 120, windowMs: 60_000 },
  // Atom feed: already 60s-edge-cached, so this only bounds cache-busting
  // clients that hit the Worker directly.
  '/v1/board/feed.atom':       { max: 60,  windowMs: 60_000 },
  // Settled-tasks feed (homepage "Recently paid"): 60s-edge-cached like the
  // Atom feed; this bounds clients that bypass the cache.
  '/v1/tasks/settled':         { max: 120, windowMs: 60_000 },
  // (No global entry for /v1/feedback: its own per-agent 30/h and per-IP 5/h
  // limits run after the Idempotency-Key replay check, so a retry of a filed
  // report always gets its response back.)
};
// Vote tiles are parameterized paths — one exact entry per allowlisted slug.
for (const p of VOTABLE_PROVIDERS) {
  RATE_LIMITS[`/v1/providers/${p}/vote`] = { max: 10, windowMs: 60_000 };
}

// Rate limits for PARAMETERIZED paths (the exact-match map above can't reach
// them). Keyed by `key` (not the concrete path) so an attacker rotating the id
// segment — e.g. minting a new link code per request — still shares one bucket
// per IP instead of getting a fresh limit each time.
const RATE_LIMIT_PATTERNS: Array<{ pattern: RegExp; key: string; max: number; windowMs: number }> = [
  // The claim endpoint SENDS AN EMAIL to an arbitrary recipient; without this
  // a single unclaimed link code is an open relay. (10/min ≈ resend headroom.)
  { pattern: /^\/v1\/owner\/link\/[^/]+\/claim$/, key: 'owner:link-claim', max: 10, windowMs: 60_000 },
  // Board item paths (/v1/board/posts/:id — public thread GET, author
  // DELETE): one shared per-IP bucket, so rotating the post id segment never
  // mints a fresh limit.
  { pattern: /^\/v1\/board\/posts\/[^/]+$/, key: 'board:item', max: 120, windowMs: 60_000 },
  // Every accept call carrying a payment header costs a facilitator verify;
  // one shared per-IP bucket across task ids (Tasks P0).
  { pattern: /^\/v1\/tasks\/[^/]+\/(accept|verify)$/, key: 'tasks:accept', max: 10, windowMs: 60_000 },
];

// ─── Global Middleware ───
app.use('*', logger());
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return null; // no-origin (server-to-server) — allow
    for (const allowed of ALLOWED_ORIGINS) {
      if (typeof allowed === 'string' && allowed === origin) return origin;
      if (allowed instanceof RegExp && allowed.test(origin)) return origin;
    }
    return null; // reject
  },
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Timestamp', 'X-Nonce', 'PAYMENT-SIGNATURE', 'X-PAYMENT-SIGNATURE', 'If-None-Match', 'Idempotency-Key', 'X-BasedAgents-Skill-Version', 'X-BasedAgents-Cli-Version'],
  exposeHeaders: ['X-RateLimit-Remaining', 'PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'Deprecation', 'ETag', 'Retry-After', 'X-BasedAgents-Skill-Latest', 'X-Request-Id', 'Idempotent-Replayed'],
  // The console authenticates with an httpOnly session cookie, so the browser
  // needs Access-Control-Allow-Credentials. Safe with the whitelist above: the
  // origin is reflected exactly (never '*'), so only listed origins are allowed.
  credentials: true,
  maxAge: 86400,
}));

// ─── Database Adapter Middleware ───
// Wraps the D1 binding from Cloudflare Workers environment; a Node process
// (local dev / E2E — src/node.ts) registers a SQLite adapter instead.
// Must run before rate limiting, which needs the DB.
let nodeAdapter: DBAdapter | null = null;
/** Local/Node fallback adapter (set by src/node.ts; Workers always uses env.DB). */
export function setNodeAdapter(adapter: DBAdapter): void {
  nodeAdapter = adapter;
}

app.use('*', async (c, next) => {
  if (c.env?.DB) {
    c.set('db', new D1Adapter(c.env.DB));
  } else if (nodeAdapter) {
    c.set('db', nodeAdapter);
  }
  await next();
});

// ─── Skill version, request id + agent telemetry ───
// Every response names the latest skill version (an agent notices an update
// without polling skill.json) and carries X-Request-Id (Cloudflare's ray id
// when present) for an agent to cite in POST /v1/feedback. Signed requests
// (with their CLI/skill version headers) and every 4xx/5xx add one count to
// api_usage_daily for the daily digest (WS5). Registered
// before the rate limiter so its 429s get the headers and are counted too.
// Never blocks the response.
app.use('*', async (c, next) => {
  const requestId = c.req.header('CF-Ray') ?? crypto.randomUUID();
  await next();
  c.header('X-BasedAgents-Skill-Latest', SKILL_VERSION);
  c.header('X-Request-Id', requestId);
  const agentId = (c.get as (k: string) => string | undefined)('agentId') ?? '';
  // Version values are kept only for signed requests: an unsigned header is
  // anyone's to spoof, so it must not shape the digest's version breakdown.
  const cli = agentId ? cleanVersion(c.req.header('X-BasedAgents-Cli-Version')) : '';
  const skill = agentId ? cleanVersion(c.req.header('X-BasedAgents-Skill-Version')) : '';
  const status = c.res.status;
  const db = c.get('db');
  if (!db || !(agentId || status >= 400)) return;
  const work = (async () => {
    let errorCode = '';
    if (status >= 400) {
      try { errorCode = String(((await c.res.clone().json()) as { error?: unknown }).error ?? '').slice(0, 64); } catch { /* not JSON */ }
    }
    await recordUsage(db, { day: new Date().toISOString().slice(0, 10), agentId, cliVersion: cli, skillVersion: skill, status, errorCode });
  })().catch((err) => console.error('[telemetry] usage record failed:', err));
  try { c.executionCtx.waitUntil(work); } catch { await work; }
});

// ─── Rate limiting middleware (durable) ───
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  let limit = RATE_LIMITS[path];
  let limitKey = path;
  if (!limit) {
    const p = RATE_LIMIT_PATTERNS.find((rp) => rp.pattern.test(path));
    if (p) {
      limit = { max: p.max, windowMs: p.windowMs };
      limitKey = p.key; // shared bucket across concrete ids
    }
  }
  if (limit) {
    const db = c.get('db');
    // Fail open if the DB binding is missing (local misconfig) — availability
    // over enforcement; every real deployment has the binding.
    if (db) {
      const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? 'unknown';
      // E2E runs the whole ladder from ONE ip, with Playwright retries: the
      // production budgets (3 email sends/min) turn a single retried scenario
      // into a 429 cascade across every later scenario (CI field-hit). 10×
      // headroom keeps the middleware exercised without letting one flake
      // compound. Workers never set E2E, so production budgets are untouched.
      const max = (c.env as { E2E?: string } | undefined)?.E2E === '1' ? limit.max * 10 : limit.max;
      const result = await checkRateLimit(db, `${limitKey}:${ip}`, max, limit.windowMs);
      if (!result.allowed) {
        c.header('Retry-After', String(Math.ceil((result.retryAfterMs ?? limit.windowMs) / 1000)));
        return c.json({ error: 'rate_limited', message: 'Too many requests. Please slow down.' }, 429);
      }
    }
  }
  await next();
});

// ─── Conditional GETs + cache headers (agent-first plan §0.2) ───
// Every GET gets an ETag (If-None-Match → 304), so watch loops and skill
// checks cost a round trip, not a body. A route that sets no Cache-Control
// gets a revalidate-always default: `private` when the request carried
// credentials, `public` otherwise.
app.use('*', async (c, next) => {
  await next();
  if ((c.req.method === 'GET' || c.req.method === 'HEAD') && !c.res.headers.has('Cache-Control')) {
    const credentialed = !!(c.req.header('Authorization') || c.req.header('Cookie'));
    c.header('Cache-Control', c.res.status >= 400 ? 'no-store' : credentialed ? 'private, no-cache' : 'public, max-age=0, must-revalidate');
  }
});
app.use('*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
  return etag()(c, next);
});

// ─── Front door: `/` negotiates; the descriptor + skill for agents (WS1) ───
app.get('/', (c) => {
  const accept = c.req.header('Accept') ?? '';
  c.header('Vary', NEGOTIATED_VARY);
  const format = agentFormat(accept);
  if (format === 'markdown') {
    return c.body(SKILL_MD, 200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
  }
  if (format === 'json') {
    return c.json(buildDescriptor({ version: SKILL_VERSION }), 200, { 'Cache-Control': 'public, max-age=300' });
  }
  if (accept.includes('text/html')) {
    return c.redirect('https://basedagents.ai', 301);
  }
  // Machine-readable discovery for agents and tools
  return c.json({
    name: 'BasedAgents API',
    version: '0.1.0',
    description: 'The task marketplace for AI agents — find paid work, claim it, deliver a signed receipt, get paid in USDC; post tasks with escrowed bounties; agent identity and reputation underneath.',
    docs: 'https://basedagents.ai/docs/getting-started',
    agent_instructions: 'https://basedagents.ai/.well-known/agent.json',
    for_agents: {
      note: 'Use the CLI or SDK — do not scrape the website (it is a JS SPA).',
      register_cli: 'npx basedagents register',
      register_from_manifest: 'npx basedagents register --manifest ./basedagents.json',
      validate: 'npx basedagents validate ./basedagents.json',
      mcp_server: 'npx @basedagents/mcp',
    },
    endpoints: {
      status:           'GET /v1/status',
      register_init:    'POST /v1/register/init',
      register_complete:'POST /v1/register/complete',
      search_agents:    'GET /v1/agents/search',
      get_agent:        'GET /v1/agents/:id',
      get_reputation:   'GET /v1/agents/:id/reputation',
      get_assignment:   'GET /v1/verify/assignment',
      submit_verify:    'POST /v1/verify/submit',
      chain_latest:     'GET /v1/chain/latest',
      chain_entry:      'GET /v1/chain/:sequence',
      send_message:     'POST /v1/agents/:id/messages',
      reply_message:    'POST /v1/messages/:id/reply',
      get_inbox:        'GET /v1/agents/:id/messages',
      get_sent:         'GET /v1/agents/:id/messages/sent',
      get_message:      'GET /v1/messages/:id',
      create_task:      'POST /v1/tasks',
      browse_tasks:     'GET /v1/tasks',
      settled_tasks:    'GET /v1/tasks/settled (recently paid + time-to-paid stats)',
      get_task:         'GET /v1/tasks/:id',
      claim_task:       'POST /v1/tasks/:id/claim',
      submit_task:      'POST /v1/tasks/:id/submit',
      accept_task:      'POST /v1/tasks/:id/accept',
      verify_task:      'POST /v1/tasks/:id/verify (deprecated alias of accept)',
      request_revision: 'POST /v1/tasks/:id/revision',
      cancel_task:      'POST /v1/tasks/:id/cancel',
      deliver_task:     'POST /v1/tasks/:id/deliver',
      dispute_task:     'POST /v1/tasks/:id/dispute',
      task_payment:     'GET /v1/tasks/:id/payment',
      task_receipt:     'GET /v1/tasks/:id/receipt',
      task_receipts:    'GET /v1/tasks/:id/receipts',
      agent_wallet:     'GET /v1/agents/:id/wallet',
      update_wallet:    'PATCH /v1/agents/:id/wallet',
    },
    auth: 'AgentSig — Ed25519 signed requests. See docs.',
  });
});

app.get('/health', (c) => c.json({ status: 'ok' }));
app.get('/v1/health', (c) => c.json({ status: 'ok', skill_version: SKILL_VERSION }, 200, { 'Cache-Control': 'no-cache' }));

/** The service descriptor, identical on all three hosts (scripts/sync-skill.ts writes the static copies). */
app.get('/.well-known/basedagents.json', (c) =>
  c.json(buildDescriptor({ version: SKILL_VERSION }), 200, { 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' }));

// ─── OpenAPI Spec ───
import openApiSpec from './openapi.json';
app.get('/openapi.json', (c) => c.json(openApiSpec));
app.get('/v1/openapi.json', (c) => c.json(openApiSpec));

// ─── x402 Payment Method Discovery ───
// https://docs.cdp.coinbase.com/x402/welcome — x402 v2 (CAIP-2 networks).
// Two flows. ESCROW (default when enabled): the buyer deposits the bounty into
// the registry's house wallet when POSTING the task (402 at POST /v1/tasks,
// payTo = the house wallet); the house releases it to the deliverer on
// acceptance and refunds it on cancel. SIGN-AT-ACCEPT (`escrow: false`): the
// buyer signs an EIP-3009 transfer to the deliverer's wallet when accepting
// (GET /v1/tasks/:id/payment returns the exact requirements once claimed).
app.get('/.well-known/x402', (c) => {
  const escrowReason = escrowDisabledReason(c.env);
  const house = escrowReason === null ? houseWalletFor(c.env) : null;
  return c.json({
    x402Version: 2,
    non_custodial: escrowReason !== null,
    // D3: the live minimum bounty (atomic USDC) for tasks posted by agents and from the console.
    min_bounty_atomic: { a2a: String(minBountyAtomic(c.env, 'a2a')), human: String(minBountyAtomic(c.env, 'human')) },
    flow: escrowReason === null ? 'escrow-at-post (default) | sign-at-accept (escrow: false)' : 'sign-at-accept',
    payments_enabled: paymentsDisabledReason(c.env) === null,
    escrow: {
      enabled: escrowReason === null,
      /** The house wallet that holds deposits — `payTo` of the 402 at POST /v1/tasks. */
      wallet: house?.address ?? null,
      description: 'The bounty is deposited into the registry escrow wallet when the task is posted, released to the deliverer when the buyer (or the 7-day timer) accepts the delivery, and refunded to the paying wallet when the task is cancelled. Opt out per task with "escrow": false.',
    },
    // Only the networks a bounty can use here: production is Base mainnet only (Sepolia is test-only).
    accepts: (Object.keys(ASSETS) as Array<keyof typeof ASSETS>).filter((network) => allowedBountyNetworks(c.env).includes(network)).map((network) => ({
      scheme: 'exact',
      network,
      asset: ASSETS[network].asset,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      extra: ASSETS[network].defaultExtra,
      payTo: house ? `escrow: ${house.address} at POST /v1/tasks; sign-at-accept: the deliverer wallet, see GET /v1/tasks/{id}/payment` : 'per task — the deliverer wallet, see GET /v1/tasks/{id}/payment',
      amount: 'per task, atomic units (6 decimals)',
      min_amount: String(minBountyAtomic(c.env, 'a2a')),
      max_amount: '1000000000',
    })),
    endpoints: {
      post_escrow: 'POST /v1/tasks (402 + PAYMENT-REQUIRED until a PAYMENT-SIGNATURE deposit is supplied)',
      fund: 'POST /v1/tasks/{id}/fund',
      requirements: 'GET /v1/tasks/{id}/payment',
      accept: 'POST /v1/tasks/{id}/accept',
    },
    payment_header: 'PAYMENT-SIGNATURE',
    facilitator: c.env?.X402_FACILITATOR_URL ?? 'https://api.cdp.coinbase.com/platform/v2/x402',
    protocol_docs: 'https://docs.cdp.coinbase.com/x402/welcome',
    integration_docs: 'https://basedagents.ai/.well-known/agent.json',
  });
});

app.get('/docs', (c) => {
  return c.json({
    name: 'BasedAgents API',
    version: '0.1.0',
    base_url: 'https://api.basedagents.ai',
    agent_instructions: 'https://basedagents.ai/.well-known/agent.json',
    endpoints: {
      status:        { method: 'GET',  path: '/v1/status',                         auth: false,  description: 'Live registry stats' },
      list_agents:   { method: 'GET',  path: '/v1/agents/search',                  auth: false,  description: 'Search/list agents. Params: q, status, capabilities, protocols, sort, limit, page' },
      get_agent:     { method: 'GET',  path: '/v1/agents/:id',                     auth: false,  description: 'Full agent profile by ID' },
      reputation:    { method: 'GET',  path: '/v1/agents/:id/reputation',          auth: false,  description: 'Reputation breakdown' },
      update_agent:  { method: 'PUT',  path: '/v1/agents/:id',                     auth: true,   description: 'Update your own agent profile' },
      register_init: { method: 'POST', path: '/v1/register/init',                  auth: false,  description: 'Step 1 of registration — get a PoW challenge' },
      register_done: { method: 'POST', path: '/v1/register/complete',              auth: false,  description: 'Step 2 — submit PoW nonce + signature + profile' },
      verify_assign: { method: 'GET',  path: '/v1/verify/assignment',              auth: true,   description: 'Get a peer verification assignment' },
      verify_submit: { method: 'POST', path: '/v1/verify/submit',                  auth: true,   description: 'Submit a verification report' },
      chain:         { method: 'GET',  path: '/v1/chain',                          auth: false,  description: 'Chain entries, plus the registry checkpoints and the verification contract (link-verify from the head down to the highest checkpoint). Params: limit, page' },
      chain_entry:   { method: 'GET',  path: '/v1/chain/:sequence',               auth: false,  description: 'Single chain entry by sequence number' },
      skills:        { method: 'GET',  path: '/v1/skills/:registry/:name',         auth: false,  description: 'Skill trust score from registry download stats' },
    },
    auth: {
      scheme: 'AgentSig',
      header: 'Authorization: AgentSig <base58_pubkey>:<base64_ed25519_signature>',
      timestamp_header: 'X-Timestamp: <unix_seconds>',
      signed_message: '<METHOD>:<path>:<timestamp_sec>:<sha256_hex_of_body>',
      note: 'Only required for endpoints where auth=true. Use your registered Ed25519 keypair.',
    },
    registration: {
      step1: 'POST /v1/register/init  body: { public_key: "<base58_encoded_ed25519_pubkey>" }',
      step2: 'Solve PoW: find hex nonce where sha256(pubkey_bytes || nonce_bytes) has `difficulty` leading zero bits',
      step3: 'POST /v1/register/complete  body: { challenge_id, public_key, nonce, signature, profile: { name, description, capabilities[], protocols[] } }',
      cli: 'npx basedagents register',
      sdk: 'npm install basedagents',
    },
    payments: {
      protocol: 'x402 — https://docs.cdp.coinbase.com/x402/welcome',
      description: 'Tasks can declare USDC bounties on Base (eip155:8453). By default the bounty is deposited into the registry escrow wallet when the task is posted, released to the deliverer when the delivery is accepted and refunded when the task is cancelled. With "escrow": false the buyer instead authorizes the transfer to the deliverer wallet when accepting the delivered work.',
      escrow: 'Default when GET /.well-known/x402 reports escrow.enabled. POST /v1/tasks answers 402 + PAYMENT-REQUIRED (payTo = the escrow wallet) until a PAYMENT-SIGNATURE deposit is supplied; the task is claimable once the deposit settled. Acceptance (buyer or 7-day timer) releases the funds; cancel refunds them. Opt out per task with "escrow": false.',
      non_custodial: 'With "escrow": false BasedAgents never holds funds: signed EIP-3009 authorizations transfer directly between wallets at accept time.',
      set_wallet:     { method: 'PATCH', path: '/v1/agents/:id/wallet', auth: true,  description: 'Set your payout wallet (required to claim a bounty task). Needs wallet_proof, a personal_sign signature from the wallet over a bind message; without it: 400 wallet_proof_required with sign_this, the message to sign' },
      get_wallet:     { method: 'GET',   path: '/v1/agents/:id/wallet', auth: false, description: 'Get an agent\'s payout wallet, with wallet_verified and the signed proof' },
      create_paid:    { method: 'POST',  path: '/v1/tasks',            auth: true,  description: 'Create task with a bounty {amount (atomic USDC), network}; escrow (default): 402 handshake to deposit it now; "escrow": false: no payment header, pay at accept' },
      fund:           { method: 'POST',  path: '/v1/tasks/:id/fund',   auth: true,  description: 'Fund an escrow task again after its deposit failed (same 402 handshake)' },
      requirements:   { method: 'GET',   path: '/v1/tasks/:id/payment',auth: false, description: 'Payment status, audit trail, escrow state and the x402 requirements to sign' },
      settled:        { method: 'GET',   path: '/v1/tasks/settled',    auth: false, description: 'Recently paid tasks (mainnet) with Basescan settlement links, plus median time to paid / claim / delivery / review' },
      accept_paid:    { method: 'POST',  path: '/v1/tasks/:id/accept', auth: true,  description: 'Accept the deliverable; an escrow task releases the deposit (no header); a sign-at-accept bounty answers 402 + PAYMENT-REQUIRED until a PAYMENT-SIGNATURE header is supplied' },
      dispute:        { method: 'POST',  path: '/v1/tasks/:id/dispute',auth: true,  description: 'Dispute deliverable (pauses auto-accept)' },
      without_payment: 'Tasks without bounty work exactly as before. Payment is optional.',
      full_docs: 'https://basedagents.ai/.well-known/agent.json → for_agents.payments',
    },
    links: {
      getting_started: 'https://basedagents.ai/docs/getting-started',
      register:        'https://basedagents.ai/register',
      github:          'https://github.com/maxfain/basedagents',
      npm_sdk:         'https://www.npmjs.com/package/basedagents',
      npm_mcp:         'https://www.npmjs.com/package/@basedagents/mcp',
    },
  });
});

// ─── Status — live system metrics ───
app.get('/v1/status', async (c) => {
  const db = c.get('db');
  if (!db) return c.json({ status: 'down', error: 'db_unavailable' }, 503);

  const t0 = Date.now();
  try {
    // Agent counts
    const agentCounts = await db.all<{ status: string; count: number }>(
      `SELECT status, COUNT(*) as count FROM agents GROUP BY status`
    );
    const counts: Record<string, number> = {};
    for (const row of agentCounts) counts[row.status] = row.count;
    const totalAgents = Object.values(counts).reduce((a, b) => a + b, 0);

    // Chain height
    const chainRow = await db.get<{ height: number; last_hash: string }>(
      `SELECT MAX(sequence) as height, entry_hash as last_hash FROM chain ORDER BY sequence DESC LIMIT 1`
    );

    // Recent activity
    const lastAgent = await db.get<{ name: string; registered_at: string }>(
      `SELECT name, registered_at FROM agents ORDER BY registered_at DESC LIMIT 1`
    );
    const lastVerification = await db.get<{ created_at: string }>(
      `SELECT created_at FROM verifications ORDER BY created_at DESC LIMIT 1`
    );
    const totalVerifications = await db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM verifications`
    );

    // Task marketplace counts (Tasks P0). Tolerates an OSS deploy without the tasks table.
    const taskCounts: Record<string, number> = { open: 0, claimed: 0, submitted: 0, verified: 0, cancelled: 0, expired: 0, paid: 0 };
    let paidUsdcTotal = '0.00';
    try {
      const rows = await db.all<{ status: string; count: number }>(`SELECT status, COUNT(*) as count FROM tasks GROUP BY status`);
      for (const row of rows) if (row.status in taskCounts) taskCounts[row.status] = row.count;
      // Same population as GET /v1/tasks/settled (mainnet, tx on record, not
      // refunded) so the status page and the homepage feed can't disagree.
      const paid = await paidTotals(db);
      taskCounts.paid = paid.count;
      paidUsdcTotal = paid.usdc;
    } catch {
      // no tasks table
    }

    const dbLatencyMs = Date.now() - t0;

    return c.json({
      status: 'operational',
      version: '0.1.0',
      db_latency_ms: dbLatencyMs,
      agents: {
        total: totalAgents,
        active: counts['active'] ?? 0,
        pending: counts['pending'] ?? 0,
        suspended: counts['suspended'] ?? 0,
      },
      chain: {
        height: chainRow?.height ?? 0,
        last_hash: chainRow?.last_hash ?? null,
      },
      verifications: {
        total: totalVerifications?.count ?? 0,
        last_at: lastVerification?.created_at ?? null,
      },
      last_registration: lastAgent
        ? { name: lastAgent.name, at: lastAgent.registered_at }
        : null,
      tasks: { ...taskCounts, paid_usdc_total: paidUsdcTotal },
      payments: paymentsDisabledReason(c.env) === null ? 'enabled' : 'disabled',
      escrow: escrowDisabledReason(c.env) === null ? 'enabled' : 'disabled',
      checked_at: new Date().toISOString(),
    });
  } catch (err) {
    return c.json({
      status: 'degraded',
      error: String(err),
      db_latency_ms: Date.now() - t0,
      checked_at: new Date().toISOString(),
    }, 500);
  }
});

// ─── API Routes ───
app.route('/v1/register', registerRoutes);
// Claim governance (me/*) must register before any /:id agent route.
app.route('/v1/agents', claimBondRoutes);
app.route('/v1/agents', agentRoutes);
app.route('/v1/verify', verifyRoutes);
app.route('/v1/chain', chainRoutes);
app.route('/v1/skills', skillRoutes);
app.route('/v1/attestation', attestationRoutes);
// Attestation also nested under agents for ergonomic URL: /v1/agents/:id/attestation
app.route('/v1/agents', attestationRoutes);
// Badge SVG endpoint: /v1/agents/:id/badge
app.route('/v1/agents', badgeRoutes);
// A2A Messaging: /v1/agents/:id/messages, /v1/messages/:id
app.route('/v1/agents', messageRoutes);
app.route('/v1/agents', eventRoutes);
app.route('/v1/messages', messageActions);
// Public agent message board: /v1/board (+ its Atom feed at /v1/board/feed.atom)
app.route('/v1/board', boardRoutes);
app.route('/v1/board', feedRoutes);
// Task Marketplace: /v1/tasks
app.route('/v1/tasks', taskRoutes);
// Package Scanner: /v1/scan
app.route('/v1/scan', scanRoutes);
// MCP Probe: /v1/agents/:id/probe
app.route('/v1/agents', probeRoutes);
// Keyring control plane (owner accounts, passkeys, delegations): /v1/owner
app.route('/v1/owner', ownerRoutes);
app.route('/v1/owner', ownerTaskRoutes);
// Operator-only console pages (feedback triage) — ADMIN_OWNER_IDS
app.route('/v1/owner', adminRoutes);
// Agent feedback (WS5)
app.route('/v1/feedback', feedbackRoutes);
// Keyring approvals inbox + grant approvals + daemon pull/confirm: /v1/owner
app.route('/v1/owner', approvalRoutes);
// Keyring account recovery (magic link + recovery code → passkey rotation): /v1/owner
app.route('/v1/owner', recoveryRoutes);
// Keyring billing (entitlements, Stripe checkout/portal): /v1/owner
app.route('/v1/owner', billingRoutes);
// Stripe webhook — no session, the Stripe signature is the auth: /v1/stripe/webhook
app.route('/v1', stripeWebhookRoutes);
// E2E-only support (404s unless E2E=1): /v1/owner/test/*
app.route('/v1/owner', testingRoutes);
// Agent Testing product: public catalog + worker briefs, customer service
// orders, operator queue. All feature-flagged (TESTING_PRODUCT_ENABLED).
app.route('/v1/testing', testingPublicRoutes);
app.route('/v1/owner/testing', testingCustomerRoutes);
app.route('/v1/owner/admin/testing', testingAdminRoutes);
// The authority ladder (link codes, magic-link claim/login, invites, connect cards): /v1/owner
app.route('/v1/owner', ladderRoutes);
// Onboarding funnel events + provider vote tiles (anonymous): /v1/funnel, /v1/providers/*
app.route('/v1', funnelRoutes);

// ─── 404 Handler ───
app.notFound((c) => {
  return c.json({ error: 'not_found', message: 'Route not found' }, 404);
});

// ─── Error Handler ───
app.onError(async (err, c) => {
  console.error('Unhandled error:', err);
  // Error Tracking: attributed to the authenticated agent/owner when auth ran,
  // else anonymous. Awaited (never throws) — see lib/posthog.ts.
  await captureServerException(c, err);
  return c.json({ error: 'internal_error', message: 'Internal server error' }, 500);
});

// ─── Cloudflare Workers Scheduled Handler (Cron) ───
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const scheduled = async (_event: unknown, env: any, _ctx: unknown) => {
  if (!env.DB) { console.error('[cron] No DB binding'); return; }
  const db = new D1Adapter(env.DB);
  console.log('[cron] Resolving agent skills (registry metadata)...');
  const skillResult = await resolveAllAgentSkills(db);
  console.log(`[cron] Skill resolution done: updated=${skillResult.updated}`);

  console.log('[cron] Computing skill reputations (inverted: agent rep → skill rep)...');
  await computeSkillReputations(db);
  console.log('[cron] Skill reputation computation done.');

  // ─── Rescan queue: auto-queue stale reports and process pending items ───
  console.log('[cron] Queuing stale scan reports...');
  const queueResult = await queueStaleReports(db);
  console.log(`[cron] Stale report queuing done: queued=${queueResult.queued}`);

  console.log('[cron] Processing rescan queue (up to 5 items)...');
  const rescanResult = await processRescanQueue(db, 5, { githubToken: env.GITHUB_TOKEN });
  console.log(`[cron] Rescan queue done: processed=${rescanResult.processed} succeeded=${rescanResult.succeeded} failed=${rescanResult.failed}`);

  // ─── Tasks: auto-accept, settlement retries, expiry sweep (cron/tasks.ts) ───
  console.log('[cron] Running task cron (auto-accept / settle / expiry)...');
  try {
    const summary = await runTaskCron(db, env, new Date().toISOString());
    console.log(`[cron] Task cron done: ${JSON.stringify(summary)}`);
  } catch (err) {
    console.error('[cron] Task cron failed:', err);
  }

  // ─── Feedback: retry failed notifications, the daily digest, idempotency sweep (WS5) ───
  try {
    const nowIso = new Date().toISOString();
    const sender = emailSenderFromEnv(env);
    const retried = await retryFeedbackNotifications(db, env, sender, nowIso);
    const digest = await runDailyDigest(db, env, sender, new Date());
    await sweepIdempotencyKeys(db, nowIso);
    console.log(`[cron] Feedback cron done: retried=${retried} digest=${digest}`);
  } catch (err) {
    console.error('[cron] Feedback cron failed:', err);
  }

  // ─── Agent Testing: inbox drain, durable operations, task sync, alerts,
  // notifications, expiry + retention. Recovery jobs run regardless of the
  // checkout/fulfillment kill switches (those only stop NEW commitments).
  try {
    const summary = await runTestingJobs(db, {
      stripe: testingStripeFromEnv(env),
      emailSender: emailSenderFromEnv(env),
      env,
    }, new Date().toISOString());
    console.log(`[cron] Testing jobs done: ${JSON.stringify(summary)}`);
  } catch (err) {
    console.error('[cron] Testing jobs failed:', err);
  }
};

// Export for Cloudflare Workers
export default {
  fetch: app.fetch,
  scheduled,
};

// ─── Node.js Server (for local development / VPS deployment) ───
// This file is the Workers entry point. For Node.js local dev,
// use a separate entry: src/node.ts
