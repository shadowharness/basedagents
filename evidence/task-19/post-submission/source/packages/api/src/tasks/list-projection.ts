import type { DBAdapter } from '../db/adapter.js';
import { publicTaskShape } from './service.js';

// SQL remains authoritative. This opt-in projection only stores public rows
// from bounded query pages. Keyed Rust also retains their immutable public bodies.
export type ProjectionMode = 'off' | 'js' | 'rust-fresh' | 'rust-reuse' | 'rust-u128' | 'rust-u128-etag';
type Fragment = { bytes: Uint8Array; expires: Uint8Array; eligible: boolean };
type Page = { id: number; key: string; epoch: string; fragments: Fragment[]; bytes: number };
const encode = new TextEncoder();
const PREFIX = encode.encode('{"ok":true,"tasks":[');
const TRUE = encode.encode('true}');
const FALSE = encode.encode('false}');
const SUFFIX = encode.encode(']}');
const EPOCH_SQL = "SELECT incarnation || ':' || CAST(version AS TEXT) AS epoch FROM task_projection_epoch WHERE singleton = 1";
let wasmModule: WebAssembly.Module | undefined;
let states = new WeakMap<object, Map<string, State>>();
let etags = new WeakMap<Uint8Array<ArrayBuffer>, Promise<string>>();
export function installTaskProjectionModule(module: WebAssembly.Module): void { wasmModule = module; }
export function clearTaskProjections(): void { states = new WeakMap(); etags = new WeakMap(); }
export function projectedTaskETag(body: Uint8Array<ArrayBuffer>): Promise<string> {
  let pending = etags.get(body);
  if (!pending) {
    pending = (async () => {
      // Match Hono's 256 KiB chained SHA-1 convention exactly, including large
      // pages. Bind the tag to immutable owned bytes, never just a query key.
      let digest = new Uint8Array(0) as Uint8Array<ArrayBuffer>;
      for (let offset = 0; offset < body.length; offset += 256 * 1024) {
        const chunk = body.subarray(offset, offset + 256 * 1024);
        const input = new Uint8Array(digest.length + chunk.length);
        input.set(digest); input.set(chunk, digest.length);
        digest = new Uint8Array(await crypto.subtle.digest('SHA-1', input));
      }
      return '"' + Array.from(digest, b => b.toString(16).padStart(2, '0')).join('') + '"';
    })();
    etags.set(body, pending);
  }
  return pending;
}

