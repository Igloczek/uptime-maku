// @ts-nocheck

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BunRealtimeAdapter } from "@/server/bun-websocket-server";
import { createBunFetchHandler, restoreSqliteSnapshot, takeSqliteSnapshot } from "@/server/bun-http-server";
import { clearResponseCache, createResponseCache } from "@/server/bun-response";
import Database from "@/server/database";
import { DatabaseMaintenanceCoordinator } from "@/server/database-maintenance";
import { runPendingUpgrades } from "@/server/db-migrations";
import { scheduleBackgroundJobs, stopBackgroundJobs } from "@/server/jobs";
import { incrementalVacuum } from "@/server/jobs/incremental-vacuum";
import { databaseSocketHandler } from "@/server/socket-handlers/database-socket-handler";

const originalSqlitePath = Database.sqlitePath;
const originalDataDir = Database.dataDir;
const temporaryDirectories = [];
let scheduledJobs;

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function createFakeStore({ failConnectCalls = [], failExec } = {}) {
    let open = true;
    let connectCount = 0;
    const calls = [];
    return {
        calls,
        exec: async (sql) => {
            calls.push(["exec", sql]);
            const error = failExec?.(sql);
            if (error) {
                throw error;
            }
        },
        getAll: async () => [],
        getCell: async () => "3.49.0",
        close: async () => {
            calls.push(["close"]);
            open = false;
        },
        connect: async () => {
            connectCount++;
            calls.push(["connect", connectCount]);
            if (failConnectCalls.includes(connectCount)) {
                throw new Error(`connect failed ${connectCount}`);
            }
            open = true;
        },
        isOpen: () => open,
    };
}

function createSnapshotDatabase(filePath, marker) {
    const db = new BunDatabase(filePath, { create: true, strict: true });
    db.run("CREATE TABLE monitor (id INTEGER PRIMARY KEY)");
    db.run('CREATE TABLE setting (id INTEGER PRIMARY KEY, "key" TEXT, value TEXT)');
    db.run("CREATE TABLE user (id INTEGER PRIMARY KEY)");
    db.run('INSERT INTO setting ("key", value) VALUES (?, ?)', ["marker", marker]);
    db.close();
}

function readMarker(filePath) {
    const db = new BunDatabase(filePath, { readonly: true, strict: true });
    try {
        return db.query('SELECT value FROM setting WHERE "key" = ?').get("marker").value;
    } finally {
        db.close();
    }
}

function useTemporaryDatabase() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-lifecycle-"));
    temporaryDirectories.push(directory);
    Database.sqlitePath = path.join(directory, "kuma.db");
    Database.dataDir = directory;
    return Database.sqlitePath;
}

beforeEach(() => {
    scheduledJobs = [];
});

