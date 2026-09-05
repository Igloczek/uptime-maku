// @ts-nocheck

import NotificationProvider from "@/server/notification-providers/notification-provider";
import httpClient from "@/server/http-client";

class TechulusPush extends NotificationProvider {
    name = "PushByTechulus";

    /**
     * @inheritdoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        const okMsg = "Sent Successfully.";

        let data = {
            title: notification?.pushTitle?.length ? notification.pushTitle : "iglo.monitor",
            body: msg,
            timeSensitive: notification.pushTimeSensitive ?? true,
        };

        if (notification.pushChannel) {
            data.channel = notification.pushChannel;
        }

        if (notification.pushSound) {
            data.sound = notification.pushSound;
        }

        try {
            let config = this.getAxiosConfigWithProxy({});
            await httpClient.post(`https://push.techulus.com/api/v1/notify/${notification.pushAPIKey}`, data, config);
            return okMsg;
        } catch (error) {
            this.throwGeneralAxiosError(error);
        }
    }
}

export default TechulusPush;
