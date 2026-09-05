# README Runtime Snapshot

Date: 2026-06-29

This snapshot is historical reference evidence under `docs/perf/`. It is not an upstream Uptime Kuma benchmark; it records the current iglo.monitor default path on this machine.

## Startup RSS

Command shape:

```bash
tmpdir=$(mktemp -d /tmp/iglo-monitor-readme-memory.XXXXXX)
bun src/server/server.ts --port=3037 --data-dir="$tmpdir/data" > "$tmpdir/server.log" 2>&1 &
pid=$!
curl -fsS http://127.0.0.1:3037/setup
sleep 2
ps -o rss= -p "$pid"
kill "$pid"
```

Observed:

```text
Bun runtime: 1.3.14
Server Type: Bun.serve HTTP
Database Type: sqlite (bun:sqlite)
RSS: 197696 KiB / 193.1 MiB
```

Measurement conditions:

- macOS host.
- Fresh temporary data directory.
- No user, no monitors, no heartbeat history.
- RSS sampled two seconds after `/setup` responded.

## Docker Image

Current image evidence is recorded in [bun-015-sqlite-only-docker-simplification.md](bun-015-sqlite-only-docker-simplification.md).

```text
iglo-monitor:local = 277529464 bytes / 264.7 MiB
previous Bun cleanup image = 438054063 bytes / 417.8 MiB
delta = -160524599 bytes / -153.1 MiB / -36.6%
```
