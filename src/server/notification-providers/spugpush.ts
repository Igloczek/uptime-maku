// @ts-nocheck

import NotificationProvider from "@/server/notification-providers/notification-provider";
import httpClient from "@/server/http-client";
import { DOWN, UP } from "@/constants";

class SpugPush extends NotificationProvider {
    name = "SpugPush";

    /**
     * @inheritdoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        let okMsg = "Sent Successfully.";
        try {
            let formData = {
                title: "iglo.monitor Message",
                content: msg,
            };
            if (heartbeatJSON) {
                if (heartbeatJSON["status"] === UP) {
                    formData.title = `iglo.monitor 「${monitorJSON["name"]}」 is Up`;
                    formData.content = `[✅ Up] ${heartbeatJSON["msg"]}`;
                } else if (heartbeatJSON["status"] === DOWN) {
                    formData.title = `iglo.monitor 「${monitorJSON["name"]}」 is Down`;
                    formData.content = `[🔴 Down] ${heartbeatJSON["msg"]}`;
                }
            }
            const apiUrl = `https://push.spug.cc/send/${notification.templateKey}`;
            let config = this.getAxiosConfigWithProxy({});
            await httpClient.post(apiUrl, formData, config);
            return okMsg;
        } catch (error) {
            this.throwGeneralAxiosError(error);
        }
    }
}

export default SpugPush;
