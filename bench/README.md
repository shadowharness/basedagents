# Local API endpoint benchmark

This harness runs the unmodified API routes against synthetic data in the repository's Node/SQLite configuration. It serves only `127.0.0.1` on an ephemeral port. The client has a literal loopback destination; no production URL can be supplied. Payment, analytics, email and webhook credentials are absent, and server-side `fetch` is disabled. No fixture identity, signature, chain hash or transaction hash represents a real agent or payment.

Prerequisites: Linux arm64, Node 22.23.3, npm, a C++ build toolchain for `better-sqlite3`. The recorded environment uses two shared CPU cores and a 2 GiB memory limit. Install the pinned lockfile from the repository root:

```sh
npm ci --no-audit --no-fund
npm run build:dist --workspace=@basedagents/keyring
node bench/run.mjs baseline-01 full
```

Use a new run label each time. Existing fixtures and server logs are not overwritten. Results are written beside the repository under `../runs/<label>/`. `smoke` can replace `full` for a wiring check; smoke timings are not evidence of an optimization.

`workload.json` fixes the dataset, five HTTP paths, concurrency, warmup and sample counts. Each endpoint receives 120 warmup requests, five batches of 400 measured requests at concurrency four, then a separate 400-request profiling pass. HTTP latency runs exclude profiler instrumentation; their measurements end when the whole response body has arrived. Responses must be HTTP 200 and retain the same JSON hash throughout the run. Only the status response's `checked_at` and `db_latency_ms` diagnostics are removed from that hash. The first normalized response is saved for cross-version comparisons.

The server applies the complete upstream migration chain to a fresh SQLite fixture, then inserts 2,000 agents, 50,000 tasks and 100,000 verifications with fixed timestamps. Tasks are evenly distributed across five lifecycle states; half the verified tasks carry synthetic settled payments. This is a reproducible scale fixture, not a claim about production traffic or data distribution.

Each endpoint has a standard V8 `.cpuprofile` plus SQL timing/counts and `EXPLAIN QUERY PLAN` artifacts. SQL timing measures synchronous Node SQLite invocation, including prepare and step, and excludes Promise scheduling of other requests. Profiling is a separate workload pass; it must not supply the reported latency numbers. Raw request latencies and all batch results remain in `results.json`; report medians and spread across batches along with p50 and p99.

Keep workload, data, hardware, runtime, server logging and measurement code identical across source changes. Run the repository's `npm test` after each optimization commit, preserve the command and complete output, and compare response hashes. Since the host CPU is shared, repeat an unchanged baseline after the optimized measurements to check environmental drift. Record unsuccessful experiments along with successful changes.
