// @ts-nocheck

import NotificationProvider from "@/server/notification-providers/notification-provider";
import httpClient from "@/server/http-client";
import { UP } from "@/constants";

class Pumble extends NotificationProvider {
    name = "pumble";

    /**
     * @inheritDoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        const okMsg = "Sent Successfully.";

        try {
            let config = this.getAxiosConfigWithProxy({});
            if (heartbeatJSON === null && monitorJSON === null) {
                let data = {
                    attachments: [
                        {
                            title: "iglo.monitor Alert",
                            text: msg,
                            color: "#5BDD8B",
                        },
                    ],
                };

                await httpClient.post(notification.webhookURL, data, config);
                return okMsg;
            }

            let data = {
                attachments: [
                    {
                        title: `${monitorJSON["name"]} is ${heartbeatJSON["status"] === UP ? "up" : "down"}`,
                        text: heartbeatJSON["msg"],
                        color: heartbeatJSON["status"] === UP ? "#5BDD8B" : "#DC3645",
                    },
                ],
            };

            await httpClient.post(notification.webhookURL, data, config);
            return okMsg;
        } catch (error) {
            this.throwGeneralAxiosError(error);
        }
    }
}

export default Pumble;
