// @ts-nocheck

import NotificationProvider from "@/server/notification-providers/notification-provider";
import httpClient from "@/server/http-client";

class Resend extends NotificationProvider {
    name = "Resend";

    /**
     * @inheritdoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        const okMsg = "Sent Successfully.";

        try {
            let config = {
                headers: {
                    Authorization: `Bearer ${notification.resendApiKey}`,
                    "Content-Type": "application/json",
                },
            };
            config = this.getAxiosConfigWithProxy(config);
            const email = notification.resendFromEmail.trim();

            const fromName = notification.resendFromName?.trim() || "iglo.monitor";
            let data = {
                from: `${fromName} <${email}>`,
                to: notification.resendToEmail,
                subject: notification.resendSubject || "Notification from Your iglo.monitor",
                // supplied text directly instead of html
                text: msg,
            };

            let result = await httpClient.post("https://api.resend.com/emails", data, config);
            if (result.status === 200) {
                return okMsg;
            } else {
                throw new Error(`Unexpected status code: ${result.status}`);
            }
        } catch (error) {
            this.throwGeneralAxiosError(error);
        }
    }
}

export default Resend;
