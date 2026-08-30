# BUN-013 Source Layout Evidence

Date: 2026-06-29

## Moved Source

- Moved backend runtime source from root `server/` to `src/server/`.
- Moved database source/assets from root `db/` to `src/db/`.
- Moved the Vite HTML entrypoint from root `index.html` to `src/index.html`.
- Removed root `server/`, root `db/`, and root `index.html`.
- Kept generated/runtime directories such as `data/` and `dist/` at root.

## Updated Entrypoints

- Package start scripts now run `bun src/server/server.ts`.
- Vite now uses `src` as its project root and emits the production build to root `dist/`.
- Docker release image now copies `src/` and runs `CMD ["src/server/server.ts"]`.
- Playwright web server now starts `src/server/server.ts`.
- The later Docker cleanup removed the dev Compose workflow; local development now uses `bun run dev`.
- Backend tests and helper scripts now import from `src/server` and `src/db`.

## Remaining JS Exceptions

- `src/server/modules/**` remains vendored JavaScript.

## Database Schema Layout

- `src/db/schema/current.sql` is the canonical SQLite DDL for fresh installs.
- `src/db/schema/upgrades/` contains versioned one-time upgrades for upstream Uptime Kuma 2.x databases.
- `out/kuma.db` is generated from `current.sql` via `bun run build:kuma-db`.

## Validation

```bash
bun install --frozen-lockfile
bun run tsc
bun run lint
bun run build
bun run test:backend
bun run start -- --port=3007 --data-dir=./data/src-layout-smoke
```

Results:

- `bun install --frozen-lockfile`: passed, no lockfile changes.
- `bun run tsc`: passed.
- `bun run lint`: passed with inherited warnings and Stylelint deprecation warnings.
- `bun run build`: passed.
- Root entrypoint cleanup verified: `CNAME` and root `index.html` are absent, and `src/index.html` exists.
- `bun run test:backend`: passed, 17 tests.
- Browser smoke passed: setup page rendered, user `src-smoke` was created, monitor `src-layout-smoke` was created for `http://127.0.0.1:3007`, and first heartbeat returned `200 - OK`.
- Smoke server shut down gracefully and `data/src-layout-smoke` was removed.