afterEach(() => {
    stopBackgroundJobs(scheduledJobs);
    Database.sqlitePath = originalSqlitePath;
    Database.dataDir = originalDataDir;
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe("database lifecycle wiring", () => {
    test("runs migrations through the injected store transaction", async () => {
        const calls = [];
        const transaction = {
            hasTable: async () => false,
            getAll: async () => [],
            getRow: async () => null,
            exec: async (sql) => calls.push(sql),
            commit: async () => calls.push("commit"),
            rollback: async () => calls.push("rollback"),
        };
        const store = {
            hasTable: async () => false,
            getCell: async () => null,
            begin: async () => {
                calls.push("begin");
                return transaction;
            },
        };
        const migration = {
            exec: () => {},
            hasTable: () => false,
            hasColumn: () => false,
            addColumnIfMissing: () => false,
            createIndexIfMissing: () => false,
        };

        await runPendingUpgrades(store, migration);

        expect(calls[0]).toBe("begin");
        expect(calls.some((call) => String(call).includes("INSERT INTO setting"))).toBe(true);
        expect(calls.at(-1)).toBe("commit");
        expect(calls).not.toContain("rollback");
    });

    test("schedules job SQL through the coordinator without changing ordering", async () => {
        const callbacks = new Map();
        class FakeCron {
            constructor(_interval, options, callback) {
                callbacks.set(options.name, callback);
            }
            stop() {}
        }
        const sql = [];
        const store = { exec: async (statement) => sql.push(statement) };
        let coordinated = 0;
        const coordinator = {
            run: async (operation) => {
                coordinated++;
                return operation();
            },
        };

        scheduleBackgroundJobs(store, coordinator, "UTC", FakeCron, undefined, null, scheduledJobs);
        await callbacks.get("incremental-vacuum")();

        expect(coordinated).toBe(1);
        expect(sql).toEqual(["PRAGMA incremental_vacuum(200)", "PRAGMA wal_checkpoint(PASSIVE)"]);
    });

    test("schedules in-process Bun cron jobs that can be stopped", () => {
        const store = { exec: async () => {} };
        const coordinator = {
            run: async (operation) => operation(),
            maintain: async (operation) => operation(),
        };

        scheduledJobs = scheduleBackgroundJobs(store, coordinator, "UTC");
        expect(scheduledJobs).toHaveLength(2);
        expect(typeof scheduledJobs[0].stop).toBe("function");
        stopBackgroundJobs(scheduledJobs);
        expect(scheduledJobs).toHaveLength(0);
    });

    test("wires the database socket handler to its injected store", async () => {
        const handlers = {};
        const socket = {
            userID: 1,
            on: (event, handler) => {
                handlers[event] = handler;
            },
        };
        const sql = [];
        databaseSocketHandler(socket, { exec: async (statement) => sql.push(statement) });
        let response;

        await handlers.shrinkDatabase((result) => {
            response = result;
        });

        expect(response.ok).toBe(true);
        expect(sql).toEqual(["VACUUM"]);
    });

    test("wires HTTP and WebSocket dispatch through the coordinator", async () => {
        const calls = [];
        const coordinator = {
            run: async (operation) => {
                calls.push("run");
                return operation();
            },
            maintain: async (operation) => {
                calls.push("maintain");
                return operation();
            },
        };
        const fetchHandler = createBunFetchHandler({
            server: { indexHTML: "", io: {} },
            store: {},
            databaseMaintenance: coordinator,
            disableFrameSameOrigin: false,
            development: false,
        });
        const response = await fetchHandler(new Request("http://localhost/.well-known/change-password"), {});

        const adapter = new BunRealtimeAdapter({}, { get: async () => false });
        adapter.setDatabaseMaintenanceCoordinator(coordinator);
        adapter.setMaintenanceEvents(["clear"]);
        const store = { exec: async () => calls.push("socket-store") };
        const ws = {
            data: { headers: {}, remoteAddress: "" },
            readyState: WebSocket.OPEN,
            send: () => {},
            close: () => {},
        };
        adapter.setConnectionInitializer(async (socket) => {
            await store.exec("SELECT setting");
            socket.on("write", () => store.exec("UPDATE setting"));
            socket.on("clear", () => store.exec("DELETE setting"));
        });
        await adapter.open(ws);
        await adapter.message(ws, JSON.stringify({ type: "event", event: "write", args: [] }));
        await adapter.message(ws, JSON.stringify({ type: "event", event: "clear", args: [] }));

        expect(response.status).toBe(302);
        expect(calls).toEqual(["run", "run", "socket-store", "run", "socket-store", "maintain", "socket-store"]);
    });

    test("two HTTP runtimes do not share badge responses for the same URL", async () => {
        const createRuntime = (status, responseCache) => {
            let latestCalls = 0;
            let latestError;
            const heartbeatData = {
                latest: async () => {
                    latestCalls++;
                    if (latestError) {
                        throw latestError;
                    }
                    return { status };
                },
            };
            const fetch = createBunFetchHandler({
                server: { indexHTML: "", io: {} },
                store: { getRow: async () => ({ monitor_id: 1 }) },
                databaseMaintenance: new DatabaseMaintenanceCoordinator(),
                heartbeatData,
                responseCache,
                disableFrameSameOrigin: false,
                development: false,
            });
            return {
                failLatest(error) {
                    latestError = error;
                },
                fetch,
                latestCalls: () => latestCalls,
            };
        };
        const firstCache = createResponseCache();
        const secondCache = createResponseCache();
        const first = createRuntime(1, firstCache);
        const second = createRuntime(0, secondCache);
        const request = new Request("http://localhost/api/badge/1/status");

        const firstBody = await (await first.fetch(request, {})).text();
        const secondBody = await (await second.fetch(request, {})).text();

        expect(first.latestCalls()).toBe(1);
        expect(second.latestCalls()).toBe(1);
        expect(secondBody).not.toBe(firstBody);

        clearResponseCache(firstCache);
        expect(await (await second.fetch(request, {})).text()).toBe(secondBody);
        expect(second.latestCalls()).toBe(1);

        clearResponseCache(secondCache);
        expect(await (await second.fetch(request, {})).text()).toBe(secondBody);
        expect(second.latestCalls()).toBe(2);

        first.failLatest(new Error("first runtime failed"));
        clearResponseCache(firstCache);
        const failedBody = await (await first.fetch(request, {})).text();
        expect(failedBody).not.toBe(firstBody);
        expect(first.latestCalls()).toBe(2);
        expect(await (await second.fetch(request, {})).text()).toBe(secondBody);
        expect(second.latestCalls()).toBe(2);
    });

    test("closes through the injected store after checkpointing WAL", async () => {
        const calls = [];
        const store = {
            exec: async (sql) => calls.push(["exec", sql]),
            close: async () => calls.push(["close"]),
        };

        await Database.close(store);

        expect(calls).toEqual([["exec", "PRAGMA wal_checkpoint(TRUNCATE)"], ["close"]]);
    });

    test("keeps incremental vacuum and WAL checkpoint ordering on the injected store", async () => {
        const calls = [];
        const store = {
            exec: async (sql) => calls.push(sql),
        };

        await incrementalVacuum(store);

        expect(calls).toEqual(["PRAGMA incremental_vacuum(200)", "PRAGMA wal_checkpoint(PASSIVE)"]);
    });
});

describe("database maintenance coordination", () => {
    test("WebSocket open initialization drains before maintenance and new opens wait", async () => {
        const coordinator = new DatabaseMaintenanceCoordinator();
        const adapter = new BunRealtimeAdapter({}, { get: async () => false });
        adapter.setDatabaseMaintenanceCoordinator(coordinator);
        const firstStarted = deferred();
        const releaseFirst = deferred();
        const maintenanceStarted = deferred();
        const releaseMaintenance = deferred();
        const secondStarted = deferred();
        const events = [];
        let initialization = 0;
        const store = {
            exec: async () => events.push(`db-${initialization}`),
        };
        adapter.setConnectionInitializer(async () => {
            initialization++;
            const current = initialization;
            events.push(`init-${current}-start`);
            if (current === 1) {
                firstStarted.resolve();
                await releaseFirst.promise;
            } else {
                secondStarted.resolve();
            }
            await store.exec("SELECT value FROM setting");
            events.push(`init-${current}-end`);
        });
        const websocket = () => ({
            data: { headers: {}, remoteAddress: "" },
            readyState: WebSocket.OPEN,
            send: () => {},
            close: () => {},
        });

        const firstOpen = adapter.open(websocket());
        await firstStarted.promise;
        const maintenance = coordinator.maintain(async () => {
            events.push("maintenance");
            maintenanceStarted.resolve();
            await releaseMaintenance.promise;
        });

        await Bun.sleep(0);
        expect(events).toEqual(["init-1-start"]);
        releaseFirst.resolve();
        await maintenanceStarted.promise;
        const secondOpen = adapter.open(websocket());
        await Bun.sleep(0);
        expect(events).toEqual(["init-1-start", "db-1", "init-1-end", "maintenance"]);

        releaseMaintenance.resolve();
        await Promise.all([firstOpen, maintenance, secondOpen, secondStarted.promise]);
        expect(events).toEqual([
            "init-1-start",
            "db-1",
            "init-1-end",
            "maintenance",
            "init-2-start",
            "db-2",
            "init-2-end",
        ]);
    });

    test("snapshot waits for an active job and gates a new HTTP request until copy completes", async () => {
        const databasePath = useTemporaryDatabase();
        fs.writeFileSync(databasePath, "database");
        const store = createFakeStore();
        const coordinator = new DatabaseMaintenanceCoordinator();
        const callbacks = new Map();
        class FakeCron {
            constructor(_interval, options, callback) {
                callbacks.set(options.name, callback);
            }
            stop() {}
        }
        const activeStarted = deferred();
        const releaseActive = deferred();
        const copyStarted = deferred();
        const releaseCopy = deferred();
        let copyHasStarted = false;
        let newWorkFinished = false;
        const originalExec = store.exec;
        store.exec = async (sql) => {
            if (sql === "PRAGMA incremental_vacuum(200)") {
                activeStarted.resolve();
                await releaseActive.promise;
            }
            return originalExec(sql);
        };
        scheduleBackgroundJobs(store, coordinator, "UTC", FakeCron, undefined, null, scheduledJobs);
        const fetchHandler = createBunFetchHandler({
            server: { indexHTML: "", io: {} },
            store,
            databaseMaintenance: coordinator,
            disableFrameSameOrigin: false,
            development: false,
        });

        const active = callbacks.get("incremental-vacuum")();
        await activeStarted.promise;
        const snapshot = takeSqliteSnapshot(
            store,
            coordinator,
            { stop: async () => {}, reload: async () => {} },
            async (source, destination) => {
                copyHasStarted = true;
                copyStarted.resolve();
                await releaseCopy.promise;
                fs.cpSync(source, destination);
            }
        );
        const newWork = fetchHandler(new Request("http://localhost/.well-known/change-password"), {}).then(
            (response) => {
                newWorkFinished = true;
                return response;
            }
        );

        await Bun.sleep(0);
        expect(copyHasStarted).toBe(false);
        expect(newWorkFinished).toBe(false);
        releaseActive.resolve();
        await copyStarted.promise;
        await Bun.sleep(0);
        expect(newWorkFinished).toBe(false);

        releaseCopy.resolve();
        const [, , response] = await Promise.all([active, snapshot, newWork]);
        expect(response.status).toBe(302);
    });

    test("take copy failure reconnects the same store and resumes gated work", async () => {
        const databasePath = useTemporaryDatabase();
        fs.writeFileSync(databasePath, "database");
        const store = createFakeStore();
        const coordinator = new DatabaseMaintenanceCoordinator();
        const runtimeCalls = [];

        await expect(
            takeSqliteSnapshot(
                store,
                coordinator,
                {
                    stop: async () => runtimeCalls.push("stop"),
                    reload: async () => runtimeCalls.push("reload"),
                },
                () => {
                    throw new Error("copy failed");
                }
            )
        ).rejects.toThrow("Unable to copy SQLite DB");

        expect(store.isOpen()).toBe(true);
        expect(store.calls.map(([name]) => name)).toEqual(["exec", "close", "connect"]);
        expect(runtimeCalls).toEqual(["stop", "reload"]);
        expect(await coordinator.run(() => "resumed")).toBe("resumed");
    });

    for (const copyFails of [false, true]) {
        test(`take waits for an active monitor write and resumes runtime after copy ${copyFails ? "failure" : "success"}`, async () => {
            const databasePath = useTemporaryDatabase();
            fs.writeFileSync(databasePath, "database");
            const store = createFakeStore();
            const coordinator = new DatabaseMaintenanceCoordinator();
            const monitorStarted = deferred();
            const releaseMonitor = deferred();
            const events = [];
            const activeMonitor = (async () => {
                events.push("monitor-start");
                monitorStarted.resolve();
                await releaseMonitor.promise;
                events.push("monitor-write");
                await store.exec("INSERT INTO heartbeat");
            })();
            const originalClose = store.close.bind(store);
            store.close = async () => {
                events.push("close");
                await originalClose();
            };
            const originalConnect = store.connect.bind(store);
            store.connect = async (options) => {
                events.push("connect");
                await originalConnect(options);
            };
            const runtime = {
                stop: async () => {
                    events.push("runtime-stop");
                    await activeMonitor;
                    events.push("runtime-stopped");
                },
                reload: async () => events.push("runtime-reload"),
            };

            await monitorStarted.promise;
            const outcome = takeSqliteSnapshot(store, coordinator, runtime, (source, destination) => {
                events.push("copy");
                if (copyFails) {
                    throw new Error("copy failed");
                }
                fs.cpSync(source, destination);
            }).then(
                () => null,
                (error) => error
            );

            await Bun.sleep(0);
            expect(store.calls.some(([name]) => name === "close")).toBe(false);
            releaseMonitor.resolve();
            const error = await outcome;

            if (copyFails) {
                expect(error).toBeInstanceOf(Error);
                expect(error.message).toBe("Unable to copy SQLite DB.");
            } else {
                expect(error).toBeNull();
            }
            expect(events).toEqual([
                "monitor-start",
                "runtime-stop",
                "monitor-write",
                "runtime-stopped",
                "close",
                "copy",
                "connect",
                "runtime-reload",
            ]);
            expect(store.isOpen()).toBe(true);
        });
    }

    test("restore success reconnects the same store and resumes work", async () => {
        const databasePath = useTemporaryDatabase();
        createSnapshotDatabase(databasePath, "current");
        createSnapshotDatabase(`${databasePath}.e2e-snapshot`, "snapshot");
        const store = createFakeStore();
        const coordinator = new DatabaseMaintenanceCoordinator();
        const runtimeCalls = [];

        await restoreSqliteSnapshot(null, store, coordinator, {
            stop: async () => runtimeCalls.push("stop"),
            reload: async () => runtimeCalls.push("reload"),
        });

        expect(readMarker(databasePath)).toBe("snapshot");
        expect(store.isOpen()).toBe(true);
        expect(runtimeCalls).toEqual(["stop", "reload"]);
        expect(await coordinator.run(() => "resumed")).toBe("resumed");
    });

    test("restore failure rolls back, reconnects and resumes work", async () => {
        const databasePath = useTemporaryDatabase();
        createSnapshotDatabase(databasePath, "current");
        createSnapshotDatabase(`${databasePath}.e2e-snapshot`, "snapshot");
        const store = createFakeStore({ failConnectCalls: [1] });
        const coordinator = new DatabaseMaintenanceCoordinator();
        const runtimeCalls = [];

        await expect(
            restoreSqliteSnapshot(null, store, coordinator, {
                stop: async () => runtimeCalls.push("stop"),
                reload: async () => runtimeCalls.push("reload"),
            })
        ).rejects.toThrow("connect failed 1");

        expect(readMarker(databasePath)).toBe("current");
        expect(store.isOpen()).toBe(true);
        expect(store.calls.filter(([name]) => name === "connect")).toHaveLength(2);
        expect(runtimeCalls).toEqual(["stop", "stop", "reload"]);
        expect(await coordinator.run(() => "resumed")).toBe("resumed");
    });

    test("persistent checkpoint failure keeps the original store open and resumes runtime", async () => {
        const databasePath = useTemporaryDatabase();
        createSnapshotDatabase(databasePath, "current");
        createSnapshotDatabase(`${databasePath}.e2e-snapshot`, "snapshot");
        const checkpointError = new Error("checkpoint failed");
        const store = createFakeStore({
            failExec: (sql) => (sql === "PRAGMA wal_checkpoint(TRUNCATE)" ? checkpointError : null),
        });
        const coordinator = new DatabaseMaintenanceCoordinator();
        const runtimeCalls = [];

        const error = await restoreSqliteSnapshot(null, store, coordinator, {
            stop: async () => runtimeCalls.push("stop"),
            reload: async () => runtimeCalls.push("reload"),
        }).catch((caught) => caught);

        expect(error).toBe(checkpointError);
        expect(readMarker(databasePath)).toBe("current");
        expect(store.isOpen()).toBe(true);
        expect(store.calls).toEqual([["exec", "PRAGMA wal_checkpoint(TRUNCATE)"]]);
        expect(runtimeCalls).toEqual(["stop", "stop", "reload"]);
        expect(await coordinator.run(() => store)).toBe(store);
    });

    test("concurrent take and restore serialize", async () => {
        const databasePath = useTemporaryDatabase();
        createSnapshotDatabase(databasePath, "current");
        const store = createFakeStore();
        const coordinator = new DatabaseMaintenanceCoordinator();
        const copyStarted = deferred();
        const releaseCopy = deferred();
        const events = [];

        const take = takeSqliteSnapshot(
            store,
            coordinator,
            {
                stop: async () => events.push("take-stop"),
                reload: async () => events.push("take-reload"),
            },
            async (source, destination) => {
                events.push("take-copy-start");
                copyStarted.resolve();
                await releaseCopy.promise;
                fs.cpSync(source, destination);
                events.push("take-copy-end");
            }
        );
        await copyStarted.promise;
        const restore = restoreSqliteSnapshot(null, store, coordinator, {
            stop: async () => events.push("restore-stop"),
            reload: async () => events.push("restore-reload"),
        });

        await Bun.sleep(0);
        expect(events).toEqual(["take-stop", "take-copy-start"]);
        releaseCopy.resolve();
        await Promise.all([take, restore]);
        expect(events).toEqual([
            "take-stop",
            "take-copy-start",
            "take-copy-end",
            "take-reload",
            "restore-stop",
            "restore-reload",
        ]);
    });

    for (const copyFails of [false, true]) {
        test(`the default HTTP snapshot runtime preserves paused monitors after copy ${copyFails ? "failure" : "success"}`, async () => {
            const databasePath = useTemporaryDatabase();
            fs.writeFileSync(databasePath, "database");
            if (copyFails) {
                fs.mkdirSync(`${databasePath}.e2e-snapshot`);
            }

            const store = createFakeStore();
            const coordinator = new DatabaseMaintenanceCoordinator();
            const calls = [];
            const io = {};
            const runningMonitor = {
                isStop: false,
                async stop() {
                    calls.push(["stop", this]);
                    this.isStop = true;
                },
                async start(runtimeIO) {
                    calls.push(["start", this, runtimeIO]);
                    this.isStop = false;
                },
            };
            const pausedMonitor = {
                isStop: true,
                async stop() {
                    calls.push(["paused-stop", this]);
                },
                async start() {
                    calls.push(["paused-start", this]);
                    this.isStop = false;
                },
            };
            const server = {
                io,
                monitorList: { running: runningMonitor, paused: pausedMonitor },
            };
            const fetchHandler = createBunFetchHandler({
                server,
                store,
                databaseMaintenance: coordinator,
                disableFrameSameOrigin: false,
                development: true,
            });

            const request = fetchHandler(new Request("http://localhost/_e2e/take-sqlite-snapshot"), {});
            if (copyFails) {
                await expect(request).rejects.toThrow("Unable to copy SQLite DB.");
            } else {
                expect((await request).status).toBe(200);
            }

            expect(calls).toEqual([
                ["stop", runningMonitor],
                ["start", runningMonitor, io],
            ]);
            expect(server.monitorList.running).toBe(runningMonitor);
            expect(server.monitorList.paused).toBe(pausedMonitor);
            expect(runningMonitor.isStop).toBe(false);
            expect(pausedMonitor.isStop).toBe(true);
            expect(store.isOpen()).toBe(true);
        });
    }

    test("the HTTP maintenance request is not counted as in-flight work", async () => {
        const databasePath = useTemporaryDatabase();
        fs.writeFileSync(databasePath, "database");
        const store = createFakeStore();
        const coordinator = new DatabaseMaintenanceCoordinator();
        const runtimeCalls = [];
        const io = {};
        const fetchHandler = createBunFetchHandler({
            server: {
                io,
                monitorList: {
                    1: {
                        isStop: false,
                        stop: async function () {
                            runtimeCalls.push("stop");
                            this.isStop = true;
                        },
                        start: async function (runtimeIO) {
                            runtimeCalls.push(runtimeIO === io ? "start" : "wrong-io");
                            this.isStop = false;
                        },
                    },
                },
            },
            store,
            databaseMaintenance: coordinator,
            disableFrameSameOrigin: false,
            development: true,
        });

        const response = await Promise.race([
            fetchHandler(new Request("http://localhost/_e2e/take-sqlite-snapshot"), {}),
            Bun.sleep(1000).then(() => {
                throw new Error("maintenance request deadlocked");
            }),
        ]);

        expect(response.status).toBe(200);
        expect(store.isOpen()).toBe(true);
        expect(runtimeCalls).toEqual(["stop", "start"]);
    });
});
