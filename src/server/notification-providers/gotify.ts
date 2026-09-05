// @ts-nocheck

import NotificationProvider from "@/server/notification-providers/notification-provider";
import httpClient from "@/server/http-client";

class Gotify extends NotificationProvider {
    name = "gotify";

    /**
     * @inheritdoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        const okMsg = "Sent Successfully.";

        try {
            let config = this.getAxiosConfigWithProxy({});
            if (notification.gotifyserverurl && notification.gotifyserverurl.endsWith("/")) {
                notification.gotifyserverurl = notification.gotifyserverurl.slice(0, -1);
            }
            await httpClient.post(
                `${notification.gotifyserverurl}/message?token=${notification.gotifyapplicationToken}`,
                {
                    message: msg,
                    priority: notification.gotifyPriority || 8,
                    title: "iglo.monitor",
                },
                config
            );

            return okMsg;
        } catch (error) {
            this.throwGeneralAxiosError(error);
        }
    }
}

export default Gotify;
