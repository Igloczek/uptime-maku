import {
    upgrade001UpstreamBaselineData,
    upgrade001UpstreamBaselineSchema,
} from "../db/schema/upgrades/001-upstream-baseline.js";
import {
    upgrade002ResendIntervalMinutesData,
    upgrade002ResendIntervalMinutesSchema,
} from "@/db/schema/upgrades/002-resend-interval-minutes";
import {
    upgrade003NotificationResendIntervalData,
    upgrade003NotificationResendIntervalSchema,
} from "@/db/schema/upgrades/003-notification-resend-interval";
import { upgrade004RemoveMonitorResendStateSchema } from "@/db/schema/upgrades/004-remove-monitor-resend-state";
import { log } from "@/server/logger";

export {
    addColumnIfMissing,
    columnExists,
    createIndexIfMissing,
    indexExists,
    tableExists,
} from "../db/schema/migration-helpers.js";

// Persisted by the first rewrite migration series. Keep the value for existing databases.
export const SCHEMA_VERSION_KEY = "buna_schema_version";
export const LATEST_SCHEMA_VERSION = 4;

export interface SQLiteTransaction {
    exec(sql: string, params?: unknown[]): Promise<unknown>;
    getAll(sql: string, params?: unknown[]): Promise<unknown[]>;
    getRow(sql: string, params?: unknown[]): Promise<unknown>;
    getCell(sql: string, params?: unknown[]): Promise<unknown>;
    hasTable(table: string): Promise<boolean>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
}

export interface SQLiteStore {
    exec(sql: string, params?: unknown[]): Promise<unknown>;
    getAll(sql: string, params?: unknown[]): Promise<unknown[]>;
    getRow(sql: string, params?: unknown[]): Promise<unknown>;
    getCell(sql: string, params?: unknown[]): Promise<unknown>;
    find(table: string, condition?: string, params?: unknown[]): Promise<unknown[]>;
    findOne(table: string, condition?: string, params?: unknown[]): Promise<unknown>;
    hasTable(table: string): Promise<boolean>;
    begin(): Promise<SQLiteTransaction>;
    connect(options: { sqlitePath: string; templatePath: string; testMode?: boolean }): Promise<void>;
    close(): Promise<void>;
    isOpen(): boolean;
}

/**
 * Upgrade recovery notes:
 * - SQLite implicitly commits DDL (CREATE/ALTER/CREATE INDEX) even inside BEGIN.
 * - Schema-phase changes from 001 may persist if the data-phase transaction fails.
 * - DML (GameDig rewrites, LINE Notify deletes, etc.) rolls back with the data transaction.
 * - SCHEMA_VERSION_KEY is only bumped after the data phase succeeds.
 * - On failure: restart to retry; schema steps are idempotent, data migrations re-run.
 * - For severely broken DBs: restore from backup or replace with a fresh out/kuma.db.
 */

interface SchemaUpgrade {
    version: number;
    name: string;
    runSchema?: (migration: SchemaMigration) => Promise<void>;
    runData?: (store: SQLiteTransaction) => Promise<void>;
}

export interface SchemaMigration {
    exec(sql: string, params?: unknown[]): unknown;
    hasTable(table: string): boolean;
    hasColumn(table: string, column: string): boolean;
    addColumnIfMissing(table: string, column: string, type?: string): boolean;
    createIndexIfMissing(sql: string, indexName: string): boolean;
}

const upgrades: SchemaUpgrade[] = [
    {
        version: 1,
        name: "001-upstream-baseline",
        runSchema: upgrade001UpstreamBaselineSchema,
        runData: upgrade001UpstreamBaselineData,
    },
    {
        version: 2,
        name: "002-resend-interval-minutes",
        runSchema: upgrade002ResendIntervalMinutesSchema,
        runData: upgrade002ResendIntervalMinutesData,
    },
    {
        version: 3,
        name: "003-notification-resend-interval",
        runSchema: upgrade003NotificationResendIntervalSchema,
        runData: upgrade003NotificationResendIntervalData,
    },
    {
        version: 4,
        name: "004-remove-monitor-resend-state",
        runSchema: upgrade004RemoveMonitorResendStateSchema,
    },
];

export async function getSchemaVersion(store: Pick<SQLiteStore, "hasTable" | "getCell">) {
    if (!(await store.hasTable("setting"))) {
        return null;
    }

    const value = await store.getCell('SELECT value FROM setting WHERE "key" = ?', [SCHEMA_VERSION_KEY]);
    if (value === null || value === undefined || value === "") {
        return null;
    }

    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : null;
}

export async function setSchemaVersion(store: Pick<SQLiteTransaction, "getRow" | "exec">, version: number) {
    const existing = await store.getRow('SELECT id FROM setting WHERE "key" = ?', [SCHEMA_VERSION_KEY]);
    if (existing) {
        await store.exec('UPDATE setting SET value = ? WHERE "key" = ?', [String(version), SCHEMA_VERSION_KEY]);
        return;
    }

    await store.exec('INSERT INTO setting ("key", value) VALUES (?, ?)', [SCHEMA_VERSION_KEY, String(version)]);
}

export async function resolveCurrentSchemaVersion(store: Pick<SQLiteStore, "hasTable" | "getCell">) {
    const explicitVersion = await getSchemaVersion(store);
    if (explicitVersion !== null) {
        return explicitVersion;
    }

    log.info("db", `No ${SCHEMA_VERSION_KEY} found; treating database as upstream Uptime Kuma 2.x baseline`);
    return 0;
}

export async function runPendingUpgrades(
    store: Pick<SQLiteStore, "hasTable" | "getCell" | "begin">,
    migration: SchemaMigration
) {
    let currentVersion = await resolveCurrentSchemaVersion(store);

    for (const upgrade of upgrades) {
        if (currentVersion >= upgrade.version) {
            continue;
        }

        log.info("db", `Running schema upgrade ${upgrade.name} (v${upgrade.version})`);

        if (upgrade.runSchema) {
            log.debug("db", `Applying schema phase for ${upgrade.name} (DDL auto-commits in SQLite)`);
            await upgrade.runSchema(migration);
        }

        const transaction: any = await store.begin();
        try {
            if (upgrade.runData) {
                await upgrade.runData(transaction);
            }
            await setSchemaVersion(transaction, upgrade.version);
            await transaction.commit();
            currentVersion = upgrade.version;
            log.info("db", `Schema upgrade ${upgrade.name} completed`);
        } catch (error) {
            await transaction.rollback();
            log.error(
                "db",
                `Schema upgrade ${upgrade.name} data phase failed; DML rolled back (DDL changes from schema phase may persist)`
            );
            throw error;
        }
    }
}
