<template>
    <!-- Interval -->
    <div class="my-3">
        <label for="interval" class="form-label">
            {{ $t("Heartbeat Interval") }} ({{ $t("checkEverySecond", [monitor.interval]) }})
        </label>
        <input
            id="interval"
            v-model="monitor.interval"
            type="number"
            class="form-control"
            required
            :min="minInterval"
            :max="maxInterval"
            step="1"
            @focus="lowIntervalConfirmation.editedValue = true"
            @blur="onIntervalBlur"
        />
        <div class="form-text">
            {{ monitor.humanReadableInterval }}
        </div>
        <div v-if="monitor.interval < 20" class="form-text">
            {{ $t("minimumIntervalWarning") }}
        </div>
    </div>
    <div class="my-3">
        <label for="maxRetries" class="form-label">{{ $t("Retries") }}</label>
        <input
            id="maxRetries"
            v-model="monitor.maxretries"
            type="number"
            class="form-control"
            required
            min="0"
            :max="maxRetries"
            step="1"
        />
        <div class="form-text">
            {{ $t("retriesDescription") }}
        </div>
    </div>
    <div v-if="monitor.maxretries" class="my-3">
        <label for="retry-interval" class="form-label">
            {{ $t("Heartbeat Retry Interval") }}
            <span>({{ $t("retryCheckEverySecond", [monitor.retryInterval]) }})</span>
        </label>
        <input
            id="retry-interval"
            v-model="monitor.retryInterval"
            type="number"
            class="form-control"
            required
            :min="minInterval"
            step="1"
            @focus="lowIntervalConfirmation.editedValue = true"
        />
        <div v-if="monitor.retryInterval < 20" class="form-text">
            {{ $t("minimumIntervalWarning") }}
        </div>
    </div>
    <!-- Retry only on status code failure: JSON Query only -->
    <div v-if="monitor.type === 'json-query' && monitor.maxretries > 0" class="my-3">
        <div class="form-check">
            <input
                id="retry-only-on-status-code-failure"
                v-model="monitor.retryOnlyOnStatusCodeFailure"
                type="checkbox"
                class="form-check-input"
            />
            <label for="retry-only-on-status-code-failure" class="form-check-label">
                {{ $t("Only retry if status code check fails") }}
            </label>
        </div>
        <div class="form-text">
            {{ $t("retryOnlyOnStatusCodeFailureDescription") }}
        </div>
    </div>
    <!-- Timeout: HTTP / JSON query / Keyword / Ping / RabbitMQ / SNMP / Websocket Upgrade only -->
    <div
        v-if="
            monitor.type === 'http' ||
            monitor.type === 'json-query' ||
            monitor.type === 'keyword' ||
            monitor.type === 'ping' ||
            monitor.type === 'rabbitmq' ||
            monitor.type === 'snmp' ||
            monitor.type === 'websocket-upgrade' ||
            monitor.type === 'kafka-producer'
        "
        class="my-3"
    >
        <label for="timeout" class="form-label">
            {{
                monitor.type === "ping"
                    ? $t("pingGlobalTimeoutLabel")
                    : monitor.type === "kafka-producer"
                      ? $t("Connection Timeout")
                      : $t("Request Timeout")
            }}
            <span v-if="monitor.type !== 'ping'">({{ $t("timeoutAfter", [monitor.timeout || displayTimeout]) }})</span>
        </label>
        <input
            id="timeout"
            v-model="monitor.timeout"
            type="number"
            class="form-control"
            :min="timeoutMin"
            :max="timeoutMax"
            :step="timeoutStep"
            required
        />
        <div v-if="monitor.type === 'ping'" class="form-text">
            {{ $t("pingGlobalTimeoutDescription") }}
        </div>
    </div>
</template>

<script>
import { MAX_INTERVAL_SECOND, MAX_MONITOR_RETRIES, MIN_INTERVAL_SECOND } from "@/constants";

export default {
    name: "EditMonitorHeartbeatSettings",

    props: {
        monitor: {
            type: Object,
            required: true,
        },
        lowIntervalConfirmation: {
            type: Object,
            required: true,
        },
    },

    emits: ["finish-update-interval"],

    computed: {
        minInterval() {
            return MIN_INTERVAL_SECOND;
        },

        maxInterval() {
            return MAX_INTERVAL_SECOND;
        },

        maxRetries() {
            return MAX_MONITOR_RETRIES;
        },

        timeoutStep() {
            return this.monitor.type === "ping" ? 1 : 0.1;
        },

        timeoutMin() {
            return this.monitor.type === "ping" ? 1 : 0;
        },

        timeoutMax() {
            return this.monitor.type === "ping" ? 60 : undefined;
        },

        displayTimeout() {
            return this.clampTimeout(this.monitor.interval);
        },
    },

    methods: {
        clampTimeout(timeout) {
            const maxTimeout = ~~(this.monitor.interval * 8) / 10;
            const clamped = Math.max(0, Math.min(timeout, maxTimeout));
            return Number.isFinite(clamped) ? clamped : maxTimeout;
        },

        onIntervalBlur() {
            this.$emit("finish-update-interval");
        },
    },
};
</script>
