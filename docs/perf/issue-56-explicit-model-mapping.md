# Issue #56 explicit model mapping performance report

Date: 2026-08-11

## Revision identity

| Revision                                | SHA                                        |
| --------------------------------------- | ------------------------------------------ |
| Baseline                                | `64db9070c6ad4973f1fc50006ebdb72af5a1fe5a` |
| Candidate implementation measured by QA | `a7fff97e9bc5e3944f1ffebec700f6a933e13eaf` |

All candidate measurements in this report were taken from the implementation at `a7fff97e9bc5e3944f1ffebec700f6a933e13eaf`. The commit that records this document is a later report-only commit; it changes no implementation and is not a separately measured revision. Raw QA artifacts remain outside the repository and are not committed.

## Method and reproduction

For each revision, QA used a separate checkout and ran:

```bash
git switch --detach "$REVISION"
bun install --frozen-lockfile
bun run lint
bun run build
```

The focused behavior commands used the historical baseline filename and the candidate filename respectively:

```bash
# baseline 64db9070c6ad4973f1fc50006ebdb72af5a1fe5a
bun test \
  test/backend-test/sqlite-core.test.ts \
  test/backend-test/real-browser-monitor-lifecycle.test.ts

# candidate a7fff97e9bc5e3944f1ffebec700f6a933e13eaf
bun test \
  test/backend-test/sqlite-store.test.ts \
  test/backend-test/real-browser-monitor-lifecycle.test.ts
```

Candidate-wide checks were:

```bash
bun run test:backend
bun run test-e2e
```

The underlying E2E command is `playwright test --config ./config/playwright.config.ts`.

Closure was measured with the production server entrypoint and a Bun-targeted metafile build. The required `target: "bun"` is explicit:

```bash
bun -e '
const result = await Bun.build({
  entrypoints: ["src/server/server.ts"],
  bundle: true,
  format: "esm",
  splitting: true,
  target: "bun",
  write: false,
  metafile: true,
});
if (!result.success) throw new Error("Bun.build failed");
const inputs = Object.values(result.metafile.inputs);
const outputs = Object.values(result.metafile.outputs);
console.log(JSON.stringify({
  inputs: inputs.length,
  inputBytes: inputs.reduce((total, item) => total + item.bytes, 0),
  outputs: outputs.length,
  outputBytes: outputs.reduce((total, item) => total + item.bytes, 0),
}));
'
```

An initial browser-target metafile attempt rejected Bun and Node built-ins. It is not a measurement; only the corrected Bun-targeted method above is used here. Binary size was measured from the compiled `uptime-maku` file; `dist` size is the sum of regular-file byte sizes under `dist/`.

Compiled startup used `scripts/benchmark/startup-memory.ts` with the `compiled-binary` variant, five trials, a fresh data directory per trial, existing `GET /` readiness, and a 1,000 ms warm-up:

```bash
ARTIFACT_DIR="$(mktemp -d)"
bun scripts/benchmark/startup-memory.ts \
  --variant=compiled-binary \
  --trials=5 \
  --warmup-ms=1000 \
  --outfile="$ARTIFACT_DIR/startup-memory.json"
rm -rf "$ARTIFACT_DIR"
```

The measurements used external process RSS in KiB and macOS physical footprint in bytes on macOS arm64 with Bun 1.3.14.

## Bun metafile closure

| Closure      |   Baseline |  Candidate | Delta |
| ------------ | ---------: | ---------: | ----: |
| Inputs       |      3,049 |      3,049 |     0 |
| Input bytes  | 32,778,040 | 32,778,621 |  +581 |
| Outputs      |        196 |        196 |     0 |
| Output bytes | 11,409,920 | 11,409,833 |   -87 |

The candidate keeps the same input and output counts and reduces total output bytes by 87. The 581-byte input increase does not expand the output closure.

| Artifact               |     Baseline |    Candidate | Delta |
| ---------------------- | -----------: | -----------: | ----: |
| Compiled `uptime-maku` | 95,628,002 B | 95,628,002 B |     0 |
| `dist/` regular files  |  9,756,672 B |  9,756,672 B |     0 |

## Compiled startup

| Metric                    |     Baseline |    Candidate |      Delta |
| ------------------------- | -----------: | -----------: | ---------: |
| Readiness median          |       106 ms |       106 ms |       0 ms |
| RSS median                |   69,392 KiB |   69,152 KiB |   -240 KiB |
| RSS spread                |    1,056 KiB |    4,848 KiB | +3,792 KiB |
| Physical footprint median | 27,232,832 B | 27,380,224 B | +147,392 B |

Raw samples:

| Metric                 | Baseline                                             | Candidate                                            |
| ---------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| Readiness (ms)         | `[2188, 106, 106, 105, 105]`                         | `[2010, 106, 106, 181, 106]`                         |
| RSS (KiB)              | `[69200, 69040, 69392, 69952, 70096]`                | `[65120, 69328, 69152, 68944, 69968]`                |
| Physical footprint (B) | `[27232832, 27167232, 27183680, 27707904, 27724352]` | `[26888704, 27511360, 27380224, 27232896, 27740736]` |

The candidate RSS median is 240 KiB lower, but its wider spread and the trial-level variation make this a noise-level result rather than a measured gain. Physical footprint is likewise within observed run-to-run variation. There is no measured compiled-startup regression.

## Validation and smoke results

- Frozen install and production build passed for both baseline and candidate.
- Candidate lint passed.
- Focused behavior passed: 63 tests, 0 failures, 828 assertions. Baseline passed 61 tests, 0 failures, 802 assertions.
- Candidate full backend passed: 465 tests, 15 skipped, 0 failures, 4,351 assertions.
- Candidate E2E passed: 40 tests, 0 failures.
- Acceptance scans for legacy persistence names/APIs and obsolete tracked filenames returned zero matches.

Compiled smoke started each binary against a fresh data directory, queried `/` and `/api/status-page/heartbeat/default`, checked `PRAGMA integrity_check`, counted settings before and after a clean restart, and waited for exit. Both baseline and candidate returned HTTP 200 on both routes, `integrity_check` `ok`, settings count 2 before and after restart, clean exit code 0, and a fresh data-directory footprint of 262,336 B.

Source smoke returned HTTP 200, `integrity_check` `ok`, and clean exit code 0.

Manual real-browser flow passed: setup and login, create an HTTP monitor, edit its name, observe a heartbeat, cleanly restart, confirm the edited monitor and history persisted, then delete the monitor.

## Limitations

During the deliberate restart flow, QA observed transient `runtime.platform` TypeErrors and expected WebSocket disconnects. `EditMonitor.vue` was unchanged relative to baseline, and the complete user flow passed. These runtime messages do not change the measured results above.
