// @ts-nocheck

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database as BunDatabase } from "bun:sqlite";
import { SQLiteStore } from "@/server/sqlite-store";
import { SQLiteModel } from "@/server/sqlite-model";
import { SQLITE_MODEL_MAPPING } from "@/server/sqlite-model-mapping";

function createFaultingStore(faults) {
    return new SQLiteStore({
        modelMapping: SQLITE_MODEL_MAPPING,
        databaseFactory(sqlitePath, options) {
            const db = new BunDatabase(sqlitePath, options);
            return {
                query: db.query.bind(db),
                run(sql, ...params) {
                    if (sql === "COMMIT" && faults.commit) {
                        throw new Error("forced commit failure");
                    }
                    if (sql === "ROLLBACK" && faults.rollback) {
                        throw new Error(faults.rollback);
                    }
                    return db.run(sql, ...params);
                },
                close: db.close.bind(db),
            };
        },
    });
}

class FirstNotification extends SQLiteModel {}
class SecondNotification extends SQLiteModel {}

function importInOrder(first, second, storeModule, mappingModule) {
    const result = Bun.spawnSync([
        process.execPath,
        "-e",
        `await import(${JSON.stringify(first)}); await import(${JSON.stringify(second)}); const { SQLiteStore } = await import(${JSON.stringify(storeModule)}); const { SQLITE_MODEL_MAPPING } = await import(${JSON.stringify(mappingModule)}); const store = new SQLiteStore({ modelMapping: SQLITE_MODEL_MAPPING }); if (!(store.createModel("monitor") instanceof SQLITE_MODEL_MAPPING.monitor) || !(store.createModel("heartbeat") instanceof SQLITE_MODEL_MAPPING.heartbeat)) throw new Error("explicit store lost typed models");`,
    ]);
    return { exitCode: result.exitCode, stderr: new TextDecoder().decode(result.stderr) };
}

