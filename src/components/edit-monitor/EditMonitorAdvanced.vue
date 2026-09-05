<template>
    <h2 v-if="monitor.type !== 'push'" class="mt-5 mb-2">{{ $t("Advanced") }}</h2>
    <div
        v-if="
            monitor.type === 'http' ||
            monitor.type === 'keyword' ||
            monitor.type === 'json-query' ||
            (monitor.type === 'port' && ['starttls', 'secure'].includes(monitor.smtpSecurity)) ||
            (monitor.type === 'globalping' && monitor.subtype === 'http')
        "
        class="my-3 form-check"
        :title="monitor.ignoreTls ? $t('ignoredTLSError') : ''"
    >
        <input
            id="expiry-notification"
            v-model="monitor.expiryNotification"
            class="form-check-input"
            type="checkbox"
            :disabled="monitor.ignoreTls"
        />
        <label class="form-check-label" for="expiry-notification">
            {{ $t("Certificate Expiry Notification") }}
        </label>
        <div class="form-text">
            {{ $t("certificateExpiryNotificationHelp") }}
        </div>
    </div>
    <!-- Screenshot Delay - Real Browser only -->
    <div v-if="monitor.type === 'real-browser'" class="my-3">
        <label for="screenshot-delay" class="form-label">
            {{
                $t("Screenshot Delay", {
                    milliseconds: $t("milliseconds", monitor.screenshot_delay),
                })
            }}
        </label>
        <input
            id="screenshot-delay"
            v-model="monitor.screenshot_delay"
            type="number"
            class="form-control"
            min="0"
            :max="Math.floor(monitor.interval * 1000 * 0.5)"
            step="100"
        />
        <div class="form-text">
            {{
                $t("screenshotDelayDescription", {
                    maxValueMs: Math.floor(monitor.interval * 1000 * 0.5),
                })
            }}
        </div>
        <div v-if="monitor.screenshot_delay" class="form-text text-warning">
            {{ $t("screenshotDelayWarning") }}
        </div>
    </div>
    <div v-if="showDomainExpiryNotification" class="my-3 form-check">
        <input
            id="domain-expiry-notification"
            v-model="monitor.domainExpiryNotification"
            class="form-check-input"
            type="checkbox"
        />
        <label class="form-check-label" for="domain-expiry-notification">
            {{ $t("labelDomainNameExpiryNotification") }}
        </label>
        <div class="form-text">
            {{ $t("domainExpiryNotificationHelp") }}
        </div>
        <div v-if="monitor.domainExpiryNotification && domainExpiryUnsupportedReason" class="form-text">
            {{ domainExpiryUnsupportedReason }}
        </div>
    </div>
    <div v-if="monitor.type === 'websocket-upgrade'" class="my-3 form-check">
        <input
            id="wsIgnoreSecWebsocketAcceptHeader"
            v-model="monitor.wsIgnoreSecWebsocketAcceptHeader"
            class="form-check-input"
            type="checkbox"
        />
        <i18n-t
            tag="label"
            keypath="Ignore Sec-WebSocket-Accept header"
            class="form-check-label"
            for="wsIgnoreSecWebsocketAcceptHeader"
        >
            <code>Sec-Websocket-Accept</code>
        </i18n-t>
        <div class="form-text">
            {{ $t("ignoreSecWebsocketAcceptHeaderDescription") }}
        </div>
    </div>
    <div
        v-if="
            monitor.type === 'http' ||
            monitor.type === 'keyword' ||
            monitor.type === 'json-query' ||
            monitor.type === 'redis' ||
            (monitor.type === 'globalping' && monitor.subtype === 'http')
        "
        class="my-3 form-check"
    >
        <input id="ignore-tls" v-model="monitor.ignoreTls" class="form-check-input" type="checkbox" value="" />
        <label class="form-check-label" for="ignore-tls">
            {{ monitor.type === "redis" ? $t("ignoreTLSErrorGeneral") : $t("ignoreTLSError") }}
        </label>
    </div>
    <div
        v-if="
            monitor.type === 'http' ||
            monitor.type === 'keyword' ||
            monitor.type === 'json-query' ||
            (monitor.type === 'globalping' && monitor.subtype === 'http')
        "
        class="my-3 form-check"
    >
        <input id="cache-bust" v-model="monitor.cacheBust" class="form-check-input" type="checkbox" value="" />
        <label class="form-check-label" for="cache-bust">
            <i18n-t tag="label" keypath="cacheBusterParam" class="form-check-label" for="cache-bust">
                <code>iglo_monitor_cachebuster</code>
            </i18n-t>
        </label>
        <div class="form-text">
            {{ $t("cacheBusterParamDescription") }}
        </div>
    </div>
    <div class="my-3 form-check">
        <input id="upside-down" v-model="monitor.upsideDown" class="form-check-input" type="checkbox" />
        <label class="form-check-label" for="upside-down">
            {{ $t("Upside Down Mode") }}
        </label>
        <div class="form-text">
            {{ $t("upsideDownModeDescription") }}
        </div>
    </div>
    <div v-if="monitor.type === 'gamedig'" class="my-3 form-check">
        <input
            id="gamedig-guess-port"
            v-model="monitor.gamedigGivenPortOnly"
            :true-value="false"
            :false-value="true"
            class="form-check-input"
            type="checkbox"
        />
        <label class="form-check-label" for="gamedig-guess-port">
            {{ $t("gamedigGuessPort") }}
        </label>
        <div class="form-text">
            {{ $t("gamedigGuessPortDescription") }}
        </div>
    </div>
    <!-- Max Packets / Count -->
    <div v-if="monitor.type === 'ping' || (monitor.type === 'globalping' && monitor.subtype === 'ping')" class="my-3">
        <label for="ping-count" class="form-label">{{ $t("pingCountLabel") }}</label>
        <input
            id="ping-count"
            v-model="monitor.ping_count"
            type="number"
            class="form-control"
            required
            min="1"
            max="100"
            step="1"
        />
        <div class="form-text">
            {{ $t("pingCountDescription") }}
        </div>
    </div>
    <!-- Numeric Output -->
    <div v-if="monitor.type === 'ping'" class="my-3 form-check">
        <input
            id="ping_numeric"
            v-model="monitor.ping_numeric"
            type="checkbox"
            class="form-check-input"
            :checked="monitor.ping_numeric"
        />
        <label class="form-check-label" for="ping_numeric">
            {{ $t("pingNumericLabel") }}
        </label>
        <div class="form-text">
            {{ $t("pingNumericDescription") }}
        </div>
    </div>
    <!-- Packet size -->
    <div v-if="monitor.type === 'ping'" class="my-3">
        <label for="packet-size" class="form-label">{{ $t("Packet Size") }}</label>
        <input
            id="packet-size"
            v-model="monitor.packetSize"
            type="number"
            class="form-control"
            required
            min="1"
            :max="65500"
            step="1"
        />
        <div v-if="$root.info.runtime.platform === 'linux' && monitor.packetSize < 16" class="form-text text-warning">
            {{ $t("pingPacketSizeWarning") }}
        </div>
    </div>
    <!-- per-request timeout -->
    <div v-if="monitor.type === 'ping'" class="my-3">
        <label for="ping_per_request_timeout" class="form-label">
            {{ $t("pingPerRequestTimeoutLabel") }}
        </label>
        <input
            id="ping_per_request_timeout"
            v-model="monitor.ping_per_request_timeout"
            type="number"
            class="form-control"
            required
            min="0"
            max="300"
            step="1"
        />
        <div class="form-text">
            {{ $t("pingPerRequestTimeoutDescription") }}
        </div>
    </div>
    <!-- Websocket Upgrade only -->
    <template v-if="monitor.type === 'websocket-upgrade'">
        <div class="my-3">
            <label for="acceptedStatusCodes" class="form-label">
                {{ $t("Accepted Status Codes") }}
            </label>
            <VueMultiselect
                id="acceptedStatusCodes"
                v-model="monitor.accepted_statuscodes"
                :options="acceptedWebsocketCodeOptions"
                :multiple="true"
                :close-on-select="false"
                :clear-on-select="false"
                :preserve-search="true"
                :placeholder="$t('Pick Accepted Status Codes...')"
                :preselect-first="false"
                :max-height="600"
                :taggable="true"
            ></VueMultiselect>
            <div class="form-text">
                {{ $t("acceptedStatusCodesDescription") }}
            </div>
            <i18n-t tag="div" class="form-text" keypath="wsCodeDescription">
                <template #rfc6455>
                    <a
                        href="https://datatracker.ietf.org/doc/html/rfc6455#section-7.4"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        RFC 6455
                    </a>
                </template>
            </i18n-t>
        </div>
    </template>
    <!-- HTTP / Keyword only -->
    <template
        v-if="
            monitor.type === 'http' ||
            monitor.type === 'keyword' ||
            monitor.type === 'json-query' ||
            monitor.type === 'grpc-keyword'
        "
    >
        <div class="my-3">
            <label for="maxRedirects" class="form-label">{{ $t("Max. Redirects") }}</label>
            <input
                id="maxRedirects"
                v-model="monitor.maxredirects"
                type="number"
                class="form-control"
                required
                min="0"
                :max="maxRedirects"
                step="1"
            />
            <div class="form-text">
                {{ $t("maxRedirectDescription") }}
            </div>
        </div>
        <div v-if="monitor.type === 'http' || monitor.type === 'keyword' || monitor.type === 'json-query'" class="my-3">
            <div class="form-check">
                <input
                    id="saveErrorResponse"
                    v-model="monitor.saveErrorResponse"
                    class="form-check-input"
                    type="checkbox"
                />
                <label class="form-check-label" for="saveErrorResponse">
                    {{ $t("saveErrorResponseForNotifications") }}
                </label>
            </div>
            <div class="form-text">
                <i18n-t keypath="saveResponseDescription" tag="div" class="form-text">
                    <template #templateVariable>
                        <code>heartbeatJSON.response</code>
                    </template>
                </i18n-t>
            </div>
        </div>
        <div
            v-if="
                (monitor.type === 'http' || monitor.type === 'keyword' || monitor.type === 'json-query') &&
                monitor.saveErrorResponse
            "
            class="my-3"
        >
            <div class="form-check">
                <input id="saveResponse" v-model="monitor.saveResponse" class="form-check-input" type="checkbox" />
                <label class="form-check-label" for="saveResponse">
                    {{ $t("saveResponseForNotifications") }}
                </label>
            </div>
            <div class="form-text">
                <i18n-t keypath="saveResponseDescription" tag="div" class="form-text">
                    <template #templateVariable>
                        <code>heartbeatJSON.response</code>
                    </template>
                </i18n-t>
            </div>
        </div>
        <div
            v-if="
                (monitor.type === 'http' || monitor.type === 'keyword' || monitor.type === 'json-query') &&
                (monitor.saveResponse || monitor.saveErrorResponse)
            "
            class="my-3"
        >
            <label for="responseMaxLength" class="form-label">
                {{ $t("responseMaxLength") }}
            </label>
            <input
                id="responseMaxLength"
                v-model="monitor.responseMaxLength"
                type="number"
                class="form-control"
                required
                min="0"
                step="1"
            />
            <div class="form-text">
                {{ $t("responseMaxLengthDescription") }}
            </div>
        </div>
        <div class="my-3">
            <label for="acceptedStatusCodes" class="form-label">
                {{ $t("Accepted Status Codes") }}
            </label>
            <VueMultiselect
                id="acceptedStatusCodes"
                v-model="monitor.accepted_statuscodes"
                :options="acceptedStatusCodeOptions"
                :multiple="true"
                :close-on-select="false"
                :clear-on-select="false"
                :preserve-search="true"
                :placeholder="$t('Pick Accepted Status Codes...')"
                :preselect-first="false"
                :max-height="600"
                :taggable="true"
            ></VueMultiselect>
            <div class="form-text">
                {{ $t("acceptedStatusCodesDescription") }}
            </div>
        </div>
    </template>
    <!-- Globalping Accepted Status Codes -->
    <div v-if="monitor.type === 'globalping' && monitor.subtype === 'http'" class="my-3">
        <label for="acceptedStatusCodes" class="form-label">
            {{ $t("Accepted Status Codes") }}
        </label>
        <VueMultiselect
            id="acceptedStatusCodes"
            v-model="monitor.accepted_statuscodes"
            :options="acceptedStatusCodeOptions"
            :multiple="true"
            :close-on-select="false"
            :clear-on-select="false"
            :preserve-search="true"
            :placeholder="$t('Pick Accepted Status Codes...')"
            :preselect-first="false"
            :max-height="600"
            :taggable="true"
        ></VueMultiselect>
        <div class="form-text">
            {{ $t("acceptedStatusCodesDescription") }}
        </div>
    </div>
</template>

<script>
import VueMultiselect from "vue-multiselect";
import { MAX_MONITOR_REDIRECTS, TYPES_WITH_DOMAIN_EXPIRY_SUPPORT_VIA_FIELD } from "@/constants";

export default {
    name: "EditMonitorAdvanced",

    components: {
        VueMultiselect,
    },

    props: {
        monitor: {
            type: Object,
            required: true,
        },
        domainExpiryUnsupportedReason: {
            type: String,
            default: null,
        },
        acceptedStatusCodeOptions: {
            type: Array,
            required: true,
        },
        acceptedWebsocketCodeOptions: {
            type: Array,
            required: true,
        },
    },

    computed: {
        maxRedirects() {
            return MAX_MONITOR_REDIRECTS;
        },

        showDomainExpiryNotification() {
            return this.monitor.type in TYPES_WITH_DOMAIN_EXPIRY_SUPPORT_VIA_FIELD;
        },
    },
};
</script>
