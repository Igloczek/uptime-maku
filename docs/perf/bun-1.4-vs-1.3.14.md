# Bun 1.3.14 vs 1.4.0 on Uptime Maku

Measured 2026-08-20 on Darwin `25.5.0`, `arm64`, one host. These numbers must not be compared with another host.

This is not a pure runtime swap of identical source. The 1.3.14 side is `64db9070` compiled and run with Bun `1.3.14`. The 1.4.0 side is `9dabd155` (`v1.0.0-beta.3`) compiled and run with Bun `1.4.0`. Application changes on the 1.4.0 side include the `Bun.cron` job adapter, `process.on("memoryPressure")` cache drop, and related test/runtime wiring. The `minimal-bun` and `minimal-bun-serve` probes are synthetic runtime-only processes and do not load Uptime Maku.

Raw JSON:

- [bun-1.3.14-startup-memory.json](./bun-1.3.14-startup-memory.json)
- [bun-1.4.0-startup-memory.json](./bun-1.4.0-startup-memory.json)
- [bun-1.4-vs-1.3.14-load.json](./bun-1.4-vs-1.3.14-load.json)

Compiled Darwin arm64 binaries were 96,108,914 bytes on both sides. SHA-256:

- 1.3.14 (`64db9070`): `42c4062755067bfcb391abf82f054964da217925c0f63875ce2abbd2c53df9b8`
- 1.4.0 (`9dabd155`): `180c26637f2c06a0afa9721c5d308abd2222a3d3d253c9c5ad67f241ccc8b528`

## Method

Startup/memory used the repository harness:

```bash
bun run build
bun scripts/benchmark/startup-memory.ts --trials=3 --warmup-ms=1000 --outfile=docs/perf/bun-<version>-startup-memory.json
```

Each sample started one fresh child with a fresh temporary `data-dir`, in this order: `minimal-bun`, `minimal-bun-serve`, source backend, compiled binary. It waited for `GET /` HTTP 200, warmed up for 1,000 ms, sampled external RSS (`ps`) and macOS physical footprint (`footprint`), then terminated. Three trials are a descriptive baseline, not a statistical estimate. The first compiled-binary trial is a known cold-start outlier on this harness.

Idle CPU and load used the same compiled Darwin arm64 binaries on unused loopback ports and empty data directories. After `GET /setup` returned HTTP 200, RSS and `%cpu` were sampled while idle, then 2,000 sequential `GET /setup` requests were issued. Peak RSS is the highest sample seen during that load.

## Startup and memory (medians)

| Variant                     | Metric             |   Bun 1.3.14 |    Bun 1.4.0 |                 Delta |
| --------------------------- | ------------------ | -----------: | -----------: | --------------------: |
| Minimal Bun probe           | Readiness          |        51 ms |        51 ms |                     0 |
|                             | RSS                |   23,760 KiB |    9,328 KiB |  −14,432 KiB (−60.7%) |
|                             | Physical footprint |  7,423,872 B |  5,785,024 B | −1,638,848 B (−22.1%) |
| Minimal Bun.serve probe     | Readiness          |        69 ms |        53 ms |       −16 ms (−23.2%) |
|                             | RSS                |   27,616 KiB |   14,128 KiB |  −13,488 KiB (−48.8%) |
|                             | Physical footprint | 10,028,800 B |  6,440,384 B | −3,588,416 B (−35.8%) |
| Uptime Maku source backend  | Readiness          |       116 ms |       105 ms |        −11 ms (−9.5%) |
|                             | RSS                |   70,288 KiB |   58,368 KiB |  −11,920 KiB (−17.0%) |
|                             | Physical footprint | 30,116,480 B | 27,560,000 B |  −2,556,480 B (−8.5%) |
| Uptime Maku compiled binary | Readiness          |       106 ms |       107 ms |                 +1 ms |
|                             | RSS                |   47,920 KiB |   52,192 KiB |    +4,272 KiB (+8.9%) |
|                             | Physical footprint | 21,661,440 B | 21,694,208 B |     +32,768 B (+0.2%) |

The source-backend row is the application memory result that matters for `bun src/server/server.ts`: about 17% less RSS and 8.5% less physical footprint, with a small readiness improvement. The compiled-binary startup medians are not improved; the 1.3.14 compiled first trial was a 2,108 ms cold-start outlier, and 1.4.0 compiled RSS after the 1,000 ms warmup was slightly higher.

