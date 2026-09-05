// @ts-nocheck

import NotificationProvider from "@/server/notification-providers/notification-provider";
import httpClient from "@/server/http-client";
import { DOWN, UP } from "@/constants";

class Pushbullet extends NotificationProvider {
    name = "pushbullet";

    /**
     * @inheritdoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        const okMsg = "Sent Successfully.";
        const url = "https://api.pushbullet.com/v2/pushes";

        try {
            let config = {
                headers: {
                    "Access-Token": notification.pushbulletAccessToken,
                    "Content-Type": "application/json",
                },
            };
            config = this.getAxiosConfigWithProxy(config);
            if (heartbeatJSON == null) {
                let data = {
                    type: "note",
                    title: "iglo.monitor Alert",
                    body: msg,
                };
                await httpClient.post(url, data, config);
            } else if (heartbeatJSON["status"] === DOWN) {
                let downData = {
                    type: "note",
                    title: "iglo.monitor Alert: " + monitorJSON["name"],
                    body:
                        "[🔴 Down] " +
                        heartbeatJSON["msg"] +
                        `\nTime (${heartbeatJSON["timezone"]}): ${heartbeatJSON["localDateTime"]}`,
                };
                await httpClient.post(url, downData, config);
            } else if (heartbeatJSON["status"] === UP) {
                let upData = {
                    type: "note",
                    title: "iglo.monitor Alert: " + monitorJSON["name"],
                    body:
                        "[✅ Up] " +
                        heartbeatJSON["msg"] +
                        `\nTime (${heartbeatJSON["timezone"]}): ${heartbeatJSON["localDateTime"]}`,
                };
                await httpClient.post(url, upData, config);
            }
            return okMsg;
        } catch (error) {
            this.throwGeneralAxiosError(error);
        }
    }
}

export default Pushbullet;
