// @ts-nocheck

import { BeanModel } from "@/server/bean-model";

class Group extends BeanModel {
    /**
     * Return an object that ready to parse to JSON for public Only show
     * necessary data to public
     * @param {SQLiteStore} store Store used to load related monitors
     * @param {boolean} showTags Should the JSON include monitor tags
     * @param {boolean} certExpiry Should JSON include info about
     * certificate expiry?
     * @returns {Promise<object>} Object ready to parse
     */
    async toPublicJSON(store, showTags = false, certExpiry = false) {
        let monitorBeanList = await this.getMonitorList(store);
        let monitorList = [];

        for (let bean of monitorBeanList) {
            monitorList.push(await bean.toPublicJSON(store, showTags, certExpiry));
        }

        return {
            id: this.id,
            name: this.name,
            weight: this.weight,
            monitorList,
        };
    }

    /**
     * Get all monitors
     * @returns {Promise<Bean[]>} List of monitors
     */
    async getMonitorList(store) {
        return store.convertToBeans(
            "monitor",
            await store.getAll(
                `
            SELECT monitor.*, monitor_group.send_url, monitor_group.custom_url FROM monitor, monitor_group
            WHERE monitor.id = monitor_group.monitor_id
            AND group_id = ?
            ORDER BY monitor_group.weight
        `,
                [this.id]
            )
        );
    }
}

export default Group;
