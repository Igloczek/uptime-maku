// @ts-nocheck

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database as BunDatabase } from "bun:sqlite";
import { applySqlFile } from "@/db/schema/sql-utils";
import { BunSQLiteRedbean } from "@/server/sqlite-core";
import { LATEST_SCHEMA_VERSION, SCHEMA_VERSION_KEY, getSchemaVersion } from "@/server/db-migrations";

const projectRoot = path.join(import.meta.dirname, "../..");
const baselineFixturePath = path.join(import.meta.dirname, "fixtures/upstream-kuma-baseline.sql");
const knexEndstateFixturePath = path.join(import.meta.dirname, "fixtures/upstream-kuma-knex-endstate.sql");
const templatePath = path.join(projectRoot, "out/kuma.db");
const smtpConfig =
    '{"type":"smtp","smtpHost":"mail.example.invalid","smtpPort":2525,"smtpSecure":false,"smtpFrom":"sender@example.invalid","smtpTo":"recipient@example.invalid"}';

function loadSqlFixture(dbPath, sql) {
    if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
    }

    const db = new BunDatabase(dbPath, { create: true, strict: true });
    try {
        applySqlFile(db, sql);
    } finally {
        db.close();
    }
}

function readSettingValue(dbPath, key) {
    const db = new BunDatabase(dbPath, { readonly: true });
    try {
        return db.query('SELECT value FROM setting WHERE "key" = ?').get(key)?.value;
    } finally {
        db.close();
    }
}

function readUserCount(dbPath) {
    const db = new BunDatabase(dbPath, { readonly: true });
    try {
        return db.query("SELECT COUNT(*) AS count FROM user").get().count;
    } finally {
        db.close();
    }
}

describe("Upstream Kuma upgrade", () => {
    let dir;
    let store;

    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "uptime-maku-upgrade-"));
        const dbPath = path.join(dir, "kuma.db");
        const sql = fs.readFileSync(baselineFixturePath, "utf8");
        loadSqlFixture(dbPath, sql);

        store = new BunSQLiteRedbean();
        await store.connect({
            sqlitePath: dbPath,
            templatePath: dbPath,
            testMode: true,
        });
    });

    afterEach(async () => {
        await store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test("001-upstream-baseline migrates upstream Kuma data and sets schema version", async () => {
        expect(await getSchemaVersion(store)).toBe(LATEST_SCHEMA_VERSION);

        const schemaVersion = await store.getCell('SELECT value FROM setting WHERE "key" = ?', [SCHEMA_VERSION_KEY]);
        expect(schemaVersion).toBe(String(LATEST_SCHEMA_VERSION));

        const gamedigGame = await store.getCell("SELECT game FROM monitor WHERE name = ?", ["GameDig TF2"]);
        expect(gamedigGame).toBe("teamfortress2");

        const snmpOperator = await store.getCell("SELECT json_path_operator FROM monitor WHERE name = ?", [
            "SNMP monitor",
        ]);
        expect(snmpOperator).toBe("==");

        const analyticsId = await store.getCell("SELECT analytics_id FROM status_page WHERE slug = ?", ["default"]);
        expect(analyticsId).toBe("G-LEGACY");

        const analyticsType = await store.getCell("SELECT analytics_type FROM status_page WHERE slug = ?", ["default"]);
        expect(analyticsType).toBe("google");

        const refreshInterval = await store.getCell("SELECT auto_refresh_interval FROM status_page WHERE slug = ?", [
            "default",
        ]);
        expect(refreshInterval).toBe(120);

        expect(
            await store.getAll("SELECT id, name, active, user_id, is_default, config FROM notification ORDER BY id")
        ).toEqual([
            {
                id: 4,
                name: "Existing SMTP",
                active: 1,
                user_id: null,
                is_default: 0,
                config: smtpConfig,
            },
        ]);
        expect(
            await store.getAll(
                `SELECT id, monitor_id, notification_id
                 FROM monitor_notification
                 ORDER BY id`
            )
        ).toEqual([{ id: 4, monitor_id: 1, notification_id: 4 }]);

        const domainExpiryDisabled = await store.getCell(
            "SELECT domain_expiry_notification FROM monitor WHERE name = ?",
            ["GameDig TF2"]
        );
        expect(Number(domainExpiryDisabled)).toBe(0);

        const parsedDomainExpiryDisabled = await store.getCell(
            "SELECT domain_expiry_notification FROM monitor WHERE name = ?",
            ["Unsupported domain expiry"]
        );
        expect(Number(parsedDomainExpiryDisabled)).toBe(0);
    });
});

