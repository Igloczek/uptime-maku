// @ts-nocheck

import { sendNotification } from "@/server/notification-provider-registry";
import { commandExists } from "@/server/process-helper";

class Notification {
    /**
     * Send a notification
     * @param {NotificationProviderRegistry} providerRegistry Runtime-owned provider registry
     * @param {SQLiteModel} notification Notification to send
     * @param {string} msg General Message
     * @param {object} monitorJSON Monitor details (For Up/Down only)
     * @param {object} heartbeatJSON Heartbeat details (For Up/Down only)
     * @returns {Promise<string>} Successful msg
     * @throws Error with fail msg
     */
    static async send(providerRegistry, notification, msg, monitorJSON = null, heartbeatJSON = null) {
        return sendNotification(providerRegistry, notification, msg, monitorJSON, heartbeatJSON);
    }

    /**
     * Save a notification
     * @param {object} notification Notification to save
     * @param {?number} notificationID ID of notification to update
     * @param {number} userID ID of user who adds notification
     * @returns {Promise<Model>} Notification that was saved
     */
    static async save(store, notification, notificationID, userID) {
        let model;

        if (notificationID) {
            model = await store.findOne("notification", " id = ? AND user_id = ? ", [notificationID, userID]);

            if (!model) {
                throw new Error("notification not found");
            }
        } else {
            model = store.createModel("notification");
        }

        // applyExisting is one time only, don't save it to database.
        const applyExisting = notification.applyExisting || false;
        notification.applyExisting = false;

        model.name = notification.name;
        model.user_id = userID;
        model.config = JSON.stringify(notification);
        model.is_default = notification.isDefault || false;
        await store.saveModel(model);

        if (applyExisting) {
            await applyNotificationEveryMonitor(store, model.id, userID);
        }

        return model;
    }

    /**
     * Delete a notification
     * @param {number} notificationID ID of notification to delete
     * @param {number} userID ID of user who created notification
     * @returns {Promise<void>}
     */
    static async delete(store, notificationID, userID) {
        let model = await store.findOne("notification", " id = ? AND user_id = ? ", [notificationID, userID]);

        if (!model) {
            throw new Error("notification not found");
        }

        await store.deleteModel(model);
    }

    /**
     * Check if apprise exists
     * @returns {Promise<boolean>} Does the command apprise exist?
     */
    static async checkApprise() {
        return await commandExists("apprise");
    }
}

/**
 * Apply the notification to every monitor
 * @param {number} notificationID ID of notification to apply
 * @param {number} userID ID of user who created notification
 * @returns {Promise<void>}
 */
async function applyNotificationEveryMonitor(store, notificationID, userID) {
    let monitors = await store.getAll("SELECT id FROM monitor WHERE user_id = ?", [userID]);

    for (let i = 0; i < monitors.length; i++) {
        let checkNotification = await store.findOne(
            "monitor_notification",
            " monitor_id = ? AND notification_id = ? ",
            [monitors[i].id, notificationID]
        );

        if (!checkNotification) {
            let relation = store.createModel("monitor_notification");
            relation.monitor_id = monitors[i].id;
            relation.notification_id = notificationID;
            await store.saveModel(relation);
        }
    }
}

export { Notification };
