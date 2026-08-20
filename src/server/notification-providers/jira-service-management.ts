// @ts-nocheck

import NotificationProvider from "@/server/notification-providers/notification-provider";
import httpClient from "@/server/http-client";
import { UP, DOWN } from "@/constants";

const okMsg = "Sent Successfully.";

class JiraServiceManagement extends NotificationProvider {
    name = "JiraServiceManagement";

    /**
     * @inheritdoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        const priority = notification.jsmPriority || 3;
        const baseUrl = `https://api.atlassian.com/jsm/ops/api/${notification.jsmCloudId}/v1`;
        const textMsg = "Uptime Maku Alert";

        try {
            if (heartbeatJSON == null) {
                // Test notification
                let notificationTestAlias = "uptime-maku-notification-test";
                let data = {
                    message: msg,
                    alias: notificationTestAlias,
                    source: "Uptime Maku",
                    priority: "P5",
                    tags: ["Uptime Maku"],
                };

                return this.post(notification, `${baseUrl}/alerts`, data);
            }

            if (heartbeatJSON.status === DOWN) {
                let data = {
                    message: monitorJSON ? `${textMsg}: ${monitorJSON.name}` : textMsg,
                    alias: monitorJSON.name,
                    description: msg,
                    source: "Uptime Maku",
                    priority: `P${priority}`,
                    tags: ["Uptime Maku"],
                };

                return this.post(notification, `${baseUrl}/alerts`, data);
            }

            if (heartbeatJSON.status === UP) {
                // JSM requires getting the alert ID first, then closing by ID
                const getUrl = `${baseUrl}/alerts/alias?alias=${encodeURIComponent(monitorJSON.name)}`;
                const config = this.getConfig(notification);

                let alertResponse = await httpClient.get(getUrl, config);
                const alertId = alertResponse.data.id;

                const closeUrl = `${baseUrl}/alerts/${alertId}/close`;
                let data = {
                    source: "Uptime Maku",
                };

                return this.post(notification, closeUrl, data);
            }
        } catch (error) {
            this.throwGeneralAxiosError(error);
        }
    }

    /**
     * Get axios config with Basic Auth for JSM
     * @param {SQLiteModel} notification Notification details
     * @returns {object} Axios config object
     */
    getConfig(notification) {
        const authToken = Buffer.from(`${notification.jsmEmail}:${notification.jsmApiToken}`).toString("base64");
        let config = {
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                Authorization: `Basic ${authToken}`,
            },
        };
        return this.getAxiosConfigWithProxy(config);
    }

    /**
     * Make POST request to Jira Service Management
     * @param {SQLiteModel} notification Notification to send
     * @param {string} url Request url
     * @param {object} data Request body
     * @returns {Promise<string>} Success message
     */
    async post(notification, url, data) {
        let config = this.getConfig(notification);

        let res = await httpClient.post(url, data, config);
        if (res.status == null) {
            return "Jira Service Management notification failed with invalid response!";
        }
        if (res.status < 200 || res.status >= 300) {
            return `Jira Service Management notification failed with status code ${res.status}`;
        }

        return okMsg;
    }
}

export default JiraServiceManagement;
