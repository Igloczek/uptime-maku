# Monitor provider deadline and cleanup audit

Date: 2026-07-14

- RED-test baseline: `5add23ce1c67b6c46a958e2e5854fef89c8d7ff1`
- Runtime implementation: `2045324bf7e83d805088e1b73c4687294e789659`
- Audit documentation: `98defe4b`
- Final integration harness: `e48a377751543b322db71a1601724f25396b993f`
- Numeric-validation RED tests: `aed6b97cf96fd6266689d1828f1a415eaeaa70a8`
- Legacy-runtime RED tests: `02739620`
- Numeric-validation runtime: `f48b6f7dba188f7f845846dc79c492858cfeb83c`
- Compiled lifecycle harness: `f57f53f5`
- SNMP retry-quantization RED tests: `32cf1bed529d8bf1ecac6ad4982b8f5b6b75d8d1`
- SNMP deadline and numeric-bound runtime: `893d205450605516c0712368cc36916f9f8b7952`
- Browser numeric-bound coverage: `0dffe846f51cd66a6914c06368f18e45d738bde6`
- Real-browser lifecycle RED tests: `af9d84f8`
- Real-browser lifecycle runtime: `4188beaf`
- Screenshot-delay transport RED tests: `a8f96e9c`
- Screenshot-delay transport runtime: `97b70906`
- Compiled real-Chromium lifecycle harness: `51b39d14`
- Pending-acquisition RED tests: `5746e720`
- Pending-acquisition runtime: `c09b3b0f`
- Pending-acquisition boundary tests: `83511617`

`5add23ce` adds the deterministic RED tests only, so its runtime is identical to `295ca265`.

## Result

The network and process operations audited in this change now derive their bounds from the monitor's existing
`timeout` setting. Multi-phase checks either carry one absolute deadline forward, divide the budget among a known
number of sequential operations, or cap each phase independently. Connections, requests, subprocesses, and library
clients are closed, destroyed, disconnected, cancelled, or force-ended when a check succeeds, fails, or times out.

This closes the lifecycle gap found by the SQLite snapshot audit for the audited operations: `stop()` still waits for
the active heartbeat, but a stalled network request or subprocess no longer leaves that heartbeat pending without a
provider bound and cleanup path. The timeout fallback also remains in seconds (`interval * 0.8`) before providers
convert it to milliseconds; the previous multiplication by 1,000 at assignment time could turn an interval-derived
timeout into an unexpectedly long wait.

The original provider audit covered valid numeric monitor records. A follow-up adversarial pass found that malformed
numeric strings could still be stored through the production WebSocket add/edit path, and a legacy malformed timeout
could bypass the provider deadline after restart. The numeric-validation commits listed above close that separate
input and legacy-data gap without rewriting legacy rows during a read.

The implementation does not add a second cancellation setting or an operator workflow. The existing monitor timeout
is the source of the audited I/O bounds and their cleanup triggers.

The SNMP follow-up found a timer-quantization exception to that result. Dividing a 100 ms whole-check budget among
101 or 1,001 attempts produced sub-millisecond per-attempt timers, but Bun and `net-snmp` scheduled each attempt at
roughly one millisecond. A stored retry count could therefore multiply the intended deadline. SNMP now keeps a hard
whole-check watchdog in addition to its per-attempt setting, cancels pending library requests, closes the session
exactly once, and ignores late callbacks after settlement.

The real-browser follow-up closes the last unbounded lifecycle phases. One absolute deadline and the monitor's active
heartbeat cancellation signal now cover browser acquisition, `newContext`, `newPage`, navigation, screenshot delay,
screenshot capture, and context cleanup. Pause, delete, snapshot restore, and shutdown can therefore interrupt an
active browser check instead of waiting indefinitely for Playwright. Browser instances are held by explicit local or
per-user remote owners: invalidating an owner closes only that generation, late acquisitions are disposed without
entering the cache, and a timed-out shared browser fails its peers consistently before the next check relaunches.

## Provider inventory

