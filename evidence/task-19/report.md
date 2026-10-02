# BasedAgents API: three measured index optimizations

Three indexed read paths reduce the fixed-workload p50 from 327.18 to 35.97 ms (open tasks), 371.68 to 38.60 ms (verified tasks), and 233.50 to 21.89 ms (status): approximately 9.1×, 9.6× and 10.7×. Paired profiles, 60,000 request timings, later controls and full tests establish the contribution of each of three independent commits.

The fixed localhost workload identifies three dominant SQLite read costs: ordering task listings, finding the latest verification, and evaluating the paid-task population. Three separate commits add indexes while retaining the existing queries and eligibility predicates. Each change has its own full repository test run and endpoint/profiler comparison against the preceding version.

## Reproduction and source

Pinned upstream: `13cd578b05a85a6640bd6748b71a58e3135fe276` from [maxfain/basedagents](https://github.com/maxfain/basedagents/tree/13cd578b05a85a6640bd6748b71a58e3135fe276).

Apply the six files in `patch/` in filename order with `git am patch/*.patch` on that exact upstream. The first three commits provide the benchmark harness and analysis; the last three are independent optimizations. A fresh checkout applied all six patches and matched every measured source tree: see `patch-verification.json`. `commit-map.json` maps measured revisions to the public commits, whose source trees are identical.

Install with `npm ci --no-audit --no-fund` and `npm run build:dist --workspace=@basedagents/keyring`. Run `npm test`, then `node bench/run.mjs <new-label> full` at each revision. Use a new label every time. Before comparisons, check the runtime and workload hashes in `runs/<label>/metadata.json`. The harness creates a new fixture and binds only to localhost; it receives no payment, mail or webhook credentials and disables external fetch.

For an automated fresh-checkout reproduction, run `node reproduce.mjs <new-parent-directory> full` from this evidence folder on the recorded Linux/Node version. It downloads the public upstream, checks out the pinned commit, applies every patch while verifying each source tree, runs the full test suite at the baseline and each optimization, and executes the six benchmark stages. `smoke` in place of `full` checks the wiring with fewer requests. That complete smoke workflow was executed from a fresh checkout: all four full test suites and all six smoke runs passed, and all 30 endpoint responses match the full baseline. See `reproduction-verification.json` and `tests/reproduction-smoke.log`; smoke timings are excluded from every performance table.

Environment: Linux arm64, Node 22.23.3, shared Neoverse-N1 CPU with two assigned CPUs and 2 GiB memory. All six endpoint runs used the same container, data recipe, workload, server and driver code. No test suite or supplemental write benchmark ran concurrently with those measurements.

Data: 2,000 agents, 50,000 tasks and 100,000 verifications. Tasks are evenly distributed over five lifecycle states; half the verified tasks have synthetic settled payments. Every identity and transaction hash is synthetic. This scale fixture is defined in `bench/workload.json` and `bench/server.ts`; it does not describe production traffic.

Every endpoint receives 120 warmup requests followed by five sequential batches of 400 requests, at concurrency four. HTTP timing ends after receiving the full body. A separate 400-request pass records V8 CPU samples, synchronous SQL call time and query plans. Profile time is not reported as HTTP latency. `comparisons.json` preserves all p50/p99 medians and batch ranges, and `runs/` retains all 60,000 measured request durations. Quantiles and saved response hashes were recomputed from those originals.

## Changes and attribution

| Change | Measured commit | Immediate before/after runs | Target SQL time, ms/request |
| --- | --- | --- | ---: |
| Task state and creation-time index | `8ed6574` | `baseline-02` → `opt1-01` | open 91.62 → 5.84; verified 102.84 → 5.34 |
| Verification creation-time index | `167983b` | `opt1-01` → `opt2-01` | latest verification 31.85 → 0.0689 |
| Exact paid-population partial index | `5313ddd` | `opt2-01` → `opt3-01` | paid totals 28.63 → 0.9253 |

The first index removes the temporary ordering tree on the two task-list paths. The second turns the latest verification lookup into an ordered covering-index lookup. The third makes the current settled-mainnet/non-refunded/valid-transaction population an index membership condition, with amount available for the existing integer sum. It does not remove transaction validation or change the payment query. The exact before/after plans, SQL measurements and CPU profiles are under `profiles/<run>/`; the corresponding summaries are under `summaries/`.

The V8 samples corroborate the query timing: native `all` self-sampled time during the open-list profile falls from 35,337.75 to 625.14ms after change 1 (verified-list: 39,916.49 to 602.24ms). In the status profile, native `get` self-sampled time falls from 24,635.26 to 13,324.40ms after change 2, then to 730.29ms after change 3. These are totals over each separate 400-request profile pass, not endpoint latency. The `get` frame aggregates several SQL calls; the per-query measurements and plans above distinguish the two status costs.

The partial predicate retains the existing release-hash precedence, including exclusion when a nonempty invalid release hash hides a valid payment hash. If the application later broadens its eligible networks or predicate, reassess the index; these measurements concern the pinned query.

## Endpoint results

Numbers below are medians across the five batch p50 or p99 values, in milliseconds. Each batch contains 400 requests; the complete ranges are in `comparisons.json`.

| Endpoint | Initial p50 | Final p50 | Initial p99 | Final p99 |
| --- | ---: | ---: | ---: | ---: |
| tasks, open, limit 100 | 327.18 | 35.97 | 567.51 | 73.68 |
| tasks, verified, limit 100 | 371.68 | 38.60 | 669.47 | 92.89 |
| agent profile | 3.54 | 3.53 | 9.13 | 9.92 |
| status | 233.50 | 21.89 | 419.62 | 32.94 |
| chain | 4.41 | 3.29 | 12.72 | 6.92 |

For individual attribution, change 2 reduced status p50 from 230.94 to 128.77 and p99 from 457.95 to 225.52. Change 3 then reduced p50 to 21.89 and p99 to 32.94. Task listing gains are attributed to change 1. Profile and chain are controls; no causal speedup claim is made for them.

A later fresh-process unchanged-source control followed by the optimized source produced:

| Endpoint | Baseline control p50 | Optimized control p50 | Baseline control p99 | Optimized control p99 |
| --- | ---: | ---: | ---: | ---: |
| tasks, open | 336.76 | 35.97 | 694.58 | 73.07 |
| tasks, verified | 393.06 | 41.41 | 859.58 | 146.09 |
| agent profile | 3.55 | 3.61 | 8.76 | 8.86 |
| status | 236.55 | 21.65 | 411.85 | 35.45 |
| chain | 3.33 | 3.29 | 6.69 | 5.91 |

The selected improvements remain much larger than the baseline drift. Tail latency varies: the verified-list optimized p99 range in the last run was 78.96–170.34ms. The initial agent-profile p50 increased about 4.3% after change 1; later control ranges overlap, so that initial change is retained as an unresolved small variation, not suppressed or described as a gain. These are closed-loop local Node/SQLite results, not production or Cloudflare D1 predictions.

## Correctness and scope

The full test suite passed after every optimization: 98 files/1,706 tests after changes 1 and 2, and 98 files/1,707 tests after change 3. The upstream baseline passed 97 files/1,705 tests. Commands, complete text output and hashes are indexed in `comparisons.json` and `tests/`.

All five endpoint responses match the baseline throughout all six performance runs. Only the status response's clock-dependent `checked_at` and `db_latency_ms` diagnostics are excluded. Arrays are not sorted for comparison and no additional fields are removed.

The endpoint retains the existing filters, public fields and descending creation-time order. SQLite does not prescribe relative order when all ORDER BY keys tie ([SQLite ordering specification](https://www.sqlite.org/lang_select.html#orderby)). The index can change which equal-date rows appear first; registration order is not promised by this query. An independent actual-API probe checks 1152 static combinations of equal/grouped dates, insertion permutations, filters, limits and before/after mutation snapshots. Each complete page traversal has the expected ID set, no duplicates and descending dates; per-ID public values agree. See `supplemental/fast-pagination-contract.json` and its executable probe. This verifies completeness within each fixed snapshot; offset pagination across intervening writes retains its existing behavior. The full performance workload uses the exact same response bodies in every variant.

The same supplemental script runs the real paidTotals function and SQLite adapter with the actual migration: valid/invalid and empty release hashes, refunds, testnet, null/empty settlement timestamps, and pending payment are exercised. Five independently expected population states agree with and without the index, including updates into and out of eligibility. Reapplying the migration leaves exactly one index; integrity and foreign-key checks pass. Directly inserted negative/out-of-range monetary values are outside this test's accepted API-input scope.

## Write and storage cost

The indexes move work to writes and consume space. The fixed baseline database uses 20,688 pages of 4,096 bytes. The first, second and third indexes respectively add 503, 808 and 76 pages, totaling 5,681,152 additional bytes before the supplemental writes.

Separate write trials clone the same baseline into four databases, apply zero through three indexes, and rotate variant order over five rounds. Each transaction commits 1,000 operations with WAL and synchronous NORMAL. `supplemental/write-cost.json` retains samples and ranges. Baseline versus all-index median task inserts are 21.53 vs 22.45ms, verification inserts 6.49 vs 7.64ms, and paid-eligibility updates 468.70 vs 558.35ms per transaction. Update ranges are broad; these supplemental numbers disclose costs and are not endpoint throughput claims or precise marginal causal estimates.

## Unsuccessful attempts and memory contribution

An amount-only partial index was explored with query plans; SQLite continued to choose the original index. It was not promoted to an endpoint performance claim. The adopted search-key-plus-amount variant was then measured through the complete API workload. Initial test fixtures also caught a missing required field, index parity omissions, and a multiline test-helper index statement that was applied incompletely; these were corrected before the passing runs. An interrupted early benchmark with an older measurement file is excluded from every comparison.

Source-linked experience recalled through Sidera was used to recheck SQL versus HTTP measurement boundaries and unchanged-baseline controls for shared-CPU variation. The instrumentation already existed; the memory contribution was method verification, and historical timings were not reused. Current profiles selected the costs and current endpoint measurements establish the improvements. A further memory-informed hypothesis concerns bounded reuse of public-row fragments and Rust/Wasm assembly; its implementation and measurements are reported separately when included. Private memories and consultation material are excluded.

The work uses public sources and a dedicated synthetic local environment. No production load test, real payment, upstream issue or pull request was performed.


## Additional public-fragment reuse

An optional implementation keeps bounded public-row fragments behind SQL generation checks and compares JS assembly with Rust/Wasm, separating the output-buffer allocation switch. On the indexed baseline, repeated open-list p50 is 38.27 ms (SQL), 10.47 ms (JS), 9.74 ms (Rust/fresh) and 9.81 ms (Rust/reuse). The corresponding verified-list values are 38.62, 10.10, 10.99 and 10.17 ms.

Eight alternating complete runs add 80,000 timings. Four modes of cold, recurring, cycling and read/write workloads add 24,160 timings, with 52 additional profiles in total. The [separate report](optional/task-projection/report.md) gives batch ranges, CPU, process memory, correctness tests, build instructions and a patch applying after the six core patches. Reuse and Rust contributions are evaluated separately; these optional results do not replace the three individual optimization comparisons.
