// @ts-nocheck

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import Cron from "croner";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Maintenance from "@/server/model/maintenance";
import { BunSQLiteRedbean } from "@/server/sqlite-core";
import "@/server/model-registry";
import { cachedResponse, clearResponseCache, createResponseCache, textResponse } from "@/server/bun-response";
import { IgloMonitorServer } from "@/server/iglo-monitor-server";
import { Settings } from "@/server/settings";
import { maintenanceSocketHandler } from "@/server/socket-handlers/maintenance-socket-handler";

dayjs.extend(utc);
dayjs.extend(timezone);

describe("maintenance validation and timer lifecycle", () => {
    const originalClearTimeout = global.clearTimeout;
    let runtimeStore;
    let runtimeSettings;
    let runtimeServer;
    let responseCache;
    let originals;

    beforeEach(() => {
        runtimeStore = new BunSQLiteRedbean();
        runtimeSettings = new Settings(runtimeStore);
        runtimeServer = new IgloMonitorServer(runtimeStore, runtimeSettings);
        responseCache = createResponseCache();
        originals = {
            begin: runtimeStore.begin,
            store: runtimeStore.store,
            findOne: runtimeStore.findOne,
            sendMaintenanceList: runtimeServer.sendMaintenanceList,
            sendMaintenanceListByUserID: runtimeServer.sendMaintenanceListByUserID,
            getTimezone: runtimeServer.getTimezone,
        };
    });

    afterEach(async () => {
        global.clearTimeout = originalClearTimeout;
        runtimeStore.begin = originals.begin;
        runtimeStore.store = originals.store;
        runtimeStore.findOne = originals.findOne;
        runtimeServer.sendMaintenanceList = originals.sendMaintenanceList;
        runtimeServer.sendMaintenanceListByUserID = originals.sendMaintenanceListByUserID;
        runtimeServer.getTimezone = originals.getTimezone;
        runtimeSettings.stopCacheCleaner();
        await runtimeStore.close();
    });

    const schedule = (strategy, overrides = {}) => ({
        title: "Window",
        description: "",
        active: true,
        strategy,
        intervalDay: 1,
        timezoneOption: "Europe/Warsaw",
        dateRange: [null, null],
        timeRange: [
            { hours: 10, minutes: 0 },
            { hours: 11, minutes: 0 },
        ],
        weekdays: [],
        daysOfMonth: [],
        durationMinutes: 60,
        cron: "0 10 * * *",
        ...overrides,
    });

    test("rejects malformed schedules at the socket boundary", async () => {
        const base = {
            title: "Window",
            description: "",
            active: true,
            strategy: "single",
            intervalDay: 1,
            timezoneOption: "UTC",
            dateRange: ["2026-01-01T10:00", "2026-01-01T11:00"],
            timeRange: [
                { hours: 10, minutes: 0 },
                { hours: 11, minutes: 0 },
            ],
            weekdays: [],
            daysOfMonth: [],
            durationMinutes: 60,
            cron: "0 10 * * *",
        };

        for (const invalid of [
            { ...base, title: "" },
            { ...base, strategy: "not-a-strategy" },
            { ...base, timezoneOption: "Mars/Olympus" },
            { ...base, dateRange: [base.dateRange[1], base.dateRange[0]] },
            { ...base, dateRange: [null, base.dateRange[1]] },
            { ...base, strategy: "cron", durationMinutes: 0 },
            { ...base, strategy: "cron", durationMinutes: 24 * 60 + 1 },
            {
                ...base,
                strategy: "recurring-weekday",
                timeRange: [
                    { hours: 10, minutes: 0 },
                    { hours: 10, minutes: 0 },
                ],
            },
        ]) {
            await expect(Maintenance.jsonToBean(new Maintenance(), invalid)).rejects.toThrow();
        }
    });

    test("stopping maintenance clears its start, end, and active-window timers", () => {
        const clearedTimers = [];
        global.clearTimeout = (timer) => clearedTimers.push(timer);
        const stoppedJobs = [];
        const maintenance = {
            beanMeta: {
                job: { stop: () => stoppedJobs.push("start") },
                endJob: { stop: () => stoppedJobs.push("end") },
                durationTimeout: 42,
            },
        };

        Maintenance.prototype.stop.call(maintenance);

        expect(stoppedJobs).toEqual(["start", "end"]);
        expect(clearedTimers).toEqual([42]);
        expect(maintenance.beanMeta.job).toBeUndefined();
        expect(maintenance.beanMeta.endJob).toBeUndefined();
        expect(maintenance.beanMeta.durationTimeout).toBeUndefined();
    });

    test("uses the supplied runtime server for SAME_AS_SERVER monitor maintenance", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-monitor-maintenance-"));
        try {
            await runtimeStore.connect({
                sqlitePath: path.join(directory, "kuma.db"),
                templatePath: path.join(process.cwd(), "src/db/kuma.db"),
                testMode: true,
            });
            await runtimeStore.exec(
                "INSERT INTO monitor (id, name, active, interval, type) VALUES (1, 'Test', 1, 60, 'http')"
            );
            await runtimeStore.exec(
                "INSERT INTO monitor (id, name, active, interval, type, parent) VALUES (2, 'Child', 1, 60, 'http', 1)"
            );
            const maintenance = Object.assign(runtimeStore.dispense("maintenance"), {
                title: "Server timezone window",
                description: "",
                active: true,
                strategy: "single",
                start_date: runtimeStore.isoDateTime(dayjs.utc().subtract(1, "hour")),
                end_date: runtimeStore.isoDateTime(dayjs.utc().add(1, "hour")),
                timezone: "SAME_AS_SERVER",
            });
            await runtimeStore.store(maintenance);
            await runtimeStore.exec("INSERT INTO monitor_maintenance (monitor_id, maintenance_id) VALUES (1, ?)", [
                maintenance.id,
            ]);

            let timezoneCalls = 0;
            const runtimeServer = {
                getMaintenance(id) {
                    return id === maintenance.id ? maintenance : null;
                },
                async getTimezone() {
                    timezoneCalls++;
                    return "UTC";
                },
            };

            const { default: Monitor } = await import("@/server/model/monitor");
            expect(await Monitor.isUnderMaintenance(runtimeStore, 1, runtimeServer)).toBe(true);
            expect(await Monitor.isUnderMaintenance(runtimeStore, 2, runtimeServer)).toBe(true);
            expect(timezoneCalls).toBeGreaterThan(0);
        } finally {
            await runtimeStore.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test("paused schedules never recreate a cron job or timeout on reload", async () => {
        const clearedTimers = [];
        global.clearTimeout = (timer) => clearedTimers.push(timer);
        const maintenance = new Maintenance();
        Object.assign(maintenance, {
            id: 1,
            active: 0,
            strategy: "cron",
            cron: "* * * * *",
            duration: 60,
            timezone: "UTC",
            beanMeta: { job: { stop() {} }, durationTimeout: 99, status: "under-maintenance" },
        });

        await maintenance.run(runtimeStore, runtimeServer, true, false, responseCache);

        expect(maintenance.beanMeta.job).toBeUndefined();
        expect(maintenance.beanMeta.durationTimeout).toBeUndefined();
        expect(maintenance.beanMeta.status).toBeUndefined();
        expect(clearedTimers).toEqual([99]);
    });

    test("serializes malformed legacy lists safely", async () => {
        const maintenance = new Maintenance();
        Object.assign(maintenance, {
            id: 1,
            title: "Legacy",
            description: "",
            active: false,
            strategy: "manual",
            weekdays: "{",
            days_of_month: "not-json",
        });
        maintenance.getTimezone = async () => "UTC";
        maintenance.getTimezoneOffset = async () => "+00:00";

        await expect(maintenance.toJSON(runtimeServer)).resolves.toMatchObject({
            weekdays: [],
            daysOfMonth: [],
            status: "inactive",
        });
    });

    test("generates all six strategies and calendar boundaries deterministically", async () => {
        const cases = [
            ["manual", {}, undefined, undefined],
            ["single", { dateRange: ["2028-02-29T10:00", "2028-02-29T11:00"] }, undefined, undefined],
            ["cron", {}, "0 10 * * *", 3600],
            ["recurring-interval", { intervalDay: 2 }, "0 10  * * *", 3600],
            ["recurring-weekday", { weekdays: [0, 1, 6] }, "0 10 * * 0,1,6", 3600],
            ["recurring-day-of-month", { daysOfMonth: [1, 31, "lastDay1"] }, "0 10 1,31,L * *", 3600],
        ];

        for (const [strategy, overrides, expectedCron, expectedDuration] of cases) {
            const bean = await Maintenance.jsonToBean(new Maintenance(), schedule(strategy, overrides));
            expect(bean.cron).toBe(expectedCron);
            expect(bean.duration).toBe(expectedDuration);
        }

        const crossMidnight = await Maintenance.jsonToBean(
            new Maintenance(),
            schedule("recurring-weekday", {
                weekdays: [1],
                timeRange: [
                    { hours: 23, minutes: 0 },
                    { hours: 1, minutes: 0 },
                ],
            })
        );
        expect(crossMidnight.duration).toBe(7200);

        const monthEnd = new Cron("0 10 L * *", { timezone: "Europe/Warsaw", paused: true });
        expect(monthEnd.nextRun(new Date("2028-02-01T00:00:00Z")).toISOString()).toBe("2028-02-29T09:00:00.000Z");
        monthEnd.stop();

        const springDST = new Cron("30 2 * * *", { timezone: "Europe/Warsaw", paused: true });
        const springRuns = springDST.nextRuns(3, new Date("2026-03-28T00:00:00Z")).map((date) => date.toISOString());
        expect(springRuns).toEqual([
            "2026-03-28T01:30:00.000Z",
            "2026-03-29T01:30:00.000Z",
            "2026-03-30T00:30:00.000Z",
        ]);
        springDST.stop();

        const autumnDST = new Cron("30 2 * * *", { timezone: "Europe/Warsaw", paused: true });
        expect(autumnDST.nextRuns(3, new Date("2026-10-24T00:00:00Z")).map((date) => date.toISOString())).toEqual([
            "2026-10-24T00:30:00.000Z",
            "2026-10-25T01:30:00.000Z",
            "2026-10-26T01:30:00.000Z",
        ]);
        autumnDST.stop();
    });

    test("calculates recurring end instants in the schedule timezone across DST and calendar boundaries", async () => {
        const maintenance = new Maintenance();
        Object.assign(maintenance, {
            start_time: "01:30",
            end_time: "03:30",
            timezone: "Europe/Warsaw",
        });

        expect(await maintenance.getTimeslot(runtimeServer, new Date("2026-03-29T00:30:00.000Z"))).toEqual({
            startDate: "2026-03-29T00:30:00.000Z",
            endDate: "2026-03-29T01:30:00.000Z",
        });
        expect(await maintenance.getTimeslot(runtimeServer, new Date("2026-10-24T23:30:00.000Z"))).toEqual({
            startDate: "2026-10-24T23:30:00.000Z",
            endDate: "2026-10-25T02:30:00.000Z",
        });

        maintenance.end_time = "02:30";
        expect(await maintenance.getTimeslot(runtimeServer, new Date("2026-03-29T00:30:00.000Z"))).toEqual({
            startDate: "2026-03-29T00:30:00.000Z",
            endDate: "2026-03-29T01:30:00.000Z",
        });
        expect(await maintenance.getTimeslot(runtimeServer, new Date("2026-10-24T23:30:00.000Z"))).toEqual({
            startDate: "2026-10-24T23:30:00.000Z",
            endDate: "2026-10-25T01:30:00.000Z",
        });

        maintenance.start_time = "23:30";
        maintenance.end_time = "01:15";
        expect(await maintenance.getTimeslot(runtimeServer, new Date("2028-02-29T22:30:00.000Z"))).toEqual({
            startDate: "2028-02-29T22:30:00.000Z",
            endDate: "2028-03-01T00:15:00.000Z",
        });
        expect(await maintenance.getTimeslot(runtimeServer, new Date("2026-03-28T22:30:00.000Z"))).toEqual({
            startDate: "2026-03-28T22:30:00.000Z",
            endDate: "2026-03-29T00:15:00.000Z",
        });

        maintenance.start_time = "02:00";
        maintenance.end_time = "03:00";
        expect(await maintenance.getTimeslot(runtimeServer, new Date("2026-03-29T01:00:00.000Z"))).toEqual({
            startDate: "2026-03-29T01:00:00.000Z",
            endDate: "2026-03-29T02:00:00.000Z",
        });

        maintenance.start_time = "02:30";
        expect(await maintenance.getTimeslot(runtimeServer, new Date("2026-03-29T01:30:00.000Z"))).toEqual({
            startDate: "2026-03-29T01:30:00.000Z",
            endDate: "2026-03-29T02:00:00.000Z",
        });
    });

    test("falls back to the server timezone when serializing a malformed legacy timezone", async () => {
        runtimeServer.getTimezone = async () => "UTC";
        const maintenance = Object.assign(new Maintenance(), {
            id: 1,
            title: "Legacy timezone",
            description: "",
            active: false,
            strategy: "manual",
            timezone: "Mars/Olympus",
        });

        await expect(maintenance.toJSON(runtimeServer)).resolves.toMatchObject({
            id: 1,
            title: "Legacy timezone",
            timezone: expect.any(String),
            timezoneOption: "Mars/Olympus",
            status: "inactive",
        });
    });

    test("single windows restore exactly one guarded end job and stop every callback", async () => {
        const now = Date.now();
        const date = (offset) => new Date(now + offset).toISOString();
        const active = Object.assign(new Maintenance(), {
            id: 1,
            user_id: 1,
            active: 1,
            strategy: "single",
            timezone: "UTC",
            start_date: date(-60_000),
            end_date: date(60_000),
        });

        await active.run(runtimeStore, runtimeServer, true, false, responseCache);
        expect(active.beanMeta.job).toBeUndefined();
        expect(active.beanMeta.endJob).toBeDefined();
        const staleEnd = active.beanMeta.endJob.fn;
        active.stop();
        await expect(staleEnd()).resolves.toBeUndefined();
        expect(active.beanMeta.job).toBeUndefined();
        expect(active.beanMeta.endJob).toBeUndefined();

        const future = Object.assign(new Maintenance(), {
            id: 2,
            user_id: 1,
            active: 1,
            strategy: "single",
            timezone: "UTC",
            start_date: date(60_000),
            end_date: date(120_000),
        });
        await future.run(runtimeStore, runtimeServer, true, false, responseCache);
        expect(future.beanMeta.job).toBeDefined();
        expect(future.beanMeta.endJob).toBeDefined();
        future.stop();

        const ended = Object.assign(new Maintenance(), {
            id: 3,
            user_id: 1,
            active: 1,
            strategy: "single",
            timezone: "UTC",
            start_date: date(-120_000),
            end_date: date(-60_000),
        });
        await ended.run(runtimeStore, runtimeServer, true, false, responseCache);
        expect(ended.beanMeta.job).toBeUndefined();
        expect(ended.beanMeta.endJob).toBeUndefined();
    });

    test("keeps exactly one job across twenty reloads and blocks callbacks after stop", async () => {
        const maintenance = Object.assign(runtimeStore.dispense("maintenance"), {
            id: 1,
            user_id: 1,
            active: 1,
            strategy: "cron",
            cron: "0 10 * * *",
            duration: 60,
            timezone: "UTC",
            start_date: "2020-01-01T00:00",
        });
        const previousJobs = [];

        for (let index = 0; index < 20; index++) {
            await maintenance.run(runtimeStore, runtimeServer, true, false, responseCache);
            expect(maintenance.beanMeta.job).toBeDefined();
            expect(previousJobs.every((job) => job.isStopped())).toBe(true);
            previousJobs.push(maintenance.beanMeta.job);
        }

        let releaseTimezone;
        let timezoneCalls = 0;
        maintenance.getTimezone = () => {
            timezoneCalls++;
            if (timezoneCalls === 1) {
                return Promise.resolve("UTC");
            }
            return new Promise((resolve) => (releaseTimezone = resolve));
        };
        await maintenance.run(runtimeStore, runtimeServer, true, false, responseCache);
        const pendingCallback = maintenance.beanMeta.job.fn();
        maintenance.stop();
        runtimeStore.store = async () => {
            throw new Error("stopped callbacks must not persist");
        };
        releaseTimezone("UTC");
        await expect(pendingCallback).resolves.toBeUndefined();
        expect(maintenance.beanMeta.job).toBeUndefined();
        expect(maintenance.beanMeta.endJob).toBeUndefined();
        expect(maintenance.beanMeta.durationTimeout).toBeUndefined();
        expect(maintenance.beanMeta.status).toBeUndefined();
        expect(maintenance.last_start_date).toBeUndefined();
    });

    test("does not recreate an active-window timeout after stop during duration resolution", async () => {
        const maintenance = Object.assign(new Maintenance(), {
            id: 1,
            user_id: 1,
            active: 1,
            strategy: "cron",
            cron: "0 10 * * *",
            duration: 60,
            timezone: "UTC",
        });
        await maintenance.run(runtimeStore, runtimeServer, true, false, responseCache);

        let releaseDuration;
        maintenance.inferDuration = () => new Promise((resolve) => (releaseDuration = resolve));
        const pendingCallback = maintenance.beanMeta.job.fn();
        await Bun.sleep(0);
        maintenance.stop();
        runtimeStore.store = async () => {
            throw new Error("stopped callbacks must not persist");
        };
        releaseDuration(1_000);

        await expect(pendingCallback).resolves.toBeUndefined();
        expect(maintenance.beanMeta.job).toBeUndefined();
        expect(maintenance.beanMeta.durationTimeout).toBeUndefined();
        expect(maintenance.beanMeta.status).toBeUndefined();
        expect(maintenance.last_start_date).toBeUndefined();
    });

    test("rehydrates an active window without persistence or publication and keeps one timer set", async () => {
        let stores = 0;
        let publications = 0;
        runtimeStore.store = async () => stores++;
        runtimeServer.sendMaintenanceListByUserID = async () => publications++;
        const maintenance = Object.assign(new Maintenance(), {
            id: 1,
            user_id: 1,
            active: 1,
            strategy: "cron",
            cron: "* * * * * *",
            duration: 60,
            timezone: "UTC",
            last_start_date: "2026-01-01 00:00:00",
        });
        const previousJobs = [];

        for (let index = 0; index < 20; index++) {
            await maintenance.run(runtimeStore, runtimeServer, true, true, responseCache);
            expect(maintenance.beanMeta.job).toBeDefined();
            expect(maintenance.beanMeta.durationTimeout).toBeDefined();
            expect(previousJobs.every((job) => job.isStopped())).toBe(true);
            previousJobs.push(maintenance.beanMeta.job);
        }

        expect(stores).toBe(0);
        expect(publications).toBe(0);
        expect(maintenance.last_start_date).toBe("2026-01-01 00:00:00");
        await maintenance.beanMeta.job.fn();
        expect(stores).toBe(1);
        expect(maintenance.last_start_date).not.toBe("2026-01-01 00:00:00");
        maintenance.stop();
    });

    test("keeps a concurrent pause outside a failed edit transaction until callback and cache publication", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-maintenance-isolation-"));
        const sqlitePath = path.join(directory, "kuma.db");
        const server = runtimeServer;
        const previousMaintenanceList = server.maintenanceList;
        clearResponseCache(responseCache);

        try {
            await runtimeStore.connect({
                sqlitePath,
                templatePath: path.join(process.cwd(), "src/db/kuma.db"),
                testMode: true,
            });
            await runtimeStore.exec("INSERT INTO user (id, username, password, active) VALUES (?, ?, ?, ?)", [
                1,
                "owner",
                "hash",
                1,
            ]);
            const bean = Object.assign(runtimeStore.dispense("maintenance"), {
                title: "Before edit",
                description: "",
                user_id: 1,
                active: 1,
                strategy: "manual",
                interval_day: 1,
                timezone: "UTC",
                weekdays: "[]",
                days_of_month: "[]",
            });
            const maintenanceID = await runtimeStore.store(bean);
            server.maintenanceList = { [maintenanceID]: bean };
            server.sendMaintenanceList = async () => server.maintenanceList;

            await runtimeStore.exec(
                "CREATE TABLE maintenance_commit_guard (parent_id INTEGER REFERENCES maintenance(id) DEFERRABLE INITIALLY DEFERRED)"
            );
            await runtimeStore.exec(`
                CREATE TRIGGER reject_isolated_maintenance_edit
                AFTER UPDATE ON maintenance
                WHEN NEW.title = 'Rollback edit'
                BEGIN
                    INSERT INTO maintenance_commit_guard (parent_id) VALUES (-1);
                END
            `);

            let signalCommitStarted;
            let releaseCommit;
            const commitStarted = new Promise((resolve) => (signalCommitStarted = resolve));
            const commitRelease = new Promise((resolve) => (releaseCommit = resolve));
            runtimeStore.begin = async function () {
                const transaction = await originals.begin.call(this);
                const commit = transaction.commit;
                transaction.commit = async () => {
                    signalCommitStarted();
                    await commitRelease;
                    return commit();
                };
                return transaction;
            };

            const handlers = new Map();
            maintenanceSocketHandler(
                {
                    userID: 1,
                    on(event, handler) {
                        handlers.set(event, handler);
                    },
                },
                runtimeStore,
                server,
                responseCache
            );
            const editCallbacks = [];
            const pauseCallbacks = [];
            await cachedResponse(responseCache, "maintenance-isolation", "1 hour", () => textResponse("before"));

            const editTask = handlers.get("editMaintenance")(
                {
                    id: maintenanceID,
                    title: "Rollback edit",
                    description: "",
                    active: true,
                    strategy: "manual",
                    intervalDay: 1,
                    timezoneOption: "UTC",
                    dateRange: [null, null],
                    timeRange: [
                        { hours: 10, minutes: 0 },
                        { hours: 11, minutes: 0 },
                    ],
                    weekdays: [],
                    daysOfMonth: [],
                    durationMinutes: 60,
                    cron: "0 10 * * *",
                },
                (result) => editCallbacks.push(result)
            );
            await commitStarted;
            const pauseTask = handlers.get("pauseMaintenance")(maintenanceID, (result) => pauseCallbacks.push(result));

            await Bun.sleep(20);
            expect(editCallbacks).toEqual([]);
            expect(pauseCallbacks).toEqual([]);
            const observer = new Database(sqlitePath, { readonly: true });
            expect(observer.query("SELECT title, active FROM maintenance WHERE id = ?").get(maintenanceID)).toEqual({
                title: "Before edit",
                active: 1,
            });
            observer.close();

            releaseCommit();
            await Promise.all([editTask, pauseTask]);

            expect(editCallbacks).toHaveLength(1);
            expect(editCallbacks[0]).toMatchObject({ ok: false });
            expect(pauseCallbacks).toEqual([{ ok: true, msg: "successPaused", msgi18n: true }]);
            expect(server.maintenanceList[maintenanceID]).toBe(bean);
            expect(bean.active).toBe(false);
            expect(
                await runtimeStore.getRow("SELECT title, active FROM maintenance WHERE id = ?", [maintenanceID])
            ).toEqual({
                title: "Before edit",
                active: 0,
            });
            const refreshed = await cachedResponse(responseCache, "maintenance-isolation", "1 hour", () =>
                textResponse("after")
            );
            expect(await refreshed.text()).toBe("after");
        } finally {
            runtimeStore.begin = originals.begin;
            server.sendMaintenanceList = originals.sendMaintenanceList;
            server.maintenanceList = previousMaintenanceList;
            clearResponseCache(responseCache);
            await runtimeStore.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test("rolls back when addMaintenance fails on its first transaction operation", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-maintenance-add-first-error-"));
        const store = new BunSQLiteRedbean();
        const originalBeginForTest = runtimeStore.begin;
        await store.connect({
            sqlitePath: path.join(directory, "kuma.db"),
            templatePath: path.join(process.cwd(), "src/db/kuma.db"),
            testMode: true,
        });
        runtimeStore.begin = async () => {
            const transaction = await store.begin();
            transaction.store = async () => {
                throw new Error("forced first add operation failure");
            };
            return transaction;
        };

        try {
            const handlers = new Map();
            maintenanceSocketHandler(
                {
                    userID: 1,
                    on(event, handler) {
                        handlers.set(event, handler);
                    },
                },
                runtimeStore,
                runtimeServer,
                responseCache
            );
            const callbacks = [];
            await handlers.get("addMaintenance")(schedule("manual", { timezoneOption: "UTC" }), (result) =>
                callbacks.push(result)
            );

            expect(callbacks).toEqual([{ ok: false, msg: "forced first add operation failure" }]);
            await expect(store.getCell("SELECT 1")).resolves.toBe(1);
        } finally {
            runtimeStore.begin = originalBeginForTest;
            await store.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test("rolls back when relation replacement fails on its first transaction operation", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-maintenance-relation-first-error-"));
        const store = new BunSQLiteRedbean();
        const server = runtimeServer;
        const previousMaintenanceList = server.maintenanceList;
        const originalBeginForTest = runtimeStore.begin;
        await store.connect({
            sqlitePath: path.join(directory, "kuma.db"),
            templatePath: path.join(process.cwd(), "src/db/kuma.db"),
            testMode: true,
        });
        await store.exec("INSERT INTO user (id, username, password, active) VALUES (1, 'owner', 'hash', 1)");
        await store.exec(
            "INSERT INTO monitor (id, name, type, url, interval, retry_interval, accepted_statuscodes_json, user_id) VALUES (2, 'Monitor', 'http', 'http://127.0.0.1', 60, 20, '[\"200-299\"]', 1)"
        );
        await store.exec(
            "INSERT INTO maintenance (id, title, description, user_id, active, strategy) VALUES (1, 'Window', '', 1, 1, 'manual')"
        );
        await store.exec("INSERT INTO monitor_maintenance (monitor_id, maintenance_id) VALUES (2, 1)");
        await store.exec(`
            CREATE TRIGGER reject_first_relation_delete
            BEFORE DELETE ON monitor_maintenance
            BEGIN
                SELECT RAISE(ABORT, 'forced first relation operation failure');
            END
        `);
        server.maintenanceList = { 1: { id: 1, user_id: 1 } };
        runtimeStore.findOne = async () => ({ id: 2, user_id: 1 });
        runtimeStore.begin = store.begin.bind(store);

        try {
            const handlers = new Map();
            maintenanceSocketHandler(
                {
                    userID: 1,
                    on(event, handler) {
                        handlers.set(event, handler);
                    },
                },
                runtimeStore,
                server,
                responseCache
            );
            const callbacks = [];
            await handlers.get("addMonitorMaintenance")(1, [{ id: 2 }], (result) => callbacks.push(result));

            expect(callbacks).toEqual([{ ok: false, msg: "forced first relation operation failure" }]);
            await expect(store.getCell("SELECT 1")).resolves.toBe(1);
            expect(await store.count("monitor_maintenance")).toBe(1);
        } finally {
            runtimeStore.begin = originalBeginForTest;
            runtimeStore.findOne = originals.findOne;
            server.maintenanceList = previousMaintenanceList;
            await store.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test("rolls back when edit setup fails immediately after begin", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-maintenance-first-error-"));
        const store = new BunSQLiteRedbean();
        const server = runtimeServer;
        const previousMaintenanceList = server.maintenanceList;
        const originalBeginForTest = runtimeStore.begin;
        await store.connect({
            sqlitePath: path.join(directory, "kuma.db"),
            templatePath: path.join(process.cwd(), "src/db/kuma.db"),
            testMode: true,
        });
        const bean = Object.assign(new Maintenance(), {
            id: 1,
            user_id: 1,
            title: "Before edit",
            description: "",
            active: 1,
            strategy: "manual",
            interval_day: 1,
            timezone: "UTC",
            weekdays: "[]",
            days_of_month: "[]",
        });
        bean.stop = () => {
            throw new Error("forced edit setup failure");
        };
        server.maintenanceList = { 1: bean };
        let transaction;
        runtimeStore.begin = async () => (transaction = await store.begin());

        try {
            const handlers = new Map();
            maintenanceSocketHandler(
                {
                    userID: 1,
                    on(event, handler) {
                        handlers.set(event, handler);
                    },
                },
                runtimeStore,
                server,
                responseCache
            );
            const callbacks = [];
            await handlers.get("editMaintenance")(
                {
                    id: 1,
                    title: "After edit",
                    description: "",
                    active: true,
                    strategy: "manual",
                    intervalDay: 1,
                    timezoneOption: "UTC",
                    dateRange: [null, null],
                    timeRange: [
                        { hours: 10, minutes: 0 },
                        { hours: 11, minutes: 0 },
                    ],
                    weekdays: [],
                    daysOfMonth: [],
                    durationMinutes: 60,
                    cron: "0 10 * * *",
                },
                (result) => callbacks.push(result)
            );

            expect(callbacks).toEqual([{ ok: false, msg: "forced edit setup failure" }]);
            await expect(
                Promise.race([
                    store.getCell("SELECT 1"),
                    Bun.sleep(100).then(() => {
                        throw new Error("subsequent operation stayed blocked");
                    }),
                ])
            ).resolves.toBe(1);
        } finally {
            runtimeStore.begin = originalBeginForTest;
            server.maintenanceList = previousMaintenanceList;
            await transaction?.rollback();
            await store.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test("uses the supplied store and keeps maintenance ownership isolated", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-maintenance-stores-"));
        const first = new BunSQLiteRedbean();
        const second = new BunSQLiteRedbean();
        const socket = (userID, handlers) => ({
            userID,
            on(event, handler) {
                handlers.set(event, handler);
            },
        });
        const runtime = () => ({
            maintenanceList: {},
            getMaintenance(id) {
                return this.maintenanceList[id] || null;
            },
            async getTimezone() {
                return "UTC";
            },
            async sendMaintenanceList() {},
            async sendMaintenanceListByUserID() {},
        });
        try {
            await Promise.all([
                first.connect({
                    sqlitePath: path.join(directory, "first.db"),
                    templatePath: path.join(process.cwd(), "src/db/kuma.db"),
                    testMode: true,
                }),
                second.connect({
                    sqlitePath: path.join(directory, "second.db"),
                    templatePath: path.join(process.cwd(), "src/db/kuma.db"),
                    testMode: true,
                }),
            ]);
            await Promise.all([
                first.exec("INSERT INTO user (id, username, password, active) VALUES (1, 'first', 'hash', 1)"),
                second.exec("INSERT INTO user (id, username, password, active) VALUES (2, 'second', 'hash', 1)"),
            ]);
            const firstHandlers = new Map();
            const secondHandlers = new Map();
            const firstRuntime = runtime();
            const secondRuntime = runtime();
            const firstCache = createResponseCache();
            const secondCache = createResponseCache();
            maintenanceSocketHandler(socket(1, firstHandlers), first, firstRuntime, firstCache);
            maintenanceSocketHandler(socket(2, secondHandlers), second, secondRuntime, secondCache);

            const firstResult = [];
            const secondResult = [];
            await firstHandlers.get("addMaintenance")(
                { ...schedule("manual", { timezoneOption: "UTC" }), title: "First" },
                (result) => firstResult.push(result)
            );
            await secondHandlers.get("addMaintenance")(
                { ...schedule("manual", { timezoneOption: "UTC" }), title: "Second" },
                (result) => secondResult.push(result)
            );

            expect(firstResult[0].ok).toBe(true);
            expect(secondResult[0].ok).toBe(true);
            expect(await first.getCell("SELECT title FROM maintenance WHERE id = 1")).toBe("First");
            expect(await second.getCell("SELECT title FROM maintenance WHERE id = 1")).toBe("Second");

            const foreignHandlers = new Map();
            maintenanceSocketHandler(socket(3, foreignHandlers), first, firstRuntime, firstCache);
            const denied = [];
            await foreignHandlers.get("deleteMaintenance")(1, (result) => denied.push(result));
            expect(denied).toEqual([{ ok: false, msg: "Maintenance not found" }]);
            expect(await first.count("maintenance")).toBe(1);
            expect(await second.count("maintenance")).toBe(1);
        } finally {
            await Promise.all([first.close(), second.close()]);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
