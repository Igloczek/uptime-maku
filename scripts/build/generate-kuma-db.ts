#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { Database as BunDatabase } from "bun:sqlite";
import { applySqlFile } from "@/db/schema/sql-utils";
import { SCHEMA_VERSION_KEY } from "@/server/db-migrations";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const schemaPath = path.join(projectRoot, "src/db/schema/current.sql");
const outputPath = path.join(projectRoot, "out/kuma.db");

function main() {
    const sql = fs.readFileSync(schemaPath, "utf8");

    if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const db = new BunDatabase(outputPath, { create: true, strict: true });
    try {
        applySqlFile(db, sql);

        const result = db
            .query('INSERT INTO setting ("key", value) VALUES (?, ?)')
            .run(SCHEMA_VERSION_KEY, "1");

        if (!result || Number(result.changes) !== 1) {
            throw new Error(`Failed to seed ${SCHEMA_VERSION_KEY} into generated out/kuma.db`);
        }

        const seeded = db
            .query('SELECT value FROM setting WHERE "key" = ?')
            .get(SCHEMA_VERSION_KEY)?.value;
        if (seeded !== "1") {
            throw new Error(`Expected ${SCHEMA_VERSION_KEY}=1 after generation, got ${seeded}`);
        }
    } finally {
        db.close();
    }

    console.log(`Generated ${outputPath} from ${schemaPath}`);
}

main();