| Monitor family                              | Deadline propagation                                                                                                                                                      | Cancellation and cleanup boundary                                                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP, keyword, JSON query                   | One absolute deadline covers OAuth token acquisition, the request, a single OAuth retry, and optional TLS inspection. Every later phase receives only the remaining time. | HTTP fetches are aborted by the shared client timeout; certificate-inspection sockets are destroyed by their timeout path.                                                        |
| Ping                                        | Each spawned ping attempt receives the monitor timeout without an extra one-second allowance.                                                                             | The subprocess helper sends `SIGKILL` at the attempt bound, including when a child ignores `SIGTERM`.                                                                             |
| Push, manual, group                         | No outbound provider operation runs during a heartbeat.                                                                                                                   | No provider resource is opened; the monitor lifecycle generation remains the cancellation boundary.                                                                               |
| Docker                                      | The Docker API request uses the monitor timeout instead of an interval-derived value.                                                                                     | The HTTP client aborts the request and releases its socket on timeout.                                                                                                            |
| RADIUS                                      | The configured budget is split across the initial UDP request and one retry.                                                                                              | The shared UDP socket closes when a response, error, or final timeout settles the operation.                                                                                      |
| Kafka producer                              | Connect and request limits fit inside one overall timer; library retries are disabled.                                                                                    | The producer disconnects after success, failure, or overall timeout.                                                                                                              |
| DNS                                         | Half of the budget resolves configured resolver hostnames and half performs the requested DNS lookup.                                                                     | Each `Resolver` is cancelled at its phase deadline and its timer is cleared.                                                                                                      |
| GameDig                                     | `attemptTimeout` and `socketTimeout` both derive from the monitor timeout.                                                                                                | GameDig owns the per-attempt socket lifecycle; no independent socket handle is exposed to Uptime Maku.                                                                            |
| Globalping ping, HTTP, DNS                  | One deadline covers HTTP-subtype OAuth, measurement creation, one HTTP 500 retry, and polling. Each client/fetch receives the remaining time.                             | SDK requests use abortable fetch timeouts; polling stops at the same deadline.                                                                                                    |
| gRPC keyword                                | The unary RPC receives a native gRPC deadline.                                                                                                                            | The client is closed in `finally`; expiry cancels the call and the loopback server observes cancellation.                                                                         |
| MongoDB                                     | Connect, server-selection, socket, and command limits share the configured budget; the command receives the remaining time.                                               | The client is closed in `finally`.                                                                                                                                                |
| PostgreSQL                                  | Connect and query limits derive from one deadline; the query receives the remaining time after connect.                                                                   | The client is ended in `finally`, including a stalled protocol handshake.                                                                                                         |
| MySQL                                       | Connection and query operations are each capped by the configured timeout.                                                                                                | Successful connections end normally; timeout and protocol errors destroy the connection.                                                                                          |
| Microsoft SQL Server                        | Connection and request limits derive from one deadline; the request receives the remaining time after pool connect.                                                       | The pool is closed after success or failure.                                                                                                                                      |
| Oracle Database                             | Connection and call limits derive from one deadline; the database call receives the remaining time.                                                                       | The connection is closed after success or failure.                                                                                                                                |
| Redis                                       | Connect and socket limits use the monitor budget, reconnect is disabled, and the command has an abort signal.                                                             | The client is destroyed in `finally`.                                                                                                                                             |
| MQTT                                        | Connect, subscribe, and message wait share one absolute timer; automatic reconnect is disabled.                                                                           | The client is force-ended exactly once on success, error, or timeout.                                                                                                             |
| RabbitMQ                                    | The total budget is divided among the configured nodes.                                                                                                                   | Each node's HTTP request has both a timeout and an abort signal.                                                                                                                  |
| Real browser                                | One absolute deadline covers local launch or remote connect, context/page creation, navigation, screenshot delay, screenshot, and context cleanup.                        | Stop aborts the check. The exact owner is evicted; cleanup escalates from bounded Playwright close to the owned local process or remote channel, and late resources are disposed. |
| SMTP                                        | Connection, greeting, and socket-inactivity timeouts are each capped at half the monitor timeout.                                                                         | The SMTP connection is closed in `finally`.                                                                                                                                       |
| SNMP                                        | Per-attempt time is derived from the configured retry count, while a separate hard watchdog enforces the whole monitor budget despite timer quantization.                 | Deadline calls `cancelRequests()`, then closes the session exactly once; success, callback errors, synchronous failures, and late callbacks share the same settlement guard.      |
| Steam                                       | Hostname lookup, Steam API request, and ping share one deadline.                                                                                                          | The HTTP request is abortable and the ping subprocess is killed at its bound; a late system DNS result is ignored.                                                                |
| SIP OPTIONS, system service, Tailscale ping | Each host command receives the monitor timeout.                                                                                                                           | The shared subprocess helper force-kills commands at the deadline.                                                                                                                |
| TCP, STARTTLS, TLS-alert checks             | Connect, dialogue, and TLS phases are each capped by the monitor timeout.                                                                                                 | Timeout handlers destroy the active socket and clear dialogue timers.                                                                                                             |
| WebSocket upgrade                           | OAuth acquisition and the upgrade handshake are each capped by the monitor timeout.                                                                                       | A failed or expired handshake closes the socket; OAuth fetch is aborted at its bound.                                                                                             |

## RED to GREEN evidence

The regression suite uses loopback peers that accept a request but deliberately never answer. It then calls
`Monitor.stop()` while the provider operation is active and verifies both that stop settles and that the remote side
observes cancellation or socket closure. A separate child-process fixture ignores `SIGTERM` and verifies the hard
deadline.

On `5add23ce`, with a 50 ms monitor timeout:

- the gRPC check was still pending after 250 ms and required forced server cleanup; the failed test took 286.67 ms;
- the PostgreSQL check was still pending after 250 ms and required forced socket cleanup; the failed test took
  261.75 ms.

On `2045324b`, the provider-cleanup file repeated five times completed `40 pass / 0 fail`. Every hanging peer saw its
connection close, and the child that ignored `SIGTERM` was killed. The expanded targeted monitor suite completed
`90 pass / 6 skip / 0 fail`; all six skips are opt-in public TLS/network cases. The monitor lifecycle suite completed
`4 pass / 0 fail`, including deletion waiting for an active check to reach its deadline without a stale write.

On the SNMP RED commit `32cf1bed`, a real loopback UDP sink showed that `timeout = 0.1` seconds completed in about
133 ms with 100 retries and 1,302 ms with 1,000 retries. The latter emitted 1,001 packets. The RED suite also showed
that pause/stop waited on that pending heartbeat. On `893d2054`, deterministic timer tests prove cancellation at the
100 ms whole-check boundary, and real UDP tests prove that pending requests are cancelled, the socket closes, stop
settles, a late callback cannot settle twice, and legacy `maxretries = 1000` is sanitized in memory without rewriting
the row.

On the real-browser RED commit `af9d84f8`, mocked `browser.newContext()` and `context.close()` calls remained pending
after the test's 350 ms observation window; both tests failed and required fixture release to finish. The final
14-case suite covers those two hangs plus stop-before-deadline, late local launch and remote connect, hung page
creation/navigation/screenshot, hung close and process kill, direct `SIGKILL` fallback, deterministic shared-owner
failure, 200 concurrent cancellation races, remote force-disconnect, and the helper acquisition deadlines. It passes
`14/14`; the original two stop cases now settle in about 102–105 ms including the 100 ms cleanup grace.

The transport audit also found that a saved real-browser `screenshot_delay` was absent from `getMonitor` responses
and ignored by `editMonitor`. Commit `a8f96e9c` records both failures through the production WebSocket transport.
The runtime fix serializes the field and keeps its database aliases synchronized on edit, including validation before
persistence. Both regressions pass, and an invalid boundary edit is rejected without changing the stored value.

## Verification

- Backend unit gate: `276 pass / 6 skip / 0 fail / 2,815 expect()`.
- Targeted provider and lifecycle suites: `90 pass / 6 skip / 0 fail` and `4 pass / 0 fail`.
- SNMP suite (including one live Docker-agent case): `3/3`.
- Docker-backed database suites: PostgreSQL `2/2`, MySQL `4/4`, Microsoft SQL Server `8/8`, and Oracle `8/8`.
- Docker-backed messaging suites: RabbitMQ `9/9` and MQTT `19/19`.
- Kafka unreachable-broker cleanup: `1/1`.
- `bun run lint`: exit 0 with only the repository's pre-existing warnings.
- `bun run build`: exit 0 and produced the compiled executable.

### Final validation campaign

