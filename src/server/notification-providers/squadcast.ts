// @ts-nocheck

import NotificationProvider from "@/server/notification-providers/notification-provider";
import httpClient from "@/server/http-client";
import { DOWN } from "@/constants";

class Squadcast extends NotificationProvider {
    name = "squadcast";

    /**
     * @inheritdoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        const okMsg = "Sent Successfully.";

        try {
            let config = {};
            let data = {
                message: msg,
                description: "",
                tags: {},
                heartbeat: heartbeatJSON,
                source: "iglo-monitor",
            };

            if (heartbeatJSON !== null) {
                data.description = heartbeatJSON["msg"];
                data.event_id = heartbeatJSON["monitorID"];

                if (heartbeatJSON["status"] === DOWN) {
                    data.message = `${monitorJSON["name"]} is DOWN`;
                    data.status = "trigger";
                } else {
                    data.message = `${monitorJSON["name"]} is UP`;
                    data.status = "resolve";
                }

                data.tags["AlertAddress"] = this.extractAddress(monitorJSON);

                monitorJSON["tags"].forEach((tag) => {
                    data.tags[tag["name"]] = {
                        value: tag["value"],
                    };
                    if (tag["color"] !== null) {
                        data.tags[tag["name"]]["color"] = tag["color"];
                    }
                });
            }
            config = this.getAxiosConfigWithProxy(config);

            await httpClient.post(notification.squadcastWebhookURL, data, config);
            return okMsg;
        } catch (error) {
            this.throwGeneralAxiosError(error);
        }
    }
}

export default Squadcast;
