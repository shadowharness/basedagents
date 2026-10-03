# Post submission developer follow up on API performance

**ShadowHarness developer follow-up, 3 October 2026.** After the original submission had been delivered, the ShadowHarness developer woke up, reviewed its report, and requested a deeper Rust implementation and another measurement. This report records that follow-up.

The extended Rust/u128 implementation reduces the isolated public-page processing time from **42.58 µs to 8.20 µs, a 5.20× speedup** against the JS implementation. Following that improvement through the HTTP pipeline identified another repeated cost: the shared ETag middleware was copying and hashing the response body on every request. Reusing the ETag together with the immutable body brings the measured HTTP p50 to **7.45 ms for open tasks and 8.61 ms for verified tasks**, improvements of **16.5% and 13.5%** over the JS control in this follow-up.

The current verification checkpoint is **the original three query/index improvements plus one shared response-hash reuse improvement**, with the deeper Rust/u128 work inside the optional task-list implementation. The original submission remains available at its [fixed report URL](https://github.com/shadowharness/basedagents/blob/157e94143b75afb736921631952940c6ef897713/evidence/task-19/report.md).

## What this checkpoint includes

| Improvement | Role in the completed work |
| --- | --- |
| Task state and creation-time index | Speeds the original open and verified list queries. |
| Verification creation-time index | Speeds the latest-verification lookup used by status. |
| Exact paid-population partial index | Speeds the existing paid-total calculation while retaining its eligibility rules. |
| Shared ETag hash reuse | Avoids repeating response cloning and digest generation for unchanged projected task-list bodies. |

The first three retain their separate commits, profiles and comparisons in the [original report](../report.md). Its original fixed-workload p50 values were 327.18 → 35.97 ms for open tasks, 371.68 → 38.60 ms for verified tasks, and 233.50 → 21.89 ms for status. The optional public-page implementation subsequently reused SQL-derived rows and formatting work. This follow-up measures the next steps in that implementation, with fresh controls; the figures from the different experiments remain separate.

The ETag improvement uses the existing shared conditional-GET mechanism. The two task-list routes provide a retained tag for their immutable projected bodies, allowing the common middleware to preserve its normal matching and 304 behavior without recalculating the digest. The measured implementation enables this for those two lists.

## Deeper Rust processing

Rust/Wasm now owns a u128 query fingerprint index, exact-key collision checks, u128 database incarnation and generation values, u128 expiry values and validity intervals, a u128 claimability mask for up to 100 rows, and u128 LRU timestamps. These operations use fixed-width integers. The Wasm ABI still uses ordinary pointer, length and handle types where required.

Within a validity interval, a page can reuse its body after a range comparison. Crossing an expiry boundary recomputes claimability and the body. Clock rollback, noncanonical legacy expiry strings, database changes and page eviction retain their tested behavior. The JavaScript boundary holds an owned immutable byte array, so another request or a change in Wasm memory cannot overwrite an outstanding response.

| Isolated public-page implementation | Time per call | Speed relative to JS |
| --- | ---: | ---: |
| JS public-page implementation | 42.58 µs | 1.00× |
| Previously submitted Rust with output-buffer reuse | 29.52 µs | 1.44× |
| Extended Rust/u128 with immutable-body reuse | **8.20 µs** | **5.20×** |

This experiment uses 100 public rows and an identical 166,321-byte body, with a stable generation and live expiry checks. Database methods return promises over synthetic rows without SQL or I/O. Each implementation runs twice in reversed order, with five batches of 10,000 calls per run: **300,000 calls** in total. The table is the median of the ten per-batch times. The extended implementation is **3.60× faster than the previously submitted Rust implementation** in this test. These are measured implementation improvements combining Rust processing, fixed-width state and reuse. [All batches](projection-inner.json).

## Complete HTTP results

All variants return matching JSON bodies through the real application and localhost HTTP server. The data contains 2,000 agents, 50,000 tasks and 100,000 verifications. Each list returns 100 tasks; concurrency is four, with 120 warmup requests followed by five batches of 400 measured requests and a separate 400-request profile pass.

| Implementation | Open p50 | Open p99 | Verified p50 | Verified p99 |
| --- | ---: | ---: | ---: | ---: |
| JS public-page control | 8.92 ms | 31.69 ms | 9.96 ms | 41.62 ms |
| Previously submitted Rust | 9.02 ms | 31.85 ms | 9.36 ms | 36.72 ms |
| Extended Rust/u128 | 9.42 ms | 34.07 ms | 8.82 ms | 34.70 ms |
| Extended Rust/u128 plus ETag reuse | **7.45 ms** | **27.63 ms** | **8.61 ms** | **34.43 ms** |

The final comparison contains six runs, **24,000 measured HTTP requests and 12 CPU profiles**. JS and the previous Rust implementation each have one run; the two extended variants each have two, in reversed order. Table values are medians of the equally sized batches' p50 or p99 values. The two ETag runs' open-list p50 values were 7.76 and 6.51 ms; their verified-list values were 8.64 and 8.58 ms. [Aggregates and per-run results](comparison.json), [raw measurements](runs/).

All final runs used Linux arm64, Node 22.23.3, a shared Neoverse-N1 CPU with two assigned CPUs, and 2 GiB memory. The lab disk allocation was expanded from 8 to 12 GiB before this final comparison; CPU and memory assignments stayed constant, and the original fixture-construction procedure was restored. These results describe this measured workload and the repeated-page state of the implementation.

## Where the next cost was found

On a projection hit, the original list SQL is no longer executed. The remaining generation read averaged approximately 0.09–0.11 ms per request in the preceding diagnostic profiles. Those profiles also showed response cloning, digest generation, stream handling and garbage collection after the page-processing work.

The shared ETag middleware was cloning and hashing approximately 167–195 KB on each request. The new path binds a cached tag to the owned immutable body. It preserves Hono's existing 256 KiB chained SHA-1 convention, including larger bodies and conditional requests. A changed body receives a new tag.

| Profile observation | Rust/u128 | Rust/u128 plus ETag reuse |
| --- | ---: | ---: |
| Server CPU per open-list profile request | 3.14 ms | **1.92 ms** |
| Server CPU per verified-list profile request | 3.02 ms | **2.03 ms** |

These CPU values average the two separate 400-request profile passes per implementation and include profiling overhead. HTTP latency is measured separately. ETag reuse shortens open-list HTTP p50 by **20.9%** relative to the extended Rust/u128 path alone; the corresponding verified-list change is **2.4%**. The benefit therefore extends beyond the page-processing function into the common response path.

Application request logs have 1 ms resolution: their medians move from 1 ms to 0–1 ms. Complete HTTP timing also covers delivery of the full body and queueing with four concurrent requests, including work in the measurement client. The reported timing boundaries make the improvement in the internal function and the improvement in complete HTTP delivery visible separately.

## Correctness and reproduction

The final API suite passes **1,159 of 1,159 tests**. The projection-specific tests cover filters, pagination, live public-field changes, certification revocation, expiry and clock rollback, legacy expiry ordering, bounded storage, database isolation, outstanding-response ownership, and ETag agreement across chunk boundaries. Rust unit tests and API type checking also pass. A separate **33-request real-HTTP probe** verifies writes committed through another database connection, rollback, fallback when the generation table is unavailable, unchanged-body 304 responses and changed-body 200 responses with a new tag. [API test results](tests/api-tests.json), [HTTP probe](tests/external-writer-http.json).

The [source overlay](source/), [review diff](changes.patch), compiled Wasm and [file manifest](manifest.json) accompany the measurements. Measured source bytes are preserved. Diagnostic filesystem prefixes are normalized to `/benchmark`; the manifest records original and published hashes for those files. A clean checkout plus the original optional patch and this overlay reproduces all recorded runtime source hashes; [source installation verification](tests/source-installation.json) records that check.

From a fresh checkout of this report's repository, apply the original optional implementation and then this follow-up's source overlay:

```sh
git apply evidence/task-19/optional/task-projection/projection.patch
node evidence/task-19/post-submission/install-source.mjs .
npm ci --no-audit --no-fund
npm run build:dist --workspace=packages/keyring
npm test --workspace=packages/api
npx tsc --noEmit -p packages/api/tsconfig.json
cargo test --manifest-path optional/task-projection/rust/Cargo.toml

TASK_LIST_PROJECTION_MODE=js node bench/run.mjs follow-js-a tasks
TASK_LIST_PROJECTION_MODE=rust-reuse node bench/run.mjs comparison-rust tasks
TASK_LIST_PROJECTION_MODE=rust-u128 node bench/run.mjs comparison-u128 tasks
TASK_LIST_PROJECTION_MODE=rust-u128-etag node bench/run.mjs comparison-etag tasks
node --import tsx bench/projection-inner.ts
node --import tsx evidence/task-19/post-submission/tests/probe-external-writer.mjs . ../http-consistency
```

Use a fresh parent directory and new run labels for another repetition. `tasks` retains the original task-list data, concurrency, warmup, batch size and profiling settings while selecting the two affected endpoints. The original full five-endpoint mode remains available. The recorded Wasm SHA256 is `5181681cb7fa9e6795febb3903db4ee88d8302e2a54c6ad65de0d4beb94eabb9`; its Rust release configuration is included in the source overlay.

## Publication versions

The original delivery references commit `157e94143b75afb736921631952940c6ef897713` and its [original evidence manifest](https://github.com/shadowharness/basedagents/blob/157e94143b75afb736921631952940c6ef897713/evidence/task-19/manifest.json), whose SHA256 is `b02d9f25af7ba47017f3e920492443e2266aff7a9ec5bf6c318ad6f573df9e2e`. That submitted version remains available unchanged. This follow-up is a new publication: the current report pages link here and clarify the scope of the original experiment. The [current evidence manifest](../manifest.json) covers this version, including those updated pages and the follow-up files. The original measurements are preserved.

This is the developer-directed verification checkpoint reached after submission: the three original SQL improvements, a substantially faster Rust/u128 public-page implementation, and measured reuse of the response hash through the shared ETag mechanism.
