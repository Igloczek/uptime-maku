// @ts-nocheck

import { SQLiteModel } from "@/server/sqlite-model";
import dayjs from "dayjs";

class Incident extends SQLiteModel {
    /**
     * Resolve the incident and mark it as inactive
     * @returns {Promise<void>}
     */
    async resolve(store) {
        this.active = false;
        this.pin = false;
        this.last_updated_date = store.isoDateTime(dayjs.utc());
        await store.saveModel(this);
    }

    /**
     * Return an object that ready to parse to JSON for public
     * @returns {object} Object ready to parse
     */
    toPublicJSON() {
        return {
            id: this.id,
            style: this.style,
            title: this.title,
            content: this.content,
            pin: !!this.pin,
            active: !!this.active,
            createdDate: this.created_date,
            lastUpdatedDate: this.last_updated_date,
            status_page_id: this.status_page_id,
        };
    }
}

export default Incident;