describe("Resend interval migration", () => {
    let dir;
    let store;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "uptime-maku-resend-migration-"));
        const dbPath = path.join(dir, "kuma.db");
        loadSqlFixture(dbPath, fs.readFileSync(baselineFixturePath, "utf8"));

        const db = new BunDatabase(dbPath, { create: true, strict: true });
        try {
            db.run("ALTER TABLE monitor ADD COLUMN resend_interval INTEGER NOT NULL DEFAULT 0");
            db.run("UPDATE monitor SET interval = 20, resend_interval = 31 WHERE id = 1");
            db.run('INSERT INTO setting ("key", value) VALUES (?, ?)', [SCHEMA_VERSION_KEY, "1"]);
        } finally {
            db.close();
        }
    });

    afterEach(async () => {
        if (store) {
            await store.close();
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test("converts legacy check counts to whole minutes exactly once", async () => {
        const dbPath = path.join(dir, "kuma.db");
        store = new BunSQLiteRedbean();
        await store.connect({
            sqlitePath: dbPath,
            templatePath: dbPath,
            testMode: true,
        });

        expect(await getSchemaVersion(store)).toBe(LATEST_SCHEMA_VERSION);
        expect(await store.getCell("SELECT resend_interval FROM monitor WHERE id = 1")).toBe(11);
        expect(await store.getCell("SELECT last_notification_at FROM monitor WHERE id = 1")).toBeNull();
        expect(await store.getCell('SELECT value FROM setting WHERE "key" = ?', ["resend_interval_unit"])).toBe(
            "minutes"
        );
    });

    test("preserves the configured push cadence and the latest legacy resend reset", async () => {
        const dbPath = path.join(dir, "kuma.db");
        const db = new BunDatabase(dbPath, { create: true, strict: true });
        try {
            db.run("UPDATE monitor SET type = 'push', interval = 300, resend_interval = 6 WHERE id = 1");
            db.run(`CREATE TABLE heartbeat (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                monitor_id INTEGER NOT NULL,
                status INTEGER NOT NULL,
                time DATETIME NOT NULL,
                important BOOLEAN NOT NULL DEFAULT 0,
                down_count INTEGER NOT NULL DEFAULT 0
            )`);
            db.run("INSERT INTO heartbeat (monitor_id, status, time, important, down_count) VALUES (1, 0, ?, 1, 0)", [
                "2026-08-07 12:00:00.000",
            ]);
            db.run("INSERT INTO heartbeat (monitor_id, status, time, important, down_count) VALUES (1, 0, ?, 0, 1)", [
                "2026-08-07 12:00:10.000",
            ]);
            db.run("INSERT INTO heartbeat (monitor_id, status, time, important, down_count) VALUES (1, 0, ?, 0, 0)", [
                "2026-08-07 12:00:20.000",
            ]);
        } finally {
            db.close();
        }

        store = new BunSQLiteRedbean();
        await store.connect({
            sqlitePath: dbPath,
            templatePath: dbPath,
            testMode: true,
        });

        expect(await store.getCell("SELECT resend_interval FROM monitor WHERE id = 1")).toBe(30);
        expect(await store.getCell("SELECT last_notification_at FROM monitor WHERE id = 1")).toBe(
            "2026-08-07 12:00:20.000"
        );
        expect(await store.getCell("SELECT last_notification_attempt_at FROM monitor WHERE id = 1")).toBe(
            "2026-08-07 12:00:20.000"
        );
    });
});

describe("Upstream Kuma Knex end-state", () => {
    let dir;
    let store;

    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "uptime-maku-knex-endstate-"));
        const dbPath = path.join(dir, "kuma.db");
        const sql = fs.readFileSync(knexEndstateFixturePath, "utf8");
        loadSqlFixture(dbPath, sql);

        expect(readSettingValue(dbPath, SCHEMA_VERSION_KEY)).toBeUndefined();

        store = new BunSQLiteRedbean();
        await store.connect({
            sqlitePath: dbPath,
            templatePath: dbPath,
            testMode: true,
        });
    });

    afterEach(async () => {
        await store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test("001-upstream-baseline runs when marker columns exist but the schema-version setting is absent", async () => {
        expect(await getSchemaVersion(store)).toBe(LATEST_SCHEMA_VERSION);

        const gamedigGame = await store.getCell("SELECT game FROM monitor WHERE name = ?", ["GameDig TF2"]);
        expect(gamedigGame).toBe("teamfortress2");

        const snmpOperator = await store.getCell("SELECT json_path_operator FROM monitor WHERE name = ?", [
            "SNMP monitor",
        ]);
        expect(snmpOperator).toBe("==");

        expect(await store.count("notification")).toBe(0);
        expect(await store.count("monitor_notification")).toBe(0);

        const domainExpiryDisabled = await store.getCell(
            "SELECT domain_expiry_notification FROM monitor WHERE name = ?",
            ["GameDig TF2"]
        );
        expect(Number(domainExpiryDisabled)).toBe(0);
    });
});