describe("SQLite store", () => {
    let dir;
    let store;

    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "uptime-maku-store-"));
        store = new SQLiteStore({ modelMapping: SQLITE_MODEL_MAPPING });
        await store.connect({
            sqlitePath: path.join(dir, "kuma.db"),
            templatePath: path.join(process.cwd(), "src/db/kuma.db"),
            testMode: true,
        });
    });

    afterEach(async () => {
        await store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test("keeps the SQLite core bundle outside domain and runtime boundaries", async () => {
        const build = await Bun.build({
            entrypoints: [path.join(process.cwd(), "src/server/sqlite-store.ts")],
            bundle: true,
            metafile: true,
            write: false,
            target: "bun",
        });
        expect(build.success).toBe(true);

        const inputs = Object.keys(build.metafile.inputs).map((input) => input.replaceAll("\\", "/"));
        const forbidden = [
            "src/server/model/",
            "src/server/monitor-types/",
            "src/server/notification-providers/",
            "src/server/monitor-runtime-registry.ts",
            "src/server/notification-provider-registry.ts",
            "src/server/socket-handlers/",
            "src/server/bun-http-server.ts",
            "src/server/bun-websocket-server.ts",
        ];
        expect(inputs.filter((input) => forbidden.some((boundary) => input.includes(boundary)))).toEqual([]);
    });

    test("allows store and mapping imports in either order", () => {
        const storeModule = path.join(process.cwd(), "src/server/sqlite-store.ts");
        const mappingModule = path.join(process.cwd(), "src/server/sqlite-model-mapping.ts");

        for (const [first, second] of [
            [storeModule, mappingModule],
            [mappingModule, storeModule],
        ]) {
            const result = importInOrder(first, second, storeModule, mappingModule);
            expect(result.exitCode, result.stderr).toBe(0);
        }
    });

    test("bootstraps status-page and incident columns used by Bun runtime queries", async () => {
        const monitorColumns = await store.getCol("SELECT name FROM pragma_table_info('monitor')");
        const incidentColumns = await store.getCol("SELECT name FROM pragma_table_info('incident')");
        const statusPageColumns = await store.getCol("SELECT name FROM pragma_table_info('status_page')");

        expect(monitorColumns.includes("dns_last_result")).toBe(true);
        expect(incidentColumns.includes("pin")).toBe(true);
        expect(incidentColumns.includes("active")).toBe(true);
        expect(statusPageColumns.includes("auto_refresh_interval")).toBe(true);
        expect(statusPageColumns.includes("analytics_id")).toBe(true);
        expect(statusPageColumns.includes("analytics_script_url")).toBe(true);
        expect(statusPageColumns.includes("analytics_type")).toBe(true);
        expect(statusPageColumns.includes("rss_title")).toBe(true);
        expect(statusPageColumns.includes("show_certificate_expiry")).toBe(true);
        expect(statusPageColumns.includes("show_only_last_heartbeat")).toBe(true);

        await store.exec(
            "INSERT INTO status_page (id, slug, title, icon, theme, auto_refresh_interval, analytics_id, analytics_script_url, analytics_type, rss_title, show_certificate_expiry, show_only_last_heartbeat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [1, "test", "Test", "", "auto", 30, "G-123", "https://analytics.example/script.js", "google", "RSS", 1, 1]
        );
        await store.exec(
            "INSERT INTO incident (title, content, style, pin, active, status_page_id, created_date) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ["Incident", "Content", "warning", 1, 1, 1, "2026-01-01 00:00:00"]
        );
        await store.exec("UPDATE monitor SET dns_last_result = ? WHERE id = ?", ["127.0.0.1", -1]);

        const incidents = await store.find(
            "incident",
            "pin = 1 AND active = 1 AND status_page_id = ? ORDER BY created_date DESC",
            [1]
        );
        expect(incidents.length).toBe(1);

        const statusPage = await store.findOne("status_page", " slug = ? ", ["test"]);
        expect(statusPage.analyticsId).toBe("G-123");
        expect(statusPage.analyticsScriptUrl).toBe("https://analytics.example/script.js");
        expect(statusPage.analyticsType).toBe("google");
        expect(statusPage.rssTitle).toBe("RSS");
    });

    test("transaction handle supports status-page domain mapping operations", async () => {
        await store.exec("INSERT INTO status_page (id, slug, title, icon, theme) VALUES (?, ?, ?, ?, ?)", [
            1,
            "test",
            "Test",
            "",
            "auto",
        ]);

        const trx = await store.begin();
        try {
            await trx.exec("DELETE FROM status_page_cname WHERE status_page_id = ?", [1]);
            const mapping = trx.createModel("status_page_cname");
            mapping.status_page_id = 1;
            mapping.domain = "status.example.com";
            await trx.saveModel(mapping);
            await trx.commit();
        } catch (error) {
            await trx.rollback();
            throw error;
        }

        const domain = await store.getCell("SELECT domain FROM status_page_cname WHERE status_page_id = ?", [1]);
        expect(domain).toBe("status.example.com");
    });

    test("keeps every ordinary database operation outside an active transaction", async () => {
        await store.exec("INSERT INTO notification (name, config) VALUES (?, ?)", ["existing", "{}"]);
        const existing = await store.findOne("notification", " name = ? ", ["existing"]);
        const transaction = await store.begin();
        await transaction.exec("INSERT INTO notification (name, config) VALUES (?, ?)", ["transaction", "{}"]);

        const queuedModel = store.createModel("notification");
        queuedModel.name = "queued-store";
        queuedModel.config = "{}";
        const completed = [];
        const values = {};
        const queue = (name, operation) =>
            Promise.resolve()
                .then(operation)
                .then((value) => {
                    completed.push(name);
                    values[name] = value;
                });
        const operations = [
            queue("exec", () =>
                store.exec("INSERT INTO notification (name, config) VALUES (?, ?)", ["queued-exec", "{}"])
            ),
            queue("saveModel", () => store.saveModel(queuedModel)),
            queue("deleteModel", () => store.deleteModel(existing)),
            queue("getAll", () => store.getAll("SELECT name FROM notification ORDER BY name")),
            queue("getRow", () => store.getRow("SELECT name FROM notification WHERE name = ?", ["transaction"])),
            queue("getCell", () => store.getCell("SELECT COUNT(*) FROM notification")),
            queue("getCol", () => store.getCol("SELECT name FROM notification ORDER BY name")),
            queue("getAssoc", () => store.getAssoc("SELECT name, id FROM notification ORDER BY name")),
            queue("find", () => store.find("notification", " ORDER BY name ")),
            queue("findAll", () => store.findAll("notification", " ORDER BY name ")),
            queue("findOne", () => store.findOne("notification", " name = ? ", ["transaction"])),
            queue("load", () => store.load("notification", existing.id)),
            queue("count", () => store.count("notification")),
            queue("hasTable", () => store.hasTable("notification")),
        ];

        let finalized = false;
        try {
            await Bun.sleep(20);
            expect(completed).toEqual([]);
            expect(existing.id).not.toBe(0);

            await transaction.commit();
            finalized = true;
            await Promise.all(operations);
        } finally {
            if (!finalized) {
                await transaction.rollback().catch(() => {});
            }
        }

        const names = ["queued-exec", "queued-store", "transaction"];
        expect(completed).toEqual([
            "exec",
            "saveModel",
            "deleteModel",
            "getAll",
            "getRow",
            "getCell",
            "getCol",
            "getAssoc",
            "find",
            "findAll",
            "findOne",
            "load",
            "count",
            "hasTable",
        ]);
        expect(existing.id).toBe(0);
        expect(values.getAll).toEqual(names.map((name) => ({ name })));
        expect(values.getRow).toEqual({ name: "transaction" });
        expect(values.getCell).toBe(3);
        expect(values.getCol).toEqual(names);
        expect(Object.keys(values.getAssoc)).toEqual(names);
        expect(values.find.map(({ name }) => name)).toEqual(names);
        expect(values.findAll.map(({ name }) => name)).toEqual(names);
        expect(values.findOne.name).toBe("transaction");
        expect(values.load).toBeNull();
        expect(values.count).toBe(3);
        expect(values.hasTable).toBe(true);
    });

    test("queues transactions and later ordinary work fairly without nested transactions", async () => {
        await store.exec("CREATE TABLE isolation_order (value TEXT NOT NULL)");
        const first = await store.begin();
        await first.exec("INSERT INTO isolation_order VALUES (?)", ["first"]);

        const completed = [];
        const secondPromise = store.begin().then(
            (transaction) => {
                completed.push("second");
                return { transaction };
            },
            (error) => {
                completed.push(`second-error:${error.message}`);
                return { error };
            }
        );
        const ordinary = store.exec("INSERT INTO isolation_order VALUES (?)", ["ordinary"]).then(() => {
            completed.push("ordinary");
        });
        const thirdPromise = store.begin().then(
            (transaction) => {
                completed.push("third");
                return { transaction };
            },
            (error) => {
                completed.push(`third-error:${error.message}`);
                return { error };
            }
        );

        let firstFinalized = false;
        try {
            await Bun.sleep(20);
            expect(completed).toEqual([]);
            await first.commit();
            firstFinalized = true;
        } finally {
            if (!firstFinalized) {
                await first.rollback().catch(() => {});
            }
        }

        const { transaction: second, error: secondError } = await secondPromise;
        expect(secondError).toBeUndefined();
        expect(completed).toEqual(["second"]);
        await Bun.sleep(20);
        expect(completed).toEqual(["second"]);
        await second.exec("INSERT INTO isolation_order VALUES (?)", ["second"]);
        await second.rollback();

        await ordinary;
        const { transaction: third, error: thirdError } = await thirdPromise;
        expect(thirdError).toBeUndefined();
        expect(completed).toEqual(["second", "ordinary", "third"]);
        await third.exec("INSERT INTO isolation_order VALUES (?)", ["third"]);
        await third.commit();
        await expect(third.commit()).resolves.toBeUndefined();
        await expect(third.rollback()).resolves.toBeUndefined();

        const fourth = await store.begin();
        await expect(third.rollback()).resolves.toBeUndefined();
        await expect(third.exec("INSERT INTO isolation_order VALUES ('stale')")).rejects.toThrow(
            "Transaction has finished"
        );
        await fourth.exec("INSERT INTO isolation_order VALUES (?)", ["fourth"]);
        await fourth.commit();

        expect(await store.getCol("SELECT value FROM isolation_order ORDER BY rowid")).toEqual([
            "first",
            "ordinary",
            "third",
            "fourth",
        ]);
    });

    test("rolls back a failed deferred commit before releasing queued work", async () => {
        await store.exec("CREATE TABLE isolation_parent (id INTEGER PRIMARY KEY)");
        await store.exec(
            "CREATE TABLE isolation_child (parent_id INTEGER REFERENCES isolation_parent(id) DEFERRABLE INITIALLY DEFERRED)"
        );
        await store.exec("CREATE TABLE isolation_log (value TEXT NOT NULL)");

        const transaction = await store.begin();
        await transaction.exec("INSERT INTO isolation_child VALUES (?)", [-1]);
        let ordinaryCompleted = false;
        const ordinary = store.exec("INSERT INTO isolation_log VALUES (?)", ["outside"]).then(() => {
            ordinaryCompleted = true;
        });

        await Bun.sleep(20);
        expect(ordinaryCompleted).toBe(false);
        await expect(transaction.commit()).rejects.toThrow();
        await expect(transaction.rollback()).resolves.toBeUndefined();
        await ordinary;

        expect(await store.getCell("SELECT COUNT(*) FROM isolation_child")).toBe(0);
        expect(await store.getCol("SELECT value FROM isolation_log")).toEqual(["outside"]);
        await expect(transaction.exec("INSERT INTO isolation_log VALUES ('stale')")).rejects.toThrow(
            "Transaction has finished"
        );
        await expect(transaction.saveModel(store.createModel("notification"))).rejects.toThrow(
            "Transaction has finished"
        );
    });

    test("quarantines the connection when a failed commit cannot roll back", async () => {
        await store.close();
        const faults = {};
        store = createFaultingStore(faults);
        await store.connect({
            sqlitePath: path.join(dir, "kuma.db"),
            templatePath: path.join(process.cwd(), "src/db/kuma.db"),
            testMode: true,
        });
        await store.exec("CREATE TABLE poison_probe (value TEXT NOT NULL)");
        faults.commit = true;
        faults.rollback = "forced rollback failure";

        const transaction = await store.begin();
        await transaction.exec("INSERT INTO poison_probe VALUES (?)", ["inside"]);
        const queued = Promise.allSettled([
            store.getCell("SELECT COUNT(*) FROM poison_probe"),
            store.exec("INSERT INTO poison_probe VALUES (?)", ["outside"]),
            store.begin(),
        ]);
        const queuedClose = store.close();
        let queuedResults;

        const error = await transaction.commit().catch((failure) => failure);
        expect(error).toBeInstanceOf(AggregateError);
        expect(error.errors.map(({ message }) => message)).toEqual([
            "forced commit failure",
            "forced rollback failure",
        ]);
        queuedResults = await queued;
        expect(queuedResults.map(({ status }) => status)).toEqual(["rejected", "rejected", "rejected"]);
        await expect(queuedClose).resolves.toBeUndefined();
        expect(store.isOpen()).toBe(false);
        await expect(store.getCell("SELECT COUNT(*) FROM poison_probe")).rejects.toThrow("quarantined");
        await expect(
            store.connect({
                sqlitePath: path.join(dir, "kuma.db"),
                templatePath: path.join(process.cwd(), "src/db/kuma.db"),
                testMode: true,
            })
        ).rejects.toThrow("quarantined");

        const observer = new BunDatabase(path.join(dir, "kuma.db"), { readonly: true });
        try {
            expect(observer.query("SELECT COUNT(*) AS count FROM poison_probe").get().count).toBe(0);
        } finally {
            observer.close();
        }
        await expect(store.close()).resolves.toBeUndefined();
    });

    test("quarantines the connection when an explicit rollback fails", async () => {
        await store.close();
        const faults = {};
        store = createFaultingStore(faults);
        await store.connect({
            sqlitePath: path.join(dir, "kuma.db"),
            templatePath: path.join(process.cwd(), "src/db/kuma.db"),
            testMode: true,
        });
        await store.exec("CREATE TABLE rollback_poison_probe (value TEXT NOT NULL)");
        faults.rollback = "forced explicit rollback failure";

        const transaction = await store.begin();
        await transaction.exec("INSERT INTO rollback_poison_probe VALUES (?)", ["inside"]);
        const queued = Promise.allSettled([
            store.getCell("SELECT COUNT(*) FROM rollback_poison_probe"),
            store.exec("INSERT INTO rollback_poison_probe VALUES (?)", ["outside"]),
            store.begin(),
        ]);
        const queuedClose = store.close();
        let queuedResults;

        await expect(transaction.rollback()).rejects.toThrow("forced explicit rollback failure");
        queuedResults = await queued;
        expect(queuedResults.map(({ status }) => status)).toEqual(["rejected", "rejected", "rejected"]);
        await expect(queuedClose).resolves.toBeUndefined();
        await expect(store.exec("SELECT 1")).rejects.toThrow("quarantined");

        const observer = new BunDatabase(path.join(dir, "kuma.db"), { readonly: true });
        try {
            expect(observer.query("SELECT COUNT(*) AS count FROM rollback_poison_probe").get().count).toBe(0);
        } finally {
            observer.close();
        }
        await expect(store.close()).resolves.toBeUndefined();
    });

    test("rejects 500 waiters and 100 consecutive faulted finalizers without leaking rows", async () => {
        await store.exec("CREATE TABLE poison_stress (value INTEGER NOT NULL)");
        await store.close();

        for (let cycle = 0; cycle < 100; cycle++) {
            const faults = {};
            store = createFaultingStore(faults);
            await store.connect({
                sqlitePath: path.join(dir, "kuma.db"),
                templatePath: path.join(process.cwd(), "src/db/kuma.db"),
                testMode: true,
            });
            const transaction = await store.begin();
            await transaction.exec("INSERT INTO poison_stress VALUES (?)", [cycle]);
            const waiterCount = cycle === 0 ? 500 : 3;
            const waiters = Promise.allSettled(
                Array.from({ length: waiterCount }, (_, index) =>
                    index % 3 === 0
                        ? store.getCell("SELECT COUNT(*) FROM poison_stress")
                        : index % 3 === 1
                          ? store.exec("INSERT INTO poison_stress VALUES (?)", [10_000 + index])
                          : store.begin()
                )
            );
            faults.rollback = `forced rollback failure ${cycle}`;
            if (cycle % 2 === 0) {
                faults.commit = true;
                await expect(transaction.commit()).rejects.toBeInstanceOf(AggregateError);
            } else {
                await expect(transaction.rollback()).rejects.toThrow(`forced rollback failure ${cycle}`);
            }
            expect((await waiters).every(({ status }) => status === "rejected")).toBe(true);
            expect(store.isOpen()).toBe(false);
            await expect(store.begin()).rejects.toThrow("quarantined");
            await expect(store.close()).resolves.toBeUndefined();
        }

        const observer = new BunDatabase(path.join(dir, "kuma.db"), { readonly: true });
        try {
            expect(observer.query("SELECT COUNT(*) AS count FROM poison_stress").get().count).toBe(0);
        } finally {
            observer.close();
        }
    });

    test("does not expose the raw SQLite connection", () => {
        expect("db" in store).toBe(false);
    });

    test("keeps draining queued work after an operation throws and survives mixed transaction stress", async () => {
        await store.exec("CREATE TABLE isolation_stress (value INTEGER NOT NULL)");
        const blocker = await store.begin();
        const rejected = store.getAll("SELECT FROM isolation_stress");
        const following = store.exec("INSERT INTO isolation_stress VALUES (?)", [-1]);
        await blocker.rollback();
        await expect(rejected).rejects.toThrow();
        await following;

        for (let index = 0; index < 100; index++) {
            const transaction = await store.begin();
            await transaction.exec("INSERT INTO isolation_stress VALUES (?)", [index]);
            const outside = store.exec("INSERT INTO isolation_stress VALUES (?)", [10_000 + index]);
            if (index % 2 === 0) {
                await transaction.commit();
            } else {
                await transaction.rollback();
            }
            await outside;
        }

        expect(await store.count("isolation_stress")).toBe(151);
        expect(await store.getCell("SELECT COUNT(*) FROM isolation_stress WHERE value < 10000")).toBe(51);
        expect(await store.getCell("SELECT COUNT(*) FROM isolation_stress WHERE value >= 10000")).toBe(100);
    });

    test("finishes an already-started ordinary operation before begin and makes close wait", async () => {
        await store.exec("DROP TABLE incident");
        await store.exec("CREATE TABLE incident (id INTEGER PRIMARY KEY AUTOINCREMENT, pin INTEGER)");
        const model = store.createModel("incident");
        model.pin = 1;

        const storing = store.saveModel(model);
        const transaction = await store.begin();
        await transaction.rollback();
        await storing;
        expect(await store.getCell("SELECT pin FROM incident WHERE id = ?", [model.id])).toBe(1);

        const blocker = await store.begin();
        let closed = false;
        const closing = store.close().then(() => {
            closed = true;
        });
        await Bun.sleep(20);
        expect(closed).toBe(false);
        try {
            expect(store.isOpen()).toBe(true);
        } finally {
            await blocker.rollback();
            await closing;
        }
        expect(closed).toBe(true);
        expect(store.isOpen()).toBe(false);
    });

    test("keeps close behind queued work while a transaction is pending", async () => {
        const blocker = await store.begin();
        const queued = store.exec("CREATE TABLE close_pending_transaction (id INTEGER)");
        const closing = store.close();

        await Bun.sleep(20);
        expect(store.isOpen()).toBe(true);
        await blocker.rollback();
        await queued;
        await closing;

        expect(store.isOpen()).toBe(false);
    });

    test("deleteModel deletes stored models, clears their identity, and ignores unsaved models", async () => {
        const notification = store.createModel("notification");
        notification.name = "Trash regression";
        notification.config = "{}";
        const id = await store.saveModel(notification);

        expect(await store.load("notification", id)).not.toBeNull();

        await store.deleteModel(notification);

        expect(notification.id).toBe(0);
        expect(await store.load("notification", id)).toBeNull();
        await expect(store.deleteModel(notification)).resolves.toBeUndefined();

        const unsaved = store.createModel("notification");
        await expect(store.deleteModel(unsaved)).resolves.toBeUndefined();
        await expect(store.deleteModel({ id })).rejects.toThrow(
            "Cannot delete model that is not owned by this SQLite store"
        );
    });

    test("serializes freshly created heartbeat models for live socket events", async () => {
        const heartbeat = store.createModel("heartbeat");
        heartbeat.monitor_id = 7;
        heartbeat.status = 1;
        heartbeat.time = "2026-01-01 00:00:00.000";
        heartbeat.msg = "200 - OK";
        heartbeat.ping = 12;
        heartbeat.important = true;
        heartbeat.duration = 50;
        heartbeat.retries = 0;

        expect(heartbeat.toJSON()).toEqual({
            monitorID: 7,
            status: 1,
            time: "2026-01-01 00:00:00.000",
            msg: "200 - OK",
            ping: 12,
            important: true,
            duration: 50,
            retries: 0,
            response: undefined,
        });
    });

    test("returns models for status-page group relations", async () => {
        await store.exec("INSERT INTO user (id, username, password, active) VALUES (?, ?, ?, ?)", [
            1,
            "smoke",
            "hash",
            1,
        ]);
        await store.exec("INSERT INTO status_page (id, slug, title, icon, theme) VALUES (?, ?, ?, ?, ?)", [
            1,
            "test",
            "Test",
            "",
            "auto",
        ]);
        await store.exec("INSERT INTO `group` (id, name, public, status_page_id, weight) VALUES (?, ?, ?, ?, ?)", [
            1,
            "Public",
            1,
            1,
            1,
        ]);
        await store.exec(
            "INSERT INTO monitor (id, name, type, url, interval, retry_interval, accepted_statuscodes_json, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [1, "Monitor", "http", "http://127.0.0.1", 60, 20, '["200-299"]', 1]
        );
        await store.exec(
            "INSERT INTO monitor_group (monitor_id, group_id, weight, send_url, custom_url) VALUES (?, ?, ?, ?, ?)",
            [1, 1, 1, 1, "https://example.com"]
        );

        const group = await store.findOne("group", " status_page_id = ? ", [1]);
        expect(typeof group.toPublicJSON).toBe("function");

        const monitorRows = await store.getAll(
            `
            SELECT monitor.*, monitor_group.send_url, monitor_group.custom_url
            FROM monitor, monitor_group
            WHERE monitor.id = monitor_group.monitor_id
            AND group_id = ?
            ORDER BY monitor_group.weight
        `,
            [1]
        );

        const [monitor] = store.hydrateModels("monitor", monitorRows);
        expect(typeof monitor.getIgnoreTls).toBe("function");
        expect(monitor.getIgnoreTls()).toBe(false);
        expect(monitor.sendUrl).toBe(true);
        expect(monitor.customUrl).toBe("https://example.com");
    });

    test("uses the explicit immutable model mapping and falls back for unknown tables", () => {
        expect(Object.keys(SQLITE_MODEL_MAPPING).sort()).toEqual([
            "api_key",
            "docker_host",
            "domain_expiry",
            "group",
            "heartbeat",
            "incident",
            "maintenance",
            "monitor",
            "proxy",
            "remote_browser",
            "status_page",
            "tag",
            "user",
        ]);
        expect(store.createModel("monitor")).toBeInstanceOf(SQLITE_MODEL_MAPPING.monitor);
        expect(store.createModel("not_a_model")).toBeInstanceOf(SQLiteModel);
    });

    test("each explicit store creates every supported typed model", () => {
        for (const [table, Model] of Object.entries(SQLITE_MODEL_MAPPING)) {
            expect(store.createModel(table)).toBeInstanceOf(Model);
        }
        expect(store.hydrateModel("heartbeat", { monitor_id: 1 })).toBeInstanceOf(SQLITE_MODEL_MAPPING.heartbeat);
    });

    test("keeps model constructors, models, and persistence isolated per store", async () => {
        const firstDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "uptime-maku-mapping-first-"));
        const secondDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "uptime-maku-mapping-second-"));
        const firstMapping = { notification: FirstNotification };
        const secondMapping = { notification: SecondNotification };
        const first = new SQLiteStore({ modelMapping: firstMapping });
        const second = new SQLiteStore({ modelMapping: secondMapping });

        try {
            await Promise.all([
                first.connect({
                    sqlitePath: path.join(firstDirectory, "kuma.db"),
                    templatePath: path.join(process.cwd(), "src/db/kuma.db"),
                    testMode: true,
                }),
                second.connect({
                    sqlitePath: path.join(secondDirectory, "kuma.db"),
                    templatePath: path.join(process.cwd(), "src/db/kuma.db"),
                    testMode: true,
                }),
            ]);

            firstMapping.notification = SecondNotification;
            const firstModel = first.createModel("notification");
            const secondModel = second.createModel("notification");
            expect(firstModel).toBeInstanceOf(FirstNotification);
            expect(secondModel).toBeInstanceOf(SecondNotification);
            expect(firstModel).not.toBe(secondModel);
            expect(firstModel.constructor).not.toBe(secondModel.constructor);

            firstModel.name = "first-store";
            secondModel.name = "second-store";
            await first.saveModel(firstModel);
            await second.saveModel(secondModel);

            expect(await first.getCell("SELECT name FROM notification")).toBe("first-store");
            expect(await second.getCell("SELECT name FROM notification")).toBe("second-store");
            await expect(second.saveModel(firstModel)).rejects.toThrow(
                "Cannot save model that is not owned by this SQLite store"
            );
            await expect(second.deleteModel(firstModel)).rejects.toThrow(
                "Cannot delete model that is not owned by this SQLite store"
            );
            await expect(first.saveModel(secondModel)).rejects.toThrow(
                "Cannot save model that is not owned by this SQLite store"
            );
            await expect(first.deleteModel(secondModel)).rejects.toThrow(
                "Cannot delete model that is not owned by this SQLite store"
            );
            expect(await first.getCell("SELECT name FROM notification")).toBe("first-store");
            expect(await second.getCell("SELECT name FROM notification")).toBe("second-store");
        } finally {
            await first.close();
            await second.close();
            fs.rmSync(firstDirectory, { recursive: true, force: true });
            fs.rmSync(secondDirectory, { recursive: true, force: true });
        }
    });

    test("rejects unknown model properties without changing the SQLite schema", async () => {
        const before = await store.getAll("PRAGMA table_info('notification')");
        const model = store.createModel("notification");
        model.name = "unknown-property";
        model.schemaProbe = "must-not-become-a-column";

        await expect(store.saveModel(model)).rejects.toThrow(
            "Refusing to store unknown column notification.schemaProbe"
        );

        expect(await store.getAll("PRAGMA table_info('notification')")).toEqual(before);
        expect(await store.getCell("SELECT COUNT(*) FROM notification WHERE name = ?", ["unknown-property"])).toBe(0);
    });

    test("registered model serializers preserve stored identifiers", () => {
        expect(store.hydrateModel("tag", { id: 7, name: "monitor_name", color: "#D97706" }).toJSON()).toEqual({
            id: 7,
            name: "monitor_name",
            color: "#D97706",
        });
        expect(
            store
                .hydrateModel("proxy", {
                    id: 8,
                    user_id: 3,
                    protocol: "http",
                    host: "127.0.0.1",
                    port: 8080,
                    auth: 0,
                    active: 1,
                    default: 0,
                    created_date: "2026-01-01 00:00:00",
                })
                .toJSON()
        ).toMatchObject({ id: 8, userId: 3, protocol: "http", host: "127.0.0.1", port: 8080 });
    });

    test("stores monitor camelCase fields in canonical snake_case columns", async () => {
        await store.exec("INSERT INTO user (id, username, password, active) VALUES (?, ?, ?, ?)", [
            1,
            "smoke",
            "hash",
            1,
        ]);

        const model = store.createModel("monitor");
        model.import({
            active: true,
            accepted_statuscodes_json: '["200-299"]',
            domainExpiryNotification: false,
            expiryNotification: false,
            ignoreTls: false,
            interval: 60,
            invertKeyword: false,
            ipFamily: "ipv4",
            maxretries: 0,
            name: "Store mapping",
            proxyId: null,
            pushToken: "push-token",
            resendInterval: 0,
            responseMaxLength: 1024,
            retryInterval: 20,
            saveErrorResponse: true,
            saveResponse: false,
            type: "http",
            upsideDown: false,
            url: "http://127.0.0.1",
            user_id: 1,
            weight: 2000,
            wsSubprotocol: "chat",
        });

        const id = await store.saveModel(model);
        const columns = await store.getCol("SELECT name FROM pragma_table_info('monitor')");

        expect(columns.includes("ignoreTls")).toBe(false);
        expect(columns.includes("expiryNotification")).toBe(false);
        expect(columns.includes("domainExpiryNotification")).toBe(false);
        expect(columns.includes("proxyId")).toBe(false);
        expect(columns.includes("pushToken")).toBe(false);
        expect(columns.includes("responseMaxLength")).toBe(false);
        expect(columns.includes("retryInterval")).toBe(false);
        expect(columns.includes("saveResponse")).toBe(false);
        expect(columns.includes("wsSubprotocol")).toBe(false);
        expect(columns.includes("ipFamily")).toBe(false);

        const row = await store.getRow(
            "SELECT ignore_tls, expiry_notification, domain_expiry_notification, retry_interval, save_response, save_error_response, response_max_length, push_token, ws_subprotocol, ip_family FROM monitor WHERE id = ?",
            [id]
        );
        expect(Number(row.ignore_tls)).toBe(0);
        expect(Number(row.expiry_notification)).toBe(0);
        expect(Number(row.domain_expiry_notification)).toBe(0);
        expect(Number(row.retry_interval)).toBe(20);
        expect(Number(row.save_response)).toBe(0);
        expect(Number(row.save_error_response)).toBe(1);
        expect(Number(row.response_max_length)).toBe(1024);
        expect(row.push_token).toBe("push-token");
        expect(row.ws_subprotocol).toBe("chat");
        expect(row.ip_family).toBe("ipv4");

        const loaded = await store.load("monitor", id);
        expect(loaded.getIgnoreTls()).toBe(false);
        expect(loaded.isEnabledExpiryNotification()).toBe(false);
        expect(loaded.domainExpiryNotification).toBe(false);
        expect(loaded.retryInterval).toBe(20);
        expect(loaded.responseMaxLength).toBe(1024);
        expect(loaded.pushToken).toBe("push-token");
        expect(loaded.wsSubprotocol).toBe("chat");
        expect(loaded.ipFamily).toBe("ipv4");
    });

    test("prefers canonical monitor columns over legacy stray camelCase columns", async () => {
        await store.exec('ALTER TABLE monitor ADD COLUMN "ignoreTls" TEXT');
        await store.exec(
            'INSERT INTO monitor (name, type, url, interval, retry_interval, ignore_tls, "ignoreTls", accepted_statuscodes_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            ["Legacy mapping", "http", "http://127.0.0.1", 60, 20, 0, "1", '["200-299"]']
        );

        const loaded = await store.findOne("monitor", " name = ? ", ["Legacy mapping"]);

        expect(loaded.ignore_tls).toBe(false);
        expect(loaded.ignoreTls).toBe(false);
        expect(loaded.getIgnoreTls()).toBe(false);
    });

    test("monitor CRUD round-trip preserves socket API field names", async () => {
        await store.exec("INSERT INTO user (id, username, password, active) VALUES (?, ?, ?, ?)", [
            1,
            "smoke",
            "hash",
            1,
        ]);

        const createPayload = {
            active: true,
            accepted_statuscodes_json: '["200-299"]',
            domainExpiryNotification: true,
            expiryNotification: false,
            ignoreTls: true,
            interval: 45,
            invertKeyword: true,
            ipFamily: "dual-stack",
            maxretries: 2,
            name: "Round-trip monitor",
            proxyId: null,
            pushToken: "round-trip-token",
            resendInterval: 30,
            responseMaxLength: 2048,
            retryInterval: 15,
            retryOnlyOnStatusCodeFailure: true,
            saveErrorResponse: false,
            saveResponse: true,
            type: "http",
            upsideDown: true,
            url: "http://127.0.0.1:8080",
            user_id: 1,
            weight: 1500,
            wsSubprotocol: "graphql-ws",
        };

        const model = store.createModel("monitor");
        model.import(createPayload);
        const id = await store.saveModel(model);

        const created = await store.load("monitor", id);
        expect(created.getIgnoreTls()).toBe(true);
        expect(created.isInvertKeyword()).toBe(true);
        expect(created.domainExpiryNotification).toBe(true);
        expect(created.isEnabledExpiryNotification()).toBe(false);
        expect(created.retryInterval).toBe(15);
        expect(created.retry_only_on_status_code_failure).toBe(true);
        expect(created.responseMaxLength).toBe(2048);
        expect(created.getSaveResponse()).toBe(true);
        expect(created.getSaveErrorResponse()).toBe(false);
        expect(created.pushToken).toBe("round-trip-token");
        expect(created.wsSubprotocol).toBe("graphql-ws");
        expect(created.ipFamily).toBe("dual-stack");
        expect(created.isUpsideDown()).toBe(true);

        created.import({
            name: "Updated round-trip monitor",
            ignoreTls: false,
            pushToken: "updated-token",
            wsSubprotocol: "json",
        });
        await store.saveModel(created);

        const updated = await store.load("monitor", id);
        expect(updated.name).toBe("Updated round-trip monitor");
        expect(updated.getIgnoreTls()).toBe(false);
        expect(updated.pushToken).toBe("updated-token");
        expect(updated.retryInterval).toBe(15);
        expect(updated.wsSubprotocol).toBe("json");
        expect(updated.retry_only_on_status_code_failure).toBe(true);
        expect(updated.responseMaxLength).toBe(2048);
    });
});
