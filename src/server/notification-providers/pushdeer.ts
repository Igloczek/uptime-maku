// @ts-nocheck

import NotificationProvider from "@/server/notification-providers/notification-provider";
import httpClient from "@/server/http-client";
import { DOWN, UP } from "@/constants";

class PushDeer extends NotificationProvider {
    name = "PushDeer";

    /**
     * @inheritdoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        const okMsg = "Sent Successfully.";
        const serverUrl = notification.pushdeerServer || "https://api2.pushdeer.com";
        // capture group below is necessary to prevent an ReDOS-attack
        const url = `${serverUrl.trim().replace(/([^/])\/+$/, "$1")}/message/push`;

        let valid = msg != null && monitorJSON != null && heartbeatJSON != null;

        let title;
        if (valid && heartbeatJSON.status === UP) {
            title = "## iglo.monitor: " + monitorJSON.name + " up";
        } else if (valid && heartbeatJSON.status === DOWN) {
            title = "## iglo.monitor: " + monitorJSON.name + " down";
        } else {
            title = "## iglo.monitor Message";
        }

        let data = {
            pushkey: notification.pushdeerKey,
            text: title,
            desp: msg.replace(/\n/g, "\n\n"),
            type: "markdown",
        };

        try {
            let config = this.getAxiosConfigWithProxy({});
            let res = await httpClient.post(url, data, config);

            if ("error" in res.data) {
                let error = res.data.error;
                this.throwGeneralAxiosError(error);
            }
            if (res.data.content.result.length === 0) {
                let error = "Invalid PushDeer key";
                this.throwGeneralAxiosError(error);
            } else if (JSON.parse(res.data.content.result[0]).success !== "ok") {
                let error = "Unknown error";
                this.throwGeneralAxiosError(error);
            }
            return okMsg;
        } catch (error) {
            this.throwGeneralAxiosError(error);
        }
    }
}

export default PushDeer;
