// @ts-nocheck

import NotificationProvider from "@/server/notification-providers/notification-provider";
import httpClient from "@/server/http-client";
import { DOWN, UP } from "@/constants";

class Feishu extends NotificationProvider {
    name = "Feishu";

    /**
     * @inheritdoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        const okMsg = "Sent Successfully.";

        try {
            let config = this.getAxiosConfigWithProxy({});
            if (heartbeatJSON == null) {
                let testdata = {
                    msg_type: "text",
                    content: {
                        text: msg,
                    },
                };
                await httpClient.post(notification.feishuWebHookUrl, testdata, config);
                return okMsg;
            }

            if (heartbeatJSON["status"] === DOWN) {
                let downdata = {
                    msg_type: "interactive",
                    card: {
                        config: {
                            update_multi: false,
                            wide_screen_mode: true,
                        },
                        header: {
                            title: {
                                tag: "plain_text",
                                content: "iglo.monitor Alert: [Down] " + monitorJSON["name"],
                            },
                            template: "red",
                        },
                        elements: [
                            {
                                tag: "div",
                                text: {
                                    tag: "lark_md",
                                    content: getContent(heartbeatJSON),
                                },
                            },
                        ],
                    },
                };
                await httpClient.post(notification.feishuWebHookUrl, downdata, config);
                return okMsg;
            }

            if (heartbeatJSON["status"] === UP) {
                let updata = {
                    msg_type: "interactive",
                    card: {
                        config: {
                            update_multi: false,
                            wide_screen_mode: true,
                        },
                        header: {
                            title: {
                                tag: "plain_text",
                                content: "iglo.monitor Alert: [UP] " + monitorJSON["name"],
                            },
                            template: "green",
                        },
                        elements: [
                            {
                                tag: "div",
                                text: {
                                    tag: "lark_md",
                                    content: getContent(heartbeatJSON),
                                },
                            },
                        ],
                    },
                };
                await httpClient.post(notification.feishuWebHookUrl, updata, config);
                return okMsg;
            }
        } catch (error) {
            this.throwGeneralAxiosError(error);
        }
    }
}

/**
 * Get content
 * @param {?object} heartbeatJSON Heartbeat details (For Up/Down only)
 * @returns {string} Return Successful Message
 */
function getContent(heartbeatJSON) {
    return [
        "**Message**: " + heartbeatJSON["msg"],
        "**Ping**: " + (heartbeatJSON["ping"] == null ? "N/A" : heartbeatJSON["ping"] + " ms"),
        `**Time (${heartbeatJSON["timezone"]})**: ${heartbeatJSON["localDateTime"]}`,
    ].join("\n");
}

export default Feishu;
