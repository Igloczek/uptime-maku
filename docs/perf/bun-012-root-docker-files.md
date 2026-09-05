# BUN-012 Root Docker Files Evidence

Date: 2026-06-29

## File Layout

- Production runtime Dockerfile moved from `docker/dockerfile` to root `Dockerfile`.
- The later SQLite-only Docker cleanup removed `Dockerfile.debian-base`, `Dockerfile.builder-go`, `compose.dev.yaml`, `docker-nscd.conf`, and `docker-sudoers`.
- The old `docker/` directory was removed.

## Runtime Defaults

- Root `compose.yaml` builds local image `iglo-monitor:local`.
- Root `compose.yaml` uses root `Dockerfile`.
- Package Docker scripts now expose one local image build script: `bun run build-docker`.
- Release helper default Dockerfile path is `Dockerfile`.

## Validation

```bash
bun run build
docker compose config
docker compose build --progress=plain
docker image inspect iglo-monitor:bun-final --format '{{.Size}}'
```

Results:

- `bun run build`: passed.
- `docker compose config`: passed and resolved `dockerfile: Dockerfile`.
- `docker compose build --progress=plain`: passed.
- Image size: `440150763` bytes.

## Compose Smoke

Command:

```bash
IGLO_MONITOR_PORT=3012 IGLO_MONITOR_DATA_DIR=/tmp/iglo-monitor-root-docker-smoke docker compose -p iglo-monitor-root-smoke up -d --force-recreate
```

Results:

- Container started from `iglo-monitor:bun-final`.
- Container status: `Up ... (healthy)`.
- Logs showed `Server Type: Bun.serve HTTP`.
- HTTP check passed: `http://127.0.0.1:3012/setup` returned `200`.
- Browser smoke passed: setup page rendered, admin user was created, and dashboard loaded.
- Smoke project was stopped with `docker compose -p iglo-monitor-root-smoke down --volumes --remove-orphans`.
- Temporary data directory `/tmp/iglo-monitor-root-docker-smoke` was removed.

## Remaining Docker Exceptions

- The later SQLite-only Docker cleanup removed `extra/uptime-kuma-push/` too, so the project now keeps one Docker image path for the main runtime.
- `test/test-radius.dockerfile` remains under `test/` because it is a test fixture, not a runtime image.
