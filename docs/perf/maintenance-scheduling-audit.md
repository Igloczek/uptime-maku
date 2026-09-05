# Maintenance scheduling audit

Date: 2026-07-13

- Boundary follow-up baseline: `b299847572562e89260f7b5331fb818d6be01de0`
- Final runtime and tests: `0a9ece49a4139432e376aede05d8cca80ec4646a`
- Recovery/commit follow-up baseline: `ce4a099bbfebda1c32287ffe26d5e74008185eae`
- Recovery/commit tests: `07637b3e26262c7b1c0e6a0a2eb57d65aec7c6ef`
- Recovery/commit runtime: `23d37b324a359f0d8eec34e78c2237c6a22349e0`
- Earlier scheduling foundation: `aa6527d1ef6e993055ff22c07e72cd8db15a44d9` to
  `ba8bcaf1519e933b0374283b743d2e3c692c5ed3`

## Result

Maintenance scheduling treats the schedule and its monitor/group/status-page relations as one atomic save. Add and
edit now run an already-active cron silently until `COMMIT`; only a successful commit invalidates the public
status-page cache. A deferred foreign-key failure at the commit boundary verifies that rollback neither publishes
the draft schedule nor evicts a prewarmed response. Successful add, edit, detach, and relation reattach operations
invalidate the cache after commit.

Single schedules own separate one-shot start and end jobs. Restarting inside a window restores only its end job, and
the public cache is invalidated at the real start and end boundaries. Stop, pause, delete, or replacement invalidates
both one-shot jobs and callbacks that were already waiting on asynchronous duration work. Paused schedules stay
paused after restart.

All six UI strategies are covered: manual, single, cron, recurring interval, recurring weekday, and recurring day of
month. The model tests also cover cross-midnight duration, leap/month-end behavior, Europe/Warsaw spring and autumn
DST gaps and overlaps, malformed legacy list JSON, exact job behavior through 20 reloads, and callbacks completing
after stop. Recurring end instants are resolved in the timezone of each occurrence, so a `01:30` to `03:30` window
has the correct elapsed duration on both DST transition days.

The production WebSocket integration verifies authentication and owner isolation for every maintenance mutation,
atomic relation replacement and rollback, restart persistence, and inactive schedules. A real one-second manual
monitor verifies the sequence `MAINTENANCE -> DOWN -> MAINTENANCE -> DOWN`; a local webhook receives zero
notifications during maintenance and exactly one after each exit, while the public status-page API exposes only the
active maintenance window. Delete cleanup is checked directly in all three SQLite relation tables.

The maintenance UI sends schedule and relation data through the atomic server operation. Its E2E flow saves,
reloads, edits, and deletes every strategy and asserts that no page or console errors occur. Reusing the edit route
for add resets processing and all-status-page state. Generation and route guards ignore stale load, relation, and
submit callbacks instead of mutating or navigating the new page.

## RED to GREEN evidence

The exact final tests copied onto a detached `b2998475` worktree produced:

- model/timer suite: `5 pass / 4 fail / 77 expect()`; missing end-job cleanup, occurrence-aware DST timeslots, exact
  single-window restart behavior, and the post-stop async guard were exposed;
- production integration: `4 pass / 4 fail / 116 expect()`; add/edit/cron-start cache invalidation and single-window
  expiry across restart were exposed;
- UI: the all-status-pages checkbox remained selected when edit became add, and a delayed edit callback navigated
  the reused add route away.

On `0a9ece49`, the model/timer suite is `9 pass / 0 fail / 100 expect()` and the production integration is
`8 pass / 0 fail / 123 expect()`. The deferred-commit cache test passed `20/20` consecutive repetitions with
`380 expect()` calls. The maintenance UI file passed `55/55` in a ten-repeat run, including setup and all five
maintenance scenarios.

## Verification

- `bun install --frozen-lockfile --offline`: no changes, exit 0.
- `bun run lint`: exit 0; only the repository's existing warnings.
- `bun run build` and `bun run build:binary`: exit 0; compiled executable produced.
- `bun run test:backend`: unit `248 pass / 6 skip / 0 fail / 2122 expect()`, auth integration
  `13 pass / 0 fail / 424 expect()`, maintenance integration `8 pass / 0 fail / 123 expect()`.
- `IGLO_MONITOR_BINARY=./iglo.monitor bun test ./test/integration-test/maintenance.test.ts`:
  `8 pass / 0 fail / 123 expect()`.
- Full E2E on the exact final runtime: `36/36` twice, each with a fresh setup database and natural exit 0.
- Post-format hook: model/timer suite `9/9 / 100 expect()` and lint exit 0.

All repository gates were run sequentially because the build regenerates the SQLite template and embedded asset
bundle. The lint output contains only the repository's existing warnings and stylelint deprecation notices.

## Compiled-runtime measurement

