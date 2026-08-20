// @ts-nocheck

import { SQLiteModel } from "@/server/sqlite-model";

class Tag extends SQLiteModel {
    /**
     * Return an object that ready to parse to JSON
     * @returns {object} Object ready to parse
     */
    toJSON() {
        return {
            id: this.id,
            name: this.name,
            color: this.color,
        };
    }
}

export default Tag;