The final full integration run exposed a race in the MQTT test fixture, not in the monitor runtime. The fixture's
separate publisher could send a QoS 0 message before the monitor client had completed its subscription, so two nested
topic cases timed out even though the provider deadline and forced cleanup behaved correctly. Commit `e48a3777`
changes only the test harness: it publishes a retained QoS 1 message after the publisher connects, waits for the
broker acknowledgement, and deterministically clears the retained message with QoS 1 before force-closing the
publisher. No runtime source changed in that commit. The MQTT file then completed `95/95` across five repetitions.

Validation from the final code commit produced these results:

- `bun run test:backend:all`: `349 pass / 6 skip / 0 fail / 2,938 expect()`; the six skips are the explicitly opt-in
  public TLS cases.
- Final `bun run test:backend`: unit `276 pass / 6 skip / 0 fail / 2,815 expect()`, authentication `13/13`, and
  maintenance `9/9`.
- Provider cleanup plus monitor lifecycle: `13/13`.
- Compiled executable checks: SMTP notification through the production WebSocket flow `1/1`, authentication
  `13/13`, and setup UI/readiness with a graceful zero-exit `SIGTERM` shutdown.
- Full Playwright E2E: `39/39` twice from fresh state.
- Maintenance UI repetition: `55/55` (`5` setup cases plus `5` maintenance cases repeated ten times), with no
  retries, failures, skips, page errors, or console errors in `11.2m`.
- Final executable SHA-256:
  `4de22dd4efdd5b7c2cb6d995586a5052f9e7ff0f3aaa9f7d2d381783fd05e9bb`.

Cleanup was clean after the campaign: the Playwright data directory was removed, its result recorded no failed
tests, ports `30001` and `51283` had no listeners, no Uptime Maku, Bun test-server, or Playwright process remained,
and the test suites left no owned containers. The only residual verification limits are the six opt-in public TLS
cases. Lint and build completed with only the repository's baseline lint, deprecation, and bundle-size warnings.

### Numeric configuration follow-up

`Monitor.validate()` now parses and validates the numeric fields accepted by monitor add/edit before persistence.
Numeric strings remain compatible with the Vue/WebSocket payload contract, while blank values, malformed strings,
booleans, non-finite numbers, fractions in integer-only fields, negative values, unsafe integers, and values outside
their field bounds are rejected with stable messages. The covered fields are interval and retry timing, resend and
retry counts, provider timeout, redirects, saved-response length, optional port, ping packet/count/per-request
settings, and real-browser screenshot delay. SQLite assertions verify that accepted values are stored as numeric
`INTEGER`/`REAL` values and that failed add/edit requests do not partially mutate rows.

Provider timeout keeps `0` as the automatic `interval * 0.8` sentinel. Explicit provider timeouts are accepted from
`0.1` through `MAX_INTERVAL_SECOND`, matching the browser's 0.1-second step; Oracle uses a one-second minimum because
its driver requires integral connection-timeout seconds. Monitor retries and redirects are integers from 0 through 100. Runtime normalization gives malformed or excessive legacy rows finite safe values before the first provider
operation or push schedule. It deliberately does not write those repaired values back to SQLite. Scheduler delay
normalization independently prevents invalid legacy timing from becoming an immediate loop or overflowing Bun's
timer range.

The RED baseline demonstrated both boundaries through the public transport: invalid add/edit requests succeeded,
and a loopback PostgreSQL handshake with `timeout = 'bogus'` remained pending after 1,500 ms with its socket open.
After `f48b6f7d`, the same legacy fixture uses the 0.8-second fallback for a one-second interval and closes the peer
socket before pause returns. The source and compiled-executable lifecycle paths exercise the same assertions.

Final follow-up verification:

- `bun run test:backend:all`: `363 pass / 6 skip / 0 fail / 3,126 expect()` across 47 files; the six skips are the
  explicitly opt-in public TLS cases.
- `bun run test:backend`: unit `290 pass / 6 skip / 0 fail / 3,003 expect()`, authentication `13/13`, and maintenance
  `9/9`.
- Numeric validation, provider cleanup, scheduler defense, and lifecycle targeted suite repeated three times:
  `25 pass / 5 filtered / 0 fail / 220 expect()` on every run.
- Compiled executable: SMTP production WebSocket flow `1/1`, authentication `13/13`, and numeric/legacy monitor
  lifecycle `2/2`; a fresh production data directory served entry-page/manifest readiness and exited `0` on
  `SIGTERM`.
- Full Playwright E2E: `39/39` twice from fresh state, including SMTP test/save/edit/delete through a local sink.
- Final executable SHA-256:
  `439b2d5cb63b3e968b61f57796618c0c99dd8f12eaabc4e6f4acf4201432be07`.
- Cleanup: no owned Uptime Maku, Bun test-server, or Playwright process and no owned test container remained. Existing
  containers from another workspace were left untouched.

The Docker-backed cases use real protocol servers, not mocked clients. The updated multi-case MySQL, Microsoft SQL
Server, Oracle, RabbitMQ, and MQTT harnesses keep one container per suite. PostgreSQL and SNMP start a container only
for their single live-service case. The suites use explicit startup or test bounds and await teardown so provider
assertions are not obscured by container churn or leaked cleanup.

### SNMP retry-quantization follow-up

The follow-up validation campaign produced these final results:

- `bun run test:backend:all`: `371 pass / 6 skip / 0 fail / 3,221 expect()` across 47 files; the skips remain the
  explicitly opt-in public TLS cases.
- `bun run test:backend`: unit `298 pass / 6 skip / 0 fail / 3,098 expect()`, authentication `13/13`, and maintenance
  `9/9`.
- Numeric/provider/HTTP/Globalping/RADIUS/Steam/GameDig/scheduler targeted inventory: `104/104`; the focused numeric
  and provider files passed three consecutive runs.
- Live Docker SNMP: `3/3`, including a successful query and real timeout.
- Compiled executable: monitor numeric and legacy lifecycle `4/4`, SMTP notification production WebSocket flow
  `1/1`, authentication `13/13`, and maintenance `9/9`; a fresh-data smoke served entry page, manifest, and root with
  HTTP 200 before a graceful exit-code-zero `SIGTERM` shutdown.
- Full Playwright E2E from fresh state: `39/39` twice. The added browser-bound scenario then passed twice and verifies
  native validity at retries/redirects 100 versus 101 and timeout 0.1 versus 0.01 seconds.
