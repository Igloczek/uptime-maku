# SQLite E2E snapshot restore audit

Date: 2026-07-13

- Baseline: `ac756282f818e68ce35a47d5d4a3aeff2b759b2d`
- Runtime and tests: `77ac6df5d61ad00cf0cb84894779b49c48fe98f6`

## Result

The development-only SQLite snapshot restore now quiesces iglo.monitor before replacing the database. It stops
background jobs, maintenance schedules, monitor timers, and every in-flight heartbeat; clears runtime, settings,
status-page, uptime, and HTTP response caches; validates a private snapshot copy; atomically swaps the database; and
rehydrates the runtime before responding. Restore requests share a FIFO promise queue, so concurrent E2E setup cannot
close or replace the singleton SQLite connection concurrently.

The original race also exposed a production monitor lifecycle bug. `stop()` cancelled only the next timer and
returned while the current heartbeat could still write. It now invalidates the heartbeat generation and waits for
the active check. Stale checks do not publish a heartbeat, write post-check uptime state, schedule another check, or
log/restart themselves. Pause, restart, delete, shutdown, and the E2E restore use this same lifecycle boundary.

Snapshot validation happens before runtime shutdown. If a later swap or rehydrate step fails, the handler closes any
partially loaded runtime, restores the original file, reconnects SQLite, and fully reloads jobs and caches. The
regression suite forces this path with a SQLite-valid snapshot whose required `setting` table lacks the runtime
columns. Missing files and non-SQLite input also fail without taking the service down.

The E2E barrier uncovered an independent frontend error in monitor details: the shared emitter is mitt-compatible,
but the page used DOM `addEventListener`/`event.detail`. The page now registers and removes the same handler with
`on`/`off` and consumes the direct heartbeat payload. The generated embedded asset bundle was rebuilt. These are the
only visible product changes; the internal snapshot routes remain unavailable in production and compiled builds.

## RED to GREEN evidence

On the exact baseline, the maintenance UI still reported `55 passed (11.2m)`, but each of ten repetitions appended
one hidden backend failure: ten `[MONITOR] ERROR` records and ten
`SQLITE_CONSTRAINT_FOREIGNKEY`/`FOREIGN KEY constraint failed` records. The stack ended in
`uptime-calculator.ts:356`: an old heartbeat wrote after restore had removed its monitor parent row.

The production lifecycle regression test on the unchanged baseline returned from monitor deletion while its HTTP
heartbeat was still held at a deterministic local barrier. The deleted row disappeared before the request was
released, producing the same stale-write boundary. The file finished `4 pass / 1 fail`.

On `77ac6df5`:

- the production lifecycle file is `5 pass / 0 fail / 243 expect()`; deletion remains pending until the request is
  released, then no stale heartbeat event or foreign-key log is emitted;
- the snapshot suite repeated three times is `14/14`, including three active-heartbeat barriers, 300 successful
  serialized restores, missing/non-SQLite rejection, post-swap schema failure recovery, cache rollback, maintenance
  timer removal, and starting a new monitor after restore;
- the same maintenance UI run is `55 passed (11.2m)` with `error.log` empty, zero `[MONITOR] ERROR`, and zero
  foreign-key failures.

## Verification

- `bun run lint`: exit 0; only the repository's existing warnings and stylelint deprecation notices.
- `bun run build`: exit 0; frontend assets, embedded bundle, SQLite template, and executable generated.
- `bun run test:backend`: unit `267 pass / 6 skip / 0 fail / 2,782 expect()`, auth integration
  `13 pass / 0 fail / 424 expect()`, and maintenance integration `9 pass / 0 fail / 143 expect()`.
- Full E2E: `39/39` twice, both with fresh setup data and natural exit 0; both runs had empty `error.log`, zero
  monitor errors, and zero foreign-key failures. This includes SMTP test/send/save/edit/delete through a local sink.
- Compiled production smoke: `/api/entry-page` succeeded; both internal snapshot paths returned only the ordinary SPA
  fallback, never restore text or snapshot phase JSON.
- Final focused snapshot repeat after formatting: `14/14`, empty `error.log`, zero monitor errors, zero FK errors.

The root README was not changed because snapshot restore is an internal development-test route, not a supported
production backup/restore feature or operator interface.

## Idle browser-owner follow-up

A later real-Chrome probe found that monitor quiescence alone did not retire a successful, idle shared browser. On
baseline `2ad99a63`, restore returned HTTP 200 while the captured `playwright_chromiumdev_profile` process remained
alive and the restored database contained no monitor and a null executable setting. RED commit `26f8ef17` preserves
that exact process-level failure. Runtime `e5f62c87` adds the browser cache to the same quiescence boundary: monitors
stop first, then the global browser reset is awaited before SQLite is closed or replaced.

