// @ts-nocheck

import NotificationProvider from "@/server/notification-providers/notification-provider";
import httpClient from "@/server/http-client";
import { UP, DOWN } from "@/constants";
import { getMonitorRelativeURL } from "@/util/monitor-url";

let successMessage = "Sent Successfully.";

class Splunk extends NotificationProvider {
    name = "Splunk";

    /**
     * @inheritdoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        try {
            if (heartbeatJSON == null) {
                const title = "Uptime Maku Alert";
                const monitor = {
                    type: "ping",
                    url: "Uptime Maku Test Button",
                };
                return this.postNotification(notification, title, msg, monitor, "trigger");
            }

            if (heartbeatJSON.status === UP) {
                const title = "Uptime Maku Monitor ✅ Up";
                return this.postNotification(notification, title, heartbeatJSON.msg, monitorJSON, "recovery");
            }

            if (heartbeatJSON.status === DOWN) {
                const title = "Uptime Maku Monitor 🔴 Down";
                return this.postNotification(notification, title, heartbeatJSON.msg, monitorJSON, "trigger");
            }
        } catch (error) {
            this.throwGeneralAxiosError(error);
        }
    }

    /**
     * Check if result is successful, result code should be in range 2xx
     * @param {object} result Axios response object
     * @returns {void}
     * @throws {Error} The status code is not in range 2xx
     */
    checkResult(result) {
        if (result.status == null) {
            throw new Error("Splunk notification failed with invalid response!");
        }
        if (result.status < 200 || result.status >= 300) {
            throw new Error("Splunk notification failed with status code " + result.status);
        }
    }

    /**
     * Send the message
     * @param {SQLiteModel} notification Message title
     * @param {string} title Message title
     * @param {string} body Message
     * @param {object} monitorInfo Monitor details (For Up/Down only)
     * @param {?string} eventAction Action event for PagerDuty (trigger, acknowledge, resolve)
     * @returns {Promise<string>} Success state
     */
    async postNotification(notification, title, body, monitorInfo, eventAction = "trigger") {
        let monitorUrl;
        if (monitorInfo.type === "port") {
            monitorUrl = monitorInfo.hostname;
            if (monitorInfo.port) {
                monitorUrl += ":" + monitorInfo.port;
            }
        } else if (monitorInfo.hostname != null) {
            monitorUrl = monitorInfo.hostname;
        } else {
            monitorUrl = monitorInfo.url;
        }

        if (eventAction === "recovery") {
            if (notification.splunkAutoResolve === "0") {
                return "No action required";
            }
            eventAction = notification.splunkAutoResolve;
        } else {
            eventAction = notification.splunkSeverity;
        }

        const options = {
            method: "POST",
            url: notification.splunkRestURL,
            headers: { "Content-Type": "application/json" },
            data: {
                message_type: eventAction,
                state_message: `[${title}] [${monitorUrl}] ${body}`,
                entity_display_name: "Uptime Maku Alert: " + monitorInfo.name,
                routing_key: notification.pagerdutyIntegrationKey,
                entity_id: "Uptime Maku/" + monitorInfo.id,
            },
        };

        const baseURL = await this.settings.get("primaryBaseURL");
        if (baseURL && monitorInfo) {
            options.client = "Uptime Maku";
            options.client_url = baseURL + getMonitorRelativeURL(monitorInfo.id);
        }

        let result = await httpClient.request(options);
        this.checkResult(result);
        if (result.statusText != null) {
            return "Splunk notification succeed: " + result.statusText;
        }

        return successMessage;
    }
}

export default Splunk;