- Frozen install, lint, and build succeeded; warnings were limited to the repository's existing lint, Vite
  dynamic-import, deprecation, and bundle-size categories.
- Cleanup removed the Playwright data directory and baseline worktree; no owned Uptime Maku, Bun test-server,
  Playwright, listener, or test container remained. Unrelated Compose containers from another workspace were left
  untouched.
- Final executable SHA-256:
  `1eecb26778ded1012dcafb6cf9982bdf5cd17bc94ee35706febd7c751002e4a1`.

The provider audit also confirmed the intended count semantics. Monitor `maxretries` means retries after the first
attempt; SNMP passes that value to `net-snmp`, but its hard watchdog covers all attempts as one check. Redirects are
separately bounded because they are loop iterations rather than heartbeat retries. HTTP and Steam already carry one
absolute deadline across redirects or phases. RADIUS has one fixed retry, Globalping has one fixed HTTP-500 retry,
Kafka disables library retries and uses one overall timer, and DNS/RabbitMQ/SMTP use bounded multi-phase paths.

### Real-browser lifecycle follow-up

The final real-browser campaign produced these results:

- The focused lifecycle suite passes `14/14`; its 200-check concurrent deadline race produces 200 errors, no late
  successful heartbeat, and exactly one invalidation of the shared browser generation.
- The production WebSocket lifecycle tests preserve and edit `screenshot_delay`, and reject an invalid edit without
  mutating the row.
- `bun run test:backend:all` passes `387 pass / 7 skip / 0 fail / 3,278 expect()` across 48 files. Six skips are the
  existing public TLS cases; the seventh is the explicitly opt-in real-Chromium binary case.
- The normal backend gate passes unit `314 pass / 7 skip / 0 fail / 3,155 expect()`, authentication `13/13`, and
  maintenance `9/9`.
- The compiled executable passes SMTP notification loading `1/1`, authentication `13/13`, and the real-Chromium
  production lifecycle `3/3`. Each browser run verifies the setting and Chrome-test sockets, a successful heartbeat,
  a served PNG, pause during an active navigation in under two seconds, relaunch on resume, deletion, graceful
  shutdown, and disappearance of every owned Chromium PID.
- Frozen install, lint, and build pass. Lint and build output contains only the repository's existing warning
  categories.
- Full Playwright E2E passes `40/40` twice from fresh state.
- The final arm64 executable is 91,400,930 bytes with SHA-256
  `bcab8972f2d4386d13ee8d100a7894694a82a0db16b6cb42a2fa780760832330`.

The public `chromium.launchServer()` plus `chromium.connect()` route was tested before using an internal process
handle. The server listened and was reachable, but Playwright 1.61.0's Bun WebSocket transport did not pass the
headers required by the connection and timed out, including across separate processes. Local launch therefore stays
on the public `chromium.launch()` API. The only internal adapter is isolated in `ownedBrowserProcess()` and reads the
exact-version Playwright 1.61.0 browser-process handle so an unresponsive owned child can receive `SIGKILL`.

### Browser-owner invalidation follow-up

The lifecycle campaign later found one remaining idle-owner gap. A successful check left its shared Chromium owner
cached after an E2E SQLite restore. The restore returned HTTP 200 with the old process tree still alive even though
the restored database had no monitor and `chromeExecutable = null`; a later monitor could reuse that pre-restore
browser and its old launch configuration. Direct settings changes outside the general-settings socket had the same
identity problem because every local browser used the constant cache key `local`.

The exact chain is:

- baseline: `2ad99a638f31ec396476d11ae491f09a55e671b8`;
- RED tests: `26f8ef17`;
- runtime and expanded tests: `e5f62c87`.

Local owner identity now contains the persisted executable setting. A different setting retires the previous owner,
while identical settings still reuse one healthy browser. Every owner also carries an abort signal, so global reset,
monitor stop, timeout, and peer invalidation cancel checks in launch, context, page, navigation, screenshot, and close
phases. Snapshot quiescence and graceful process shutdown both await the same idempotent global reset after stopping
monitors. Remote owners already included user, record, and URL identity; the audit confirmed that remote edit/delete
also await the targeted reset.

The final focused file passes `27/27` in three consecutive runs. It covers concurrent reset calls, reset while a
replacement starts, pending local launch and remote connect, all active page phases, URL and executable changes,
late results, close escalation, a 200-check shared-owner deadline race, and one reset of 100 independent remote
owners. A real local Chrome run verifies source and compiled settings mutation, screenshot serving, pause/resume,
PID replacement, and bounded shutdown. The source-only snapshot run additionally forces a post-swap schema failure:
the old browser disappears, the original database and setting are recovered, the monitor relaunches with a new PID,
and a later successful restore retires that recovered owner before responding.

Verification on this follow-up:

- standard backend gate: unit `327 pass / 8 skip / 0 fail / 3,198 expect()`, authentication `13/13 / 424`, and
  maintenance `9/9 / 143`;
- backend-all: `400 pass / 8 skip / 0 fail / 3,321 expect()` across 48 files; the skips are the two separately run
  browser opt-ins and six public-network TLS cases;
- compiled binary: SMTP `1/1 / 6`, authentication `13/13 / 424`, maintenance `9/9 / 143`, SNMP lifecycle `1/1 / 6`,
  and real-Chrome lifecycle all pass;
- full Playwright E2E: `40/40` twice, including 200 serialized snapshot restores in total, SMTP through a local sink,
  and no `error.log` after either run;
- frozen build and lint pass with only the repository's existing warning categories. Production snapshot paths still
  return the ordinary SPA HTML and expose no E2E operation or state.

## Measurements

All cleanup measurements use a configured provider timeout of 50 ms and deterministic loopback peers. Test duration
includes fixture setup, client scheduling, the timeout itself, and resource teardown, so the expected result is
slightly above 50 ms rather than exactly 50 ms.

| Hanging operation                |                     Baseline at 250 ms | Result median (`--rerun-each=5`) |
| -------------------------------- | -------------------------------------: | -------------------------------: |
| gRPC                             |                          Still pending |                         58.25 ms |
| PostgreSQL                       |                          Still pending |                         56.44 ms |
| MongoDB                          | Not bounded by the baseline regression |                         59.50 ms |
| MySQL                            | Not bounded by the baseline regression |                         57.98 ms |
| Redis                            | Not bounded by the baseline regression |                         58.38 ms |
| SMTP                             | Not bounded by the baseline regression |                         32.90 ms |
| MQTT                             | Not bounded by the baseline regression |                         60.90 ms |
| Child process ignoring `SIGTERM` | Not bounded by the baseline regression |                         54.07 ms |