The real-browser snapshot regression starts from a snapshot with no browser config or monitor, saves a local
executable through the production WebSocket API, waits for a successful screenshot heartbeat, and captures the
complete descendant PID set. It then checks both recovery directions:

- a SQLite-valid snapshot with a structurally invalid `setting` table fails after the swap; the old browser is gone,
  the original database and executable setting are restored, and the recovered monitor starts on a different PID;
- a valid restore removes that recovered browser before HTTP completion, restores the null setting and empty monitor
  list, and a subsequent saved setting/check starts a third, distinct owner.

Five final real-Chrome restore samples had a 43.101 ms median versus 13.500 ms across ten baseline samples. The
baseline number is not a successful cleanup latency: each response left its captured process alive. The extra
29.601 ms is the intended cost of waiting for Chrome before a dev-only snapshot response. The ordinary no-browser
restore measurements above remain the relevant steady E2E cost.

The full E2E suite remains `40/40` in two complete Playwright runs, including 100 queued restores per run, forced
post-swap recovery, later monitor creation, and no `error.log`. The compiled production executable still exposes
neither restore semantics nor snapshot state; both paths return only the normal SPA HTML.

## Measurements

All measurements used Bun 1.3.14 on the same Apple arm64 host. The dev restore comparison started each revision's
source server with a private copy of the same 224 KiB SQLite snapshot, then performed 100 sequential loopback
restores. Both logs contained zero `ERROR` or foreign-key entries.

| 100 dev restores | Baseline `ac756282` | Result `77ac6df5` |     Delta |
| ---------------- | ------------------: | ----------------: | --------: |
| Mean             |            1.647 ms |          4.265 ms | +2.618 ms |
| Median           |            1.387 ms |          4.063 ms | +2.677 ms |
| p95              |            2.453 ms |          5.449 ms | +2.996 ms |
| Maximum          |           11.991 ms |         12.431 ms | +0.440 ms |

The additional time pays for integrity/FK validation, runtime quiescence, cache reset, and rehydration in a dev-only
test operation.

For production impact, each revision's compiled executable was started ten times with a fresh copy of that database.
Readiness is the first successful `GET /api/entry-page`; RSS is sampled with `ps` after one second. Processes were
force-stopped only after the sample to avoid including the intentional graceful-shutdown delay in the next run.

- Baseline binary: 91,483,490 bytes, SHA-256
  `c8e621ddb70b2094497e1c71a08b42a609724f6f2813791477e7ecc4e2814fc7`
- Result binary: 91,367,906 bytes, SHA-256
  `dce437126ce310e61e82c5b01466e072a7c6067aa9ddaf6d770300d45733c1af`

| Production executable | Baseline `ac756282` | Result `77ac6df5` |     Delta |
| --------------------- | ------------------: | ----------------: | --------: |
| Median readiness      |          237.815 ms |        242.269 ms | +4.454 ms |
| Median RSS            |         131,232 KiB |       131,136 KiB |   -96 KiB |

Raw readiness samples in milliseconds:

```text
baseline: 210.853, 248.083, 237.815, 214.079, 216.644, 241.103, 241.578, 244.536, 212.520, 238.499
result:   220.406, 242.269, 225.466, 243.918, 244.436, 238.822, 251.698, 353.725, 249.835, 235.815
```

Raw RSS samples in KiB:

```text
baseline: 131184, 131248, 131168, 131280, 131232, 131264, 131264, 131312, 131152, 131136
result:   131184, 131056, 131072, 131280, 131200, 131280, 131088, 131104, 131280, 131136
```

An inactive-monitor lifecycle microbenchmark ran five samples of 100,000 awaited `stop()` calls after warmup. The
baseline samples were `5.175, 4.191, 4.091, 3.923, 5.185 ms`; the result samples were
`7.562, 6.723, 4.676, 5.160, 4.850 ms`. Mean cost was 45.1 ns versus 57.9 ns per empty stop, an absolute delta of
12.8 ns. With an active heartbeat, the new method intentionally waits for the actual check instead of reporting a
false stop; that duration is governed by the monitor request and its configured timeout.

## Residual limits

- An in-flight protocol check can still delay pause, delete, shutdown, or E2E restore until its configured timeout or
  finite phase bounds are reached and cleanup finishes. As of `2045324b`, provider-specific deadlines and cleanup
  prevent the audited network/process operations from waiting without a bound; see the
  [monitor provider deadline and cleanup audit](./monitor-provider-deadline-audit.md). This does not change the
  historical snapshot measurements above.
- Snapshot restore is test harness behavior. It is neither exposed by the production executable nor a replacement
  for an operator-managed SQLite backup and restore procedure.
- Restoring an older snapshot also restores its session rows and JWT secret. A browser holding a newer session must
  authenticate again; the E2E test asserts the UI recovers without page or console errors.
- The restore queue serializes restore operations. E2E tests should still avoid unrelated state mutations while a
  snapshot is deliberately being replaced.
