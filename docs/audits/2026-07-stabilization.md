# July 2026 stabilization audit

## Scope

This record summarizes the stabilization range from `origin/master` at
`4272bf3ff241f300f3dedc823f1960ff1cecec90` through `c11903d3b872ad46a56992a1399b7b27b811f1b8`.
It is a map to the detailed evidence, not a new claim that one final command tested every historical revision.
Finding origin is classified separately in [Why iglo.monitor exists](../why-iglo-monitor.md).

The range contains 87 granular commits. Audit follow-ups preserve the deterministic RED test, minimal runtime fix,
and documentation/measurement commits instead of rewriting them, because their separate SHAs are part of the
failure-to-fix evidence.

## Method

1. Inventory the fork range, changed runtime surfaces, supported providers, and existing test gates.
2. Reproduce a finding deterministically and commit the RED test without changing the relevant runtime.
3. Run the same test on an isolated baseline worktree, then apply the smallest shared-path fix.
4. Verify source, compiled, and—where deployment boundaries matter—physically isolated executable paths. Tests use
   loopback sinks, fake clocks, blocked I/O, and owned process fixtures rather than public services.
5. Record before/after runtime, memory, database, networking, or scheduling measurements when those paths change.
6. Ask for an independent read-only adversarial review, add missing boundary tests, and repeat focused and full gates.

Each detailed report names the exact measured revision, binary checksum, commands, counts, and residual limits.
Those historical counts and checksums belong to that report's SHA; they must not be read as one giant run on the
closeout revision.

## Findings and evidence

| Domain                | Outcome                                                                                                                                                                                                                       | Evidence                                                                                                                                                      | Residual boundary                                                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Notifications         | Migrated SMTP configuration loads in the executable and test/send/save/edit/delete reaches a local SMTP sink. The original failure was `Cannot find module './notification-providers/smtp.ts' from '/$bunfs/root/server.js'`. | [compiled notification integration](../../test/integration-test/notification-provider-binary.test.ts), commits `12ba7378`–`9737551`                           | Metadata/import coverage spans providers; external notification services still require service-specific credentials and endpoints.                                         |
| Status pages          | Incident/group rendering, public heartbeat reload, and related form state were restored.                                                                                                                                      | [status-page E2E](../../test/e2e/specs/status-page.spec.ts), commits `b012dade`–`390d7a2`                                                                     | Coverage is focused on the restored public flows.                                                                                                                          |
| Core/UI               | Binary boot, store bridge, dashboard heartbeat charts, reverse-proxy settings, and HTTP proxy/TLS lifecycle were repaired and owner-validated.                                                                                | [HTTP client tests](../../test/backend-test/http-client.test.ts), [monitor form E2E](../../test/e2e/specs/monitor-form.spec.ts), commits `63a20540`–`209259b` | External proxies and certificate authorities are represented by deterministic local fixtures.                                                                              |
| Auth/API/metrics      | Sessions, API keys, setup concurrency, metrics ownership/redaction, bounded credential admission, and Bun peer attribution were hardened.                                                                                     | [auth/security audit](../perf/auth-security-api-metrics-audit.md)                                                                                             | Fixed-size fallback hashes can collide; trusted forwarding headers still require an operator-controlled proxy boundary.                                                    |
| Maintenance           | Owner checks, atomic relations/publication, one-shot timers, restart recovery, cache invalidation, and DST occurrence handling were corrected.                                                                                | [maintenance audit](../perf/maintenance-scheduling-audit.md)                                                                                                  | DST tests use representative boundaries, not every IANA transition; legacy malformed values are not silently rewritten.                                                    |
| SQLite transactions   | A FIFO owner barrier prevents cross-transaction work; rollback failure quarantines the connection and rejects queued/future operations.                                                                                       | [transaction isolation audit](../perf/sqlite-transaction-isolation-audit.md)                                                                                  | A forgotten healthy transaction still blocks; the FIFO queue has no capacity timeout.                                                                                      |
| Development snapshot  | E2E restore now validates, quiesces, swaps, rehydrates, recovers on failure, and serializes requests; production builds expose no restore route.                                                                              | [snapshot restore audit](../perf/sqlite-e2e-snapshot-restore-audit.md)                                                                                        | This is test infrastructure, not an operator backup API; restores intentionally serialize state replacement.                                                               |
| Provider lifecycle    | Audited network/process providers now have finite phase bounds and deterministic cleanup tied to monitor timeout.                                                                                                             | [provider deadline audit](../perf/monitor-provider-deadline-audit.md)                                                                                         | Some finite multi-phase checks can exceed one configured timeout; library/OS cancellation limits are itemized in the report.                                               |
| Numeric configuration | Production add/edit rejects unsafe timeout/retry values; malformed legacy rows use bounded in-memory fallbacks.                                                                                                               | [numeric follow-up](../perf/monitor-provider-deadline-audit.md#numeric-configuration-follow-up)                                                               | Legacy values stay unchanged on disk until a successful edit.                                                                                                              |
| SNMP                  | A whole-check watchdog bounds retry timer quantization, cancels pending requests, and closes the session once.                                                                                                                | [SNMP follow-up](../perf/monitor-provider-deadline-audit.md#snmp-retry-quantization-follow-up)                                                                | The watchdog bounds the whole check; third-party session cleanup still follows `net-snmp` behavior.                                                                        |
| Real browser          | Acquisition, page/context lifecycle, screenshot delay, owner invalidation, and POSIX process-group retirement are bounded and observed.                                                                                       | [browser follow-ups](../perf/monitor-provider-deadline-audit.md#real-browser-lifecycle-follow-up)                                                             | System Chrome/Chromium is optional but required for this monitor type; POSIX supervision uses `/bin/sh` and fails closed if its owned control pipe is externally disabled. |
| Standalone binary     | `playwright-core` is embedded; a copy outside the repository passes real-browser lifecycle without `node_modules`, `NODE_PATH`, or a sidecar.                                                                                 | [standalone binary proof](../perf/standalone-real-browser-binary.md)                                                                                          | A configured system Chrome/Chromium executable is still required for real-browser checks.                                                                                  |

## SMTP deployment proof

The notification regression was tested at three boundaries: migrated SQLite configuration, production WebSocket
test/send behavior against a loopback SMTP sink, and the compiled executable. The later standalone-binary test also
moves the executable to an empty directory before launch, preventing repository `node_modules` from masking a
missing bundled dependency.

## Release closeout

- [ ] Run the final local frozen install, lint, build, backend, and E2E gates on the closeout revision.
- [ ] Build and test the Linux x64 executable in an isolated directory.
- [ ] Push the preserved commit series.
- [ ] Deploy only the ready executable to the LXC host and repeat migration, SMTP, startup, and smoke checks there.