For the two exact RED cases, the behavior changed from more than five times the configured timeout and still pending
to cleanup at roughly 1.1–1.2 times the timeout including harness overhead. The five result samples were:

```text
gRPC:      69.46, 58.25, 58.12, 58.40, 58.21 ms
Postgres:  56.42, 55.27, 56.83, 56.44, 57.02 ms
MongoDB:   71.07, 58.74, 59.22, 59.50, 60.95 ms
MySQL:     57.98, 59.61, 56.70, 57.98, 58.15 ms
Redis:     65.49, 55.58, 56.97, 59.80, 58.38 ms
SMTP:      34.61, 30.96, 32.90, 32.92, 32.81 ms
MQTT:      84.95, 60.90, 61.18, 58.67, 59.30 ms
process:   54.07, 53.45, 55.30, 53.58, 56.05 ms
```

### Numeric-validation measurements

The validation microbenchmark calls `Monitor.validate()` with one valid numeric monitor payload one million times
per sample. The median increased from 4.291625 ns/call to 7.098375 ns/call: +2.80675 ns/call (+65.4%), an absolute
increase of about 2.8 milliseconds per million monitor saves. This path runs on monitor mutation, not on every
heartbeat.

The legacy PostgreSQL measurement uses a loopback peer that accepts the connection and never completes its protocol
handshake. At the RED baseline it was still pending after 1,500 ms and required manual socket destruction. The final
five samples were 808.819, 804.511, 803.797, 803.275, and 803.993 ms (median 803.993 ms), matching the intended
0.8-second fallback plus fixture overhead.

Compiled startup and resident memory did not regress in the sample medians. Startup changed from 300.136 ms to
299.535 ms (-0.601 ms), and RSS changed from 187,808 KiB to 187,264 KiB (-544 KiB). The first final startup sample
was a cold 1,366.973 ms outlier; it is retained below rather than discarded from the record.

```text
validate baseline: 3.024209, 3.115917, 3.190833, 4.291625, 4.796666, 5.151208, 6.239417 ms / 1,000,000
validate final:    6.640042, 6.662000, 6.707209, 7.098375, 9.907541, 10.430126, 11.085959 ms / 1,000,000
startup baseline:  325.373000, 296.083750, 303.422292, 300.135999, 298.176458 ms
startup final:     1366.973000, 281.315917, 303.245583, 296.258583, 299.535292 ms
RSS baseline:      188304, 186528, 194000, 187088, 187808 KiB
RSS final:         195312, 187264, 187536, 187120, 187072 KiB
```

### SNMP retry-quantization measurements

The SNMP timeout benchmark uses a real loopback UDP socket that records every datagram but deliberately never
answers. Each row is five sequential checks with `timeout = 0.1` seconds. The baseline is the RED commit
`32cf1bed`; the result is `893d2054` plus the test-only browser commit. `maxretries = 1000` represents a malformed
legacy row, which the final runtime sanitizes to zero retries in memory.

| Retry value | Baseline median | Baseline packets/check | Final median | Final packets/check |
| ----------- | --------------: | ---------------------: | -----------: | ------------------: |
| 100         |      133.221 ms |                    101 |   100.467 ms |               75–78 |
| 1,000       |    1,302.219 ms |                  1,001 |   102.970 ms |                   1 |

```text
timeout/retry baseline 100:  133.221, 133.457, 133.014, 135.013, 133.196 ms
timeout/retry final 100:     101.268, 100.279, 100.462, 100.512, 100.467 ms
timeout/retry baseline 1000: 1305.319, 1301.086, 1302.219, 1302.931, 1300.109 ms
timeout/retry final 1000:    102.459, 102.970, 103.192, 102.566, 103.204 ms
```

A healthy local `net-snmp` agent measured normal success overhead over seven batches of 1,000 sequential checks
after 200 warm-ups. The median changed from 0.1490 to 0.1524 ms/check (+0.0034 ms, +2.3%). The valid-save validation
benchmark measured seven batches of 100,000 new monitor models: 0.1370 versus 0.1568 microseconds/call (+0.0198
microseconds). Both are below one percent of a 100 ms minimum provider timeout in absolute terms.

Seven fresh-data compiled starts measured readiness at `/api/entry-page`, RSS after another 100 ms, then graceful
`SIGTERM` shutdown. Median startup changed from 303.91 to 303.20 ms (-0.71 ms), and RSS from 198,272 to 198,368 KiB
(+96 KiB, +0.05%). The cold first baseline sample (1,512.06 ms) and all other samples are retained below. Binary
size changed from 91,500,002 to 91,384,418 bytes (-115,584 bytes).

```text
healthy SNMP baseline: 0.1656, 0.1463, 0.1490, 0.1493, 0.1362, 0.1479, 0.1741 ms/check
healthy SNMP final:    0.1507, 0.1435, 0.1485, 0.1563, 0.1676, 0.1654, 0.1524 ms/check
validation baseline:   0.1980, 0.1432, 0.1323, 0.1370, 0.1325, 0.1462, 0.1368 microseconds/call
validation final:      0.2175, 0.1574, 0.1568, 0.1540, 0.1548, 0.1601, 0.1541 microseconds/call
startup baseline:      1512.06, 303.91, 299.79, 301.98, 304.44, 302.94, 304.44 ms
startup final:         414.12, 298.73, 301.80, 303.20, 307.22, 302.65, 306.64 ms
RSS baseline:          198496, 198528, 198272, 198096, 198128, 198464, 198096 KiB
RSS final:             198480, 198512, 198848, 197248, 198368, 198096, 198080 KiB
```

### Real-browser lifecycle measurements

The browser baseline is the exact pre-follow-up runtime at `8b6c6a3a`. Both builds used Bun 1.3.14, Playwright
1.61.0, and local Chrome 150.0.7871.115. A warm healthy check's seven-sample median changed from 699.680 to
699.255 ms (-0.425 ms, -0.06%). A cold launch/check median changed from 1,096.995 to 1,101.096 ms (+4.101 ms,
+0.37%). The original hung `newContext` and `context.close` stop cases were still pending after 350 ms; the final
mocked stop cases finish in about 102–105 ms, and a real 100 ms browser deadline completed in 122.1 ms with no
remaining Playwright Chromium process.

