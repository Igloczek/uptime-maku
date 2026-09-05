// @ts-nocheck

import NotificationProvider from "@/server/notification-providers/notification-provider";
import httpClient from "@/server/http-client";
import { DOWN, UP } from "@/constants";

class Line extends NotificationProvider {
    name = "line";

    /**
     * @inheritdoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        const okMsg = "Sent Successfully.";
        const url = "https://api.line.me/v2/bot/message/push";

        try {
            let config = {
                headers: {
                    "Content-Type": "application/json",
                    Authorization: "Bearer " + notification.lineChannelAccessToken,
                },
            };
            config = this.getAxiosConfigWithProxy(config);
            if (heartbeatJSON == null) {
                let testMessage = {
                    to: notification.lineUserID,
                    messages: [
                        {
                            type: "text",
                            text: "Test Successful!",
                        },
                    ],
                };
                await httpClient.post(url, testMessage, config);
            } else if (heartbeatJSON["status"] === DOWN) {
                let downMessage = {
                    to: notification.lineUserID,
                    messages: [
                        {
                            type: "text",
                            text:
                                "iglo.monitor Alert: [🔴 Down]\n" +
                                "Name: " +
                                monitorJSON["name"] +
                                " \n" +
                                heartbeatJSON["msg"] +
                                `\nTime (${heartbeatJSON["timezone"]}): ${heartbeatJSON["localDateTime"]}`,
                        },
                    ],
                };
                await httpClient.post(url, downMessage, config);
            } else if (heartbeatJSON["status"] === UP) {
                let upMessage = {
                    to: notification.lineUserID,
                    messages: [
                        {
                            type: "text",
                            text:
                                "iglo.monitor Alert: [✅ Up]\n" +
                                "Name: " +
                                monitorJSON["name"] +
                                " \n" +
                                heartbeatJSON["msg"] +
                                `\nTime (${heartbeatJSON["timezone"]}): ${heartbeatJSON["localDateTime"]}`,
                        },
                    ],
                };
                await httpClient.post(url, upMessage, config);
            }
            return okMsg;
        } catch (error) {
            this.throwGeneralAxiosError(error);
        }
    }
}

export default Line;
