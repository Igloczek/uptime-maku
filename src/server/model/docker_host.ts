// @ts-nocheck

import { SQLiteModel } from "@/server/sqlite-model";

class DockerHost extends SQLiteModel {
    /**
     * Returns an object that ready to parse to JSON
     * @returns {object} Object ready to parse
     */
    toJSON() {
        return {
            id: this.id,
            userID: this.user_id,
            dockerDaemon: this.docker_daemon,
            dockerType: this.docker_type,
            name: this.name,
        };
    }
}

export default DockerHost;