Seven fresh-data compiled starts measured readiness and RSS. Excluding each cold first start, median readiness changed
from 300.652 to 299.503 ms (-1.149 ms); all-sample RSS medians changed from 187,648 to 190,896 KiB (+3,248 KiB,
+1.73%), within the observed run-to-run spread. Binary size changed from 91,500,002 to 91,400,930 bytes
(-99,072 bytes).

```text
healthy browser baseline: 694.207, 693.015, 690.622, 700.913, 700.147, 699.680, 699.959 ms
healthy browser final:    695.090, 699.255, 694.914, 699.726, 702.517, 699.734, 697.839 ms
cold browser baseline:    1353.597, 1098.558, 1095.400, 1084.421, 1096.995 ms
cold browser final:       1244.019, 1094.106, 1101.755, 1094.359, 1101.096 ms
startup baseline:         1470.067, 299.067, 298.227, 299.978, 304.692, 302.604, 301.326 ms
startup final:            1984.829, 302.733, 299.839, 299.009, 298.604, 303.069, 299.167 ms
RSS baseline:             195472, 187520, 187328, 187456, 196240, 191840, 187648 KiB
RSS final:                187360, 195920, 190896, 193216, 187328, 195872, 187344 KiB
```

### Browser-owner invalidation measurements

The follow-up comparison uses the exact baseline `2ad99a63` and runtime `e5f62c87`, Bun 1.3.14, Playwright 1.61.0,
and local Chrome on the same Apple arm64 host. The mocked healthy reuse benchmark ran seven processes with 100,000
checks after 1,000 warmups. Its median changed from 9.891167 to 9.924540 microseconds/check (+0.033373 microseconds,
+0.34%). The added settings read and identity comparison therefore do not materially affect an unchanged monitor.

An idle-owner reset benchmark ran 10,000 reset/reacquire cycles per process. Reset itself changed from 1.808035 to
2.104475 microseconds (+0.296440 microseconds). Alternating executable identity exposed the baseline bug directly:
10,000 changes produced one launch and zero closes. The result produced 10,001 launches and 10,000 closes at a
15.954754-microsecond median per mocked change cycle. That number is the bookkeeping cost; a real configuration
change intentionally includes actual browser close and launch time.

```text
healthy baseline: 9.972180, 9.891167, 9.790845, 9.932835, 9.766917, 9.782113, 10.039155 us/check
healthy result:   9.802763, 9.939340, 9.916915, 9.925700, 9.918998, 9.924540, 9.982964 us/check
reset baseline:   1.923604, 1.770225, 1.872642, 1.745159, 1.876845, 1.808035, 1.753280 us/reset
reset result:     2.019885, 2.294919, 2.091469, 2.161440, 2.104475, 2.100370, 2.105627 us/reset
changed baseline: 8.900983, 8.947967, 8.819617, 8.834571, 8.856246, 8.985171, 8.965658 us/check
changed result:   16.283004, 15.819604, 15.939271, 15.892467, 16.022654, 15.954754, 16.129025 us/check
```

A real Chrome was idle during five compiled shutdown samples. Median graceful shutdown changed from 2,019.971 to
2,036.317 ms (+16.346 ms), and every final response waited until all captured Chromium PIDs disappeared. A real
development snapshot restore changed from a 13.500 ms ten-sample baseline median that returned with the old PID alive
to a 43.101 ms five-sample result median with the full old tree gone. This dev-only operation deliberately pays the
extra 29.601 ms for real process cleanup.

Seven fresh-data compiled starts show no production idle regression: median readiness changed from 302.889 to
299.756 ms (-3.133 ms), and median RSS from 197,152 to 197,040 KiB (-112 KiB). Graceful shutdown with no browser
owner changed from 2,037.057 to 2,042.233 ms (+5.176 ms). Cold first samples are retained below.

```text
startup baseline: 1443.551, 294.570, 306.324, 280.122, 302.889, 303.697, 277.310 ms
startup result:    389.382, 278.145, 301.731, 276.320, 309.698, 299.756, 280.345 ms
RSS baseline:      196768, 197152, 197136, 197264, 197168, 197392, 196832 KiB
RSS result:        197040, 196640, 197280, 196816, 197072, 197168, 196752 KiB
shutdown baseline: 2042.837, 2035.305, 2035.048, 2037.057, 2041.512, 2036.446, 2041.983 ms
shutdown result:   2043.122, 2031.106, 2043.770, 2042.233, 2036.860, 2035.178, 2042.507 ms
```

The final arm64 executable is 91,400,930 bytes with SHA-256
`f1d576adc344cc2a2893281f339e87b46ca917833ec03e25d193d721417135b9`.

### Pending browser-acquisition follow-up

The final adversarial pass found a narrower gap before Playwright completed its launch or remote-connect handshake.
The owner stored only the acquisition promise, while its browser and process fields were populated after that promise
resolved. A settings reset could therefore invalidate the owner and return while the detached Chromium wrapper and
its descendants were still alive. SQLite restore inherited the same false cleanup boundary. Remote connections had
the equivalent risk because Playwright exposes no public transport handle before `connect()` resolves.

Local launch now captures the exact detached Playwright child synchronously, before the handshake promise can settle.
The capture is scoped to the launch owner with `AsyncLocalStorage`, reference-counts the temporary spawn hook, and
accepts only Playwright's `detached` process carrying `--remote-debugging-pipe`; unrelated children are not eligible.
On POSIX, retirement sends `SIGTERM` to that process group, waits 100 ms, escalates to `SIGKILL`, and confirms the
group is gone. Acquisition is capped at five seconds and owner retirement at 5.5 seconds. Remote connect uses the same
hard acquisition cap and waits for Playwright's rejected connection to close its socket. Late browser results are
closed instead of entering the owner cache.

The regression suite covers one and 100 pending local acquisitions, 100 independent remote owners, exact
user/browser targeting, `Monitor.stop()`, configuration replacement serialization, a connection that ignores its
mocked timeout, source and compiled settings/test callbacks, remote add/edit/delete callbacks, source snapshot success
and rollback, and compiled `SIGTERM`. The real shell fixture puts a wrapper, shell child, and sleeping grandchild in
one process group; every relevant callback asserts the complete group or socket is gone first.