interface RustExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  input_resize(length: number): number;
  put(id: number, length: number): number;
  remove(id: number): void;
  render(id: number, nowLength: number, reuse: number): number;
  output_len(): number;
  put_keyed(id: number, keyLength: number, epochLength: number, length: number): number;
  lookup(keyLength: number, epochLength: number, nowLength: number): number;
  keyed_ptr(): number;
  keyed_len(): number;
  keyed_revision(): number;
  oldest_id(): number;
}
class RustRenderer {
  private readonly api: RustExports;
  private readonly bodies = new Map<number, { revision: number; bytes: Uint8Array<ArrayBuffer> }>();
  constructor(readonly keyed: boolean) {
    if (!wasmModule) throw new Error('Install the compiled task projection Wasm module before enabling Rust mode');
    this.api = new WebAssembly.Instance(wasmModule, {}).exports as RustExports;
  }
  put(page: Page): void {
    const key = this.keyed ? encode.encode(page.key) : new Uint8Array(0);
    const epoch = this.keyed ? encode.encode(page.epoch) : new Uint8Array(0);
    const prefix = key.length + epoch.length;
    const size = prefix + 4 + page.fragments.reduce((n, f) => n + 12 + f.bytes.length + f.expires.length, 0);
    const ptr = this.api.input_resize(size);
    const input = new Uint8Array(this.api.memory.buffer, ptr, size);
    const data = new DataView(input.buffer, ptr, size);
    input.set(key); input.set(epoch, key.length);
    data.setUint32(prefix, page.fragments.length, true);
    let cursor = prefix + 4;
    for (const f of page.fragments) {
      data.setUint32(cursor, f.bytes.length, true);
      data.setUint32(cursor + 4, f.expires.length, true);
      data.setUint32(cursor + 8, f.eligible ? 1 : 0, true); cursor += 12;
      input.set(f.bytes, cursor); cursor += f.bytes.length;
      input.set(f.expires, cursor); cursor += f.expires.length;
    }
    const accepted = this.keyed ? this.api.put_keyed(page.id, key.length, epoch.length, size) : this.api.put(page.id, size);
    if (!accepted) throw new Error('Invalid projection payload');
  }
  remove(id: number): void { this.api.remove(id); this.bodies.delete(id); }
  oldestId(): number { return this.api.oldest_id(); }
  lookup(keyText: string, epochText: string): Uint8Array<ArrayBuffer> | null {
    const key = encode.encode(keyText), epoch = encode.encode(epochText), now = encode.encode(new Date().toISOString());
    const length = key.length + epoch.length + now.length;
    const ptr = this.api.input_resize(length);
    const input = new Uint8Array(this.api.memory.buffer, ptr, length);
    input.set(key); input.set(epoch, key.length); input.set(now, key.length + epoch.length);
    const id = this.api.lookup(key.length, epoch.length, now.length);
    if (!id) return null;
    const revision = this.api.keyed_revision(), previous = this.bodies.get(id);
    if (previous?.revision === revision) return previous.bytes;
    // This owned immutable copy survives Wasm growth, eviction and other requests.
    // Fetch copies it into each Response; it is never modified after publication.
    const bytes = new Uint8Array(this.api.memory.buffer, this.api.keyed_ptr(), this.api.keyed_len()).slice();
    this.bodies.set(id, { revision, bytes }); return bytes;
  }
  render(id: number, now: Uint8Array, reuse: boolean): Uint8Array<ArrayBuffer> {
    const input = this.api.input_resize(now.length);
    new Uint8Array(this.api.memory.buffer, input, now.length).set(now);
    const output = this.api.render(id, now.length, reuse ? 1 : 0);
    // Copy before another request can reuse/grow Wasm memory. No borrowed
    // view escapes into an asynchronous HTTP send.
    return new Uint8Array(this.api.memory.buffer, output, this.api.output_len()).slice();
  }
}
function later(a: Uint8Array, b: Uint8Array): boolean {
  // Matches the existing ISO-string comparison, including legacy strings.
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return a.length > b.length;
}
class State {
  pages = new Map<string, Page>();
  pending = new Map<string, Promise<Page | null>>();
  bytes = 0;
  nextId = 1;
  buildSerial = 0;
  latestBuild = new Map<string, number>();
  buffer = new Uint8Array(0);
  rust?: RustRenderer;
  counters = { hits: 0, misses: 0, rebuilds: 0, evictions: 0, oversize: 0, changedDuringBuild: 0, unavailable: 0 };
  constructor(readonly mode: ProjectionMode, readonly maxBytes: number, readonly maxPages: number) {
    if (mode.startsWith('rust')) this.rust = new RustRenderer(mode.startsWith('rust-u128'));
  }
  remove(key: string): void {
    const p = this.pages.get(key);
    if (!p) return;
    this.bytes -= p.bytes; this.pages.delete(key); this.rust?.remove(p.id);
  }
  render(page: Page): Uint8Array<ArrayBuffer> {
    if (this.rust?.keyed) return this.rust.lookup(page.key, page.epoch)!;
    const now = encode.encode(new Date().toISOString());
    if (this.rust) return this.rust.render(page.id, now, this.mode === 'rust-reuse');
    const needed = PREFIX.length + SUFFIX.length + page.fragments.reduce((n, f) => n + f.bytes.length + FALSE.length + 1, 0);
    if (this.buffer.length < needed) this.buffer = new Uint8Array(needed);
    let cursor = 0;
    const append = (bytes: Uint8Array) => { this.buffer.set(bytes, cursor); cursor += bytes.length; };
    append(PREFIX);
    for (let i = 0; i < page.fragments.length; i++) {
      if (i) this.buffer[cursor++] = 44;
      const f = page.fragments[i]; append(f.bytes);
      append(f.eligible && (!f.expires.length || later(f.expires, now)) ? TRUE : FALSE);
    }
    append(SUFFIX);
    return this.buffer.slice(0, cursor);
  }
}
function getState(identity: object, mode: ProjectionMode, maxBytes: number, maxPages: number): State {
  let modes = states.get(identity);
  if (!modes) { modes = new Map(); states.set(identity, modes); }
  const key = `${mode}:${maxBytes}:${maxPages}`;
  let state = modes.get(key);
  if (!state) { state = new State(mode, maxBytes, maxPages); modes.set(key, state); }
  return state;
}
export function taskProjectionStats(identity: object): unknown {
  return [...(states.get(identity)?.entries() ?? [])].map(([mode, s]) => ({ mode, ...s.counters,
    pages: s.pages.size, retainedBytes: s.bytes, outputCapacity: s.buffer.length }));
}
export async function projectedTaskList(db: DBAdapter, identity: object, sql: string, params: unknown[],
  mode: ProjectionMode, maxBytes = 8 * 1024 * 1024, maxPages = 64): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!['js', 'rust-fresh', 'rust-reuse', 'rust-u128', 'rust-u128-etag'].includes(mode)) return null;
  const state = getState(identity, mode, maxBytes, maxPages);
  // Read on every request; dropped application notifications cannot cause
  // stale results. D1's un-sessioned queries use its primary database.
  let epoch: string | undefined;
  try { epoch = (await db.get<{ epoch: string }>(EPOCH_SQL))?.epoch; }
  catch { state.counters.unavailable++; return null; }
  if (!epoch) return null;
  if (state.rust?.keyed && !/^[0-9a-fA-F]{32}:\d{1,38}$/.test(epoch)) { state.counters.unavailable++; return null; }
  const key = JSON.stringify([sql, params]); // Includes filters, page and environment network policy.
  if (state.rust?.keyed) {
    const body = state.rust.lookup(key, epoch);
    if (body) { state.counters.hits++; return body; }
  }
  const existing = state.pages.get(key);
  if (!state.rust?.keyed && existing?.epoch === epoch) {
    state.counters.hits++;
    state.pages.delete(key); state.pages.set(key, existing);
    return state.render(existing);
  }
  state.counters.misses++;
  // Bound rebuild work as well as retained data. Different requests continue
  // through SQL while the bounded number of builds is occupied.
  const pendingKey = epoch + ':' + key;
  const prior = state.pending.get(pendingKey);
  if (prior) { await prior; return projectedTaskList(db, identity, sql, params, mode, maxBytes, maxPages); }
  if (state.pending.size >= 4) return null;
  const serial = ++state.buildSerial;
  state.latestBuild.set(key, serial);
  const build = (async (): Promise<Page | null> => {
    const rows = await db.all<Record<string, unknown>>(sql, ...params);
    let after: string | undefined;
    try { after = (await db.get<{ epoch: string }>(EPOCH_SQL))?.epoch; }
    catch { state.counters.unavailable++; return null; }
    // Bracket row materialization with generation reads. Any committed change
    // discards this build; it cannot overwrite a newer page.
    if (after !== epoch || state.latestBuild.get(key) !== serial) { state.counters.changedDuringBuild++; return null; }
    const fragments = rows.map(row => {
      const out = publicTaskShape(row); delete out.claimable;
      return { bytes: encode.encode(JSON.stringify(out).slice(0, -1) + ',"claimable":'),
        expires: encode.encode(typeof row.expires_at === 'string' ? row.expires_at : ''),
        eligible: row.status === 'open' && (!row.escrow || row.escrow_status === 'funded') };
    });
    // Keyed mode retains rows + a Rust body + an owned immutable JS body.
    // Reserve all three, including worst-case false/comma suffixes and key overhead.
    const rawBytes = fragments.reduce((n, f) => n + f.bytes.length + f.expires.length + 12, 4) + encode.encode(key).length;
    const bytes = state.rust?.keyed ? rawBytes * 3 + fragments.length * 96 + 256 : rawBytes;
    if (bytes > Math.min(maxBytes, 1024 * 1024) || maxPages < 1) { state.counters.oversize++; return null; }
    state.remove(key);
    while (state.pages.size >= maxPages || state.bytes + bytes > maxBytes) {
      const oldest = state.rust?.keyed ? [...state.pages].find(([, p]) => p.id === state.rust!.oldestId())?.[0] : state.pages.keys().next().value;
      state.remove(oldest!); state.counters.evictions++;
    }
    const page = { id: state.nextId++, key, epoch: epoch!, fragments, bytes };
    state.rust?.put(page);
    // Rust owns its fragments. Do not keep an extra JS copy of public rows.
    if (state.rust) page.fragments = [];
    state.pages.set(key, page); state.bytes += bytes; state.counters.rebuilds++;
    return page;
  })();
  state.pending.set(pendingKey, build);
  try {
    const page = await build;
    // Another completed build may evict this page before our continuation.
    return page && state.pages.get(key) === page ? state.render(page) : null;
  }
  finally {
    state.pending.delete(pendingKey);
    if (state.latestBuild.get(key) === serial) state.latestBuild.delete(key);
  }
}
