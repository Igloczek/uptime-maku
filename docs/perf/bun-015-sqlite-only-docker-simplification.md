# BUN-015 SQLite-Only Docker Simplification Evidence

Date: 2026-06-29

## Scope

- The application database is SQLite-only.
- The first-run database setup no longer offers MariaDB, embedded MariaDB, or any other application database backend.
- Docker now has one main runtime image built from the root `Dockerfile`.
- The root `compose.yaml` is runtime convenience only; development runs directly with Bun.
- The README now describes Uptime Maku as a performance-focused Uptime Maku derivative with fewer dependencies, fewer deployment knobs, and a smaller runtime surface.

## Removed Runtime Surface

- Removed inherited helper Dockerfiles and dev Compose assets:
    - `Dockerfile.builder-go`
    - `Dockerfile.debian-base`
    - `compose.dev.yaml`
    - `docker-nscd.conf`
    - `docker-sudoers`
- Removed the separate `extra/uptime-kuma-push/` helper image and the Docker push-monitor example that depended on `uptime-maku:push`.
- Removed old nightly/rootless/PR-test/upload-artifact release image paths.
- Removed embedded MariaDB application database code.
- Removed MariaDB application database setup UI and setup API branches.
- Removed `@testcontainers/mariadb` and the direct `sqlstring` dependency.
- Moved legacy SQLite migration dependencies to dev-only ownership:
    - `@louislam/sqlite3`
    - `knex`
    - SQLite migration support remains dev-only and is not part of the application runtime image.

MySQL/MariaDB monitor support remains as monitor functionality. It is not an application database backend.

## Docker Image Size

Previous Bun cleanup image from `docs/perf/bun-014-final-bun-cleanup.md`:

```text
uptime-maku:bun-final = 438054063 bytes
```

Current single local runtime image:

```bash
docker build -f Dockerfile -t uptime-maku:local .
docker run --rm uptime-maku:local --version
docker image inspect uptime-maku:local --format '{{.Size}}'
```

Pinned Docker base:

```text
runtime/build = oven/bun:1.3.14-alpine
```

Result:

```text
Bun runtime = 1.3.14
uptime-maku:local = 277529464 bytes
```

Delta:

```text
-160524599 bytes
```

## Local Browser Smoke

Started:

```bash
bun run start -- --port=3015 --data-dir=./data/sqlite-only-smoke
```

Observed startup logs:

```text
Using SQLite as the application database
Database Type: sqlite (bun:sqlite)
Server Type: Bun.serve HTTP
```

Browser flow:

- Loaded first-run setup.
- Created user `smoke`.
- Confirmed setup did not show a database selection step.
- Created HTTP monitor `SQLite-only smoke` for `http://127.0.0.1:3015`.
- Dashboard showed heartbeat `Up` with `200 - OK`.

SQLite persistence check:

```json
{
    "config": {
        "type": "sqlite"
    },
    "users": 1,
    "monitors": 1,
    "latestMonitor": {
        "id": 1,
        "name": "SQLite-only smoke",
        "type": "http",
        "url": "http://127.0.0.1:3015"
    },
    "heartbeats": 1,
    "latestHeartbeat": {
        "status": 1,
        "msg": "200 - OK"
    }
}
```

Cleanup: local server stopped cleanly and `./data/sqlite-only-smoke` was removed.

## Docker Runtime Smoke

Started:

```bash
docker run --rm -d --name uptime-maku-sqlite-smoke \
    -p 3016:3001 \
    -v /tmp/uptime-maku-docker-sqlite-smoke:/app/data \
    uptime-maku:local
```

HTTP check:

```bash
curl -fsS http://127.0.0.1:3016/setup
```

Result:

```text
HTTP 200 on attempt 1
```

Container logs confirmed:

```text
Your bun version: 1.3.14
Server Type: Bun.serve HTTP
Using SQLite as the application database
Database Type: sqlite (bun:sqlite)
```

Docker healthcheck:

```json
{
    "Status": "healthy",
    "FailingStreak": 0,
    "Log": [
        {
            "ExitCode": 0,
            "Output": "Health Check OK [Res Code: 302]\n"
        }
    ]
}
```

Mounted data directory contained:

```json
{
    "type": "sqlite"
}
```

and a newly created `kuma.db`.

Cleanup: Docker smoke container stopped and `/tmp/uptime-maku-docker-sqlite-smoke` was removed.

## Validation

- `bun install --frozen-lockfile`: passed.
- `bun run tsc`: passed.
- `bun run lint`: passed with inherited Oxlint warnings and Stylelint deprecation warnings.
- `bun run build`: passed.
- `bun run test:backend`: passed, 17 tests.
- `bun test ./test/backend-test/test-migration.ts`: passed.
- `docker build -f Dockerfile -t uptime-maku:local .`: passed.
- Local browser smoke: passed.
- Docker boot/healthcheck smoke: passed.
