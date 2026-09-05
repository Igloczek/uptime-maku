// @ts-nocheck

import NotificationProvider from "@/server/notification-providers/notification-provider";
import httpClient from "@/server/http-client";
import { UP } from "@/constants";

class Bitrix24 extends NotificationProvider {
    name = "Bitrix24";

    /**
     * @inheritdoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        const okMsg = "Sent Successfully.";

        try {
            const params = {
                user_id: notification.bitrix24UserID,
                message: "[B]iglo.monitor[/B]",
                "ATTACH[COLOR]": (heartbeatJSON ?? {})["status"] === UP ? "#b73419" : "#67b518",
                "ATTACH[BLOCKS][0][MESSAGE]": msg,
            };

            let config = this.getAxiosConfigWithProxy({ params });
            await httpClient.get(`${notification.bitrix24WebhookURL}/im.notify.system.add.json`, config);
            return okMsg;
        } catch (error) {
            this.throwGeneralAxiosError(error);
        }
    }
}

export default Bitrix24;
