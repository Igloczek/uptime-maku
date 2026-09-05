# BUN-007 Monitor Runtime Loading Evidence

Date: 2026-06-28

## Startup Import Surface

Before BUN-007, startup eagerly instantiated optional monitor implementations in `src/server/iglo-monitor-server.ts` and notification providers in `src/server/notification.ts`.

- Optional monitor implementations eagerly imported before: 23
- Notification provider JS files eagerly imported before: 95, including the shared base class
- Concrete notification provider implementations eagerly imported before: 94
- Optional monitor implementations eagerly imported after: 0
- Notification provider implementations eagerly imported after `Notification.init()`: 0

Focused measurement:

```bash
bun test test/backend-test/monitor-runtime-loading.test.ts
```

Passing checks:

- `monitor runtime lazy loading > startup metadata does not import optional monitor implementations`
- `monitor runtime lazy loading > notification init registers providers without importing provider modules`

Remaining eager monitor/provider loading:

- Core monitor logic still lives in `src/server/model/monitor.ts` for `http`, `keyword`, `json-query`, `ping`, `push`, `docker`, `radius`, and `kafka-producer`.
- Optional monitor helper modules are loaded only from registry `load()` callbacks or explicit UI helper actions such as testing Chrome/remote browser or listing GameDig games.
- Notification provider modules are loaded only by `getNotificationProvider(type)` when a configured provider sends.

## Timer Behavior

Focused scheduler validation:

```bash
bun test test/backend-test/monitor-scheduler.test.ts
```

Passing checks:

- `monitor scheduler timer control > repeated restart scheduling leaves one active check loop`
- `monitor scheduler timer control > pause and stop clear future checks`

Scheduler change:

- `Monitor.start()` clears any existing heartbeat timer before starting.
- All future heartbeat scheduling routes through `scheduleHeartbeat()`, which clears the prior timer first.
- `Monitor.stop()` clears and nulls the timer before marking the monitor stopped.
- Push monitor startup delay is now tracked in `heartbeatInterval`, so stop/pause can cancel it.
