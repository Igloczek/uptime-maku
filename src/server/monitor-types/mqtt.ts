// @ts-nocheck

import { MonitorType } from "@/server/monitor-types/monitor-type";
import { log } from "@/server/logger";
import { UP } from "@/constants";
import mqtt from "mqtt";
import { evaluateJsonata } from "@/server/json-query";
import { ConditionVariable } from "@/server/monitor-conditions/variables";
import { defaultStringOperators, defaultNumberOperators } from "@/server/monitor-conditions/operators";
import { ConditionExpressionGroup } from "@/server/monitor-conditions/expression";
import { evaluateExpressionGroup } from "@/server/monitor-conditions/evaluator";

class MqttMonitorType extends MonitorType {
    name = "mqtt";

    supportsConditions = true;

    conditionVariables = [
        new ConditionVariable("topic", defaultStringOperators),
        new ConditionVariable("message", defaultStringOperators),
        new ConditionVariable("json_value", defaultStringOperators.concat(defaultNumberOperators)),
    ];

    /**
     * @inheritdoc
     */
    async check(monitor, heartbeat, server) {
        const [messageTopic, receivedMessage] = await this.mqttAsync(monitor.hostname, monitor.mqttTopic, {
            port: monitor.port,
            username: monitor.mqttUsername,
            password: monitor.mqttPassword,
            timeout: (monitor.timeout ?? 20) * 1000,
            websocketPath: monitor.mqttWebsocketPath,
        });

        if (monitor.mqttCheckType == null || monitor.mqttCheckType === "") {
            monitor.mqttCheckType = "keyword";
        }

        // Check if conditions are defined
        const conditions = monitor.conditions ? ConditionExpressionGroup.fromMonitor(monitor) : null;
        const hasConditions = conditions && conditions.children && conditions.children.length > 0;

        if (hasConditions) {
            await this.checkConditions(monitor, heartbeat, messageTopic, receivedMessage, conditions);
        } else if (monitor.mqttCheckType === "keyword") {
            this.checkKeyword(monitor, heartbeat, messageTopic, receivedMessage);
        } else if (monitor.mqttCheckType === "json-query") {
            await this.checkJsonQuery(monitor, heartbeat, receivedMessage);
        } else {
            throw new Error("Unknown MQTT Check Type");
        }
    }

    /**
     * Check using keyword matching
     * @param {object} monitor Monitor object
     * @param {object} heartbeat Heartbeat object
     * @param {string} messageTopic Received MQTT topic
     * @param {string} receivedMessage Received MQTT message
     * @returns {void}
     * @throws {Error} If keyword is not found in message
     */
    checkKeyword(monitor, heartbeat, messageTopic, receivedMessage) {
        if (receivedMessage != null && receivedMessage.includes(monitor.mqttSuccessMessage)) {
            heartbeat.msg = `Topic: ${messageTopic}; Message: ${receivedMessage}`;
            heartbeat.status = UP;
        } else {
            throw new Error(`Message Mismatch - Topic: ${monitor.mqttTopic}; Message: ${receivedMessage}`);
        }
    }

    /**
     * Check using JSONata query
     * @param {object} monitor Monitor object
     * @param {object} heartbeat Heartbeat object
     * @param {string} receivedMessage Received MQTT message
     * @returns {Promise<void>}
     */
    async checkJsonQuery(monitor, heartbeat, receivedMessage) {
        const parsedMessage = JSON.parse(receivedMessage);
        const result = await evaluateJsonata(monitor.jsonPath, parsedMessage);

        if (result?.toString() === monitor.expectedValue) {
            heartbeat.msg = "Message received, expected value is found";
            heartbeat.status = UP;
        } else {
            throw new Error("Message received but value is not equal to expected value, value was: [" + result + "]");
        }
    }

    /**
     * Check using conditions system
     * @param {object} monitor Monitor object
     * @param {object} heartbeat Heartbeat object
     * @param {string} messageTopic Received MQTT topic
     * @param {string} receivedMessage Received MQTT message
     * @param {ConditionExpressionGroup} conditions Parsed conditions
     * @returns {Promise<void>}
     */
    async checkConditions(monitor, heartbeat, messageTopic, receivedMessage, conditions) {
        let jsonValue = null;

        // Parse JSON and extract value if jsonPath is defined
        if (monitor.jsonPath) {
            try {
                const parsedMessage = JSON.parse(receivedMessage);
                jsonValue = await evaluateJsonata(monitor.jsonPath, parsedMessage);
            } catch (e) {
                // JSON parsing failed, jsonValue remains null
            }
        }

        const conditionData = {
            topic: messageTopic,
            message: receivedMessage,
            json_value: jsonValue?.toString() ?? "",
        };

        const conditionsResult = evaluateExpressionGroup(conditions, conditionData);

        if (conditionsResult) {
            heartbeat.msg = `Topic: ${messageTopic}; Message: ${receivedMessage}`;
            heartbeat.status = UP;
        } else {
            throw new Error(`Conditions not met - Topic: ${messageTopic}; Message: ${receivedMessage}`);
        }
    }

    /**
     * Connect to MQTT Broker, subscribe to topic and receive message as String
     * @param {string} hostname Hostname / address of machine to test
     * @param {string} topic MQTT topic
     * @param {object} options MQTT options. Contains port, username,
     * password, websocketPath and timeout
     * @returns {Promise<string>} Received MQTT message
     */
    mqttAsync(hostname, topic, options = {}) {
        return new Promise((resolve, reject) => {
            const { port, username, password, websocketPath, timeout = 20_000 } = options;

            // Adds MQTT protocol to the hostname if not already present
            if (!/^(?:http|mqtt|ws)s?:\/\//.test(hostname)) {
                hostname = "mqtt://" + hostname;
            }

            // Construct the URL based on protocol
            let mqttUrl = `${hostname}:${port}`;
            if (hostname.startsWith("ws://") || hostname.startsWith("wss://")) {
                if (websocketPath && !websocketPath.startsWith("/")) {
                    mqttUrl = `${hostname}:${port}/${websocketPath || ""}`;
                } else {
                    mqttUrl = `${hostname}:${port}${websocketPath || ""}`;
                }
            }

            log.debug(this.name, `MQTT connecting to ${mqttUrl}`);

            const client = mqtt.connect(mqttUrl, {
                username,
                password,
                clientId: "iglo-monitor_" + Math.random().toString(16).substr(2, 8),
                connectTimeout: timeout,
                reconnectPeriod: 0,
            });
            let settled = false;
            let timeoutID;
            const finish = (error, value) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeoutID);
                client.end(true);
                error ? reject(error) : resolve(value);
            };
            timeoutID = setTimeout(() => {
                log.debug(this.name, "MQTT timeout triggered");
                finish(new Error("Timeout, Message not received"));
            }, timeout);

            client.on("connect", () => {
                log.debug(this.name, "MQTT connected");

                try {
                    client.subscribe(topic, () => {
                        log.debug(this.name, "MQTT subscribed to topic");
                    });
                } catch (e) {
                    finish(new Error("Cannot subscribe topic"));
                }
            });

            client.on("error", (error) => {
                finish(error);
            });

            client.on("message", (messageTopic, message) => {
                finish(null, [messageTopic, message.toString("utf8")]);
            });
        });
    }
}

export { MqttMonitorType };
