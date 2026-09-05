# BUN-008 Bun Default Runtime Evidence

Date: 2026-06-28

## Default Runtime

- Package install: `bun install --frozen-lockfile`
- Production start: `bun run start`
- Production command: `bun src/server/server.ts`
- Build: `bun run build`
- Backend tests: `bun run test:backend`
- Docker runtime target at the time: `docker build -f Dockerfile -t iglo-monitor:bun-final --target release .`
- Current Docker runtime target: `docker build -f Dockerfile -t iglo-monitor:local .`

## Removed Node-Era Defaults

- `package-lock.json` is no longer the default lockfile; `bun.lock` is the package-manager source of truth.
- npm-backed default scripts were replaced with Bun-backed `start`, `build`, `test:backend`, and development commands.
- Helper scripts no longer import removed `args-parser`; they use `src/server/args.ts`.
- `extra/reset-password.js` no longer imports removed `socket.io-client`; after resetting JWT state it warns that a server restart disconnects active WebSocket sessions.
- The production Docker build and runtime stages now use the Bun image instead of inherited Node base images.
- The release image installs production dependencies with `bun install --frozen-lockfile --production` and copies only runtime directories/artifacts from the build stage: `dist`, `src`, and a minimal `extra` subset.
- The copied `extra` subset is `extra/healthcheck.ts` for Docker healthchecks, `extra/rdap-dns.json` for domain-expiry monitors, and `extra/push-examples/` for push-monitor socket helper examples.
- Other `extra/*` package scripts remain host/development/release helpers and are intentionally not supported inside the pruned production container unless a later task adds them to the runtime image.
- Inherited Docker helper scripts and compose defaults now target `iglo-monitor:*` images instead of upstream `louislam/uptime-kuma:*` images. The root `compose.yaml` builds this repository with `Dockerfile` instead of pulling a public upstream runtime image.

## Remaining Node-Era Dependencies

These packages still appear in `package.json` because accepted BUN-001 through BUN-007 code still references them. Removing them in BUN-008 would break current behavior rather than prune dead code.

| Dependency                                  | Current reason                                                                                                                                                                                           | Follow-up                                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `express`                                   | `src/server/server.ts`, setup flow, routers, static middleware, and `IgloMonitorServer.app` still mount inherited Express handlers. Bun serves the default listener, but route extraction is incomplete. | Extract remaining Express routers/middleware into Bun-native fetch handlers, then delete Express.         |
| `express-basic-auth`                        | Basic auth middleware is still used by `src/server/auth.ts`.                                                                                                                                             | Replace API/status-page auth middleware with Bun request helpers after Express router removal.            |
| `express-static-gzip`                       | `src/server/server.ts` still uses inherited static gzip middleware for compatibility routes.                                                                                                             | Serve precompressed assets directly from `bun-http-server.js`, then delete this dependency.               |
| `prometheus-api-metrics`                    | `/metrics` is still mounted through Express middleware.                                                                                                                                                  | Replace with a Bun-native metrics response path.                                                          |
| `@louislam/sqlite3`, `redbean-node`, `knex` | SQLite migration tests and legacy migration assets still reference Redbean/Knex/sqlite3.                                                                                                                 | Replace remaining legacy migration coverage with Bun SQLite-native checks, then prune these dependencies. |
| `axios`                                     | Many inherited frontend pages, notification providers, optional monitor types, Docker helper, and NTLM helper still import Axios.                                                                        | Continue BUN-006 provider-by-provider conversion to native `fetch`, then prune Axios.                     |

## Removed Dependency Import Scan

Focused scan:

```bash
rg -n 'args-parser|socket\.io-client' package.json extra src test
```

Result: no direct imports or package entries remain. `bun.lock` still contains transitive `yargs-parser` entries pulled by other packages; that is not the removed `args-parser` package.

## Final Smoke Checklist

- Install: passed with `bun install --frozen-lockfile`.
- Build: passed with `bun run build`.
- Backend tests: passed with `bun run test:backend`; 17 tests passed.
- Start command: passed with `bun run start -- --port=3007 --data-dir=./data/bun-final-smoke`.
- Login/setup: passed in browser smoke by creating user `smoke` and reaching `/dashboard`.
- Monitor creation: passed in browser smoke by creating monitor `BUN-008 localhost` for `http://localhost:3007`.
- Native WebSocket status update: passed. Server logs showed native WebSocket connections and token login, and browser dashboard showed monitor status `Up` after heartbeat hydration.
- SQLite persistence: passed. `bun:sqlite` inspection showed 1 user, 1 monitor, and 21 heartbeat rows before cleanup; latest heartbeat rows had `status = 1`.
- Compose/container smoke: passed with `IGLO_MONITOR_PORT=3011 IGLO_MONITOR_DATA_DIR=/tmp/iglo-monitor-compose-smoke docker compose -p iglo-monitor-smoke -f compose.yaml up -d --build --force-recreate`. The container was healthy, served the app through the then-pinned Bun image, completed setup/login, created an HTTP monitor for `http://127.0.0.1:3001`, and stored a heartbeat with `status = 1`, `msg = '200 - OK'`, and `ping = 3`. Current Docker image evidence is superseded by `docs/perf/bun-015-sqlite-only-docker-simplification.md`.
- Compose SQLite schema check: passed. The smoke `monitor` table had no camelCase columns after monitor creation; frontend camelCase monitor fields were stored in canonical snake_case columns such as `ignore_tls`, `domain_expiry_notification`, `ip_family`, and `ws_subprotocol`.
- Cleanup: smoke server stopped and `data/bun-final-smoke` removed after validation.

## Docker

- Image: `iglo-monitor:bun-final`
- Size: `478563803` bytes.
- Build: passed with `docker compose --progress=plain -p iglo-monitor-smoke -f compose.yaml up -d --build --force-recreate`.
- Current Dockerfile outcome: root `Dockerfile` builds one Bun runtime image. The old helper Dockerfiles, dev Compose file, nightly/rootless/PR-test targets, and upload-artifact target were removed after this report.
