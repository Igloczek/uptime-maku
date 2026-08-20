// @ts-nocheck

import { log } from "@/server/logger";

class Settings {
    /**
     *  Example:
     *      {
     *         key1: {
     *             value: "value2",
     *             timestamp: 12345678
     *         },
     *         key2: {
     *             value: 2,
     *             timestamp: 12345678
     *         },
     *     }
     * @type {{}}
     */
    cacheList = {};

    cacheCleaner = null;

    constructor(store) {
        this.store = store;
    }

    /**
     * Retrieve value of setting based on key
     * @param {string} key Key of setting to retrieve
     * @returns {Promise<any>} Value
     */
    async get(key) {
        // Start cache clear if not started yet
        if (!this.cacheCleaner) {
            this.cacheCleaner = setInterval(() => {
                log.debug("settings", "Cache Cleaner is just started.");
                for (key in this.cacheList) {
                    if (Date.now() - this.cacheList[key].timestamp > 60 * 1000) {
                        log.debug("settings", "Cache Cleaner deleted: " + key);
                        delete this.cacheList[key];
                    }
                }
            }, 60 * 1000);
        }

        // Query from cache
        if (key in this.cacheList) {
            const v = this.cacheList[key].value;
            return v;
        }

        let value = await this.store.getCell("SELECT `value` FROM setting WHERE `key` = ? ", [key]);

        try {
            const v = JSON.parse(value);

            this.cacheList[key] = {
                value: v,
                timestamp: Date.now(),
            };

            return v;
        } catch (e) {
            return value;
        }
    }

    /**
     * Sets the specified setting to specified value
     * @param {string} key Key of setting to set
     * @param {any} value Value to set to
     * @param {?string} type Type of setting
     * @returns {Promise<void>}
     */
    async set(key, value, type = null) {
        let model = await this.store.findOne("setting", " `key` = ? ", [key]);
        if (!model) {
            model = this.store.createModel("setting");
            model.key = key;
        }
        model.type = type;
        model.value = JSON.stringify(value);
        await this.store.saveModel(model);

        this.deleteCache([key]);
    }

    /**
     * Get settings based on type
     * @param {string} type The type of setting
     * @returns {Promise<Model>} Settings
     */
    async getSettings(type) {
        let list = await this.store.getAll("SELECT `key`, `value` FROM setting WHERE `type` = ? ", [type]);

        let result = {};

        for (let row of list) {
            try {
                result[row.key] = JSON.parse(row.value);
            } catch (e) {
                result[row.key] = row.value;
            }
        }

        return result;
    }

    /**
     * Set settings based on type
     * @param {string} type Type of settings to set
     * @param {object} data Values of settings
     * @returns {Promise<void>}
     */
    async setSettings(type, data) {
        let keyList = Object.keys(data);

        let promiseList = [];

        for (let key of keyList) {
            let model = await this.store.findOne("setting", " `key` = ? ", [key]);

            if (model == null) {
                model = this.store.createModel("setting");
                model.type = type;
                model.key = key;
            }

            if (model.type === type) {
                model.value = JSON.stringify(data[key]);
                promiseList.push(this.store.saveModel(model));
            }
        }

        await Promise.all(promiseList);

        this.deleteCache(keyList);
    }

    /**
     * Delete selected keys from settings cache
     * @param {string[]} keyList Keys to remove
     * @returns {void}
     */
    deleteCache(keyList) {
        for (let key of keyList) {
            delete this.cacheList[key];
        }
    }

    /**
     * Stop the cache cleaner if running
     * @returns {void}
     */
    stopCacheCleaner() {
        if (this.cacheCleaner) {
            clearInterval(this.cacheCleaner);
            this.cacheCleaner = null;
        }
    }
}

export { Settings };
