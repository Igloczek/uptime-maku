# SQLite transaction isolation audit

## Scope and result

iglo.monitor uses one Bun SQLite connection. The original isolation work added a private transaction owner and a FIFO
barrier so ordinary store operations could not join somebody else's transaction. A follow-up failure audit found one
remaining unsafe terminal state: if both `COMMIT` and its defensive `ROLLBACK` failed, or an explicit `ROLLBACK`
failed, the store released queued work onto the same connection while SQLite could still be inside the old
transaction. It also found a public raw-database escape and two transaction callsites whose first statement ran
outside their rollback guard.

The regression-test commit is `7d22425776c696c03cf0c08a3be39b55c06d90c3`. Applied to unchanged runtime
`71de12422892b15225e7075e56faaa99410b8aef` (repository revision `8972e5c6dc8e59255f4e1d09444f03a2e961ecbe`),
the focused suites produced `31 pass / 6 fail / 312 expect()` with a natural exit. The failures proved that:

- a failed `COMMIT` followed by a failed `ROLLBACK` lost the rollback error and released queued work;
- a failed explicit rollback also released queued reads and writes;
- the native database remained reachable through the public `db` property and there was no safe `isOpen()` query;
- the first status-page delete and the first maintenance-edit operation could fail after `BEGIN` but before entering
  their rollback guards.

A detached baseline probe made the transaction leak observable from a second SQLite connection:

```json
{
    "runtime": "8972e5c6",
    "commitError": "forced commit failure",
    "outsideResolved": true,
    "rawInTransaction": true,
    "ownerRows": ["inside", "outside"],
    "observerRows": []
}
```

The hardening runtime is `56243ca04f48b55323856b256850ae2cb67343e1`. The store now permanently quarantines
the detached native connection whenever rollback fails. It rejects queued and future operations, rejects `connect()`
and later `begin()` calls, and closes the detached connection on a best-effort basis. A combined commit/rollback
failure is reported as an `AggregateError` containing both failures; an explicit rollback failure remains the primary
error. `close()` remains idempotent and cannot deadlock behind a poisoned transaction.

The native handle is now a JavaScript private field. Production code uses `isOpen()` for lifecycle checks, and schema
migrations receive a short-lived capability exposing only schema operations. The capability is invalidated after the
schema phase and cannot query rows, run arbitrary DML, close the store, or return the native database. The first
status-page delete and `bean.stop()` in maintenance edit now execute inside their transaction guards. All five
production `begin()` callsites were audited, and forced-first-operation tests cover migration data, maintenance add
and edit, relation replacement, and status-page save.

No transaction timeout or queue cap was added. There was no prior timeout or capacity policy. Every production
`begin()` callsite has an explicit commit/rollback guard, and a healthy queue remains FIFO with the synchronous fast
path unchanged. A forgotten healthy transaction therefore still blocks later work instead of admitting it into an
unknown transaction.

## Correctness and stress evidence

The final focused suites pass `44/44` tests and `859` assertions. Three consecutive runs completed naturally in
0.62-0.66 seconds. They cover every public read/write method, FIFO ordering, queued transactions, commit and rollback,
deferred-FK commit failure, both rollback-failure paths, error aggregation, stale and repeated finalizers, close,
post-poison rejection, native-handle privacy, and all production transaction callsites.

The poison stress runs 100 independently constructed stores, alternating explicit rollback failure with combined
commit/rollback failure. Its first cycle queues 500 mixed reads, writes, and transactions. Every waiter rejects, the
external observer sees zero uncommitted rows, later operations remain rejected, and every store closes without an
unhandled rejection or deadlock. This is a finite 500-waiter stress sample; the production queue is not capacity
bounded.

The full source maintenance integration suite passes `9/9` tests and `143` assertions with a natural process exit. It
covers add/edit/pause/resume/delete, monitor and status-page relations, rollback and restart recovery, real monitor
suppression, webhook publication, and public response-cache behavior.

## Final verification

- `bun install --frozen-lockfile`: 856 installs across 890 packages, no changes, exit 0.
- `bun run lint`: exit 0; only the repository's existing warnings and stylelint deprecation notices.
- `bun run build` and a separate `bun run build:binary`: exit 0.
- `bun run test:backend`: unit `265 pass / 6 skip / 0 fail / 2,774 expect()`, auth integration
  `13 pass / 0 fail / 424 expect()`, and maintenance integration `9 pass / 0 fail / 143 expect()`.
- Fresh compiled arm64 executable: generic fresh-data smoke (`/setup` and `/api/entry-page` HTTP 200, graceful
  `SIGTERM` exit 0), maintenance `9/9 / 143 expect()`, SMTP production socket `1/1 / 6 expect()`, and auth
  `13/13 / 424 expect()`.
- Post-build focused transaction suites: `44/44 / 859 expect()`.
- Full E2E: `36/36` twice, both with a fresh setup database and natural exit 0.
- Maintenance UI: `55/55` in a ten-repeat run, including setup and all five maintenance scenarios.

The verified 91,367,906-byte executable has SHA-256
`28659c4118ac28956e66fd1ab5b73ba1baf17c2ac70b02ccfd1d195a215e7b93`.

## Benchmark method

Raw samples are in [`sqlite-transaction-isolation-benchmark.ndjson`](./sqlite-transaction-isolation-benchmark.ndjson).
Both revisions in each comparison were run five times with Bun 1.3.14 on an Apple M1 Mac mini with 16 GiB RAM. Each
fresh process copied the same SQLite template in `journal_mode=MEMORY`, warmed 500 inserts, forced a full Bun GC, then
measured:

1. 5,000 awaited, non-contended inserts;
2. 500 inserts submitted while a transaction was held for 25 ms and then rolled back;
3. post-GC RSS before and after the measured work.

The original isolation comparison showed why the FIFO was required:

| Median                          | Baseline `549881bb` | Isolated `71de1242` |
| ------------------------------- | ------------------: | ------------------: |
| Non-contended inserts           |        15,405 ops/s |        15,774 ops/s |
| Contended completion p95        |             0.63 ms |            56.79 ms |
| Contended drain after release   |             0.23 ms |            31.57 ms |
| Contended writes preserved      |           **0/500** |         **500/500** |
| Fixed-path contended throughput |             invalid |         8,552 ops/s |
| Post-GC RSS delta               |            2.27 MiB |            4.00 MiB |

The baseline's apparent contention speed was invalid: all 500 operations ran inside the held transaction and were
rolled back. The isolated p95 includes the deliberate 25 ms hold plus draining 500 real SQLite writes.

The rollback-failure hardening was then measured against the already isolated runtime with a new paired five-process
sample:

| Median                        | Isolated `71de1242` | Hardened `56243ca0` |     Delta |
| ----------------------------- | ------------------: | ------------------: | --------: |
| Non-contended inserts         |        19,920 ops/s |        19,923 ops/s |    +0.01% |
| Contended completion p95      |            56.06 ms |            57.84 ms |    +3.17% |
| Contended drain after release |            29.71 ms |            31.08 ms |    +4.62% |
| Contended throughput          |         8,712 ops/s |         8,448 ops/s |    -3.02% |
| Contended writes preserved    |         **500/500** |         **500/500** |         - |
| Post-GC RSS delta             |            3.84 MiB |            3.72 MiB | -0.12 MiB |

The healthy synchronous fast path is flat within run-to-run noise. The quarantine logic is reached only after a
rollback failure; the healthy contended path shows a small 3-5% latency variance and preserves all rows in both
revisions. The 500 simultaneous waiters used here are a finite measurement sample, not a queue bound or a memory
guarantee.
