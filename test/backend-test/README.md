# Bun Backend Tests

Documentation: https://bun.sh/docs/test

Create a test file in this directory with the name `*.test.ts`.

Bun discovers `*.test.ts` files when `./test/backend-test` is passed to `bun test`.

> [!TIP]
> Writing great tests is hard.
>
> You can make our live much simpler by following this guidance:
>
> - Use `describe()` to group related tests
> - Use `test()` for individual test cases
> - One test per scenario
> - Use descriptive test names: `function() [behavior] [condition]`
> - Don't prefix with "Test" or "Should"

## Template

```ts
import { describe, expect, test } from "bun:test";

describe("Feature Name", () => {
    test("function() returns expected value when condition is met", () => {
        expect(1).toBe(1);
    });
});
```

## Mocking

Use Bun's native mocks for `node:test`-style `mock.method` / `mock.fn` patterns:

```ts
import { describe, expect, spyOn, test } from "bun:test";

test("spies on a module method", async () => {
    const spy = spyOn(SomeModule, "method").mockImplementation(async () => "ok");
    try {
        // exercise code under test
        expect(spy).toHaveBeenCalled();
    } finally {
        spy.mockRestore();
    }
});
```

For standalone function mocks, use `mock()` from `bun:test` (`mock.fn()` in Node maps to `mock(() => undefined)`).

## Run

```bash
bun run test:backend          # fast unit gate plus auth and maintenance integration
bun run test:backend:unit     # fast, offline unit subset
bun run test:backend:all      # full suite (includes integration / Docker tests)
```

### Fast unit gate (`test:backend:unit`)

The unit subset runs fast, hermetic tests (no Docker or public network):

- `sqlite-core.test.ts` — SQLite store bootstrap and queries
- `cert-hostname-match.test.ts` — certificate hostname matching
- `http-client.test.ts` — fetch wrapper behavior
- `globalping.test.ts` — mocked Globalping monitor behavior
- `monitor-conditions/*.test.ts` — condition parsing and evaluation
- `monitor-response.test.ts` — saved response serialization and truncation
- `monitor-runtime-loading.test.ts` — lazy monitor/notification loading
- `monitor-numeric-validation.test.ts` — timeout/retry/redirect save bounds and safe legacy-runtime fallbacks
- `monitor-scheduler.test.ts` — scheduler timer control
- `monitor-provider-timeout.test.ts` — loopback deadlines, SNMP retry quantization/cancellation, socket cleanup, and
  process-kill behavior
- `real-browser-monitor-lifecycle.test.ts` — browser acquisition/context/page deadlines, stop/reset cancellation,
  configuration identity, pending-acquisition retirement, targeted remote-owner reset, shared-owner races, late-result
  cleanup, supervised POSIX process-group identity, stale-PID rejection, and local/remote force-cleanup behavior
- `check-translations.test.ts` — translation key and placeholder safety
- `monitors/{gamedig,grpc,steam,tcp,websocket}.test.ts` — mocked or loopback protocol behavior
- `notification-providers/notification-provider.test.ts` — provider error normalization
- `ping-chart.test.ts`, `uptime-calculator.test.ts` — uptime and chart calculations
- `status-page.test.ts` — status descriptions and RSS formatting
- `system-service.test.ts` — mocked host command behavior
- `schema.test.ts` — generated `kuma.db` schema contract
- `upgrade.test.ts` — upstream Kuma 2.x one-time upgrade path

Add a file here only when it is fast, deterministic, and does not require external services.

### Expected failure categories in `test:backend:all`

The full suite discovers all `*.test.ts` files. Some failures are environmental, not migration regressions:

| Category       | Examples                                                                         | Cause                             |
| -------------- | -------------------------------------------------------------------------------- | --------------------------------- |
| Testcontainers | `monitors/{mqtt,mssql,mysql,oracledb,postgres,rabbitmq}.test.ts`, `snmp.test.ts` | Requires Docker and live services |
| Public network | `domain.test.ts`, opt-in TCP via `IGLO_MONITOR_PUBLIC_NETWORK_TESTS=1`           | Needs live RDAP/DNS/TLS           |
| Host/process   | `ping.test.ts`, `monitors/kafka-producer.test.ts`                                | Needs host tools or a local mock  |

The Testcontainers suites require a working local Docker daemon. The multi-case MySQL, Microsoft SQL Server, Oracle,
RabbitMQ, and MQTT suites share one real service container across their cases. PostgreSQL and SNMP start a container
only for their single live-service case. The suites use explicit startup or test bounds and await container teardown,
keeping protocol coverage realistic while avoiding unnecessary startup noise and cleanup leaks.

Use `test:backend` for the normal repository gate: it runs this unit subset, then the auth-security and maintenance
integration suites. Use `test:backend:unit` for a focused offline iteration.

The production WebSocket lifecycle tests can also target a compiled executable without changing their assertions:

```bash
IGLO_MONITOR_BINARY=./iglo.monitor bun test ./test/backend-test/monitor-lifecycle.test.ts
```

An opt-in case exercises a real local Chrome/Chromium process, screenshot serving, settings-triggered owner
replacement, pause during an active navigation, relaunch, and process cleanup on shutdown. Without
`IGLO_MONITOR_BINARY` it runs against source; with the variable it runs against the compiled executable:

```bash
IGLO_MONITOR_BINARY=./iglo.monitor \
IGLO_MONITOR_REAL_BROWSER_CHROME=/usr/bin/chromium \
bun test ./test/backend-test/monitor-lifecycle.test.ts --test-name-pattern "real-browser monitor completes"
```

To verify the single-file release contract, the standalone variant copies the executable into a fresh temporary
directory with no package manifest or `node_modules`, starts it from that directory without Bun module paths, and
runs the same real Chromium, screenshot, pause, delete, and shutdown checks:

```bash
IGLO_MONITOR_BINARY=./iglo.monitor \
IGLO_MONITOR_STANDALONE_BINARY=1 \
IGLO_MONITOR_REAL_BROWSER_CHROME=/usr/bin/chromium \
bun test ./test/backend-test/monitor-lifecycle.test.ts --test-name-pattern "copied standalone binary"
```

Source runs also include a development-only SQLite snapshot scenario. It verifies browser cleanup before restore
completion, post-swap database recovery, restored settings, and a fresh owner after rehydration:

```bash
IGLO_MONITOR_REAL_BROWSER_CHROME=/usr/bin/chromium \
bun test ./test/backend-test/monitor-lifecycle.test.ts --test-name-pattern "SQLite restore retires"
```

A separate test-only opt-in uses a Chromium wrapper that stalls before the Playwright handshake and a loopback remote
WebSocket that never answers. It verifies settings and test callbacks, remote-browser edit/delete, SQLite restore,
and `SIGTERM` cannot return while the matching process tree or socket is still live. The snapshot cases run only
against source; the other cases exercise source or the compiled executable:

```bash
IGLO_MONITOR_PENDING_BROWSER_ACQUISITION=1 \
bun test ./test/backend-test/monitor-lifecycle.test.ts \
  --test-name-pattern "pre-handshake|remote-browser (test|edit)|SIGTERM"

IGLO_MONITOR_PENDING_BROWSER_ACQUISITION=1 \
IGLO_MONITOR_BINARY=./iglo.monitor \
bun test ./test/backend-test/monitor-lifecycle.test.ts \
  --test-name-pattern "pre-handshake|remote-browser (test|edit)|SIGTERM"
```
