// @ts-nocheck

import NotificationProvider from "@/server/notification-providers/notification-provider";
import httpClient from "@/server/http-client";
import { DOWN, UP } from "@/constants";

class PushPlus extends NotificationProvider {
    name = "PushPlus";

    /**
     * @inheritdoc
     * @param {SQLiteModel} notification Notification object
     * @param {string} msg Message content
     * @param {?object} monitorJSON Monitor details
     * @param {?object} heartbeatJSON Heartbeat details
     * @returns {Promise<string>} Success message
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        const okMsg = "Sent Successfully.";
        const url = "https://www.pushplus.plus/send";
        try {
            let config = {
                headers: {
                    "Content-Type": "application/json",
                },
            };
            config = this.getAxiosConfigWithProxy(config);
            const params = {
                token: notification.pushPlusSendKey,
                title: this.checkStatus(heartbeatJSON, monitorJSON),
                content: msg,
                template: "html",
            };
            await httpClient.post(url, params, config);
            return okMsg;
        } catch (error) {
            this.throwGeneralAxiosError(error);
        }
    }

    /**
     * Get the formatted title for message
     * @param {?object} heartbeatJSON Heartbeat details (For Up/Down only)
     * @param {?object} monitorJSON Monitor details (For Up/Down only)
     * @returns {string} Formatted title
     */
    checkStatus(heartbeatJSON, monitorJSON) {
        let title = "Uptime Maku Message";
        if (heartbeatJSON != null && heartbeatJSON["status"] === UP) {
            title = "Uptime Maku Monitor Up " + monitorJSON["name"];
        }
        if (heartbeatJSON != null && heartbeatJSON["status"] === DOWN) {
            title = "Uptime Maku Monitor Down " + monitorJSON["name"];
        }
        return title;
    }
}

export default PushPlus;
