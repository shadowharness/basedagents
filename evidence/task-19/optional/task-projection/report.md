# Optional public task fragments: JS and Rust/Wasm comparison

On the indexed SQL baseline, retaining public-row fragments reduces repeated row materialization and JSON encoding. The fixed repeated-list workload's p50 improves by 3.65× and 3.82× with JS and 3.90× and 3.80× with Rust/reused output (open and verified lists respectively). These ratios compare the same instrumented source, fixture and complete HTTP responses.

## Experimental separation

A (off) executes indexed SQL. B (js) retains bounded public fragments and reuses a JS assembly buffer. C0 (rust-fresh) assembles fragments with Rust compiled to Wasm and a new output allocation. C1 (rust-reuse) uses the identical compiled module with output-buffer reuse. A→B tests the complete public-fragment read implementation, including avoided row fetching, reused formatting/JSON work and changed response assembly; B→C0 includes the language/boundary and different allocation strategy; C0→C1 isolates the output allocation switch. Rust's contribution is assessed against B, not only against SQL.

Execution order is A/B/C0/C1/C1/C0/B/A, with five batches of 400 requests per endpoint in each run. All five endpoints have identical normalized JSON bodies across all modes and the indexed baseline. 80,000 timed requests and 40 profiles cover these eight full runs. Mode-independent generation triggers are installed in every mode, including A. No writes occur in this repeated-read comparison.

| Endpoint | Mode | p50 ms | p99 ms | p50 batch range | CPU ms/profile request | RSS MiB, two processes |
| --- | --- | ---: | ---: | --- | ---: | --- |
| tasks-open | off | 38.27 | 87.35 | 35.42–43.48 | 12.55 | 171.19, 175.64 |
| tasks-open | js | 10.47 | 40.57 | 7.24–19.59 | 3.80 | 183.48, 166.01 |
| tasks-open | rust-fresh | 9.74 | 33.91 | 7.88–12.30 | 3.48 | 181.22, 175.23 |
| tasks-open | rust-reuse | 9.81 | 36.24 | 8.26–19.60 | 3.16 | 181.89, 190.82 |
| tasks-verified | off | 38.62 | 85.87 | 35.22–42.96 | 13.34 | 175.86, 163.20 |
| tasks-verified | js | 10.10 | 36.98 | 8.34–12.80 | 3.63 | 185.57, 187.91 |
| tasks-verified | rust-fresh | 10.99 | 39.29 | 8.73–16.69 | 3.17 | 180.82, 187.70 |
| tasks-verified | rust-reuse | 10.17 | 39.50 | 8.64–12.08 | 3.08 | 183.94, 186.93 |

CPU usage and RSS are observations from separate 400-request profiler passes. RSS is process memory, not only retained fragments; logical payload limits do not bound allocator or Wasm capacity. Quantiles are recomputed from raw timings, with a median across ten batches for each mode.

The large measured gain is reuse of public-row work. Rust/reuse versus JS changes open-list p50 from 10.47 to 9.81 ms and verified-list p50 from 10.10 to 10.17 ms, with overlapping batch ranges. Switching only Rust output allocation likewise does not consistently improve both endpoints. The CPU observations are retained, but these data do not establish an additional Rust-specific endpoint latency gain. Both implementations and the allocation experiment are supplied so that further workloads can discriminate that contribution.

## Varied and updating workloads

Each mode also executes 40 distinct cold pages, then five batches each for eight recurring pages, 128 cycling pages, and eight pages with a committed SQL update every 20 reads through an independent connection. These add 24,160 timed requests and 12 profiles. The write changes an oldest row outside measured pages, forcing generation invalidation while keeping the compared response bodies identical. Mutation-to-visible-response behavior is covered separately by correctness tests. Cold pages have only one 40-request batch and are exploratory. Mixed modes run once in off/js/rust-fresh/rust-reuse order; their five batch ranges do not remove inter-mode time drift.

