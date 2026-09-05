# iglo.monitor startup/memory baseline

Baseline reference: `master` at `a66d1e3d5779f045790a0604be76f50aa80a03d0`.

Measured 2026-08-07 on Bun `1.3.14`, Darwin `25.5.0`, `arm64`. This is a single-host baseline; these numbers must not be compared with another host. The raw JSON report is [bun-startup-memory-baseline.json](./bun-startup-memory-baseline.json).

## Method

Each sample started one fresh child process with a fresh temporary `data-dir`, in this fixed order: `minimal-bun`, `minimal-bun-serve`, source backend, compiled binary. It waited for readiness, warmed up for 1,000 ms, sampled external RSS, then terminated and removed the process/data directory. RSS is collected with `ps` on macOS and Linux. Physical footprint is collected with macOS `footprint` only; it is explicitly unavailable on Linux. Every variant has three trials. Three trials are a descriptive baseline, not a statistical estimate. Application readiness is the existing `GET /` with HTTP 200; no benchmark endpoint, IPC, or production hook is involved.

The process start is the cold portion of each trial; the RSS/footprint sample is taken after the readiness warm-up, so it is a warm measurement. The fixed order makes the report reproducible on one host, but does not make results from different hosts comparable.

The `minimal-bun` and `minimal-bun-serve` processes are synthetic probes. Their `process.memoryUsage()` and optional `Bun.unsafe.memoryFootprint()` values are recorded separately in the JSON only to describe runtime overhead; they are not application measurements. Application rows use only external process metrics. The committed values below are macOS measurements; on Linux the physical-footprint column is unavailable.

The committed JSON uses the current runner schema: both `gitSha` and `baselineSha` bind it to master `a66d1e3d5779f045790a0604be76f50aa80a03d0`, and every recorded trial includes `forcedKill: false`.

## Median baseline

| Variant                      | Readiness |         RSS | Physical footprint |
| ---------------------------- | --------: | ----------: | -----------------: |
| Minimal Bun probe            |     51 ms |  23,632 KiB |        7,309,120 B |
| Minimal Bun.serve probe      |     52 ms |  27,520 KiB |        9,897,792 B |
| iglo.monitor source backend  |    365 ms | 167,808 KiB |      122,342,080 B |
| iglo.monitor compiled binary |    666 ms | 212,848 KiB |      143,772,288 B |

## Raw external samples

| Variant                      | Trial 1 (readiness / RSS / footprint)  | Trial 2                              | Trial 3                              |
| ---------------------------- | -------------------------------------- | ------------------------------------ | ------------------------------------ |
| Minimal Bun probe            | 51 ms / 23,632 KiB / 7,309,120 B       | 51 ms / 23,712 KiB / 7,423,808 B     | 52 ms / 23,616 KiB / 7,292,672 B     |
| Minimal Bun.serve probe      | 58 ms / 27,520 KiB / 9,963,264 B       | 52 ms / 27,520 KiB / 9,897,792 B     | 52 ms / 27,552 KiB / 9,897,728 B     |
| iglo.monitor source backend  | 413 ms / 167,808 KiB / 122,047,104 B   | 365 ms / 167,776 KiB / 122,358,336 B | 364 ms / 167,872 KiB / 122,342,080 B |
| iglo.monitor compiled binary | 2,264 ms / 212,224 KiB / 143,772,288 B | 666 ms / 212,848 KiB / 143,706,944 B | 469 ms / 213,008 KiB / 144,558,848 B |

The compiled first trial shows a cold-start outlier; the reported median preserves it as a raw sample without treating it as a failure.

## Reproduction

```bash
bun run build
bun scripts/benchmark/startup-memory.ts \
  --trials=3 \
  --warmup-ms=1000
```

Without `--outfile`, the command writes a SHA-named report such as `docs/perf/bun-startup-memory-<SHA>.json` and cannot overwrite this baseline. To intentionally reproduce the committed report, run the command at the exact baseline checkout and bind it explicitly:

```bash
git switch --detach a66d1e3d5779f045790a0604be76f50aa80a03d0
bun run build
bun scripts/benchmark/startup-memory.ts \
  --trials=3 \
  --warmup-ms=1000 \
  --baseline-sha=a66d1e3d5779f045790a0604be76f50aa80a03d0 \
  --outfile=docs/perf/bun-startup-memory-baseline.json
```