The comparison uses the exact RED commit `5746e720` (runtime-identical to `8b9b4755`) and final runtime `c09b3b0f`,
Bun 1.3.14, Playwright 1.61.0, and the same Apple arm64 host. Healthy browser reuse ran 100,000 mocked checks after
1,000 warmups. Its seven-sample median changed from 10.204573 to 10.028223 microseconds/check (-0.176350
microseconds, -1.73%), which is benchmark noise rather than a regression because the capture path runs only while
creating a local owner.

The deliberately stalled compiled settings switch changed from an 8.019 ms median that returned with owned PIDs
alive to 129.581 ms with the complete group gone. Source SQLite restore changed from a 14.872 ms median with the
group alive after HTTP success to 129.566 ms with it gone. The additional 114–122 ms is the intentional cleanup
barrier, dominated by the 100 ms graceful-termination window. Pending compiled shutdown changed from 2,018.663 to
2,137.971 ms (+119.308 ms); both versions eventually lost the fixture when the whole application exited, while the
final runtime now performs and verifies explicit owner retirement before completing shutdown.

```text
healthy reuse baseline: 10.027957, 10.047098, 10.059291, 10.204573, 10.250360, 10.299252, 10.395419 us/check
healthy reuse final:     9.855532, 9.919225, 10.028223, 9.989963, 10.104248, 10.187022, 10.220255 us/check
settings reset baseline: 7.760625, 8.120458, 8.018708, 8.030584, 7.670208 ms (owned PIDs alive)
settings reset final:    130.928750, 129.581166, 130.021042, 125.160666, 129.319000 ms (group gone)
snapshot baseline:       14.872125, 18.795042, 12.836459, 13.957333, 15.853583 ms (group alive)
snapshot final:          128.483625, 119.276417, 129.566000, 129.689250, 131.913166 ms (group gone)
pending shutdown base:   2018.662500, 2015.873792, 2016.463292, 2019.087083, 2019.126709 ms
pending shutdown final:  2139.614000, 2138.299667, 2137.970625, 2132.590000, 2133.042375 ms
```

Seven fresh-data compiled starts show no idle cost. Excluding each cold first sample, median readiness changed from
286.635 to 286.615 ms (-0.020 ms); all-sample RSS median changed from 198,688 to 198,576 KiB (-112 KiB), and idle
shutdown changed from 2,020.629 to 2,021.164 ms (+0.535 ms). The executable remains 91,400,930 bytes.

```text
startup baseline: 1451.569, 282.729, 286.046, 285.505, 287.224, 292.637, 288.314 ms
startup final:    372.166, 287.052, 282.792, 285.097, 290.587, 286.541, 286.689 ms
RSS baseline:     198848, 198688, 199024, 198768, 198544, 198688, 198592 KiB
RSS final:        198720, 198352, 198576, 198752, 198656, 198432, 198576 KiB
shutdown baseline: 2025.148, 2017.222, 2019.304, 2024.831, 2026.209, 2020.629, 2019.528 ms
shutdown final:    2021.720, 2026.397, 2021.164, 2018.984, 2021.069, 2023.951, 2018.953 ms
```

Final verification passed backend unit `332 pass / 15 skip`, authentication `13/13`, maintenance `9/9`, and
backend-all `405 pass / 15 skip` across 48 files. The 15 default skips are six public-network TLS cases and nine
browser opt-ins; the relevant browser opt-ins passed separately on source and the compiled executable. Compiled SMTP
passed `1/1`, compiled authentication `13/13`, and source and compiled real-Chrome lifecycle each passed with 22
expectations. Full Playwright E2E passed `40/40` twice. Frozen install, lint, and build passed with only the existing
warning categories.

### Browser process-identity follow-up

The pending-acquisition cleanup still treated `kill(-pid, 0)` as proof that a captured process group belonged to
Uptime Maku. A captured `ChildProcess` remained in `acquiredProcesses` after exit. If its numeric PID was later reused
by an unrelated process-group leader, reset, snapshot restore, or shutdown could send TERM and KILL to that foreign
group. The deterministic RED commit `11840bd4` marks a captured child exited, simulates a reused group, and proves the
old cleanup still signalled it. It also changes identity between the TERM grace period and KILL. Commit `68ce85c7`
adds a real detached fixture whose launcher exits while leaving a sleeping descendant; it proves that simply refusing
to signal after leader exit would exchange the foreign-process bug for an orphan leak.

The POSIX launch path now inserts a minimal `/bin/sh` supervisor as the detached process-group leader. Chromium
inherits Playwright's fd 3/4 transport, does not inherit the private fd 5 control channel, and the supervisor closes
its own copies of fd 3/4. The supervisor deliberately remains alive after Chromium exits. Uptime Maku writes TERM or
KILL to fd 5; the still-owned leader then signals its own group, so there is no numeric-PID ownership guess or
check-to-signal race. EOF also kills the group if Uptime Maku exits without completing normal retirement. Exit and
close listeners immediately remove the captured record, concurrent cleanup shares one promise, and a lost control
pipe fails closed instead of falling back to a PID. Windows retains its existing direct-child path.

The first real-Chrome run exposed a related ordering issue: keeping the supervisor alive made `browser.close()` cross
the 100 ms bound, after which the old fallback closed Playwright's shared connection. One successful `testChrome`
therefore made every later launch fail with `launch: close: Chromium test complete`. Local owner disposal now starts
the browser close, retires the captured supervisor through fd 5, and waits for Playwright's process cleanup before it
considers force-disconnecting the channel. Three consecutive real `testChrome` calls, subsequent monitor launch, and
source and compiled full-Chrome lifecycles all pass.

Runtime commit `7c6a3403` implements the ownership protocol, `65978cb4` corrects the process-tree fixture to read the
wrapper's actual PGID now that the supervisor is the group leader, and `ab675b9b` refuses the dependency's numeric
POSIX kill if a future Playwright change ever bypasses capture. The focused lifecycle file passes `37/37`; its new
cases cover stale exit/close state, identity loss between TERM and KILL, a naturally exited launcher with a live
descendant, 100 concurrent resets producing exactly one TERM/KILL pair, control-pipe failure, and an untracked process
handle without a numeric fallback. The real pending wrapper still ignores TERM and carries a child and grandchild;
settings, Chrome-test, snapshot success/rollback, and `SIGTERM` callbacks all observe the entire actual group gone.

