// @ts-nocheck

import NotificationProvider from "@/server/notification-providers/notification-provider";
import webpush from "web-push";

class Webpush extends NotificationProvider {
    name = "Webpush";

    /**
     * @inheritDoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        const okMsg = "Sent Successfully.";

        try {
            const publicVapidKey = await this.settings.get("webpushPublicVapidKey");
            const privateVapidKey = await this.settings.get("webpushPrivateVapidKey");

            webpush.setVapidDetails("https://github.com/iglo-tech/iglo.monitor", publicVapidKey, privateVapidKey);

            const data = JSON.stringify({
                title: "iglo.monitor",
                body: msg,
            });

            await webpush.sendNotification(notification.subscription, data);

            return okMsg;
        } catch (error) {
            this.throwGeneralAxiosError(error);
        }
    }
}

export default Webpush;
