# Optional public task projection

This extension sits on the three indexed SQL optimizations. SQL owns all
durable data, filtering, ordering, authorization and mutation decisions.
The projection retains public row fragments from recently used query pages.
It assembles each HTTP response from those fragments and evaluates expiry
against the current request time. It does not store completed HTTP responses.

Modes are `off`, `js`, `rust-fresh` and `rust-reuse`. The two Rust modes use
the same compiled Wasm module; only output-buffer allocation differs. JS
also reuses its assembly buffer. Every mode copies outgoing bytes before
the next request may reuse storage. Rust retains row fragments in linear
memory; the JS boundary releases its duplicate after transferring them.

## Build and local validation

The recorded experiment uses Rust 1.90.0 and Node 22.23.3. No Rust packages
outside the standard library are required.

```sh
rustup target add wasm32-unknown-unknown --toolchain 1.90.0
cargo +1.90.0 test --manifest-path optional/task-projection/rust/Cargo.toml
cargo +1.90.0 build --release --target wasm32-unknown-unknown --manifest-path optional/task-projection/rust/Cargo.toml
cp optional/task-projection/rust/target/wasm32-unknown-unknown/release/task_projection.wasm optional/task-projection/task_projection.wasm
npm test
TASK_LIST_PROJECTION_MODE=rust-reuse node bench/run.mjs projection-example full
```

Run labels must be new. The fixture, request count, HTTP concurrency and
endpoint paths remain in `bench/workload.json`. `bench/projection-mixed.mjs`
adds cold-page, varied-query and independent-connection write workloads.
Use the same source and compiled module for every comparison mode.

## Integration

Execute `install.sql` transactionally before enabling a mode. It requires
the task, agent and certification tables used by the full API deployment.
Its triggers advance a durable generation within the transaction that
changes any public-row dependency. Direct SQL writes are included; no
application notification is needed. Conditional `changes()` gates and
outbox rollback behavior are covered by the projection tests.

Set the `TASK_LIST_PROJECTION_MODE` binding to `js` to use JS assembly. For
Rust, install a compiled `WebAssembly.Module` with
`installTaskProjectionModule` from `src/tasks/list-projection.ts` before
serving requests, then select `rust-reuse`. Node may compile the bytes from
disk (as `bench/server.ts` does). A Workers entry module should statically
import the `.wasm` module through its bundler and register that module;
Workers does not support compiling arbitrary Wasm bytes at runtime.
The benchmark exercises Wasm on Node's V8, not the deployed D1 service.

Each read checks SQL's generation. Rebuilds bracket the row query with
generation reads and discard a result if the database changed. Concurrent
requests for one query/generation share a build; at most four builds run
at once. Other requests use SQL. An older build cannot replace a more
recent build of the same query. D1 queries use the primary through the
existing un-sessioned adapter. A replicated/session adapter needs the same
primary freshness guarantee before enabling this feature.

Retained fragments and query keys are bounded to 64 pages and 8 MiB of
logical payload per mode/database, with a 1 MiB per-page limit and LRU
eviction. These limits are not a bound on process RSS: input/output buffers,
allocator capacity and Wasm linear memory also consume space. Measured
memory accompanies benchmark results. Cold or evicted pages rebuild from
SQL. A missing generation table or failed generation query falls back to SQL.
A readable generation table does not detect missing triggers: keep the complete
trigger set installed while a projection mode is enabled. Restart isolates
after schema migrations or database restore. Disable the mode before
removing its generation table or triggers.

The SQL path remains available for workloads whose rebuild/invalidations
cost more than reuse saves. Repeated-query and varied-query measurements
must be reported separately; local fixture results are not production D1
latency claims.
