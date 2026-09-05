// @ts-nocheck

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const projectRoot = path.join(import.meta.dirname, "../..");
const binaryPath = process.env.IGLO_MONITOR_BINARY ? path.resolve(projectRoot, process.env.IGLO_MONITOR_BINARY) : null;
let appProcess;
let dataDir;
let sockets = [];
let sink;

function reservePort() {
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = listener.port;
    listener.stop(true);
    return port;
}

async function startApp() {
    const port = reservePort();
    const command = binaryPath
        ? [binaryPath, `--port=${port}`, "--host=127.0.0.1", `--data-dir=${dataDir}`]
        : [process.execPath, "src/server/server.ts", `--port=${port}`, "--host=127.0.0.1", `--data-dir=${dataDir}`];
    appProcess = Bun.spawn(command, {
        cwd: projectRoot,
        env: { ...process.env, NODE_ENV: "production", IGLO_MONITOR_WS_ORIGIN_CHECK: "bypass" },
        stdout: process.env.DEBUG_MAINTENANCE_TEST ? "inherit" : "ignore",
        stderr: process.env.DEBUG_MAINTENANCE_TEST ? "inherit" : "ignore",
    });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (appProcess.exitCode !== null) {
            throw new Error(`iglo.monitor exited with ${appProcess.exitCode}`);
        }
        try {
            if ((await fetch(`http://127.0.0.1:${port}`)).ok) {
                return port;
            }
        } catch {}
        await Bun.sleep(50);
    }
    throw new Error("iglo.monitor did not start");
}

async function stopApp() {
    for (const socket of sockets.splice(0)) {
        socket.close();
    }
    if (appProcess?.exitCode === null) {
        appProcess.kill("SIGTERM");
        await Promise.race([
            appProcess.exited,
            Bun.sleep(5_000).then(() => {
                throw new Error("iglo.monitor did not stop");
            }),
        ]);
    }
    appProcess = null;
}

async function connect(port) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(socket);
    const callbacks = new Map();
    const events = new Map();
    let nextID = 1;
    const ready = new Promise((resolve, reject) => {
        socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
        socket.addEventListener("message", (event) => {
            const message = JSON.parse(String(event.data));
            if (message.type === "event") {
                if (message.event === "loginRequired" || message.event === "autoLogin") {
                    resolve();
                }
                const waiters = events.get(message.event) || [];
                events.set(message.event, []);
                waiters.forEach((waiter) => waiter(message.args?.[0]));
            } else if ((message.type === "reply" || message.type === "error") && message.id) {
                const callback = callbacks.get(message.id);
                if (callback) {
                    if (callback.replies) {
                        callback.replies.push(
                            message.type === "error" ? { error: message.message } : message.args?.[0]
                        );
                        callback.firstReply();
                        return;
                    }
                    callbacks.delete(message.id);
                    message.type === "error"
                        ? callback.reject(new Error(message.message))
                        : callback.resolve(message.args?.[0]);
                }
            }
        });
    });
    await Promise.race([
        ready,
        Bun.sleep(10_000).then(() => {
            throw new Error("WebSocket was not ready");
        }),
    ]);
    return {
        request(event, ...args) {
            const id = String(nextID++);
            const reply = new Promise((resolve, reject) => callbacks.set(id, { resolve, reject }));
            socket.send(JSON.stringify({ type: "event", event, args, id }));
            return Promise.race([
                reply,
                Bun.sleep(10_000).then(() => {
                    throw new Error(`No reply for ${event}`);
                }),
            ]);
        },
        async requestReplies(event, ...args) {
            const id = String(nextID++);
            const replies = [];
            let firstReply;
            const received = new Promise((resolve) => (firstReply = resolve));
            callbacks.set(id, { replies, firstReply });
            socket.send(JSON.stringify({ type: "event", event, args, id }));
            await Promise.race([
                received,
                Bun.sleep(10_000).then(() => {
                    throw new Error(`No reply for ${event}`);
                }),
            ]);
            await Bun.sleep(300);
            callbacks.delete(id);
            return replies;
        },
        nextEvent(name) {
            return new Promise((resolve) => events.set(name, [...(events.get(name) || []), resolve]));
        },
    };
}

async function waitFor(check, timeout = 10_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = await check();
        if (value) {
            return value;
        }
        await Bun.sleep(100);
    }
    throw new Error("Timed out waiting for maintenance state");
}

function maintenance() {
    return {
        title: "Owner-only maintenance",
        description: "private schedule",
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
    };
}

