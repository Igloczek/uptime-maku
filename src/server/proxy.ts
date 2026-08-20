// @ts-nocheck

import { SUPPORTED_PROXY_PROTOCOLS, validateProxyDefinition } from "@/server/proxy-validation";

class Proxy {
    static SUPPORTED_PROXY_PROTOCOLS = SUPPORTED_PROXY_PROTOCOLS;

    /**
     * Saves and updates given proxy entity
     * @param {object} proxy Proxy to store
     * @param {number} proxyID ID of proxy to update
     * @param {number} userID ID of user the proxy belongs to
     * @returns {Promise<Model>} Updated proxy
     */
    static async save(store, proxy, proxyID, userID) {
        const validated = validateProxyDefinition(proxy);
        let model;

        if (proxyID) {
            model = await store.findOne("proxy", " id = ? AND user_id = ? ", [proxyID, userID]);

            if (!model) {
                throw new Error("proxy not found");
            }
        } else {
            model = store.createModel("proxy");
        }

        // When proxy is default update deactivate old default proxy
        if (validated.default) {
            await store.exec("UPDATE proxy SET `default` = 0 WHERE `default` = 1 AND user_id = ?", [userID]);
        }

        model.user_id = userID;
        Object.assign(model, validated);

        await store.saveModel(model);

        if (proxy.applyExisting) {
            await applyProxyEveryMonitor(store, model.id, userID);
        }

        return model;
    }

    /**
     * Deletes proxy with given id and removes it from monitors
     * @param {number} proxyID ID of proxy to delete
     * @param {number} userID ID of proxy owner
     * @returns {Promise<void>}
     */
    static async delete(store, proxyID, userID) {
        const model = await store.findOne("proxy", " id = ? AND user_id = ? ", [proxyID, userID]);

        if (!model) {
            throw new Error("proxy not found");
        }

        // Delete removed proxy from monitors if exists
        await store.exec("UPDATE monitor SET proxy_id = null WHERE proxy_id = ?", [proxyID]);

        // Delete proxy from list
        await store.deleteModel(model);
    }

    /**
     * Reload proxy settings for current monitors
     * @returns {Promise<void>}
     */
    static async reloadProxy(store, monitorList) {
        let updatedList = await store.getAssoc("SELECT id, proxy_id FROM monitor");

        for (let monitorID in monitorList) {
            let monitor = monitorList[monitorID];

            if (updatedList[monitorID]) {
                monitor.proxy_id = updatedList[monitorID].proxy_id;
            }
        }
    }
}

/**
 * Applies given proxy id to monitors
 * @param {number} proxyID ID of proxy to apply
 * @param {number} userID ID of proxy owner
 * @returns {Promise<void>}
 */
async function applyProxyEveryMonitor(store, proxyID, userID) {
    // Find all monitors with id and proxy id
    const monitors = await store.getAll("SELECT id, proxy_id FROM monitor WHERE user_id = ?", [userID]);

    // Update proxy id not match with given proxy id
    for (const monitor of monitors) {
        if (monitor.proxy_id !== proxyID) {
            await store.exec("UPDATE monitor SET proxy_id = ? WHERE id = ?", [proxyID, monitor.id]);
        }
    }
}

export { Proxy };
