// @ts-nocheck

import NotificationProvider from "@/server/notification-providers/notification-provider";
import httpClient from "@/server/http-client";

class Pushy extends NotificationProvider {
    name = "pushy";

    /**
     * @inheritdoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        const okMsg = "Sent Successfully.";

        try {
            let config = this.getAxiosConfigWithProxy({});
            await httpClient.post(
                `https://api.pushy.me/push?api_key=${notification.pushyAPIKey}`,
                {
                    to: notification.pushyToken,
                    data: {
                        message: "iglo.monitor",
                    },
                    notification: {
                        body: msg,
                        badge: 1,
                        sound: "ping.aiff",
                    },
                },
                config
            );
            return okMsg;
        } catch (error) {
            this.throwGeneralAxiosError(error);
        }
    }
}

export default Pushy;