Verification on the follow-up:

- frozen install, lint, and single-executable build passed;
- standard backend gate passed unit `337 pass / 15 skip / 0 fail / 3,239 expect()`, authentication `13/13 / 424`,
  and maintenance `9/9 / 143`;
- backend-all passed `410 pass / 15 skip / 0 fail / 3,362 expect()` across 48 files;
- compiled SMTP passed `1/1 / 6`, authentication `13/13 / 424`, maintenance `9/9 / 143`, and SNMP lifecycle
  `1/1 / 6`;
- source and compiled real-Chrome settings, test, screenshot, pause/resume, relaunch, and shutdown passed repeatedly;
- source pending snapshot success and rollback passed `2/2`, and the real-Chrome snapshot recovery passed `1/1`;
- full Playwright E2E passed `40/40` twice from fresh state;
- cleanup left no Uptime Maku, Chromium, supervisor, pending wrapper, or sleeping fixture process.

Healthy same-owner reuse ran seven fresh processes with 100,000 mocked checks after 1,000 warmups. Its median changed
from 15.604245 to 15.582110 microseconds/check (-0.022135 microseconds, -0.14%). The supervisor is created only on a
new local launch, so the normal cached-check path has no measurable regression. The complete real-Chrome lifecycle,
which intentionally performs several owner retirements, changed from a 7,224.16 ms three-sample median to 7,592.46
ms (+368.30 ms); each retirement includes the 100 ms TERM grace.

A naturally exited launcher with one live descendant changed from a 12.811 ms unsafe reset median to 124.398 ms
(+111.587 ms) with retained ownership and confirmed cleanup. The compiled pending settings callback changed from
628.68 to 660.30 ms (+31.62 ms) in five-sample medians. Both increases are cleanup-boundary cost, not heartbeat cost.

```text
healthy reuse baseline: 15.604245, 15.814623, 15.651678, 15.430522, 15.600122, 15.605015, 15.489897 us/check
healthy reuse final:    15.859961, 15.416958, 15.552504, 15.582110, 15.741528, 15.668954, 15.429702 us/check
natural exit baseline:  12.879, 12.804, 12.804, 12.829, 12.811 ms (numeric PGID ownership was unsafe)
natural exit final:     125.520, 121.797, 121.700, 124.398, 125.377 ms (descendant gone before callback)
forced reset baseline:  854.89, 647.35, 628.63, 620.96, 628.68 ms
forced reset final:     669.78, 660.30, 653.54, 630.64, 661.53 ms
real lifecycle base:    7613.84, 7224.16, 7201.04 ms
real lifecycle final:   7592.46, 7625.45, 7591.78 ms
```

Seven fresh-data compiled starts show no idle regression. Excluding each cold first sample, median readiness changed
from 282.884 to 281.397 ms (-1.487 ms); all-sample RSS median changed from 196,880 to 196,736 KiB (-144 KiB), and
idle shutdown was unchanged at 2,016.306 versus 2,016.309 ms. Binary size changed from 91,516,514 to 91,400,930
bytes (-115,584 bytes). The final arm64 checksum is
`1692dc60f2ef882e87b78ea747a48817d65d9f844f31a7c432c8dc7aeab93d5f`.

```text
startup baseline: 1452.515, 289.830, 281.937, 286.694, 282.337, 281.648, 283.430 ms
startup final:    368.651, 279.913, 281.760, 279.763, 287.242, 287.478, 281.033 ms
RSS baseline:     196768, 196880, 196864, 196928, 196944, 196864, 196880 KiB
RSS final:        196736, 196784, 196736, 196736, 196560, 196736, 196768 KiB
shutdown baseline: 2016.912, 2016.483, 2018.407, 2016.306, 2016.122, 2016.281, 2016.003 ms
shutdown final:    2018.862, 2018.247, 2015.912, 2016.309, 2017.486, 2015.313, 2016.279 ms
```

## Residual limits

- GameDig exposes per-attempt and socket timeouts, but no public top-level `AbortSignal` or socket handle. Uptime Maku
  therefore relies on the library's bounded internal cleanup rather than independently destroying the socket.
- The operating-system `dns.lookup` used by Steam cannot be actively cancelled. Uptime Maku races it against the
  shared deadline, ignores a late result, and does not allow it to publish a late heartbeat; the following HTTP and
  ping operations are abortable or killable.
- Playwright does not expose native timeout options for `browser.newContext()` or `context.close()`, a public remote
  force-disconnect API, or a public process handle from `chromium.launch()`. Uptime Maku supplies its own cancellation
  boundary, bounds close, and supervises the POSIX local process group over an owned pipe before handshake. This
  requires `/bin/sh`, which is present on the supported POSIX hosts. Pre-handshake tree escalation remains
  POSIX-specific; Windows uses direct-process cleanup and is excluded from the process-group fixture.
- If an external actor stops the whole supervisor group so it cannot read its control pipe, cleanup fails closed and
  reports the owned group instead of attempting a numeric-PID fallback. Resuming or explicitly retiring that owned
  group is then an operator action; the safety boundary deliberately prefers an owned leak under hostile process
  manipulation to signalling a potentially unrelated process after PID reuse.
- Some sequential paths cap individual phases rather than carrying one absolute deadline: ping can make an IPv6
  fallback attempt, MySQL caps connection and query operations separately, SMTP uses half-timeout phase caps, and
  TCP/STARTTLS/WebSocket OAuth paths can enter another bounded phase. Their worst-case wall time can therefore exceed
  one monitor timeout while remaining bounded by the finite phase count and cleanup.
- Graceful lifecycle operations wait for real provider cleanup rather than reporting a false stop. Real browser and
  SNMP checks now have active cancellation plus hard whole-check bounds; the other finite multi-phase limits remain as
  described above.
- Malformed legacy values are normalized in memory but intentionally left unchanged on disk. A later successful edit
  persists canonical numeric values; this avoids hidden writes during startup or push requests.

The root README records the browser acquisition bound and lifecycle barrier. The backend test README documents both
real-Chromium and pending-acquisition opt-ins for source and compiled runs.
