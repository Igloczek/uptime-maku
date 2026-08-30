// @ts-nocheck

import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Database as BunDatabase } from "bun:sqlite";
import {
    expectedIndexes,
    expectedTableColumns,
    expectedTables,
} from "@/db/schema/expected-schema";
import { applySqlFile } from "@/db/schema/sql-utils";
import { SCHEMA_VERSION_KEY } from "@/server/db-migrations";

const projectRoot = path.join(import.meta.dirname, "../..");
const kumaDbPath = path.join(projectRoot, "out/kuma.db");
const currentSqlPath = path.join(projectRoot, "src/db/schema/current.sql");

function getTables(db) {
    return db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map((row) => row.name);
}

function getColumns(db, table) {
    return db.query(`PRAGMA table_info("${table}")`).all().map((row) => row.name);
}

function getIndexes(db) {
    return db
        .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map((row) => row.name);
}

function assertExactSchemaContract(db) {
    const tables = getTables(db);
    expect(tables).toEqual(expectedTables);

    for (const [table, expectedColumns] of Object.entries(expectedTableColumns)) {
        expect(getColumns(db, table)).toEqual(expectedColumns);
    }

    const indexes = getIndexes(db);
    for (const indexName of expectedIndexes) {
        expect(indexes.includes(indexName)).toBe(true);
    }
}

describe("Database schema contract", () => {
    test("current.sql produces the canonical schema contract", () => {
        const sql = fs.readFileSync(currentSqlPath, "utf8");
        const db = new BunDatabase(":memory:", { create: true, strict: true });
        try {
            applySqlFile(db, sql);
            assertExactSchemaContract(db);
        } finally {
            db.close();
        }
    });

    test("generated kuma.db matches current.sql contract", () => {
        expect(fs.existsSync(kumaDbPath)).toBe(true);

        const db = new BunDatabase(kumaDbPath, { readonly: true });
        try {
            assertExactSchemaContract(db);

            const schemaVersion = db
                .query('SELECT value FROM setting WHERE "key" = ?')
                .get(SCHEMA_VERSION_KEY)?.value;
            expect(schemaVersion).toBe("1");
        } finally {
            db.close();
        }
    });
});
