// @ts-nocheck

import NotificationProvider from "@/server/notification-providers/notification-provider";
import httpClient from "@/server/http-client";
import { DOWN, UP } from "@/constants";

class WPush extends NotificationProvider {
    name = "WPush";

    /**
     * @inheritdoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        const okMsg = "Sent Successfully.";

        try {
            const context = {
                title: this.checkStatus(heartbeatJSON, monitorJSON),
                content: msg,
                apikey: notification.wpushAPIkey,
                channel: notification.wpushChannel,
            };
            let config = this.getAxiosConfigWithProxy({});
            const result = await httpClient.post("https://api.wpush.cn/api/v1/send", context, config);
            if (result.data.code !== 0) {
                throw result.data.message;
            }

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
        let title = "iglo.monitor Message";
        if (heartbeatJSON != null && heartbeatJSON["status"] === UP) {
            title = "iglo.monitor Monitor Up " + monitorJSON["name"];
        }
        if (heartbeatJSON != null && heartbeatJSON["status"] === DOWN) {
            title = "iglo.monitor Monitor Down " + monitorJSON["name"];
        }
        return title;
    }
}

export default WPush;
