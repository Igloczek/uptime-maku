// @ts-nocheck

class RemoteBrowser {
    /**
     * Gets remote browser from ID
     * @param {number} remoteBrowserID ID of the remote browser
     * @param {number} userID ID of the user who created the remote browser
     * @returns {Promise<Model>} Remote Browser
     */
    static async get(store, remoteBrowserID, userID) {
        let model = await store.findOne("remote_browser", " id = ? AND user_id = ? ", [remoteBrowserID, userID]);

        if (!model) {
            throw new Error("Remote browser not found");
        }

        return model;
    }

    /**
     * Save a Remote Browser
     * @param {object} remoteBrowser Remote Browser to save
     * @param {?number} remoteBrowserID ID of the Remote Browser to update
     * @param {number} userID ID of the user who adds the Remote Browser
     * @returns {Promise<Model>} Updated Remote Browser
     */
    static async save(store, remoteBrowser, remoteBrowserID, userID) {
        let model;

        if (remoteBrowserID) {
            model = await store.findOne("remote_browser", " id = ? AND user_id = ? ", [remoteBrowserID, userID]);

            if (!model) {
                throw new Error("Remote browser not found");
            }
        } else {
            model = store.createModel("remote_browser");
        }

        model.user_id = userID;
        model.name = remoteBrowser.name;
        model.url = remoteBrowser.url;

        await store.saveModel(model);

        return model;
    }

    /**
     * Delete a Remote Browser
     * @param {number} remoteBrowserID ID of the Remote Browser to delete
     * @param {number} userID ID of the user who created the Remote Browser
     * @returns {Promise<void>}
     */
    static async delete(store, remoteBrowserID, userID) {
        let model = await store.findOne("remote_browser", " id = ? AND user_id = ? ", [remoteBrowserID, userID]);

        if (!model) {
            throw new Error("Remote Browser not found");
        }

        // Delete removed remote browser from monitors if exists
        await store.exec("UPDATE monitor SET remote_browser = null WHERE remote_browser = ?", [remoteBrowserID]);

        await store.deleteModel(model);
    }
}

export { RemoteBrowser };
