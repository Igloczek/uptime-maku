// @ts-nocheck

import { log } from "@/server/logger";
import { Kafka } from "kafkajs";

/**
 * Monitor Kafka using Producer
 * @param {string[]} brokers List of kafka brokers to connect, host and
 * port joined by ':'
 * @param {string} topic Topic name to produce into
 * @param {string} message Message to produce
 * @param {object} options Kafka client options. Contains ssl, clientId,
 * allowAutoTopicCreation and interval (interval defaults to 20,
 * allowAutoTopicCreation defaults to false, clientId defaults to
 * "iglo.monitor" and ssl defaults to false)
 * @param {object} saslOptions Options for kafka client
 * Authentication (SASL) (defaults to {})
 * @returns {Promise<string>} Status message
 */
export function kafkaProducerAsync(brokers, topic, message, options = {}, saslOptions = {}) {
    const {
        interval = 20,
        timeout = interval * 0.8,
        allowAutoTopicCreation = false,
        ssl = false,
        clientId = "iglo.monitor",
        connectionTimeout = 1,
    } = options;
    const timeoutMs = timeout * 1000;
    const requestTimeout = Math.max(1, Math.floor(timeoutMs / 2));

    if (saslOptions.mechanism === "None") {
        saslOptions = undefined;
    }

    const client = new Kafka({
        brokers,
        clientId,
        sasl: saslOptions,
        retry: { retries: 0 },
        ssl,
        connectionTimeout: Math.min(connectionTimeout * 1000, requestTimeout),
        requestTimeout,
    });
    const producer = client.producer({
        allowAutoTopicCreation,
        retry: { retries: 0 },
    });

    return new Promise((resolve, reject) => {
        let settled = false;
        let connected = false;
        const finish = async (error, result) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeoutID);
            try {
                await producer.disconnect();
            } catch (disconnectError) {
                error ||= disconnectError;
            }
            error ? reject(error) : resolve(result);
        };
        const timeoutID = setTimeout(() => {
            log.debug("kafkaProducer", "KafkaProducer timeout triggered");
            void finish(new Error("Timeout"));
        }, timeoutMs);

        void (async () => {
            try {
                await producer.connect();
                connected = true;
                await producer.send({
                    topic,
                    messages: [{ value: message }],
                });
                await finish(null, "Message sent successfully");
            } catch (error) {
                const message = connected
                    ? `Error sending message: ${error.message}`
                    : `Error in producer connection: ${error.message}`;
                await finish(new Error(message));
            }
        })();
    });
}
