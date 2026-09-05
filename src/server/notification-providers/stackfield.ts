// @ts-nocheck

import NotificationProvider from "@/server/notification-providers/notification-provider";
import httpClient from "@/server/http-client";
import { getMonitorRelativeURL } from "@/util/monitor-url";

class Stackfield extends NotificationProvider {
    name = "stackfield";

    /**
     * @inheritdoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        const okMsg = "Sent Successfully.";

        try {
            // Stackfield message formatting: https://www.stackfield.com/help/formatting-messages-2001

            let textMsg = "+iglo.monitor Alert+";

            if (monitorJSON && monitorJSON.name) {
                textMsg += `\n*${monitorJSON.name}*`;
            }

            textMsg += `\n${msg}`;

            const baseURL = await this.settings.get("primaryBaseURL");
            if (baseURL) {
                const urlPath = monitorJSON ? getMonitorRelativeURL(monitorJSON.id) : "/";
                textMsg += `\n${baseURL + urlPath}`;
            }

            const data = {
                Title: textMsg,
            };
            let config = this.getAxiosConfigWithProxy({});

            await httpClient.post(notification.stackfieldwebhookURL, data, config);
            return okMsg;
        } catch (error) {
            this.throwGeneralAxiosError(error);
        }
    }
}

export default Stackfield;
