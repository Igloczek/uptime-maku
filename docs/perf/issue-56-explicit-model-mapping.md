# Issue #56 explicit model mapping performance report

Date: 2026-08-11

| Revision                   | SHA                                        |
| -------------------------- | ------------------------------------------ |
| Baseline (`origin/master`) | `64db9070c6ad4973f1fc50006ebdb72af5a1fe5a` |
| Candidate                  | `ca7b6fe96356c745656a040f508b1fb980f5ded7` |

This report covers the final explicit per-store model mapping implementation for issue #56. Measurements were taken on the same host and with the same Bun/build configuration for both revisions. Raw measurement artifacts are intentionally not committed.

## Method and reproduction

For each revision:

```bash
git switch --detach "$REVISION"
bun install --frozen-lockfile
bun run build
```

Compiled startup measurements used five fresh trials, a fresh data directory per trial, a 1,000 ms warm-up, existing HTTP readiness, external process RSS in KiB, and macOS physical footprint in bytes. The repository harness can reproduce the compiled variant without a fixed artifact path:

```bash
ARTIFACT_DIR="$(mktemp -d)"
bun scripts/benchmark/startup-memory.ts \
  --variant=compiled-binary \
  --trials=5 \
  --warmup-ms=1000 \
  --outfile="$ARTIFACT_DIR/startup-memory.json"
rm -rf "$ARTIFACT_DIR"
```

Closure counts used `Bun.build` with the production server entrypoint, `target: "bun"`, and `metafile: true`. Input and output counts are the lengths of the metafile input/output maps; byte totals are the sums of their byte sizes. The backend subset filters inputs to `src/server/` and `src/db/`.

Focused validation was run with the repository's Bun commands:

```bash
bun run lint
bun run build
bun test \
  test/backend-test/sqlite-core.test.ts \
  test/backend-test/composition-root.test.ts \
  test/backend-test/schema.test.ts \
  test/backend-test/upgrade.test.ts \
  test/backend-test/runtime-registry-callsite.test.ts \
  test/backend-test/monitor-runtime-loading.test.ts \
  test/backend-test/heartbeat-data-plane.test.ts \
  test/backend-test/status-page.test.ts \
  test/backend-test/auth-settings-injection.test.ts \
  test/backend-test/bun-websocket-server.test.ts \
  test/backend-test/user-resources-injection.test.ts
```

## Bun metafile closure

| Closure                          |   Baseline |  Candidate |  Delta |
| -------------------------------- | ---------: | ---------: | -----: |
| Bun inputs                       |      3,049 |      3,049 |      0 |
| Bun outputs                      |        196 |        196 |      0 |
| Bun input bytes                  | 32,778,040 | 32,776,769 | -1,271 |
| Bun output bytes                 | 11,409,866 | 11,409,338 |   -528 |
| `src/server/` + `src/db/` inputs |        227 |        227 |      0 |
| `src/server/` + `src/db/` bytes  |  1,416,581 |  1,415,310 | -1,271 |

The candidate does not expand the compiled input or output closure. The small byte reductions are consistent with removing the process-global registration compatibility path.

## Compiled startup RSS

RSS values are external process measurements in KiB. Variance is sample variance in KiB²; SD is sample standard deviation in KiB; spread is maximum minus minimum across the five trials.

| Revision  | Samples (KiB)                          | Median |      Mean | Sample variance |       SD | Spread |
| --------- | -------------------------------------- | -----: | --------: | --------------: | -------: | -----: |
| Baseline  | 69,296; 70,016; 70,000; 69,952; 69,792 | 69,952 | 69,811.20 |       90,803.20 |   301.34 |    720 |
| Candidate | 64,960; 69,824; 69,872; 70,032; 69,088 | 69,824 | 68,755.20 |    4,633,523.20 | 2,152.56 |  5,072 |

The median delta is **-128 KiB (-0.18%)**. The candidate's larger spread and variance make the median difference too small to treat as a performance gain; there is no measured startup RSS regression beyond observed run-to-run noise.

| Compiled startup metric   |     Baseline |    Candidate |               Delta |
| ------------------------- | -----------: | -----------: | ------------------: |
| Readiness median          |       108 ms |       109 ms |               +1 ms |
| Physical footprint median | 27,740,672 B | 27,576,832 B | -163,840 B (-0.59%) |

## Validation and manual smoke

- Frozen install and production build passed for baseline and candidate.
- Focused behavioral validation passed: 86 tests, 0 failures, 1,158 assertions. This includes typed creation, import-order independence, fresh explicit stores, per-store constructor/bean/persistence isolation, unknown-property rejection without schema mutation, and supported-baseline upgrade behavior.
- Lint passed with only existing warnings and deprecation notices.
- Compiled manual smoke passed: `/api/entry-page` returned HTTP 200 with 37 bytes; `/setup` returned HTTP 200 with 1,196 bytes; SQLite `PRAGMA integrity_check` returned `ok`; the settings table contained 2 rows; SIGTERM produced exit code 0.

Representative smoke commands are:

```bash
DATA_DIR="$(mktemp -d)"
PORT=3001
./uptime-maku --host=127.0.0.1 --port="$PORT" --data-dir="$DATA_DIR" &
PID=$!
curl -fsS -o /dev/null -w '%{http_code} %{size_download}\n' "http://127.0.0.1:$PORT/api/entry-page"
curl -fsS -o /dev/null -w '%{http_code} %{size_download}\n' "http://127.0.0.1:$PORT/setup"
DB="$DATA_DIR/kuma.db" bun -e 'import { Database } from "bun:sqlite"; const db = new Database(process.env.DB); console.log(db.query("PRAGMA integrity_check").get()); console.log(db.query("SELECT COUNT(*) AS count FROM setting").get()); db.close();'
kill -TERM "$PID"
wait "$PID"
rm -rf "$DATA_DIR"
```

## Local limitations

- The HTTP-client tests failed before test execution on both baseline and candidate because the IPv6 `::1` port-0 fixture could not bind (`EADDRINUSE`). This is an identical environment limitation, not a candidate-only failure.
- The full local backend run reported 333 passed, 6 skipped, 74 failed, and 2 errors; the failures were blocked by port/listener collisions in the environment.
- The local E2E run did not complete because the Playwright `config.webServer` readiness wait reached its 60-second timeout.

These limitations were recorded rather than filtered or retried as implementation results. The compiled smoke, focused behavior, closure, and paired baseline/candidate measurements provide the issue-specific evidence; the measured performance outcome is no regression.
