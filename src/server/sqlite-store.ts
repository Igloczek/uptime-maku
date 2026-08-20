// @ts-nocheck
"use strict";

import fs from "fs";
import SQLiteModel from "@/server/sqlite-model";
import { Database as BunDatabase } from "bun:sqlite";
import dayjs from "dayjs";
import { filterStoreRow } from "@/db/schema/column-metadata";
import { hydrateModelFromRow, normalizeRowForStore } from "@/server/sqlite-model-hydration";
import {
    addColumnIfMissing as addSchemaColumnIfMissing,
    columnExists as schemaColumnExists,
    createIndexIfMissing as createSchemaIndexIfMissing,
    runPendingUpgrades,
    tableExists as schemaTableExists,
} from "@/server/db-migrations";

function normalizeSql(sql) {
    return sql.replace(/`/g, '"');
}

function conditionSql(condition) {
    const trimmed = condition.trim();
    if (!trimmed) {
        return "";
    }
    if (/^(where|order by|group by|limit)\b/i.test(trimmed)) {
        return condition;
    }
    return ` WHERE ${condition}`;
}

class SQLiteStore {
    #db = null;
    #databaseFactory;
    #modelMapping;
    #modelTables = new WeakMap();
    #poisonError = null;
    sqlitePath = null;
    dbConfig = { type: "sqlite" };
    #transactionOwner = null;
    #transactionQueue = [];
    #processingQueue = false;

    constructor({
        modelMapping,
        databaseFactory = (sqlitePath, options) => new BunDatabase(sqlitePath, options),
    } = {}) {
        if (!modelMapping || typeof modelMapping !== "object") {
            throw new TypeError("SQLiteStore requires an explicit model mapping");
        }
        this.#databaseFactory = databaseFactory;
        this.#modelMapping = Object.freeze({ ...modelMapping });
    }

    isOpen() {
        return this.#db !== null;
    }

    #database() {
        if (this.#poisonError) {
            throw this.#poisonError;
        }
        if (!this.#db) {
            throw new Error("SQLite database is closed");
        }
        return this.#db;
    }

    async connect({ sqlitePath, templatePath, testMode = false }) {
        if (this.#poisonError) {
            throw this.#poisonError;
        }
        this.sqlitePath = sqlitePath;
        this.dbConfig = { type: "sqlite" };
        if (!fs.existsSync(sqlitePath)) {
            // Bun compiled binaries expose embedded files under `/$bunfs/...`.
            // `fs.copyFileSync` fails there with ENOENT; read+write works.
            fs.writeFileSync(sqlitePath, fs.readFileSync(templatePath));
        }

        this.#db = this.#databaseFactory(sqlitePath, { create: true, strict: true });
        const db = this.#database();
        db.run(testMode ? "PRAGMA journal_mode = MEMORY" : "PRAGMA journal_mode = WAL");
        db.run("PRAGMA foreign_keys = ON");
        db.run("PRAGMA cache_size = -12000");
        db.run("PRAGMA auto_vacuum = INCREMENTAL");
        db.run("PRAGMA busy_timeout = 5000");
        db.run("PRAGMA synchronous = NORMAL");
        const migration = this.#createSchemaMigrationHandle();
        try {
            await runPendingUpgrades(this, migration.handle);
        } finally {
            migration.finish();
        }
    }

    #createSchemaMigrationHandle() {
        let active = true;
        const run = (operation) => {
            if (!active) {
                throw new Error("Schema migration has finished");
            }
            return operation(this.#database());
        };
        return {
            handle: {
                exec: (sql, params = []) => run((db) => db.query(normalizeSql(sql)).run(...params)),
                hasTable: (table) => run((db) => schemaTableExists(db, table)),
                hasColumn: (table, column) => run((db) => schemaColumnExists(db, table, column)),
                addColumnIfMissing: (table, column, type) =>
                    run((db) => addSchemaColumnIfMissing(db, table, column, type)),
                createIndexIfMissing: (sql, indexName) => run((db) => createSchemaIndexIfMissing(db, sql, indexName)),
            },
            finish: () => {
                active = false;
            },
        };
    }

    async close() {
        if (!this.#db) {
            return;
        }
        try {
            return await this.#runDatabaseOperation(null, () => {
                const db = this.#db;
                this.#db = null;
                db?.close();
            });
        } catch (error) {
            if (error !== this.#poisonError) {
                throw error;
            }
        }
    }

    #modelForTable(table, row = {}) {
        const Model = this.#modelMapping[table] || SQLiteModel;
        const model = hydrateModelFromRow(Model, table, row);
        this.#modelTables.set(model, table);
        return model;
    }

    createModel(table) {
        return this.#modelForTable(table);
    }

    hydrateModel(table, row = {}) {
        return this.#modelForTable(table, row);
    }

    hydrateModels(table, rows = []) {
        return rows.map((row) => this.#modelForTable(table, row));
    }

    #tableForModel(model, operation) {
        const table = this.#modelTables.get(model);
        if (!table) {
            throw new Error(`Cannot ${operation} model that is not owned by this SQLite store`);
        }
        return table;
    }

    #saveModel(model) {
        const table = this.#tableForModel(model, "save");

        let row = {};
        for (const [key, value] of Object.entries(model)) {
            if (key === "id" || key.startsWith("_") || typeof value === "function") {
                continue;
            }
            row[key] = value;
        }
        row = normalizeRowForStore(table, row);
        row = filterStoreRow(table, row);

        const columns = Object.keys(row);
        if (model.id) {
            if (columns.length > 0) {
                const assignments = columns.map((column) => `"${column}" = ?`).join(", ");
                this.#exec(`UPDATE "${table}" SET ${assignments} WHERE id = ?`, [
                    ...columns.map((column) => row[column]),
                    model.id,
                ]);
            }
            return model.id;
        }

        if (columns.length === 0) {
            const result = this.#database().query(`INSERT INTO "${table}" DEFAULT VALUES`).run();
            model.id = Number(result.lastInsertRowid);
            return model.id;
        }

        const placeholders = columns.map(() => "?").join(", ");
        const result = this.#database()
            .query(
                `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${placeholders})`
            )
            .run(...columns.map((column) => row[column]));
        model.id = Number(result.lastInsertRowid);
        return model.id;
    }

    async saveModel(model) {
        return this.#runDatabaseOperation(null, () => this.#saveModel(model));
    }

    #deleteModel(model) {
        const table = this.#tableForModel(model, "delete");
        if (model.id) {
            this.#exec(`DELETE FROM "${table}" WHERE id = ?`, [model.id]);
            model.id = 0;
        }
    }

    async deleteModel(model) {
        return this.#runDatabaseOperation(null, () => this.#deleteModel(model));
    }

    #exec(sql, params = []) {
        this.#database()
            .query(normalizeSql(sql))
            .run(...params);
    }

    #getAll(sql, params = []) {
        try {
            return this.#database()
                .query(normalizeSql(sql))
                .all(...params);
        } catch (error) {
            if (String(error.message).includes("no such table")) {
                return [];
            }
            throw error;
        }
    }

    #getRow(sql, params = []) {
        try {
            return (
                this.#database()
                    .query(normalizeSql(sql))
                    .get(...params) || null
            );
        } catch (error) {
            if (String(error.message).includes("no such table")) {
                return null;
            }
            throw error;
        }
    }

    #getCell(sql, params = []) {
        const row = this.#getRow(sql, params);
        if (!row) {
            return null;
        }
        return row[Object.keys(row)[0]];
    }

    #getCol(sql, params = []) {
        const rows = this.#getAll(sql, params);
        return rows.map((row) => row[Object.keys(row)[0]]);
    }

    #getAssoc(sql, params = []) {
        const rows = this.#getAll(sql, params);
        const result = {};
        for (const row of rows) {
            const keys = Object.keys(row);
            result[row[keys[0]]] = row[keys[1]];
        }
        return result;
    }

    #find(table, condition = "", params = []) {
        const rows = this.#getAll(`SELECT * FROM "${table}" ${conditionSql(condition)}`, params);
        return rows.map((row) => this.#modelForTable(table, row));
    }

    #findOne(table, condition = "", params = []) {
        const row = this.#getRow(`SELECT * FROM "${table}" ${conditionSql(condition)} LIMIT 1`, params);
        return row ? this.#modelForTable(table, row) : null;
    }

    async exec(sql, params = []) {
        return this.#runDatabaseOperation(null, () => this.#exec(sql, params));
    }

    async getAll(sql, params = []) {
        return this.#runDatabaseOperation(null, () => this.#getAll(sql, params));
    }

    async getRow(sql, params = []) {
        return this.#runDatabaseOperation(null, () => this.#getRow(sql, params));
    }

    async getCell(sql, params = []) {
        return this.#runDatabaseOperation(null, () => this.#getCell(sql, params));
    }

    async getCol(sql, params = []) {
        return this.#runDatabaseOperation(null, () => this.#getCol(sql, params));
    }

    async getAssoc(sql, params = []) {
        return this.#runDatabaseOperation(null, () => this.#getAssoc(sql, params));
    }

    async find(table, condition = "", params = []) {
        return this.#runDatabaseOperation(null, () => this.#find(table, condition, params));
    }

    async findAll(table, condition = "", params = []) {
        return this.#runDatabaseOperation(null, () => this.#find(table, condition, params));
    }

    async findOne(table, condition = "", params = []) {
        return this.#runDatabaseOperation(null, () => this.#findOne(table, condition, params));
    }

    async load(table, id) {
        return this.#runDatabaseOperation(null, () => this.#findOne(table, " id = ? ", [id]));
    }

    async count(table, condition = "", params = []) {
        return this.#runDatabaseOperation(null, () =>
            Number(this.#getCell(`SELECT COUNT(*) FROM "${table}"${conditionSql(condition)}`, params))
        );
    }

    async hasTable(table) {
        return this.#runDatabaseOperation(
            null,
            () => !!this.#getCell("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table])
        );
    }

    #runDatabaseOperation(owner, operation) {
        if (this.#poisonError) {
            throw this.#poisonError;
        }
        if (owner !== null) {
            if (owner !== this.#transactionOwner) {
                throw new Error("Transaction has finished");
            }
            return operation();
        }

        if (!this.#transactionOwner && !this.#processingQueue && this.#transactionQueue.length === 0) {
            return operation();
        }

        return new Promise((resolve, reject) => {
            this.#transactionQueue.push({ type: "operation", operation, resolve, reject });
            this.#drainTransactionQueue();
        });
    }

    #drainTransactionQueue() {
        if (this.#poisonError) {
            this.#rejectTransactionQueue(this.#poisonError);
            return;
        }
        if (this.#transactionOwner || this.#processingQueue) {
            return;
        }

        const item = this.#transactionQueue.shift();
        if (!item) {
            return;
        }

        if (item.type === "transaction") {
            const owner = Symbol("sqlite-transaction");
            this.#transactionOwner = owner;
            try {
                this.#database().run("BEGIN");
                item.resolve(this.#createTransaction(owner));
            } catch (error) {
                this.#transactionOwner = null;
                item.reject(error);
                this.#drainTransactionQueue();
            }
            return;
        }

        this.#processingQueue = true;
        Promise.resolve()
            .then(item.operation)
            .then(item.resolve, item.reject)
            .finally(() => {
                this.#processingQueue = false;
                this.#drainTransactionQueue();
            });
    }

    #rejectTransactionQueue(error) {
        for (const item of this.#transactionQueue.splice(0)) {
            item.reject(error);
        }
    }

    #quarantine(error) {
        const db = this.#db;
        this.#db = null;
        this.#transactionOwner = null;
        let cause = error;
        try {
            db?.close();
        } catch (closeError) {
            cause = new AggregateError([error, closeError], "SQLite transaction and connection close failed");
        }
        this.#poisonError = new Error("SQLite store is quarantined after transaction rollback failure", { cause });
        this.#rejectTransactionQueue(this.#poisonError);
    }

    #createTransaction(owner) {
        let finished = false;
        const run = (operation) => {
            if (finished) {
                throw new Error("Transaction has finished");
            }
            return this.#runDatabaseOperation(owner, operation);
        };
        const finish = async (command) => {
            if (finished) {
                return;
            }
            if (owner !== this.#transactionOwner) {
                throw new Error("Transaction has finished");
            }
            const release = () => {
                if (owner === this.#transactionOwner) {
                    this.#transactionOwner = null;
                    this.#drainTransactionQueue();
                }
            };
            try {
                this.#database().run(command);
                finished = true;
            } catch (primaryError) {
                if (command === "COMMIT") {
                    try {
                        this.#database().run("ROLLBACK");
                        finished = true;
                    } catch (rollbackError) {
                        finished = true;
                        const error = new AggregateError(
                            [primaryError, rollbackError],
                            "SQLite COMMIT and ROLLBACK failed"
                        );
                        this.#quarantine(error);
                        throw error;
                    }
                    release();
                } else {
                    finished = true;
                    this.#quarantine(primaryError);
                }
                throw primaryError;
            }
            release();
        };
        return {
            exec: async (sql, params = []) => run(() => this.#exec(sql, params)),
            getAll: async (sql, params = []) => run(() => this.#getAll(sql, params)),
            getRow: async (sql, params = []) => run(() => this.#getRow(sql, params)),
            getCell: async (sql, params = []) => run(() => this.#getCell(sql, params)),
            hasTable: async (table) =>
                run(() => !!this.#getCell("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table])),
            createModel: (...args) => this.createModel(...args),
            hydrateModel: (...args) => this.hydrateModel(...args),
            hydrateModels: (...args) => this.hydrateModels(...args),
            saveModel: async (model) => run(() => this.#saveModel(model)),
            deleteModel: async (model) => run(() => this.#deleteModel(model)),
            commit: () => finish("COMMIT"),
            rollback: () => finish("ROLLBACK"),
        };
    }

    async begin() {
        if (this.#poisonError) {
            throw this.#poisonError;
        }
        this.#database();
        return new Promise((resolve, reject) => {
            this.#transactionQueue.push({ type: "transaction", resolve, reject });
            this.#drainTransactionQueue();
        });
    }

    isoDateTime(value = dayjs.utc()) {
        return dayjs(value).utc().format("YYYY-MM-DD HH:mm:ss");
    }

    isoDateTimeMillis(value = dayjs.utc()) {
        return dayjs(value).utc().format("YYYY-MM-DD HH:mm:ss.SSS");
    }
}

export { SQLiteStore };