Each sample starts the revision's own compiled arm64 executable with a fresh temporary SQLite directory on
`127.0.0.1`, polls `GET /` every 5 ms until success, records wall time and process RSS from `ps`, sends `SIGTERM`,
and removes the directory. Five baseline/final pairs were alternated on the same host. The first pair includes cold
host-cache cost; medians reduce its effect.

- Baseline binary SHA-256: `3440825f6822a00f7922ae4c816574971109e50e20de351b2144803a70255349`
- Final binary SHA-256: `23c08b3a344e1f3c2a7374bf66e5e4fdd0f5afa1716960fa918868ce0cfec259`

Command shape:

```bash
bun /tmp/benchmark-maintenance-startup.ts <baseline-binary> <baseline-revision> <final-binary> <final-revision> 5
```

| Revision | Ready samples (ms)                           | Median (ms) | RSS samples (KiB)                      | Median (KiB) |
| -------- | -------------------------------------------- | ----------: | -------------------------------------- | -----------: |
| Baseline | 1464.948, 293.478, 290.549, 323.295, 292.249 |     293.478 | 188960, 189024, 189040, 189408, 189168 |       189040 |
| Final    | 1387.809, 294.064, 292.119, 299.620, 295.145 |     295.145 | 189264, 189136, 189152, 189488, 189152 |       189152 |

The measured median delta is +1.667 ms ready time and +112 KiB RSS, effectively neutral at this sample size. The
scheduler still has no recurring polling loop. Cron/recurring schedules own one Croner job and only an active-window
timeout while running; a single schedule owns at most one start and one end job.

Raw samples:

```json
{"revision":"b299847572562e89260f7b5331fb818d6be01de0","sample":1,"readyMilliseconds":1464.948417,"rssKiB":188960}
{"revision":"0a9ece49a4139432e376aede05d8cca80ec4646a","sample":1,"readyMilliseconds":1387.809125,"rssKiB":189264}
{"revision":"b299847572562e89260f7b5331fb818d6be01de0","sample":2,"readyMilliseconds":293.478,"rssKiB":189024}
{"revision":"0a9ece49a4139432e376aede05d8cca80ec4646a","sample":2,"readyMilliseconds":294.064042,"rssKiB":189136}
{"revision":"b299847572562e89260f7b5331fb818d6be01de0","sample":3,"readyMilliseconds":290.548917,"rssKiB":189040}
{"revision":"0a9ece49a4139432e376aede05d8cca80ec4646a","sample":3,"readyMilliseconds":292.119042,"rssKiB":189152}
{"revision":"b299847572562e89260f7b5331fb818d6be01de0","sample":4,"readyMilliseconds":323.295042,"rssKiB":189408}
{"revision":"0a9ece49a4139432e376aede05d8cca80ec4646a","sample":4,"readyMilliseconds":299.620375,"rssKiB":189488}
{"revision":"b299847572562e89260f7b5331fb818d6be01de0","sample":5,"readyMilliseconds":292.249291,"rssKiB":189168}
{"revision":"0a9ece49a4139432e376aede05d8cca80ec4646a","sample":5,"readyMilliseconds":295.144792,"rssKiB":189152}
```

## Recovery and commit-boundary follow-up

The follow-up fixes three production boundaries found after the first audit:

- a recurring `02:00` or `02:30` Europe/Warsaw start in the spring DST gap now begins at `03:00` and keeps its
  nominal same-day duration, while ordinary DST-spanning, overlap, and cross-midnight windows retain their elapsed
  time semantics;
- an invalid timezone in a legacy row falls back to the server timezone for runtime calculation and serialization,
  but its raw `timezoneOption` is retained rather than silently rewritten;
- startup and transaction-validation recovery recreate only the required in-memory job/timeout. They do not write
  `last_start_date`, invalidate caches, broadcast, or notify. A failed edit therefore restores the exact persisted
  row and exact live/public state.

Maintenance mutations now separate transaction success from publication. Add and edit acknowledge success exactly
once after `COMMIT`; pause, resume, and delete also acknowledge exactly once. A post-commit list/cache publication
failure is logged without turning a committed mutation into a false failure or trying to roll it back. True
pre-commit persistence failures still roll back and report failure.

### Follow-up RED to GREEN evidence

The exact tests from `07637b3e` applied to a detached `ce4a099b` worktree produced:

- model/timer suite: `8 pass / 3 fail / 163 expect()`; the DST-gap end moved to the next day, an invalid legacy
  timezone threw during serialization, and 20 recovery loads performed 20 unwanted stores/publications;
- production integration: `7 pass / 2 fail / 120 expect()`; malformed legacy timezone made committed add/edit
  return failure, and a deferred foreign-key rollback advanced `last_start_date` by one second;
- the isolated post-commit case returned one false callback for add/edit and two callbacks for pause/resume/delete
  (success followed by false).

On `23d37b32`, the model/timer suite is `11 pass / 0 fail / 168 expect()` and production integration is
`9 pass / 0 fail / 143 expect()`. The post-commit callback case passed `20/20`, the exact rollback case passed
`20/20`, and the combined DST/legacy/recovery model cases passed `20/20`.