async function setupStatusPage(slug) {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-maintenance-"));
    let port = await startApp();
    const bootstrap = await connect(port);
    expect((await bootstrap.request("setup", "owner", "owner-password")).ok).toBe(true);
    await stopApp();

    const db = new Database(path.join(dataDir, "kuma.db"));
    const statusPageID = Number(
        db.query("INSERT INTO status_page (slug, title, icon, theme) VALUES (?, ?, '', 'auto')").run(slug, slug)
            .lastInsertRowid
    );
    db.close();
    port = await startApp();
    const owner = await connect(port);
    expect((await owner.request("login", { username: "owner", password: "owner-password", token: "" })).ok).toBe(true);
    return { owner, port, statusPageID };
}

async function publicStatusPage(port, slug) {
    const response = await fetch(`http://127.0.0.1:${port}/api/status-page/${slug}`);
    expect(response.ok).toBe(true);
    return response.json();
}

async function publicMaintenance(port, slug) {
    return (await publicStatusPage(port, slug)).maintenanceList;
}

afterEach(async () => {
    await stopApp();
    sink?.stop(true);
    sink = null;
    if (dataDir) {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

describe("maintenance ownership boundaries", () => {
    test("commits each mutation once when a malformed legacy timezone is present", async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-maintenance-"));
        let port = await startApp();
        const bootstrap = await connect(port);
        expect((await bootstrap.request("setup", "owner", "owner-password")).ok).toBe(true);
        await stopApp();

        const db = new Database(path.join(dataDir, "kuma.db"));
        const ownerID = db.query("SELECT id FROM user WHERE username = ?").get("owner").id;
        const statusPageID = Number(
            db
                .query("INSERT INTO status_page (slug, title, icon, theme) VALUES (?, ?, '', 'auto')")
                .run("legacy-timezone", "Legacy timezone").lastInsertRowid
        );
        const insertMaintenance = db.query(
            "INSERT INTO maintenance (title, description, user_id, active, strategy, weekdays, days_of_month, timezone) VALUES (?, '', ?, ?, 'manual', '[]', '[]', ?)"
        );
        const legacyID = Number(insertMaintenance.run("Malformed legacy", ownerID, 0, "Mars/Olympus").lastInsertRowid);
        const existingID = Number(insertMaintenance.run("Before edit", ownerID, 1, "UTC").lastInsertRowid);
        db.query("INSERT INTO maintenance_status_page (status_page_id, maintenance_id) VALUES (?, ?)").run(
            statusPageID,
            existingID
        );
        db.close();

        port = await startApp();
        const owner = await connect(port);
        expect((await owner.request("login", { username: "owner", password: "owner-password", token: "" })).ok).toBe(
            true
        );
        expect(await publicMaintenance(port, "legacy-timezone")).toEqual([
            expect.objectContaining({ id: existingID, title: "Before edit" }),
        ]);

        const editReplies = await owner.requestReplies(
            "editMaintenance",
            { ...maintenance(), id: existingID, title: "After edit" },
            { monitors: [], statusPages: [{ id: statusPageID }] }
        );
        const addReplies = await owner.requestReplies(
            "addMaintenance",
            { ...maintenance(), title: "Added once" },
            { monitors: [], statusPages: [{ id: statusPageID }] }
        );
        const stateDB = new Database(path.join(dataDir, "kuma.db"), { readonly: true });
        const addedID = stateDB.query("SELECT id FROM maintenance WHERE title = ?").get("Added once").id;
        stateDB.close();
        const pauseReplies = await owner.requestReplies("pauseMaintenance", addedID);
        const paused = (await owner.request("getMaintenance", addedID)).maintenance.active;
        const resumeReplies = await owner.requestReplies("resumeMaintenance", addedID);
        const resumed = (await owner.request("getMaintenance", addedID)).maintenance.active;
        const deleteReplies = await owner.requestReplies("deleteMaintenance", addedID);

        expect({ editReplies, addReplies, pauseReplies, resumeReplies, deleteReplies }).toEqual({
            editReplies: [{ ok: true, msg: "Saved.", msgi18n: true, maintenanceID: existingID }],
            addReplies: [{ ok: true, msg: "successAdded", msgi18n: true, maintenanceID: addedID }],
            pauseReplies: [{ ok: true, msg: "successPaused", msgi18n: true }],
            resumeReplies: [{ ok: true, msg: "successResumed", msgi18n: true }],
            deleteReplies: [{ ok: true, msg: "successDeleted", msgi18n: true }],
        });
        expect(paused).toBe(false);
        expect(resumed).toBe(true);
        expect((await owner.request("getMaintenance", existingID)).maintenance.title).toBe("After edit");
        expect(await publicMaintenance(port, "legacy-timezone")).toEqual([
            expect.objectContaining({ id: existingID, title: "After edit" }),
        ]);

        const listEvent = owner.nextEvent("maintenanceList");
        expect((await owner.request("getMaintenanceList")).ok).toBe(true);
        const listed = await listEvent;
        expect(listed).toMatchObject({
            [legacyID]: { id: legacyID, title: "Malformed legacy", timezoneOption: "Mars/Olympus" },
            [existingID]: { id: existingID, title: "After edit" },
        });
        expect(listed[addedID]).toBeUndefined();

        const resultDB = new Database(path.join(dataDir, "kuma.db"), { readonly: true });
        expect(resultDB.query("SELECT title FROM maintenance WHERE id = ?").get(existingID)).toEqual({
            title: "After edit",
        });
        expect(resultDB.query("SELECT COUNT(*) AS count FROM maintenance WHERE id = ?").get(addedID)).toEqual({
            count: 0,
        });
        resultDB.close();
        expect(await publicMaintenance(port, "legacy-timezone")).toEqual([
            expect.objectContaining({ id: existingID, title: "After edit" }),
        ]);
    }, 120_000);

    test("invalidates a prewarmed public status page only after an atomic add commits", async () => {
        const slug = "maintenance-add-cache";
        const { owner, port, statusPageID } = await setupStatusPage(slug);
        expect(await publicMaintenance(port, slug)).toEqual([]);

        const created = await owner.request(
            "addMaintenance",
            { ...maintenance(), title: "Added after prewarm" },
            { monitors: [], statusPages: [{ id: statusPageID }] }
        );
        expect(created.ok).toBe(true);
        expect(await publicMaintenance(port, slug)).toEqual([
            expect.objectContaining({
                id: created.maintenanceID,
                title: "Added after prewarm",
                status: "under-maintenance",
            }),
        ]);
    });

    test("invalidates a prewarmed public status page only after an atomic edit commits", async () => {
        const slug = "maintenance-edit-cache";
        const { owner, port, statusPageID } = await setupStatusPage(slug);
        const now = Date.now();
        const targetSecond = (new Date(now).getUTCSeconds() + 30) % 60;
        const created = await owner.request(
            "addMaintenance",
            {
                ...maintenance(),
                title: "Before edit",
                strategy: "cron",
                cron: `${targetSecond} * * * * *`,
                durationMinutes: 1,
                timezoneOption: "UTC",
                dateRange: [new Date(now - 600_000).toISOString(), new Date(now + 600_000).toISOString()],
            },
            { monitors: [], statusPages: [{ id: statusPageID }] }
        );
        expect(created.ok).toBe(true);
        const prewarmed = await publicStatusPage(port, slug);
        expect(prewarmed.config.title).toBe(slug);
        expect(prewarmed.maintenanceList).toEqual([
            expect.objectContaining({ title: "Before edit", status: "under-maintenance" }),
        ]);

        const before = (await owner.request("getMaintenance", created.maintenanceID)).maintenance;
        const db = new Database(path.join(dataDir, "kuma.db"));
        const databaseBefore = db.query("SELECT * FROM maintenance WHERE id = ?").get(created.maintenanceID);
        const relationsBefore = db
            .query("SELECT * FROM maintenance_status_page WHERE maintenance_id = ? ORDER BY id")
            .all(created.maintenanceID);
        db.query("UPDATE status_page SET title = ? WHERE id = ?").run("Changed behind cache", statusPageID);
        db.exec(`
            CREATE TABLE maintenance_commit_guard (
                parent_id INTEGER,
                FOREIGN KEY (parent_id) REFERENCES maintenance(id) DEFERRABLE INITIALLY DEFERRED
            );
            CREATE TRIGGER reject_maintenance_edit
            AFTER UPDATE ON maintenance
            WHEN NEW.title = 'Rollback edit'
            BEGIN
                INSERT INTO maintenance_commit_guard (parent_id) VALUES (-1);
            END
        `);
        db.close();
        await Bun.sleep(1_100);
        const rejected = await owner.request(
            "editMaintenance",
            { ...before, title: "Rollback edit" },
            { monitors: [], statusPages: [{ id: statusPageID }] }
        );
        expect(rejected.ok).toBe(false);
        expect((await owner.request("getMaintenance", created.maintenanceID)).maintenance).toEqual(before);
        expect((await publicStatusPage(port, slug)).config.title).toBe(slug);

        const cleanupDB = new Database(path.join(dataDir, "kuma.db"));
        expect(cleanupDB.query("SELECT * FROM maintenance WHERE id = ?").get(created.maintenanceID)).toEqual(
            databaseBefore
        );
        expect(
            cleanupDB
                .query("SELECT * FROM maintenance_status_page WHERE maintenance_id = ? ORDER BY id")
                .all(created.maintenanceID)
        ).toEqual(relationsBefore);
        cleanupDB.exec("DROP TRIGGER reject_maintenance_edit");
        cleanupDB.close();
        const edited = await owner.request(
            "editMaintenance",
            { ...before, title: "After edit" },
            { monitors: [], statusPages: [{ id: statusPageID }] }
        );
        expect(edited.ok).toBe(true);
        const refreshed = await publicStatusPage(port, slug);
        expect(refreshed.config.title).toBe("Changed behind cache");
        expect(refreshed.maintenanceList).toEqual([expect.objectContaining({ title: "After edit" })]);

        const detached = await owner.request(
            "editMaintenance",
            { ...before, title: "Detached" },
            {
                monitors: [],
                statusPages: [],
            }
        );
        expect(detached.ok).toBe(true);
        expect(await publicMaintenance(port, slug)).toEqual([]);

        expect(
            (await owner.request("addMaintenanceStatusPage", created.maintenanceID, [{ id: statusPageID }])).ok
        ).toBe(true);
        expect(await publicMaintenance(port, slug)).toEqual([expect.objectContaining({ title: "Detached" })]);
    });

    test("invalidates a prewarmed public status page when a cron window starts", async () => {
        const slug = "maintenance-cron-cache";
        const { owner, port, statusPageID } = await setupStatusPage(slug);
        const now = Date.now();
        const created = await owner.request(
            "addMaintenance",
            {
                ...maintenance(),
                title: "Cron after prewarm",
                strategy: "cron",
                cron: "* * * * * *",
                durationMinutes: 1,
                timezoneOption: "UTC",
                dateRange: [new Date(now + 4_000).toISOString(), new Date(now + 70_000).toISOString()],
            },
            { monitors: [], statusPages: [{ id: statusPageID }] }
        );
        expect(created.ok).toBe(true);
        expect(await publicMaintenance(port, slug)).toEqual([]);

        await waitFor(async () => {
            const result = await owner.request("getMaintenance", created.maintenanceID);
            return result.maintenance.status === "under-maintenance";
        }, 15_000);
        expect(await publicMaintenance(port, slug)).toEqual([
            expect.objectContaining({ title: "Cron after prewarm", status: "under-maintenance" }),
        ]);
    }, 120_000);

    test("starts and expires a cached single window across restart at its real boundaries", async () => {
        const slug = "maintenance-single-end";
        let { owner, port, statusPageID } = await setupStatusPage(slug);
        expect(await publicMaintenance(port, slug)).toEqual([]);
        const now = Date.now();
        const created = await owner.request(
            "addMaintenance",
            {
                ...maintenance(),
                title: "Short single",
                strategy: "single",
                dateRange: [new Date(now + 2_000).toISOString(), new Date(now + 10_000).toISOString()],
            },
            { monitors: [], statusPages: [{ id: statusPageID }] }
        );
        expect(created.ok).toBe(true);
        expect(await publicMaintenance(port, slug)).toEqual([]);
        await waitFor(async () => {
            const result = await owner.request("getMaintenance", created.maintenanceID);
            return result.maintenance.status === "under-maintenance";
        });
        expect(await publicMaintenance(port, slug)).toEqual([expect.objectContaining({ title: "Short single" })]);

        await stopApp();
        port = await startApp();
        owner = await connect(port);
        expect((await owner.request("login", { username: "owner", password: "owner-password", token: "" })).ok).toBe(
            true
        );
        expect((await owner.request("getMaintenance", created.maintenanceID)).maintenance.status).toBe(
            "under-maintenance"
        );
        expect(await publicMaintenance(port, slug)).toEqual([expect.objectContaining({ title: "Short single" })]);

        await waitFor(async () => {
            const result = await owner.request("getMaintenance", created.maintenanceID);
            return result.maintenance.status === "ended";
        }, 15_000);
        expect(await publicMaintenance(port, slug)).toEqual([]);
    }, 120_000);

    test("keeps schedules and every mutation scoped to their owner", async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-maintenance-"));
        let port = await startApp();
        const bootstrap = await connect(port);
        expect((await bootstrap.request("setup", "owner", "owner-password")).ok).toBe(true);
        await stopApp();

        const db = new Database(path.join(dataDir, "kuma.db"));
        const ownerID = db.query("SELECT id FROM user WHERE username = ?").get("owner").id;
        db.query("INSERT INTO user (username, password, active) VALUES (?, ?, ?)").run(
            "other",
            await Bun.password.hash("other-password", { algorithm: "argon2id" }),
            1
        );
        db.query(
            "INSERT INTO monitor (name, active, user_id, interval, type, kafka_producer_brokers, kafka_producer_sasl_options, rabbitmq_nodes, conditions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run("Owner monitor", 1, ownerID, 60, "manual", "[]", "{}", "[]", "[]");
        const monitorID = db.query("SELECT id FROM monitor WHERE user_id = ?").get(ownerID).id;
        db.close();

        port = await startApp();
        const owner = await connect(port);
        const other = await connect(port);
        const anonymous = await connect(port);
        expect((await owner.request("login", { username: "owner", password: "owner-password", token: "" })).ok).toBe(
            true
        );
        expect((await other.request("login", { username: "other", password: "other-password", token: "" })).ok).toBe(
            true
        );
        expect((await anonymous.request("getMaintenanceList")).ok).toBe(false);
        expect((await anonymous.request("addMaintenance", maintenance())).ok).toBe(false);
        const created = await owner.request("addMaintenance", maintenance());
        expect(created).toEqual({ ok: true, msg: "successAdded", msgi18n: true, maintenanceID: expect.any(Number) });
        const id = created.maintenanceID;
        expect((await owner.request("addMonitorMaintenance", id, [{ id: monitorID }])).ok).toBe(true);
        expect((await owner.request("addMonitorMaintenance", id, [{ id: monitorID }, { id: 999999 }])).ok).toBe(false);
        expect((await owner.request("getMonitorMaintenance", id)).monitors).toEqual([{ id: monitorID }]);

        for (const schedule of [
            { ...maintenance(), title: "Cron", strategy: "cron", cron: "0 10 * * *", durationMinutes: 15 },
            {
                ...maintenance(),
                title: "Interval",
                strategy: "recurring-interval",
                dateRange: ["2026-01-01T00:00", "2026-12-31T23:59"],
                timeRange: [
                    { hours: 10, minutes: 0 },
                    { hours: 10, minutes: 30 },
                ],
            },
            {
                ...maintenance(),
                title: "Weekday",
                strategy: "recurring-weekday",
                dateRange: ["2026-01-01T00:00", "2026-12-31T23:59"],
                timeRange: [
                    { hours: 10, minutes: 0 },
                    { hours: 10, minutes: 30 },
                ],
                weekdays: [1],
            },
            {
                ...maintenance(),
                title: "Day of month",
                strategy: "recurring-day-of-month",
                dateRange: ["2026-01-01T00:00", "2026-12-31T23:59"],
                timeRange: [
                    { hours: 10, minutes: 0 },
                    { hours: 10, minutes: 30 },
                ],
                daysOfMonth: [1, "lastDay1"],
            },
        ]) {
            expect(await owner.request("addMaintenance", schedule)).toMatchObject({ ok: true });
        }

        const list = other.nextEvent("maintenanceList");
        expect((await other.request("getMaintenanceList")).ok).toBe(true);
        expect(await list).toEqual({});
        for (const [event, args] of [
            ["getMaintenance", [id]],
            ["editMaintenance", [{ ...maintenance(), id, title: "Stolen" }]],
            ["getMonitorMaintenance", [id]],
            ["getMaintenanceStatusPage", [id]],
            ["addMonitorMaintenance", [id, []]],
            ["addMaintenanceStatusPage", [id, []]],
            ["pauseMaintenance", [id]],
            ["resumeMaintenance", [id]],
            ["deleteMaintenance", [id]],
        ]) {
            expect((await other.request(event, ...args)).ok).toBe(false);
        }

        expect((await owner.request("getMaintenance", id)).maintenance.title).toBe("Owner-only maintenance");
        expect((await owner.request("getMonitorMaintenance", id)).monitors).toEqual([{ id: monitorID }]);
    }, 120_000);

    test("saves schedule and monitor, group, and status-page relations atomically", async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-maintenance-"));
        let port = await startApp();
        const bootstrap = await connect(port);
        expect((await bootstrap.request("setup", "owner", "owner-password")).ok).toBe(true);
        await stopApp();

        const db = new Database(path.join(dataDir, "kuma.db"));
        const ownerID = db.query("SELECT id FROM user WHERE username = ?").get("owner").id;
        db.query("INSERT INTO user (username, password, active) VALUES (?, ?, ?)").run(
            "other",
            await Bun.password.hash("other-password", { algorithm: "argon2id" }),
            1
        );
        const otherID = db.query("SELECT id FROM user WHERE username = ?").get("other").id;
        const insertMonitor = db.query(
            "INSERT INTO monitor (name, active, user_id, interval, type, kafka_producer_brokers, kafka_producer_sasl_options, rabbitmq_nodes, conditions) VALUES (?, 0, ?, 60, ?, '[]', '{}', '[]', '[]')"
        );
        const monitorID = Number(insertMonitor.run("Owner monitor", ownerID, "manual").lastInsertRowid);
        const groupID = Number(insertMonitor.run("Owner group", ownerID, "group").lastInsertRowid);
        const foreignMonitorID = Number(insertMonitor.run("Foreign monitor", otherID, "manual").lastInsertRowid);
        const insertPage = db.query("INSERT INTO status_page (slug, title, icon, theme) VALUES (?, ?, '', 'auto')");
        const pageID = Number(insertPage.run("maintenance-one", "Maintenance one").lastInsertRowid);
        const pageTwoID = Number(insertPage.run("maintenance-two", "Maintenance two").lastInsertRowid);
        db.close();

        port = await startApp();
        const owner = await connect(port);
        expect((await owner.request("login", { username: "owner", password: "owner-password", token: "" })).ok).toBe(
            true
        );

        const rejectedAdd = await owner.request(
            "addMaintenance",
            { ...maintenance(), title: "Rejected atomic" },
            {
                monitors: [{ id: monitorID }, { id: foreignMonitorID }],
                statusPages: [{ id: pageID }],
            }
        );
        expect(rejectedAdd.ok).toBe(false);

        const created = await owner.request(
            "addMaintenance",
            { ...maintenance(), title: "Atomic relations" },
            {
                monitors: [{ id: monitorID }, { id: monitorID }, { id: groupID }],
                statusPages: [{ id: pageID }, { id: pageID }],
            }
        );
        const id = created.maintenanceID;
        expect(typeof id).toBe("number");
        expect(created).toMatchObject({ ok: true });
        const createdMonitors = await owner.request("getMonitorMaintenance", id);
        expect(createdMonitors).toMatchObject({ ok: true });
        expect(createdMonitors.monitors.map(({ id }) => id).sort()).toEqual([monitorID, groupID].sort());
        expect((await owner.request("getMaintenanceStatusPage", id)).statusPages).toEqual([
            { id: pageID, title: "Maintenance one" },
        ]);

        const before = (await owner.request("getMaintenance", id)).maintenance;
        const rejectedEdit = await owner.request(
            "editMaintenance",
            { ...before, title: "Must roll back" },
            {
                monitors: [{ id: foreignMonitorID }],
                statusPages: [{ id: pageTwoID }],
            }
        );
        expect(rejectedEdit.ok).toBe(false);
        expect((await owner.request("getMaintenance", id)).maintenance.title).toBe("Atomic relations");
        expect((await owner.request("getMonitorMaintenance", id)).monitors.map(({ id }) => id).sort()).toEqual(
            [monitorID, groupID].sort()
        );
        expect((await owner.request("getMaintenanceStatusPage", id)).statusPages).toEqual([
            { id: pageID, title: "Maintenance one" },
        ]);

        const saved = await owner.request(
            "editMaintenance",
            { ...before, title: "Atomic relations edited" },
            {
                monitors: [{ id: groupID }],
                statusPages: [{ id: pageTwoID }],
            }
        );
        expect(saved.ok).toBe(true);
        expect((await owner.request("getMaintenance", id)).maintenance.title).toBe("Atomic relations edited");
        expect((await owner.request("getMonitorMaintenance", id)).monitors).toEqual([{ id: groupID }]);
        expect((await owner.request("getMaintenanceStatusPage", id)).statusPages).toEqual([
            { id: pageTwoID, title: "Maintenance two" },
        ]);

        expect((await owner.request("deleteMaintenance", id)).ok).toBe(true);
        await stopApp();
        const resultDB = new Database(path.join(dataDir, "kuma.db"));
        expect(
            resultDB.query("SELECT COUNT(*) AS count FROM maintenance WHERE title LIKE 'Rejected atomic%'").get()
        ).toEqual({
            count: 0,
        });
        expect(
            resultDB.query("SELECT COUNT(*) AS count FROM monitor_maintenance WHERE maintenance_id = ?").get(id)
        ).toEqual({ count: 0 });
        expect(
            resultDB.query("SELECT COUNT(*) AS count FROM maintenance_status_page WHERE maintenance_id = ?").get(id)
        ).toEqual({ count: 0 });
        resultDB.close();
    }, 120_000);

    test("does not revive paused cron schedules and keeps failed edits atomic", async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-maintenance-"));
        let port = await startApp();
        const bootstrap = await connect(port);
        expect((await bootstrap.request("setup", "owner", "owner-password")).ok).toBe(true);
        await stopApp();

        port = await startApp();
        const owner = await connect(port);
        expect((await owner.request("login", { username: "owner", password: "owner-password", token: "" })).ok).toBe(
            true
        );

        const paused = await owner.request("addMaintenance", {
            ...maintenance(),
            title: "Paused cron",
            active: false,
            strategy: "cron",
            cron: "* * * * *",
            durationMinutes: 10,
        });
        expect(paused.ok).toBe(true);
        expect((await owner.request("getMaintenance", paused.maintenanceID)).maintenance).toMatchObject({
            active: false,
            status: "inactive",
            timeslotList: [],
        });

        const cron = await owner.request("addMaintenance", {
            ...maintenance(),
            title: "Atomic cron",
            strategy: "cron",
            cron: "0 10 * * *",
            durationMinutes: 10,
        });
        expect(cron.ok).toBe(true);
        const before = (await owner.request("getMaintenance", cron.maintenanceID)).maintenance;
        const failed = await owner.request("editMaintenance", {
            ...before,
            strategy: "recurring-weekday",
            timeRange: [
                { hours: 10, minutes: 0 },
                { hours: 10, minutes: 30 },
            ],
            weekdays: [],
        });
        expect(failed).toMatchObject({ ok: false });
        expect((await owner.request("getMaintenance", cron.maintenanceID)).maintenance).toMatchObject({
            strategy: "cron",
            cron: "0 10 * * *",
            active: true,
        });

        await stopApp();
        const db = new Database(path.join(dataDir, "kuma.db"));
        expect(db.query("SELECT strategy, cron, active FROM maintenance WHERE id = ?").get(cron.maintenanceID)).toEqual(
            {
                strategy: "cron",
                cron: "0 10 * * *",
                active: 1,
            }
        );
        expect(
            db.query("SELECT last_start_date FROM maintenance WHERE id = ?").get(paused.maintenanceID).last_start_date
        ).toBeNull();
        db.close();

        port = await startApp();
        const restarted = await connect(port);
        expect(
            (await restarted.request("login", { username: "owner", password: "owner-password", token: "" })).ok
        ).toBe(true);
        expect((await restarted.request("getMaintenance", paused.maintenanceID)).maintenance).toMatchObject({
            active: false,
            status: "inactive",
            timeslotList: [],
        });
    }, 120_000);

    test("suppresses real monitor notifications during maintenance and exposes only active public windows", async () => {
        const webhookRequests = [];
        sink = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                webhookRequests.push(await request.json());
                return new Response("ok");
            },
        });
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-maintenance-"));
        let port = await startApp();
        const bootstrap = await connect(port);
        expect((await bootstrap.request("setup", "owner", "owner-password")).ok).toBe(true);
        await stopApp();

        const db = new Database(path.join(dataDir, "kuma.db"));
        const ownerID = db.query("SELECT id FROM user WHERE username = ?").get("owner").id;
        const monitorID = Number(
            db
                .query(
                    "INSERT INTO monitor (name, active, user_id, interval, type, manual_status, kafka_producer_brokers, kafka_producer_sasl_options, rabbitmq_nodes, conditions) VALUES (?, 0, ?, 1, 'manual', 0, '[]', '{}', '[]', '[]')"
                )
                .run("Maintenance heartbeat", ownerID).lastInsertRowid
        );
        const notificationID = Number(
            db.query("INSERT INTO notification (name, active, user_id, is_default, config) VALUES (?, 1, ?, 0, ?)").run(
                "Local webhook",
                ownerID,
                JSON.stringify({
                    name: "webhook",
                    type: "webhook",
                    webhookURL: `http://127.0.0.1:${sink.port}`,
                    httpMethod: "POST",
                    webhookContentType: "json",
                })
            ).lastInsertRowid
        );
        db.query("INSERT INTO monitor_notification (monitor_id, notification_id) VALUES (?, ?)").run(
            monitorID,
            notificationID
        );
        const statusPageID = Number(
            db
                .query("INSERT INTO status_page (slug, title, icon, theme) VALUES (?, ?, '', 'auto')")
                .run("runtime-maintenance", "Runtime maintenance").lastInsertRowid
        );
        const groupID = Number(
            db
                .query("INSERT INTO `group` (name, public, active, weight, status_page_id) VALUES (?, 1, 1, 1, ?)")
                .run("Public services", statusPageID).lastInsertRowid
        );
        db.query("INSERT INTO monitor_group (monitor_id, group_id, weight) VALUES (?, ?, 1)").run(monitorID, groupID);
        db.close();

        port = await startApp();
        const owner = await connect(port);
        expect((await owner.request("login", { username: "owner", password: "owner-password", token: "" })).ok).toBe(
            true
        );
        const created = await owner.request(
            "addMaintenance",
            { ...maintenance(), title: "Runtime window" },
            {
                monitors: [{ id: monitorID }],
                statusPages: [{ id: statusPageID }],
            }
        );
        expect(created.ok).toBe(true);
        expect((await owner.request("resumeMonitor", monitorID)).ok).toBe(true);

        const latestHeartbeat = () => {
            const heartbeatDB = new Database(path.join(dataDir, "kuma.db"), { readonly: true });
            const heartbeat = heartbeatDB
                .query("SELECT id, status FROM heartbeat WHERE monitor_id = ? ORDER BY id DESC LIMIT 1")
                .get(monitorID);
            heartbeatDB.close();
            return heartbeat;
        };
        const maintenanceBeat = await waitFor(() => {
            const heartbeat = latestHeartbeat();
            return heartbeat?.status === 3 && heartbeat;
        });
        expect(webhookRequests).toHaveLength(0);
        let publicPage = await (await fetch(`http://127.0.0.1:${port}/api/status-page/runtime-maintenance`)).json();
        expect(publicPage.maintenanceList).toHaveLength(1);
        expect(publicPage.maintenanceList[0].title).toBe("Runtime window");

        expect((await owner.request("pauseMaintenance", created.maintenanceID)).ok).toBe(true);
        const downBeat = await waitFor(() => {
            const heartbeat = latestHeartbeat();
            return heartbeat?.id > maintenanceBeat.id && heartbeat.status === 0 && heartbeat;
        });
        await waitFor(() => webhookRequests.length === 1);
        expect(webhookRequests[0].heartbeat.status).toBe(0);
        publicPage = await (await fetch(`http://127.0.0.1:${port}/api/status-page/runtime-maintenance`)).json();
        expect(publicPage.maintenanceList).toEqual([]);

        expect((await owner.request("resumeMaintenance", created.maintenanceID)).ok).toBe(true);
        const resumedBeat = await waitFor(() => {
            const heartbeat = latestHeartbeat();
            return heartbeat?.id > downBeat.id && heartbeat.status === 3 && heartbeat;
        });
        await Bun.sleep(1_200);
        expect(webhookRequests).toHaveLength(1);
        publicPage = await (await fetch(`http://127.0.0.1:${port}/api/status-page/runtime-maintenance`)).json();
        expect(publicPage.maintenanceList).toEqual([expect.objectContaining({ title: "Runtime window" })]);

        expect((await owner.request("deleteMaintenance", created.maintenanceID)).ok).toBe(true);
        await waitFor(() => {
            const heartbeat = latestHeartbeat();
            return heartbeat?.id > resumedBeat.id && heartbeat.status === 0;
        });
        await waitFor(() => webhookRequests.length === 2);
        publicPage = await (await fetch(`http://127.0.0.1:${port}/api/status-page/runtime-maintenance`)).json();
        expect(publicPage.maintenanceList).toEqual([]);
        const cleanupDB = new Database(path.join(dataDir, "kuma.db"), { readonly: true });
        expect(
            cleanupDB.query("SELECT COUNT(*) AS count FROM maintenance WHERE id = ?").get(created.maintenanceID)
        ).toEqual({
            count: 0,
        });
        expect(
            cleanupDB
                .query("SELECT COUNT(*) AS count FROM monitor_maintenance WHERE maintenance_id = ?")
                .get(created.maintenanceID)
        ).toEqual({ count: 0 });
        expect(
            cleanupDB
                .query("SELECT COUNT(*) AS count FROM maintenance_status_page WHERE maintenance_id = ?")
                .get(created.maintenanceID)
        ).toEqual({ count: 0 });
        cleanupDB.close();
    }, 120_000);
});
