// @ts-nocheck

import { SQLiteModel } from "@/server/sqlite-model";

class Proxy extends SQLiteModel {
    /**
     * Return an object that ready to parse to JSON
     * @returns {object} Object ready to parse
     */
    toJSON() {
        return {
            id: this.id,
            userId: this.user_id,
            protocol: this.protocol,
            host: this.host,
            port: this.port,
            auth: !!this.auth,
            username: this.username,
            password: this.password,
            active: !!this.active,
            default: !!this.default,
            createdDate: this.created_date,
        };
    }
}

export default Proxy;
