// @ts-nocheck
"use strict";

/**
 * Base model for SQLite store models.
 * Kept in its own module so model classes can import it without creating
 * a circular dependency with the store singleton.
 */
class SQLiteModel {
    import(data) {
        if (!data || typeof data !== "object") {
            return this;
        }

        for (const [key, value] of Object.entries(data)) {
            if (typeof value !== "function") {
                this[key] = value;
            }
        }
        return this;
    }

    export() {
        const result = {};
        for (const [key, value] of Object.entries(this)) {
            if (!key.startsWith("__") && typeof value !== "function") {
                result[key] = value;
            }
        }
        return result;
    }

    toJSON() {
        return this.export();
    }
}

export { SQLiteModel };
export default SQLiteModel;
