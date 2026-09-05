// @ts-nocheck

import NotificationProvider from "@/server/notification-providers/notification-provider";
import httpClient from "@/server/http-client";
import { UP, DOWN } from "@/constants";

class SIGNL4 extends NotificationProvider {
    name = "SIGNL4";

    /**
     * @inheritdoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        const okMsg = "Sent Successfully.";

        try {
            let data = {
                heartbeat: heartbeatJSON,
                monitor: monitorJSON,
                msg,
                // Source system
                "X-S4-SourceSystem": "iglo.monitor",
                monitorUrl: this.extractAddress(monitorJSON),
            };

            let config = {
                headers: {
                    "Content-Type": "application/json",
                },
            };
            config = this.getAxiosConfigWithProxy(config);

            if (heartbeatJSON == null) {
                // Test alert
                data.title = "iglo.monitor Alert";
                data.message = msg;
            } else if (heartbeatJSON.status === UP) {
                data.title = "iglo.monitor Monitor ✅ Up";
                data["X-S4-ExternalID"] = "iglo.monitor-" + monitorJSON.monitorID;
                data["X-S4-Status"] = "resolved";
            } else if (heartbeatJSON.status === DOWN) {
                data.title = "iglo.monitor Monitor 🔴 Down";
                data["X-S4-ExternalID"] = "iglo.monitor-" + monitorJSON.monitorID;
                data["X-S4-Status"] = "new";
            }

            await httpClient.post(notification.webhookURL, data, config);
            return okMsg;
        } catch (error) {
            this.throwGeneralAxiosError(error);
        }
    }
}

export default SIGNL4;
