# BUN-014 Final Bun Cleanup Evidence

Date: 2026-06-29

## Bun Configuration

- Removed `.npmrc`.
- Added `bunfig.toml` with `[install].minimumReleaseAge = 1209600`.
- The previous release-age guard was 14 days. Bun expects this value in seconds, so 14 days is `1209600`.
- Dropped `legacy-peer-deps=true`; Bun installs peer dependencies by default, and `bun install --frozen-lockfile` passes with the current dependency graph.

## Removed Fallbacks and Dependencies

- Removed `package-lock.json`; `bun.lock` is the only lockfile.
- Removed `.prettierignore`; Oxfmt ignore settings live in `.oxfmtrc.json`.
- Removed `test/test-backend.mjs`.
- Removed package scripts `test-backend-20` and `test-backend-22`.
- Removed direct dependencies/dev dependencies that no longer had a Bun runtime owner:
    - `test`
    - `http-graceful-shutdown`
    - `socket.io`
    - `dotenv`
- Removed the Node HTTP/Socket.IO fallback constructor path from `src/server/iglo-monitor-server.ts`.
- Added a Bun-only entrypoint guard in `src/server/server.ts`; running the server without Bun exits immediately.
- Replaced release version helper lockfile updates with `bun install --lockfile-only`.
- Replaced package-version reads that depended on npm script environment variables with direct `package.json` reads.
- Updated the Docker build and release install layers to copy `bunfig.toml` next to `package.json` and `bun.lock`.

## Remaining Node-Era Dependencies

These remain because code still imports them directly on supported paths.

| Dependency                                  | Current owner                                                                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `express`                                   | `src/server/server.ts`, `src/server/iglo-monitor-server.ts`, routers, and compatibility middleware still mount an Express app behind Bun. |
| `express-basic-auth`                        | `src/server/auth.ts` basic-auth middleware.                                                                                               |
| `express-static-gzip`                       | `src/server/server.ts` static asset compatibility path.                                                                                   |
| `prometheus-api-metrics`                    | `/metrics` middleware in `src/server/server.ts`.                                                                                          |
| `@louislam/sqlite3`, `redbean-node`, `knex` | SQLite migration tests and legacy migration assets. The application runtime uses the Bun SQLite compatibility store.                      |
| `axios`                                     | Frontend pages, notification providers, monitor implementations, Docker helper, update checker, and vendored NTLM helper.                 |
| `ws`                                        | WebSocket Upgrade monitor implementation and backend websocket tests.                                                                     |
| `isomorphic-ws`                             | Nostr notification provider global WebSocket shim.                                                                                        |
| `node-cloudflared-tunnel`                   | Cloudflared socket handler.                                                                                                               |
| `node-radius-utils`                         | Radius utility wrapper in `src/server/util-server.ts`.                                                                                    |

## Validation

- `bun install --frozen-lockfile`: passed, no lockfile changes.
- `bun run tsc`: passed.
- `bun run lint`: passed with inherited Oxlint warnings and Stylelint deprecation warnings.
- `bun run build`: passed.
- `bun run test:backend`: passed, 17 tests.
- Current Docker validation moved to the later SQLite-only Docker cleanup report. This historical run built `iglo-monitor:bun-final` at `438054063` bytes before the image matrix cleanup.

## Local Browser Smoke

- Started: `bun run start -- --port=3007 --data-dir=./data/final-bun-smoke`.
- Browser setup: created user `smoke`.
- Dashboard: reached `/dashboard`.
- Monitor creation: created HTTP monitor `final-bun-smoke` for `http://localhost:3007`.
- Heartbeat: browser showed `Up` and `200 - OK`.
- SQLite persistence check:

```json
{ "users": 1, "monitors": 1, "heartbeats": 1, "latest": { "status": 1, "msg": "200 - OK" } }
```

- Cleanup: server stopped cleanly, browser closed, and `./data/final-bun-smoke` was removed.

## Compose Browser Smoke

- Started local image through root compose file:

```bash
IGLO_MONITOR_PORT=3013 IGLO_MONITOR_DATA_DIR=/tmp/iglo-monitor-final-compose-smoke docker compose -p iglo-monitor-final-smoke up -d --force-recreate
```

- `/setup` returned HTTP 200.
- Browser setup: created user `compose`.
- Dashboard: reached `/dashboard`.
- Monitor creation: created HTTP monitor `compose-final-smoke` for `http://127.0.0.1:3001`.
- Heartbeat: browser showed `Up` and `200 - OK`.
- Mounted SQLite persistence check:

```json
{ "users": 1, "monitors": 1, "heartbeats": 1, "latest": { "status": 1, "msg": "200 - OK" } }
```

- Cleanup: compose stack removed and `/tmp/iglo-monitor-final-compose-smoke` deleted.