### Follow-up verification

- `bun install --frozen-lockfile --offline`: 856 installs, 890 packages, no changes, exit 0.
- `bun run lint`: exit 0; only the repository's existing warnings and stylelint deprecation notices.
- `bun run build` and a separate `bun run build:binary`: exit 0.
- `bun run test:backend`: unit `250 pass / 6 skip / 0 fail / 2190 expect()`, auth integration
  `13 pass / 0 fail / 424 expect()`, maintenance integration `9 pass / 0 fail / 143 expect()`.
- Exact compiled arm64 executable: maintenance `9/9 / 143 expect()`, SMTP production socket `1/1 / 6 expect()`,
  and auth `13/13 / 424 expect()`.
- Full E2E: `36/36` twice, both with a fresh setup database and natural exit 0.
- Maintenance UI: `55/55` in a ten-repeat run, including setup and all five maintenance scenarios; no page or
  console errors.

The executable built from `23d37b32` has SHA-256
`c486ba15f62a43101018c4acb24067008dcb65267e2fc5d9dbb2f18c6f9fd208`.

### Follow-up compiled-runtime measurement

The measurement method is unchanged: each sample starts the revision's own compiled arm64 executable with a fresh
temporary SQLite directory on a random loopback port, polls `GET /` every 5 ms, records wall time and RSS, sends
`SIGTERM`, and removes the directory. Five baseline/final pairs were alternated on the same host.

- Baseline binary SHA-256: `0a0b2cb7fc30eacacfce8617052312b46c1b30946240944f1804492d2187e710`
- Final binary SHA-256: `c486ba15f62a43101018c4acb24067008dcb65267e2fc5d9dbb2f18c6f9fd208`

| Revision | Ready samples (ms)                           | Median (ms) | RSS samples (KiB)                      | Median (KiB) |
| -------- | -------------------------------------------- | ----------: | -------------------------------------- | -----------: |
| Baseline | 1493.627, 980.648, 315.919, 317.736, 326.972 |     326.972 | 187888, 187648, 187744, 187808, 188144 |       187808 |
| Final    | 441.606, 374.420, 316.804, 318.211, 329.699  |     329.699 | 187472, 186736, 187968, 187808, 187824 |       187808 |

The measured median delta is +2.727 ms ready time and 0 KiB RSS, effectively neutral at this sample size.

Raw samples:

```json
{"revision":"ce4a099bbfebda1c32287ffe26d5e74008185eae","sample":1,"readyMilliseconds":1493.626959,"rssKiB":187888}
{"revision":"23d37b324a359f0d8eec34e78c2237c6a22349e0","sample":1,"readyMilliseconds":441.60599999999977,"rssKiB":187472}
{"revision":"ce4a099bbfebda1c32287ffe26d5e74008185eae","sample":2,"readyMilliseconds":980.6478749999997,"rssKiB":187648}
{"revision":"23d37b324a359f0d8eec34e78c2237c6a22349e0","sample":2,"readyMilliseconds":374.4197920000006,"rssKiB":186736}
{"revision":"ce4a099bbfebda1c32287ffe26d5e74008185eae","sample":3,"readyMilliseconds":315.91920800000116,"rssKiB":187744}
{"revision":"23d37b324a359f0d8eec34e78c2237c6a22349e0","sample":3,"readyMilliseconds":316.8039169999993,"rssKiB":187968}
{"revision":"ce4a099bbfebda1c32287ffe26d5e74008185eae","sample":4,"readyMilliseconds":317.73579099999915,"rssKiB":187808}
{"revision":"23d37b324a359f0d8eec34e78c2237c6a22349e0","sample":4,"readyMilliseconds":318.210833000001,"rssKiB":187808}
{"revision":"ce4a099bbfebda1c32287ffe26d5e74008185eae","sample":5,"readyMilliseconds":326.9720000000016,"rssKiB":188144}
{"revision":"23d37b324a359f0d8eec34e78c2237c6a22349e0","sample":5,"readyMilliseconds":329.6990829999995,"rssKiB":187824}
```

### SQLite isolation follow-up

The later [SQLite transaction isolation audit](./sqlite-transaction-isolation-audit.md) closes a cross-request
boundary that this maintenance audit did not originally exercise: an unrelated pause could use the singleton SQLite
connection while an edit transaction was awaiting commit. The new deterministic regression test holds a deferred-FK
edit commit, sends pause concurrently, and verifies callback order plus database, live scheduler, and response-cache
state after rollback.

## Residual limits

- Malformed legacy weekday/day JSON is handled safely as an empty list, and an invalid legacy timezone uses the
  server timezone, but iglo.monitor does not rewrite either corrupted value automatically.
- Existing manually inserted duplicate relation rows are deduplicated on the next save; the legacy SQLite tables do
  not have a new uniqueness constraint.
- Status pages are global in the current SQLite schema and therefore cannot be owner-filtered like monitors.
- Calendar tests exercise a representative DST timezone and boundary cases, not every IANA timezone transition.
