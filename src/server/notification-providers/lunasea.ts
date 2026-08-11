// @ts-nocheck

import NotificationProvider from "@/server/notification-providers/notification-provider";
import httpClient from "@/server/http-client";
import { DOWN, UP } from "@/constants";

class LunaSea extends NotificationProvider {
    name = "lunasea";

    /**
     * @inheritdoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        const okMsg = "Sent Successfully.";
        const url = "https://notify.lunasea.app/v1";

        try {
            let config = this.getAxiosConfigWithProxy({});
            const target = this.getTarget(notification);
            if (heartbeatJSON == null) {
                let testdata = {
                    title: "Uptime Maku Alert",
                    body: msg,
                };
                await httpClient.post(`${url}/custom/${target}`, testdata, config);
                return okMsg;
            }

            if (heartbeatJSON["status"] === DOWN) {
                let downdata = {
                    title: "Uptime Maku Alert: " + monitorJSON["name"],
                    body:
                        "[🔴 Down] " +
                        heartbeatJSON["msg"] +
                        `\nTime (${heartbeatJSON["timezone"]}): ${heartbeatJSON["localDateTime"]}`,
                };
                await httpClient.post(`${url}/custom/${target}`, downdata, config);
                return okMsg;
            }

            if (heartbeatJSON["status"] === UP) {
                let updata = {
                    title: "Uptime Maku Alert: " + monitorJSON["name"],
                    body:
                        "[✅ Up] " +
                        heartbeatJSON["msg"] +
                        `\nTime (${heartbeatJSON["timezone"]}): ${heartbeatJSON["localDateTime"]}`,
                };
                await httpClient.post(`${url}/custom/${target}`, updata, config);
                return okMsg;
            }
        } catch (error) {
            this.throwGeneralAxiosError(error);
        }
    }

    /**
     * Generates the lunasea target to send the notification to
     * @param {SQLiteModel} notification Notification details
     * @returns {string} The target to send the notification to
     */
    getTarget(notification) {
        if (notification.lunaseaTarget === "user") {
            return "user/" + notification.lunaseaUserID;
        }
        return "device/" + notification.lunaseaDevice;
    }
}

export default LunaSea;
