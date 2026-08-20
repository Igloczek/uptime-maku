// @ts-nocheck

import { SQLiteModel } from "@/server/sqlite-model";

class RemoteBrowser extends SQLiteModel {
    /**
     * Returns an object that ready to parse to JSON
     * @returns {object} Object ready to parse
     */
    toJSON() {
        return {
            id: this.id,
            url: this.url,
            name: this.name,
        };
    }
}

export default RemoteBrowser;
