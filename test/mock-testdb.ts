import { sync as rimrafSync } from "rimraf";
import Database from "@/server/database";
import { SQLiteStore } from "@/server/sqlite-store";
import { SQLITE_MODEL_MAPPING } from "@/server/sqlite-model-mapping";

class TestDB {
    dataDir;

    constructor(dir = "./data/test") {
        this.dataDir = dir;
        this.store = new SQLiteStore({ modelMapping: SQLITE_MODEL_MAPPING });
    }

    async create() {
        Database.initDataDir({ "data-dir": this.dataDir });
        await Database.connect(this.store, true);
    }

    async destroy() {
        await Database.close(this.store);
        this.dataDir && rimrafSync(this.dataDir);
    }
}

export default TestDB;