describe("Fresh Uptime Maku template", () => {
    let dir;
    let store;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "uptime-maku-fresh-"));
    });

    afterEach(async () => {
        if (store) {
            await store.close();
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test("pre-seeded template skips upgrade and does not mutate schema version", async () => {
        const dbPath = path.join(dir, "kuma.db");
        fs.copyFileSync(templatePath, dbPath);

        const beforeVersion = readSettingValue(dbPath, SCHEMA_VERSION_KEY);
        expect(beforeVersion).toBe(String(LATEST_SCHEMA_VERSION));

        const beforeUserCount = readUserCount(dbPath);

        store = new BunSQLiteRedbean();
        await store.connect({
            sqlitePath: dbPath,
            templatePath: dbPath,
            testMode: true,
        });

        expect(await getSchemaVersion(store)).toBe(LATEST_SCHEMA_VERSION);
        expect(await store.count("user")).toBe(beforeUserCount);
        expect(await store.count("notification")).toBe(0);
    });
});

describe("Upgrade transaction recovery", () => {
    test("rolls back when the first data-phase statement fails and remains usable", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uptime-maku-upgrade-first-error-"));
        const dbPath = path.join(dir, "kuma.db");
        loadSqlFixture(dbPath, fs.readFileSync(baselineFixturePath, "utf8"));
        let insideTransaction = false;
        let failFirstDataStatement = true;
        const store = new BunSQLiteRedbean({
            databaseFactory(sqlitePath, options) {
                const db = new BunDatabase(sqlitePath, options);
                return {
                    query(sql) {
                        const statement = db.query(sql);
                        return new Proxy(statement, {
                            get(target, property) {
                                if (property === "run") {
                                    return (...params) => {
                                        if (
                                            insideTransaction &&
                                            failFirstDataStatement &&
                                            /^\s*UPDATE status_page SET analytics_type/.test(sql)
                                        ) {
                                            failFirstDataStatement = false;
                                            throw new Error("forced first upgrade data statement failure");
                                        }
                                        return target.run(...params);
                                    };
                                }
                                const value = Reflect.get(target, property, target);
                                return typeof value === "function" ? value.bind(target) : value;
                            },
                        });
                    },
                    run(sql, ...params) {
                        const result = db.run(sql, ...params);
                        if (sql === "BEGIN") {
                            insideTransaction = true;
                        } else if (sql === "COMMIT" || sql === "ROLLBACK") {
                            insideTransaction = false;
                        }
                        return result;
                    },
                    close: db.close.bind(db),
                };
            },
        });

        try {
            await expect(
                store.connect({
                    sqlitePath: dbPath,
                    templatePath: dbPath,
                    testMode: true,
                })
            ).rejects.toThrow("forced first upgrade data statement failure");
            expect(store.isOpen()).toBe(true);
            await expect(store.getCell("SELECT 1")).resolves.toBe(1);
            const transaction = await store.begin();
            await expect(transaction.rollback()).resolves.toBeUndefined();
            expect(await getSchemaVersion(store)).toBeNull();
        } finally {
            await store.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