| Scenario | Mode | p50 ms | p99 ms | p50 batch range |
| --- | --- | ---: | ---: | --- |
| cold-distinct-pages | off | 66.04 | 146.57 | 66.04–66.04 |
| cold-distinct-pages | js | 90.14 | 371.83 | 90.14–90.14 |
| cold-distinct-pages | rust-fresh | 75.45 | 128.43 | 75.45–75.45 |
| cold-distinct-pages | rust-reuse | 91.97 | 213.74 | 91.97–91.97 |
| hot-eight-pages | off | 37.82 | 92.83 | 33.56–40.42 |
| hot-eight-pages | js | 10.90 | 39.36 | 8.16–12.02 |
| hot-eight-pages | rust-fresh | 9.44 | 28.69 | 8.45–11.15 |
| hot-eight-pages | rust-reuse | 8.89 | 30.79 | 8.18–9.87 |
| churn-128-pages | off | 57.19 | 145.62 | 53.00–59.61 |
| churn-128-pages | js | 59.50 | 143.33 | 57.17–61.84 |
| churn-128-pages | rust-fresh | 65.44 | 140.58 | 54.30–68.75 |
| churn-128-pages | rust-reuse | 58.53 | 133.02 | 54.12–61.66 |
| read-write-eight-pages | off | 36.42 | 68.91 | 35.95–44.51 |
| read-write-eight-pages | js | 15.41 | 70.28 | 14.55–17.89 |
| read-write-eight-pages | rust-fresh | 15.03 | 69.23 | 14.75–19.48 |
| read-write-eight-pages | rust-reuse | 14.96 | 63.27 | 13.19–17.73 |

The cycling workload exceeds the 64-page retention bound and exposes rebuild/eviction costs. Generation changes invalidate fragments after writes. Use the repeated-query and mixed measurements separately when choosing a mode; the SQL mode remains available. Per-scenario resources, raw timings, SQL plans, fingerprints and write durations are in `runs/` and `comparison.json`.

## Correctness and source

The final source passed 99 test files / 1723 repository tests and API TypeScript checking. Sixteen projection tests cover tied dates, filters, expiry without writes, mutations, owner/credential/delegation revocation, database separation, retained-data bounds, discarded stale rebuilds, output-buffer ownership and transactional changes()/rollback behavior. SQL owns filtering, authorization and durable state; the projection can be discarded and rebuilt. Retention is bounded to 64 pages / 8 MiB of logical payload with a 1 MiB page limit and at most four concurrent builds. A missing generation table or failed generation query falls back to SQL. The complete trigger set must remain installed; a missing trigger with a readable generation table is not automatically detected.

Apply `projection.patch` after the six core patches. `commit-map.json` records an identical final tree for the measured and public source. Build Rust 1.90.0 for wasm32-unknown-unknown following `integration.md`; the recorded module is supplied with SHA256 `b48a8cd5f107a11e1f0aed3e451a01ac5dec0acbb06e52c6eda77f9a772c0f3c`. Keep this optional change distinct from the three formal optimizations. Measurements use local Node/V8 and SQLite on the same two-CPU environment; they do not measure deployed D1 or Workers execution.

## External-writer HTTP consistency

A separate file-backed SQLite probe made 40 real localhost HTTP requests across all four modes. After another connection committed a visible title change, each mode returned the new title and matched SQL; the generation increased and each projection rebuilt. A committed status change removed the ID from open and added it to verified. A rolled-back visible change preserved the generation and responses without rebuilding. With writes stopped and the generation table removed, all modes returned HTTP 200 and matched SQL for both lists. The probe checks explicit written values and IDs as well as SQL equality. See `external-writer-http.json` and `probe-external-writer.mjs`.

GETs start after COMMIT or ROLLBACK; this does not add an in-flight freshness guarantee or a performance result. From the patched checkout with dependencies installed, run `node --import tsx <evidence>/optional/task-projection/probe-external-writer.mjs . <new-output-directory>`. The recorded run used the same measured source and Wasm hash.