## Compiled binary idle CPU and HTTP load

| Metric               |  Bun 1.3.14 |   Bun 1.4.0 |                Delta |
| -------------------- | ----------: | ----------: | -------------------: |
| Ready (`GET /setup`) |    220.5 ms |    174.7 ms |    −45.8 ms (−20.8%) |
| Idle RSS median      |  47,904 KiB |  40,424 KiB |  −7,480 KiB (−15.6%) |
| Idle CPU median      |        0.0% |        0.0% |                    0 |
| Idle CPU max         |       21.5% |       16.2% |              −5.3 pp |
| 2,000 `GET /setup`   |     9.674 s |     7.954 s |    −1.720 s (−17.8%) |
| Throughput           | 206.7 req/s | 251.5 req/s | +44.8 req/s (+21.7%) |
| Peak RSS during load |  52,464 KiB |  46,272 KiB |  −6,192 KiB (−11.8%) |
| RSS after load       |  45,360 KiB |  46,272 KiB |     +912 KiB (+2.0%) |
| CPU after load       |        2.7% |        2.7% |                    0 |

Idle CPU median is zero on both sides after readiness. The idle CPU max samples the transient spike immediately after start; 1.4.0 peaked lower. Sequential `/setup` throughput is about 22% higher on 1.4.0, with lower peak RSS. After-load RSS is within noise of each other.

The longer idle window (this table) shows lower compiled RSS on 1.4.0 than the 1,000 ms startup-harness sample. Treat the two compiled RSS figures as different sampling windows, not a contradiction.

## Raw startup trials

Readiness / RSS / footprint.

| Variant                 | Bun    | Trial 1                              | Trial 2                            | Trial 3                            |
| ----------------------- | ------ | ------------------------------------ | ---------------------------------- | ---------------------------------- |
| Minimal Bun probe       | 1.3.14 | 51 ms / 23,760 KiB / 7,440,192 B     | 51 ms / 23,680 KiB / 7,423,872 B   | 51 ms / 23,760 KiB / 7,423,744 B   |
|                         | 1.4.0  | 54 ms / 12,336 KiB / 5,785,024 B     | 51 ms / 9,328 KiB / 5,768,704 B    | 51 ms / 7,664 KiB / 5,785,088 B    |
| Minimal Bun.serve probe | 1.3.14 | 69 ms / 27,616 KiB / 10,012,480 B    | 53 ms / 27,616 KiB / 10,028,800 B  | 113 ms / 27,600 KiB / 10,045,248 B |
|                         | 1.4.0  | 58 ms / 11,312 KiB / 6,342,144 B     | 53 ms / 14,128 KiB / 6,440,384 B   | 52 ms / 14,128 KiB / 6,456,832 B   |
| Source backend          | 1.3.14 | 158 ms / 67,376 KiB / 29,755,968 B   | 116 ms / 70,416 KiB / 30,198,272 B | 115 ms / 70,288 KiB / 30,116,480 B |
|                         | 1.4.0  | 158 ms / 54,816 KiB / 26,068,992 B   | 104 ms / 58,368 KiB / 27,560,000 B | 105 ms / 59,184 KiB / 27,920,384 B |
| Compiled binary         | 1.3.14 | 2,108 ms / 47,920 KiB / 20,531,072 B | 105 ms / 52,688 KiB / 22,464,256 B | 106 ms / 41,472 KiB / 21,661,440 B |
|                         | 1.4.0  | 208 ms / 48,048 KiB / 20,416,320 B   | 107 ms / 52,192 KiB / 21,694,208 B | 105 ms / 52,416 KiB / 21,956,352 B |

## Reading

- The Bun 1.4.0 runtime itself is substantially smaller: synthetic RSS dropped by about half to 60%.
- Development source-backend RSS dropped about 17%. That is the main application memory result.
- Compiled-binary size is unchanged at ~92 MiB. Compiled idle RSS is lower on the longer sample (−16%) and slightly higher on the 1,000 ms startup sample; do not treat compiled RSS as a clear win from the startup harness alone.
- Sequential `/setup` throughput and peak RSS under that load favor 1.4.0.
- This does not measure monitor polling, WebSocket fan-out, or a populated database.
