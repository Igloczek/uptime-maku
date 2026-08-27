// @ts-nocheck

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import httpClient from "@/server/http-client";
import { Prometheus } from "@/server/prometheus";
import { log } from "@/server/logger";
import {
    UP,
    DOWN,
    PENDING,
    MAINTENANCE,
    MAX_INTERVAL_SECOND,
    MIN_INTERVAL_SECOND,
    MIN_PROVIDER_TIMEOUT_SECOND,
    MAX_MONITOR_RETRIES,
    MAX_MONITOR_REDIRECTS,
    SQL_DATETIME_FORMAT,
    PING_PACKET_SIZE_MIN,
    PING_PACKET_SIZE_MAX,
    PING_PACKET_SIZE_DEFAULT,
    PING_GLOBAL_TIMEOUT_MIN,
    PING_GLOBAL_TIMEOUT_MAX,
    PING_GLOBAL_TIMEOUT_DEFAULT,
    PING_COUNT_MIN,
    PING_COUNT_MAX,
    PING_COUNT_DEFAULT,
    PING_PER_REQUEST_TIMEOUT_MIN,
    PING_PER_REQUEST_TIMEOUT_MAX,
    PING_PER_REQUEST_TIMEOUT_DEFAULT,
    RESPONSE_BODY_LENGTH_DEFAULT,
    RESPONSE_BODY_LENGTH_MAX,
} from "@/constants";
import { flipStatus } from "@/util/status";
import { checkStatusCode, encodeBase64 } from "@/server/http-utils";
import { getTotalClientInRoom } from "@/server/client-room";
import { getOAuthClientCredentialsToken } from "@/server/oauth-client-credentials";
import { BeanModel } from "@/server/bean-model";
import { Notification } from "@/server/notification";
import { demoMode } from "@/server/config";
import { DockerHost } from "@/server/docker";
import jwt from "@/server/jwt";
import zlib from "node:zlib";
import { promisify } from "node:util";
import packageJson from "@/package-meta";
import { clearResponseCache } from "@/server/bun-response";
import { buildProxyFetchOption, resolveCoreHttpProxy } from "@/server/proxy-validation";
import { writeErrorLog } from "@/server/error-log";

const brotliCompress = promisify(zlib.brotliCompress);
const version = packageJson.version;
let rootCertificates;

dayjs.extend(utc);

function normalizeNumber(value, { error, integer = false, safeInteger = false, min, max }) {
    if (
        (typeof value !== "number" && typeof value !== "string") ||
        (typeof value === "string" && value.trim() === "")
    ) {
        throw new Error(error);
    }

    const number = Number(value);
    if (
        !Number.isFinite(number) ||
        (integer && !Number.isInteger(number)) ||
        (safeInteger && !Number.isSafeInteger(number)) ||
        number < min ||
        number > max
    ) {
        throw new Error(error);
    }
    return number;
}

function runtimeNumber(value, fallback, { integer = false, safeInteger = false, min, max }) {
    const number = Number(value);
    return Number.isFinite(number) &&
        (!integer || Number.isInteger(number)) &&
        (!safeInteger || Number.isSafeInteger(number)) &&
        number >= min &&
        number <= max
        ? number
        : fallback;
}

/**
 * status:
 *      0 = DOWN
 *      1 = UP
 *      2 = PENDING
 *      3 = MAINTENANCE
 */
class Monitor extends BeanModel {
    getEffectiveTimeout() {
        const interval = runtimeNumber(this.interval, MIN_INTERVAL_SECOND, {
            integer: true,
            min: MIN_INTERVAL_SECOND,
            max: MAX_INTERVAL_SECOND,
        });
        const minimum = this.type === "oracledb" ? 1 : MIN_PROVIDER_TIMEOUT_SECOND;
        return runtimeNumber(this.timeout, Math.max(minimum, interval * 0.8), {
            min: minimum,
            max: MAX_INTERVAL_SECOND,
        });
    }

    normalizeRuntimeConfig() {
        this.interval = runtimeNumber(this.interval, MIN_INTERVAL_SECOND, {
            integer: true,
            min: MIN_INTERVAL_SECOND,
            max: MAX_INTERVAL_SECOND,
        });
        this.retryInterval = runtimeNumber(this.retryInterval, this.interval, {
            integer: true,
            min: MIN_INTERVAL_SECOND,
            max: MAX_INTERVAL_SECOND,
        });
        this.resendInterval = runtimeNumber(this.resendInterval, 0, {
            safeInteger: true,
            min: 0,
            max: Number.MAX_SAFE_INTEGER,
        });
        this.maxretries = runtimeNumber(this.maxretries, 0, {
            safeInteger: true,
            min: 0,
            max: MAX_MONITOR_RETRIES,
        });
        this.timeout = this.getEffectiveTimeout();
        this.maxredirects = runtimeNumber(this.maxredirects, 10, {
            safeInteger: true,
            min: 0,
            max: MAX_MONITOR_REDIRECTS,
        });
        this.response_max_length = runtimeNumber(
            this.response_max_length !== undefined ? this.response_max_length : this.responseMaxLength,
            RESPONSE_BODY_LENGTH_DEFAULT,
            {
                integer: true,
                min: 0,
                max: RESPONSE_BODY_LENGTH_MAX,
            }
        );
        this.port =
            this.port === null || this.port === undefined || (typeof this.port === "string" && !this.port.trim())
                ? null
                : runtimeNumber(this.port, null, { integer: true, min: 0, max: 65535 });

        if (this.type === "ping") {
            this.packetSize = runtimeNumber(this.packetSize, PING_PACKET_SIZE_DEFAULT, {
                integer: true,
                min: PING_PACKET_SIZE_MIN,
                max: PING_PACKET_SIZE_MAX,
            });
            this.ping_count = runtimeNumber(this.ping_count, PING_COUNT_DEFAULT, {
                integer: true,
                min: PING_COUNT_MIN,
                max: PING_COUNT_MAX,
            });
            this.ping_per_request_timeout = runtimeNumber(
                this.ping_per_request_timeout,
                PING_PER_REQUEST_TIMEOUT_DEFAULT,
                {
                    integer: true,
                    min: PING_PER_REQUEST_TIMEOUT_MIN,
                    max: PING_PER_REQUEST_TIMEOUT_MAX,
                }
            );
        }

        if (this.type === "real-browser") {
            this.screenshot_delay = runtimeNumber(this.screenshot_delay, 0, {
                safeInteger: true,
                min: 0,
                max: Number.MAX_SAFE_INTEGER,
            });
        }
    }

    /**
     * Return an object that ready to parse to JSON for public Only show
     * necessary data to public
     * @param {boolean} showTags Include tags in JSON
     * @param {boolean} certExpiry Include certificate expiry info in
     * JSON
     * @returns {Promise<object>} Object ready to parse
     */
    async toPublicJSON(showTags = false, certExpiry = false) {
        let obj = {
            id: this.id,
            name: this.name,
            sendUrl: this.sendUrl,
            type: this.type,
        };

        if (this.sendUrl) {
            obj.url = this.customUrl ?? this.url;
        }

        if (showTags) {
            obj.tags = await this.getTags();
        }

        if (certExpiry) {
            const { certExpiryDaysRemaining, validCert } = await this.getCertExpiry(this.id);
            obj.certExpiryDaysRemaining = certExpiryDaysRemaining;
            obj.validCert = validCert;
        }

        return obj;
    }

    /**
     * Return an object that ready to parse to JSON
     * @param {object} preloadData to prevent n+1 problems, we query the data in a batch outside of this function
     * @param {boolean} includeSensitiveData Include sensitive data in
     * JSON
     * @returns {object} Object ready to parse
     */
    toJSON(preloadData = {}, includeSensitiveData = true) {
        let screenshot = null;

        if (this.type === "real-browser") {
            screenshot = "/screenshots/" + jwt.sign(this.id, preloadData.jwtSecret) + ".png";
        }

        const path = preloadData.paths.get(this.id) || [];
        const pathName = path.join(" / ");

        let data = {
            id: this.id,
            name: this.name,
            description: this.description,
            path,
            pathName,
            parent: this.parent,
            childrenIDs: preloadData.childrenIDs.get(this.id) || [],
            url: this.url,
            wsIgnoreSecWebsocketAcceptHeader: this.getWsIgnoreSecWebsocketAcceptHeader(),
            wsSubprotocol: this.wsSubprotocol,
            method: this.method,
            hostname: this.hostname,
            port: this.port,
            location: this.location,
            protocol: this.protocol,
            maxretries: this.maxretries,
            weight: this.weight,
            active: preloadData.activeStatus.get(this.id),
            forceInactive: preloadData.forceInactive.get(this.id),
            type: this.type,
            subtype: this.subtype,
            timeout: this.timeout,
            interval: this.interval,
            retryInterval: this.retryInterval,
            retryOnlyOnStatusCodeFailure: Boolean(this.retry_only_on_status_code_failure),
            resendInterval: this.resendInterval,
            keyword: this.keyword,
            invertKeyword: this.isInvertKeyword(),
            expiryNotification: this.isEnabledExpiryNotification(),
            domainExpiryNotification: Boolean(this.domainExpiryNotification),
            ignoreTls: this.getIgnoreTls(),
            upsideDown: this.isUpsideDown(),
            packetSize: this.packetSize,
            maxredirects: this.maxredirects,
            accepted_statuscodes: this.getAcceptedStatuscodes(),
            dns_resolve_type: this.dns_resolve_type,
            dns_resolve_server: this.dns_resolve_server,
            dns_last_result: this.dns_last_result,
            docker_container: this.docker_container,
            docker_host: this.docker_host,
            proxyId: this.proxy_id,
            notificationIDList: preloadData.notifications.get(this.id) || {},
            tags: preloadData.tags.get(this.id) || [],
            maintenance: preloadData.maintenanceStatus.get(this.id),
            mqttTopic: this.mqttTopic,
            mqttSuccessMessage: this.mqttSuccessMessage,
            mqttCheckType: this.mqttCheckType,
            databaseQuery: this.databaseQuery,
            authMethod: this.authMethod,
            grpcUrl: this.grpcUrl,
            grpcProtobuf: this.grpcProtobuf,
            grpcMethod: this.grpcMethod,
            grpcServiceName: this.grpcServiceName,
            grpcEnableTls: this.getGrpcEnableTls(),
            radiusCalledStationId: this.radiusCalledStationId,
            radiusCallingStationId: this.radiusCallingStationId,
            game: this.game,
            gamedigGivenPortOnly: this.getGameDigGivenPortOnly(),
            httpBodyEncoding: this.httpBodyEncoding,
            jsonPath: this.jsonPath,
            expectedValue: this.expectedValue,
            system_service_name: this.system_service_name,
            kafkaProducerTopic: this.kafkaProducerTopic,
            kafkaProducerBrokers: JSON.parse(this.kafkaProducerBrokers),
            kafkaProducerSsl: this.getKafkaProducerSsl(),
            kafkaProducerAllowAutoTopicCreation: this.getKafkaProducerAllowAutoTopicCreation(),
            kafkaProducerMessage: this.kafkaProducerMessage,
            screenshot,
            screenshot_delay: this.screenshot_delay,
            cacheBust: this.getCacheBust(),
            remote_browser: this.remote_browser,
            snmpOid: this.snmpOid,
            jsonPathOperator: this.jsonPathOperator,
            snmpVersion: this.snmpVersion,
            smtpSecurity: this.smtpSecurity,
            rabbitmqNodes: JSON.parse(this.rabbitmqNodes),
            conditions: JSON.parse(this.conditions),
            ipFamily: this.ipFamily,
            expectedTlsAlert: this.expected_tls_alert,

            // ping advanced options
            ping_numeric: this.isPingNumeric(),
            ping_count: this.ping_count,
            ping_per_request_timeout: this.ping_per_request_timeout,

            // response saving options
            saveResponse: this.getSaveResponse(),
            saveErrorResponse: this.getSaveErrorResponse(),
            responseMaxLength: this.response_max_length ?? RESPONSE_BODY_LENGTH_DEFAULT,
        };

        if (includeSensitiveData) {
            data = {
                ...data,
                headers: this.headers,
                body: this.body,
                grpcBody: this.grpcBody,
                grpcMetadata: this.grpcMetadata,
                basic_auth_user: this.basic_auth_user,
                basic_auth_pass: this.basic_auth_pass,
                oauth_client_id: this.oauth_client_id,
                oauth_client_secret: this.oauth_client_secret,
                oauth_token_url: this.oauth_token_url,
                oauth_scopes: this.oauth_scopes,
                oauth_audience: this.oauth_audience,
                oauth_auth_method: this.oauth_auth_method,
                bearer_token: this.bearer_token,
                gamedigToken: this.gamedigToken,
                pushToken: this.pushToken,
                databaseConnectionString: this.databaseConnectionString,
                radiusUsername: this.radiusUsername,
                radiusPassword: this.radiusPassword,
                radiusSecret: this.radiusSecret,
                mqttUsername: this.mqttUsername,
                mqttPassword: this.mqttPassword,
                mqttWebsocketPath: this.mqttWebsocketPath,
                authWorkstation: this.authWorkstation,
                authDomain: this.authDomain,
                tlsCa: this.tlsCa,
                tlsCert: this.tlsCert,
                tlsKey: this.tlsKey,
                kafkaProducerSaslOptions: JSON.parse(this.kafkaProducerSaslOptions),
                rabbitmqUsername: this.rabbitmqUsername,
                rabbitmqPassword: this.rabbitmqPassword,
            };
        }

        data.includeSensitiveData = includeSensitiveData;
        return data;
    }

    /**
     * Get all tags applied to this monitor
     * @returns {Promise<LooseObject<any>[]>} List of tags on the
     * monitor
     */
    async getTags(store = this.__store) {
        return await store.getAll(
            "SELECT mt.*, tag.name, tag.color FROM monitor_tag mt JOIN tag ON mt.tag_id = tag.id WHERE mt.monitor_id = ? ORDER BY tag.name",
            [this.id]
        );
    }

    /**
     * Gets certificate expiry for this monitor
     * @param {number} monitorID ID of monitor to send
     * @returns {Promise<LooseObject<any>>} Certificate expiry info for
     * monitor
     */
    async getCertExpiry(monitorID, store = this.__store) {
        let tlsInfoBean = await store.findOne("monitor_tls_info", "monitor_id = ?", [monitorID]);
        let tlsInfo;
        if (tlsInfoBean) {
            tlsInfo = JSON.parse(tlsInfoBean?.info_json);
            if (tlsInfo?.valid && tlsInfo?.certInfo?.daysRemaining) {
                return {
                    certExpiryDaysRemaining: tlsInfo.certInfo.daysRemaining,
                    validCert: true,
                };
            }
        }
        return {
            certExpiryDaysRemaining: "",
            validCert: false,
        };
    }

    /**
     * Is the TLS expiry notification enabled?
     * @returns {boolean} Enabled?
     */
    isEnabledExpiryNotification() {
        return Boolean(this.expiryNotification);
    }

    /**
     * Check if ping should use numeric output only
     * @returns {boolean} True if IP addresses will be output instead of symbolic hostnames
     */
    isPingNumeric() {
        return Boolean(this.ping_numeric);
    }

    /**
     * Parse to boolean
     * @returns {boolean} Should TLS errors be ignored?
     */
    getIgnoreTls() {
        return Boolean(this.ignoreTls);
    }

    /**
     * Parse to boolean
     * @returns {boolean} Should WS headers be ignored?
     */
    getWsIgnoreSecWebsocketAcceptHeader() {
        return Boolean(this.wsIgnoreSecWebsocketAcceptHeader);
    }

    /**
     * Parse to boolean
     * @returns {boolean} Is the monitor in upside down mode?
     */
    isUpsideDown() {
        return Boolean(this.upsideDown);
    }

    /**
     * Parse to boolean
     * @returns {boolean} Invert keyword match?
     */
    isInvertKeyword() {
        return Boolean(this.invertKeyword);
    }

    /**
     * Parse to boolean
     * @returns {boolean} Enable TLS for gRPC?
     */
    getGrpcEnableTls() {
        return Boolean(this.grpcEnableTls);
    }

    /**
     * Parse to boolean
     * @returns {boolean} if cachebusting is enabled
     */
    getCacheBust() {
        return Boolean(this.cacheBust);
    }

    /**
     * Get accepted status codes
     * @returns {object} Accepted status codes
     */
    getAcceptedStatuscodes() {
        return JSON.parse(this.accepted_statuscodes_json);
    }

    /**
     * Get if game dig should only use the port which was provided
     * @returns {boolean} gamedig should only use the provided port
     */
    getGameDigGivenPortOnly() {
        return Boolean(this.gamedigGivenPortOnly);
    }

    /**
     * Parse to boolean
     * @returns {boolean} Kafka Producer Ssl enabled?
     */
    getKafkaProducerSsl() {
        return Boolean(this.kafkaProducerSsl);
    }

    /**
     * Parse to boolean
     * @returns {boolean} Kafka Producer Allow Auto Topic Creation Enabled?
     */
    getKafkaProducerAllowAutoTopicCreation() {
        return Boolean(this.kafkaProducerAllowAutoTopicCreation);
    }

    /**
     * Parse to boolean
     * @returns {boolean} Should save response data on success?
     */
    getSaveResponse() {
        return Boolean(this.save_response);
    }

    /**
     * Parse to boolean
     * @returns {boolean} Should save response data on error?
     */
    getSaveErrorResponse() {
        return Boolean(this.save_error_response);
    }

    /**
     * Start monitor
     * @param {Server} io Socket server instance
     * @returns {Promise<void>}
     */
    async start(io, heartbeatData, server, runHeartbeatWrite = (operation) => operation(), responseCache) {
        const store = heartbeatData.store;
        this.normalizeRuntimeConfig();
        this.clearHeartbeatTimer();
        this.isStop = false;
        const generation = (this.heartbeatGeneration || 0) + 1;
        this.heartbeatGeneration = generation;

        let previousBeat = null;
        let retries = 0;
        const isStale = () => this.isStop || this.heartbeatGeneration !== generation;

        try {
            this.prometheus = new Prometheus(this, await this.getTags(heartbeatData.store));
        } catch (e) {
            log.error("prometheus", "Please submit an issue to our GitHub repo. Prometheus update error: ", e.message);
        }

        const beat = async () => {
            if (isStale()) {
                return;
            }
            let beatInterval = this.interval;

            if (!beatInterval) {
                beatInterval = 1;
            }

            if (demoMode) {
                if (beatInterval < 20) {
                    console.log("beat interval too low, reset to 20s");
                    beatInterval = 20;
                }
            }

            // Expose here for prometheus update
            // undefined if not https
            let tlsInfo = undefined;

            if (!previousBeat || this.type === "push") {
                previousBeat = await heartbeatData.latest(this.id);
                if (previousBeat) {
                    retries = previousBeat.retries;
                }
            }

            let isFirstBeat = !previousBeat;

            let bean = heartbeatData.store.dispense("heartbeat");
            bean.monitor_id = this.id;
            bean.time = heartbeatData.store.isoDateTimeMillis(dayjs.utc());
            bean.status = DOWN;
            bean.downCount = previousBeat?.downCount || 0;

            if (this.isUpsideDown()) {
                bean.status = flipStatus(bean.status);
            }

            try {
                if (await Monitor.isUnderMaintenance(heartbeatData.store, this.id, server)) {
                    bean.msg = "Monitor under maintenance";
                    bean.status = MAINTENANCE;
                } else if (this.type === "http" || this.type === "keyword" || this.type === "json-query") {
                    // Do not do any queries/high loading things before the "bean.ping"
                    let startTime = dayjs().valueOf();
                    const deadline = startTime + this.timeout * 1000;
                    const remainingTimeout = () => {
                        const remaining = deadline - dayjs().valueOf();
                        if (remaining <= 0) {
                            throw new Error("HTTP monitor timed out");
                        }
                        return remaining;
                    };

                    // HTTP basic auth
                    let basicAuthHeader = {};
                    if (this.auth_method === "basic") {
                        basicAuthHeader = {
                            Authorization: "Basic " + encodeBase64(this.basic_auth_user, this.basic_auth_pass),
                        };
                    }

                    // Bearer token auth
                    let bearerAuthHeader = {};
                    if (this.auth_method === "bearer") {
                        bearerAuthHeader = {
                            Authorization: "Bearer " + this.bearer_token,
                        };
                    }

                    // OIDC: Basic client credential flow.
                    // Additional grants might be implemented in the future
                    let oauth2AuthHeader = {};
                    if (this.auth_method === "oauth2-cc") {
                        try {
                            if (
                                this.oauthAccessToken === undefined ||
                                new Date(this.oauthAccessToken.expires_at * 1000) <= new Date()
                            ) {
                                this.oauthAccessToken =
                                    await this.makeOAuthClientCredentialsRequest(remainingTimeout());
                            }
                            oauth2AuthHeader = {
                                Authorization:
                                    this.oauthAccessToken.token_type + " " + this.oauthAccessToken.access_token,
                            };
                        } catch (e) {
                            throw new Error("The oauth config is invalid. " + e.message);
                        }
                    }

                    let contentType = null;
                    let bodyValue = null;

                    if (this.body && typeof this.body === "string" && this.body.trim().length > 0) {
                        if (!this.httpBodyEncoding || this.httpBodyEncoding === "json") {
                            try {
                                bodyValue = JSON.parse(this.body);
                                contentType = "application/json";
                            } catch (e) {
                                throw new Error("Your JSON body is invalid. " + e.message);
                            }
                        } else if (this.httpBodyEncoding === "form") {
                            bodyValue = this.body;
                            contentType = "application/x-www-form-urlencoded";
                        } else if (this.httpBodyEncoding === "xml") {
                            bodyValue = this.body;
                            contentType = "text/xml; charset=utf-8";
                        }
                    }

                    // HTTP client options
                    const options = {
                        url: this.url,
                        method: (this.method || "get").toLowerCase(),
                        timeout: remainingTimeout(),
                        headers: {
                            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
                            ...(contentType ? { "Content-Type": contentType } : {}),
                            ...basicAuthHeader,
                            ...bearerAuthHeader,
                            ...oauth2AuthHeader,
                            ...(this.headers ? JSON.parse(this.headers) : {}),
                        },
                        maxRedirects: this.maxredirects,
                        validateStatus: (status) => {
                            return checkStatusCode(status, this.getAcceptedStatuscodes());
                        },
                    };

                    if (bodyValue) {
                        options.data = bodyValue;
                    }

                    if (this.cacheBust) {
                        const randomFloatString = Math.random().toString(36);
                        const cacheBust = randomFloatString.substring(2);
                        options.params = {
                            uptime_maku_cachebuster: cacheBust,
                        };
                    }

                    log.debug("monitor", `[${this.name}] Prepare Options for fetch`);
                    await this.assertFetchHttpTransportSupported(options, store);

                    log.debug("monitor", `[${this.name}] Fetch Options prepared (proxy: ${Boolean(options.proxy)})`);
                    log.debug("monitor", `[${this.name}] Fetch Request`);

                    // Make Request
                    let res = await this.makeHttpMonitorRequest(options, false, deadline);

                    bean.msg = `${res.status} - ${res.statusText}`;
                    bean.ping = dayjs().valueOf() - startTime;

                    // Bun fetch does not expose peer certificates, so inspect TLS separately when needed.
                    if (this.isEnabledExpiryNotification()) {
                        try {
                            const target = new URL(this.url);
                            if (target.protocol === "https:") {
                                const port = target.port ? Number(target.port) : 443;
                                const { inspectRemoteCertificate } = await import("@/server/tls-cert");
                                const inspected = await inspectRemoteCertificate(
                                    target.hostname,
                                    port,
                                    remainingTimeout()
                                );
                                if (inspected) {
                                    tlsInfo = inspected;
                                    await this.handleTlsInfo(
                                        tlsInfo,
                                        server.notificationProviderRegistry,
                                        server.settings,
                                        store
                                    );
                                }
                            }
                        } catch (error) {
                            log.debug("monitor", `[${this.name}] TLS certificate inspection skipped: ${error.message}`);
                        }
                    }

                    // in the frontend, the save response is only shown if the saveErrorResponse is set
                    if (this.getSaveResponse() && this.getSaveErrorResponse()) {
                        await this.saveResponseData(bean, res.data);
                    }

                    // eslint-disable-next-line eqeqeq
                    if (process.env.UPTIME_MAKU_LOG_RESPONSE_BODY_MONITOR_ID == this.id) {
                        log.info("monitor", res.data);
                    }

                    if (this.type === "http") {
                        bean.status = UP;
                    } else if (this.type === "keyword") {
                        let data = res.data;

                        // Convert to string for object/array
                        if (typeof data !== "string") {
                            data = JSON.stringify(data);
                        }

                        let keywordFound = data.includes(this.keyword);
                        if (keywordFound === !this.isInvertKeyword()) {
                            bean.msg += ", keyword " + (keywordFound ? "is" : "not") + " found";
                            bean.status = UP;
                        } else {
                            data = data.replace(/<[^>]*>?|[\n\r]|\s+/gm, " ").trim();
                            if (data.length > 50) {
                                data = data.substring(0, 47) + "...";
                            }
                            throw new Error(
                                bean.msg +
                                    ", but keyword is " +
                                    (keywordFound ? "present" : "not") +
                                    " in [" +
                                    data +
                                    "]"
                            );
                        }
                    } else if (this.type === "json-query") {
                        let data = res.data;

                        const { evaluateJsonQuery } = await import("@/server/json-query");
                        const { status, response } = await evaluateJsonQuery(
                            data,
                            this.jsonPath,
                            this.jsonPathOperator,
                            this.expectedValue
                        );

                        if (status) {
                            bean.status = UP;
                            bean.msg = `JSON query passes (comparing ${response} ${this.jsonPathOperator} ${this.expectedValue})`;
                        } else {
                            throw new Error(
                                `JSON query does not pass (comparing ${response} ${this.jsonPathOperator} ${this.expectedValue})`
                            );
                        }
                    }
                } else if (this.type === "ping") {
                    const { ping } = await import("@/server/ping");
                    bean.ping = await ping(
                        this.hostname,
                        this.ping_count,
                        "",
                        this.ping_numeric,
                        this.packetSize,
                        this.timeout,
                        this.ping_per_request_timeout
                    );
                    bean.msg = "";
                    bean.status = UP;
                } else if (this.type === "push") {
                    // Type: Push
                    log.debug(
                        "monitor",
                        `[${this.name}] Checking monitor at ${dayjs().format("YYYY-MM-DD HH:mm:ss.SSS")}`
                    );
                    const bufferTime = 1000; // 1s buffer to accommodate clock differences

                    if (previousBeat) {
                        const msSinceLastBeat = dayjs.utc().valueOf() - dayjs.utc(previousBeat.time).valueOf();

                        log.debug("monitor", `[${this.name}] msSinceLastBeat = ${msSinceLastBeat}`);

                        // If the previous beat was down or pending we use the regular
                        // beatInterval/retryInterval in the setTimeout further below
                        if (
                            previousBeat.status !== (this.isUpsideDown() ? DOWN : UP) ||
                            msSinceLastBeat > beatInterval * 1000 + bufferTime
                        ) {
                            bean.duration = Math.round(msSinceLastBeat / 1000);
                            throw new Error("No heartbeat in the time window");
                        } else {
                            let timeout = beatInterval * 1000 - msSinceLastBeat;
                            if (timeout < 0) {
                                timeout = bufferTime;
                            } else {
                                timeout += bufferTime;
                            }
                            // No need to insert successful heartbeat for push type, so end here
                            retries = 0;
                            log.debug("monitor", `[${this.name}] timeout = ${timeout}`);
                            this.scheduleHeartbeat(safeBeat, timeout);
                            return;
                        }
                    } else {
                        bean.duration = beatInterval;
                        throw new Error("No heartbeat in the time window");
                    }
                } else if (this.type === "docker") {
                    log.debug("monitor", `[${this.name}] Prepare Options for Axios`);

                    const options = {
                        url: `/containers/${this.docker_container}/json`,
                        timeout: this.timeout * 1000,
                        headers: {
                            Accept: "*/*",
                        },
                        tls: {
                            rejectUnauthorized: !this.getIgnoreTls(),
                        },
                    };

                    const dockerHost = await store.load("docker_host", this.docker_host);

                    if (!dockerHost) {
                        throw new Error("Failed to load docker host config");
                    }

                    if (dockerHost._dockerType === "socket") {
                        options.socketPath = dockerHost._dockerDaemon;
                        options.url = "http://localhost" + options.url;
                    } else if (dockerHost._dockerType === "tcp") {
                        options.baseURL = DockerHost.patchDockerURL(dockerHost._dockerDaemon);
                        options.tls = {
                            ...options.tls,
                            ...(await DockerHost.getHttpsAgentOptions(dockerHost._dockerType, options.baseURL)),
                        };
                        // Bun fetch cannot enable SSL_OP_LEGACY_SERVER_CONNECT for older Docker daemons.
                        log.debug(
                            "monitor",
                            `[${this.name}] Docker-over-TCP uses Bun fetch TLS; legacy TLS renegotiation is not supported`
                        );
                    }

                    log.debug("monitor", `[${this.name}] HTTP Request`);
                    let res = await httpClient.request(options);

                    if (!res.data.State) {
                        throw Error("Container state is not available");
                    }
                    if (!res.data.State.Running) {
                        throw Error("Container State is " + res.data.State.Status);
                    }
                    if (res.data.State.Paused) {
                        throw Error("Container is in a paused state");
                    }
                    if (res.data.State.Restarting) {
                        bean.status = PENDING;
                        bean.msg = "Container is reporting it is currently restarting";
                    } else if (res.data.State.Health && res.data.State.Health.Status !== "none") {
                        // if healthchecks are disabled (?), Health MAY not be present
                        if (res.data.State.Health.Status === "healthy") {
                            bean.status = UP;
                            bean.msg = "healthy";
                        } else if (res.data.State.Health.Status === "unhealthy") {
                            throw Error("Container State is unhealthy according to its healthcheck");
                        } else {
                            bean.status = PENDING;
                            bean.msg = res.data.State.Health.Status;
                        }
                    } else {
                        bean.status = UP;
                        bean.msg = `Container has not reported health and is currently ${res.data.State.Status}. As it is running, it is considered UP. Consider adding a health check for better service visibility`;
                    }
                } else if (this.type === "radius") {
                    let startTime = dayjs().valueOf();

                    // Handle monitors that were created before the
                    // update and as such don't have a value for
                    // this.port.
                    let port;
                    if (this.port == null) {
                        port = 1812;
                    } else {
                        port = this.port;
                    }

                    const { radius } = await import("@/server/radius");
                    const resp = await radius(
                        this.hostname,
                        this.radiusUsername,
                        this.radiusPassword,
                        this.radiusCalledStationId,
                        this.radiusCallingStationId,
                        this.radiusSecret,
                        port,
                        this.timeout * 1000 * 0.5
                    );

                    bean.msg = resp.code;
                    bean.status = UP;
                    bean.ping = dayjs().valueOf() - startTime;
                } else if (this.type in server.monitorTypeList) {
                    let startTime = dayjs().valueOf();
                    const monitorType = await server.getMonitorType(this.type);
                    if (!monitorType) {
                        throw new Error("Unknown Monitor Type");
                    }
                    await monitorType.check(this, bean, server, heartbeatData);

                    if (!monitorType.allowCustomStatus && bean.status !== UP) {
                        throw new Error(
                            "The monitor implementation is incorrect, non-UP error must throw error inside check()"
                        );
                    }

                    if (bean.ping === undefined || bean.ping === null) {
                        bean.ping = dayjs().valueOf() - startTime;
                    }
                } else if (this.type === "kafka-producer") {
                    let startTime = dayjs().valueOf();

                    const { kafkaProducerAsync } = await import("@/server/kafka");
                    bean.msg = await kafkaProducerAsync(
                        JSON.parse(this.kafkaProducerBrokers),
                        this.kafkaProducerTopic,
                        this.kafkaProducerMessage,
                        {
                            allowAutoTopicCreation: this.kafkaProducerAllowAutoTopicCreation,
                            ssl: this.kafkaProducerSsl,
                            clientId: `Uptime Maku/${version}`,
                            interval: this.interval,
                            timeout: this.timeout,
                            connectionTimeout: this.timeout,
                        },
                        JSON.parse(this.kafkaProducerSaslOptions)
                    );
                    bean.status = UP;
                    bean.ping = dayjs().valueOf() - startTime;
                } else {
                    throw new Error("Unknown Monitor Type");
                }

                if (this.isUpsideDown()) {
                    bean.status = flipStatus(bean.status);

                    if (bean.status === DOWN) {
                        throw new Error("Flip UP to DOWN");
                    }
                }

                retries = 0;
            } catch (error) {
                if (error?.name === "CanceledError") {
                    bean.msg = `timeout by AbortSignal (${this.timeout}s)`;
                } else {
                    bean.msg = error.message;
                }

                if (this.getSaveErrorResponse() && error?.response?.data !== undefined) {
                    await this.saveResponseData(bean, error.response.data);
                }

                // If UP come in here, it must be upside down mode
                // Just reset the retries
                if (this.isUpsideDown() && bean.status === UP) {
                    retries = 0;
                } else if (this.type === "json-query" && this.retry_only_on_status_code_failure) {
                    // For json-query monitors with retry_only_on_status_code_failure enabled,
                    // only retry if the error is NOT from JSON query evaluation
                    // JSON query errors have the message "JSON query does not pass..."
                    const isJsonQueryError =
                        typeof error.message === "string" && error.message.includes("JSON query does not pass");

                    if (isJsonQueryError) {
                        // Don't retry on JSON query failures, mark as DOWN immediately
                        retries = 0;
                    } else if (this.maxretries > 0 && retries < this.maxretries) {
                        retries++;
                        bean.status = PENDING;
                    } else {
                        // Continue counting retries during DOWN
                        retries++;
                    }
                } else {
                    // General retry logic for all other monitor types
                    if (this.maxretries > 0 && retries < this.maxretries) {
                        retries++;
                        bean.status = PENDING;
                    } else {
                        // Continue counting retries during DOWN
                        retries++;
                    }
                }
            }

            bean.retries = retries;

            if (isStale()) {
                return;
            }

            if (bean.status !== MAINTENANCE && Boolean(this.domainExpiryNotification)) {
                try {
                    const { default: DomainExpiry } = await import("@/server/model/domain_expiry");
                    const supportInfo = await DomainExpiry.checkSupport(this, server.settings);
                    const domainExpiryDate = await DomainExpiry.checkExpiry(supportInfo.domain, store, server.settings);
                    if (domainExpiryDate) {
                        DomainExpiry.sendNotifications(
                            server.notificationProviderRegistry,
                            server.settings,
                            store,
                            supportInfo.domain,
                            (await Monitor.getNotificationList(this, store)) || []
                        );
                    } else {
                        log.debug("monitor", `Failed getting expiration date for domain ${supportInfo.domain}`);
                    }
                } catch (error) {
                    if (
                        error.message === "domain_expiry_unsupported_unsupported_tld_no_rdap_endpoint" &&
                        Boolean(this.domainExpiryNotification)
                    ) {
                        log.warn(
                            "domain_expiry",
                            `Domain expiry unsupported for '.${error.meta.publicSuffix}' because its RDAP endpoint is not listed in the IANA database.`
                        );
                    }
                }
            }

            if (isStale()) {
                return;
            }

            const uptimeCalculator = await runHeartbeatWrite(() =>
                heartbeatData.runOperation(this.id, async () => {
                    if (isStale()) {
                        return null;
                    }
                    if (this.type === "push") {
                        previousBeat = await heartbeatData.latest(this.id);
                        retries = previousBeat?.retries || 0;
                        isFirstBeat = !previousBeat;
                        bean = heartbeatData.store.dispense("heartbeat");
                        bean.monitor_id = this.id;
                        bean.time = heartbeatData.store.isoDateTimeMillis(dayjs.utc());
                        bean.status = this.isUpsideDown() ? UP : DOWN;
                        bean.downCount = previousBeat?.downCount || 0;

                        if (await Monitor.isUnderMaintenance(heartbeatData.store, this.id, server)) {
                            bean.msg = "Monitor under maintenance";
                            bean.status = MAINTENANCE;
                            retries = 0;
                        } else {
                            const bufferTime = 1000;
                            if (previousBeat) {
                                const msSinceLastBeat = dayjs.utc().valueOf() - dayjs.utc(previousBeat.time).valueOf();
                                const expectedStatus = this.isUpsideDown() ? DOWN : UP;
                                if (
                                    previousBeat.status === expectedStatus &&
                                    msSinceLastBeat <= beatInterval * 1000 + bufferTime
                                ) {
                                    retries = 0;
                                    const timeout = Math.max(
                                        bufferTime,
                                        beatInterval * 1000 - msSinceLastBeat + bufferTime
                                    );
                                    this.scheduleHeartbeat(safeBeat, timeout);
                                    return null;
                                }
                                bean.duration = Math.round(msSinceLastBeat / 1000);
                            } else {
                                bean.duration = beatInterval;
                            }
                            bean.msg = "No heartbeat in the time window";
                            if (this.isUpsideDown() && bean.status === UP) {
                                retries = 0;
                            } else if (this.maxretries > 0 && retries < this.maxretries) {
                                retries++;
                                bean.status = PENDING;
                            } else {
                                retries++;
                            }
                        }
                        bean.retries = retries;
                    }

                    log.debug("monitor", `[${this.name}] Check isImportant`);
                    const isImportant = Monitor.isImportantBeat(isFirstBeat, previousBeat?.status, bean.status);
                    let shouldNotify = false;
                    bean.downCount = 0;

                    if (isImportant) {
                        bean.important = true;
                        if (Monitor.isImportantForNotification(isFirstBeat, previousBeat?.status, bean.status)) {
                            shouldNotify = true;
                        } else {
                            log.debug(
                                "monitor",
                                `[${this.name}] will not sendNotification because it is (or was) under maintenance`
                            );
                        }
                    } else {
                        bean.important = false;
                        if (bean.status === DOWN && Monitor.isResendDue(this)) {
                            log.debug(
                                "monitor",
                                `[${this.name}] sendNotification again: Resend Interval: ${this.resendInterval} minutes`
                            );
                            shouldNotify = true;
                        }
                    }

                    if (bean.status === UP) {
                        log.debug(
                            "monitor",
                            `Monitor #${this.id} '${this.name}': Successful Response: ${bean.ping} ms | Interval: ${beatInterval} seconds | Type: ${this.type}`
                        );
                    } else if (bean.status === PENDING) {
                        if (this.retryInterval > 0) {
                            beatInterval = this.retryInterval;
                        }
                        log.warn(
                            "monitor",
                            `Monitor #${this.id} '${this.name}': Pending: ${bean.msg} | Max retries: ${this.maxretries} | Retry: ${retries} | Retry Interval: ${beatInterval} seconds | Type: ${this.type}`
                        );
                    } else if (bean.status === MAINTENANCE) {
                        log.warn(
                            "monitor",
                            `Monitor #${this.id} '${this.name}': Under Maintenance | Type: ${this.type}`
                        );
                    } else {
                        log.warn(
                            "monitor",
                            `Monitor #${this.id} '${this.name}': Failing: ${bean.msg} | Interval: ${beatInterval} seconds | Type: ${this.type} | Resend Interval: ${this.resendInterval} minutes`
                        );
                    }

                    const calculator = await heartbeatData.commitWrite(bean);
                    if (isStale()) {
                        return null;
                    }

                    if (shouldNotify) {
                        log.debug("monitor", `[${this.name}] sendNotification`);
                        await Monitor.sendNotification(isFirstBeat, this, bean, heartbeatData.store, server);
                        if (!isFirstBeat || bean.status === DOWN) {
                            await Monitor.markNotificationSent(this, heartbeatData.store);
                        }
                    }

                    if (isImportant) {
                        log.debug("monitor", `[${this.name}] response cache clear`);
                        clearResponseCache(responseCache);
                        await server.sendMaintenanceListByUserID(this.user_id);
                    }

                    log.debug("monitor", `[${this.name}] Send to socket`);
                    io.to(this.user_id).emit("heartbeat", bean.toJSON());
                    await Monitor.sendStats(heartbeatData, io, this.id, this.user_id, server.settings);

                    log.debug("monitor", `[${this.name}] prometheus.update`);
                    const data24h = calculator.get24Hour();
                    const data30d = calculator.get30Day();
                    const data1y = calculator.get1Year();
                    this.prometheus?.update(bean, tlsInfo, { data24h, data30d, data1y });

                    previousBeat = bean;
                    return calculator;
                })
            );

            if (!uptimeCalculator) {
                return;
            }

            if (!isStale()) {
                log.debug("monitor", `[${this.name}] SetTimeout for next check.`);

                let intervalRemainingMs = Math.max(1, beatInterval * 1000 - dayjs().diff(dayjs.utc(bean.time)));

                log.debug("monitor", `[${this.name}] Next heartbeat in: ${intervalRemainingMs}ms`);

                this.scheduleHeartbeat(safeBeat, intervalRemainingMs);
            } else {
                log.info("monitor", `[${this.name}] isStop = true, no next check.`);
            }
        };

        /**
         * Get a heartbeat and handle errors7
         * @returns {void}
         */
        const safeBeat = () => {
            const heartbeatAbortController = new AbortController();
            this.activeHeartbeatAbortController = heartbeatAbortController;
            const activeHeartbeat = (async () => {
                try {
                    await beat();
                } catch (e) {
                    if (isStale()) {
                        return;
                    }
                    console.trace(e);
                    writeErrorLog(e, false);
                    log.error("monitor", "Please report to https://github.com/Igloczek/uptime-maku/issues");

                    if (!isStale()) {
                        log.info("monitor", "Try to restart the monitor");
                        this.scheduleHeartbeat(safeBeat, this.interval * 1000);
                    }
                }
            })();
            this.activeHeartbeat = activeHeartbeat;
            return activeHeartbeat.finally(() => {
                if (this.activeHeartbeat === activeHeartbeat) {
                    this.activeHeartbeat = null;
                }
                if (this.activeHeartbeatAbortController === heartbeatAbortController) {
                    this.activeHeartbeatAbortController = null;
                }
            });
        };

        // Delay Push Type
        if (this.type === "push") {
            this.scheduleHeartbeat(() => {
                safeBeat();
            }, this.interval * 1000);
        } else {
            safeBeat();
        }
    }

    /**
     * Schedule the next heartbeat after clearing any pending heartbeat timer.
     * @param {Function} callback Timer callback
     * @param {number} delay Delay in milliseconds
     * @returns {void}
     */
    scheduleHeartbeat(callback, delay) {
        this.clearHeartbeatTimer();
        const safeDelay = runtimeNumber(delay, MIN_INTERVAL_SECOND * 1000, {
            min: 1,
            max: MAX_INTERVAL_SECOND * 1000,
        });
        this.heartbeatInterval = setTimeout(callback, safeDelay);
    }

    /**
     * Clear any scheduled heartbeat timer.
     * @returns {void}
     */
    clearHeartbeatTimer() {
        if (this.heartbeatInterval) {
            clearTimeout(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    /**
     * Save response body to a heartbeat if response saving is enabled.
     * @param {import("redbean-node").Bean} bean Heartbeat bean to populate.
     * @param {unknown} data Response payload.
     * @returns {void}
     */
    async saveResponseData(bean, data) {
        if (data === undefined) {
            return;
        }

        let responseData = data;
        if (typeof responseData !== "string") {
            try {
                responseData = JSON.stringify(responseData);
            } catch (error) {
                responseData = String(responseData);
            }
        }

        const maxSize = this.response_max_length ?? RESPONSE_BODY_LENGTH_DEFAULT;
        if (responseData.length > maxSize) {
            responseData = responseData.substring(0, maxSize) + "... (truncated)";
        }

        // Offload brotli compression from main event loop to libuv thread pool
        bean.response = (await brotliCompress(Buffer.from(responseData, "utf8"))).toString("base64");
    }

    /**
     * Apply supported Bun fetch transport options and fail loudly for unsupported legacy options.
     * @param {object} options HTTP request options
     * @returns {Promise<void>}
     */
    async assertFetchHttpTransportSupported(options = {}, store = this.__store) {
        if (this.auth_method === "ntlm") {
            throw new Error("NTLM monitor authentication is not supported by the Bun fetch HTTP client");
        }

        if (this.auth_method === "mtls") {
            throw new Error("mTLS monitor authentication is not supported by the Bun fetch HTTP client");
        }

        if (this.ipFamily === "ipv4" || this.ipFamily === "ipv6") {
            throw new Error("Forced IP family selection is not supported by the Bun fetch HTTP client");
        }

        // TLS cert expiry is handled by a separate inspectRemoteCertificate() pass.

        const proxy = await resolveCoreHttpProxy(store, this.type, this.proxy_id, this.user_id, this.getIgnoreTls());
        if (proxy) {
            options.proxy = buildProxyFetchOption(proxy);
        }

        if (this.getIgnoreTls()) {
            options.rejectUnauthorized = false;
        }
    }

    /**
     * Make a request using the internal fetch wrapper
     * @param {object} options Options for the HTTP client
     * @param {boolean} finalCall Should this be the final call i.e
     * don't retry on failure
     * @returns {object} HTTP response
     */
    async makeHttpMonitorRequest(options, finalCall = false, deadline = Date.now() + options.timeout) {
        try {
            return await httpClient.request(options);
        } catch (error) {
            /**
             * Make a single attempt to obtain an new access token in the event that
             * the recent api request failed for authentication purposes
             */
            if (this.auth_method === "oauth2-cc" && error.response?.status === 401 && !finalCall) {
                let remaining = deadline - Date.now();
                if (remaining <= 0) {
                    throw new Error("HTTP monitor timed out while refreshing OAuth credentials");
                }
                this.oauthAccessToken = await this.makeOAuthClientCredentialsRequest(remaining);
                let oauth2AuthHeader = {
                    Authorization: this.oauthAccessToken.token_type + " " + this.oauthAccessToken.access_token,
                };
                options.headers = { ...options.headers, ...oauth2AuthHeader };
                remaining = deadline - Date.now();
                if (remaining <= 0) {
                    throw new Error("HTTP monitor timed out after refreshing OAuth credentials");
                }
                options.timeout = remaining;

                return this.makeHttpMonitorRequest(options, true, deadline);
            }

            throw error;
        }
    }

    /**
     * Stop monitor
     * @returns {Promise<void>}
     */
    async stop() {
        this.clearHeartbeatTimer();
        this.isStop = true;
        this.heartbeatGeneration = (this.heartbeatGeneration || 0) + 1;
        this.activeHeartbeatAbortController?.abort(new Error("Monitor stopped"));

        if (this.activeHeartbeat) {
            await this.activeHeartbeat;
        }

        this.prometheus?.remove();
    }

    /**
     * Get prometheus instance
     * @returns {Prometheus|undefined} Current prometheus instance
     */
    getPrometheus() {
        return this.prometheus;
    }

    /**
     * Helper Method:
     * returns URL object for further usage
     * returns null if url is invalid
     * @returns {(null|URL)} Monitor URL
     */
    getUrl() {
        try {
            return new URL(this.url);
        } catch (_) {
            return null;
        }
    }

    /**
     * Example: http: or https:
     * @returns {(null|string)} URL's protocol
     */
    getURLProtocol() {
        const url = this.getUrl();
        if (url) {
            return this.getUrl().protocol;
        } else {
            return null;
        }
    }

    /**
     * Store TLS info to database
     * @param {object} checkCertificateResult Certificate to update
     * @returns {Promise<object>} Updated certificate
     */
    async updateTlsInfo(checkCertificateResult, store = this.__store) {
        let tlsInfoBean = await store.findOne("monitor_tls_info", "monitor_id = ?", [this.id]);

        if (tlsInfoBean == null) {
            tlsInfoBean = store.dispense("monitor_tls_info");
            tlsInfoBean.monitor_id = this.id;
        } else {
            // Clear sent history if the cert changed.
            try {
                let oldCertInfo = JSON.parse(tlsInfoBean.info_json);

                let isValidObjects =
                    oldCertInfo && oldCertInfo.certInfo && checkCertificateResult && checkCertificateResult.certInfo;

                if (isValidObjects) {
                    if (oldCertInfo.certInfo.fingerprint256 !== checkCertificateResult.certInfo.fingerprint256) {
                        log.debug("monitor", "Resetting sent_history");
                        await store.exec(
                            "DELETE FROM notification_sent_history WHERE type = 'certificate' AND monitor_id = ?",
                            [this.id]
                        );
                    } else {
                        log.debug("monitor", "No need to reset sent_history");
                        log.debug("monitor", oldCertInfo.certInfo.fingerprint256);
                        log.debug("monitor", checkCertificateResult.certInfo.fingerprint256);
                    }
                } else {
                    log.debug("monitor", "Not valid object");
                }
            } catch (e) {}
        }

        tlsInfoBean.info_json = JSON.stringify(checkCertificateResult);
        await store.store(tlsInfoBean);

        return checkCertificateResult;
    }

    /**
     * Checks if the monitor is active based on itself and its parents
     * @param {number} monitorID ID of monitor to send
     * @param {boolean} active is active
     * @returns {Promise<boolean>} Is the monitor active?
     */
    static async isActive(monitorID, active, store) {
        const parentActive = await Monitor.isParentActive(monitorID, store);

        return active === 1 && parentActive;
    }

    /**
     * Send statistics to clients
     * @param {Server} io Socket server instance
     * @param {number} monitorID ID of monitor to send
     * @param {number} userID ID of user to send to
     * @returns {void}
     */
    static async sendStats(heartbeatData, io, monitorID, userID, settings) {
        const hasClients = getTotalClientInRoom(io, userID) > 0;

        if (hasClients) {
            const stats = await heartbeatData.stats(monitorID);
            // Send 24 hour average ping
            let data24h = stats.day;
            io.to(userID).emit(
                "avgPing",
                monitorID,
                data24h.avgPing === null ? null : Number(data24h.avgPing.toFixed(2))
            );

            // Send 24 hour uptime
            io.to(userID).emit("uptime", monitorID, 24, data24h.uptime);

            // Send 30 day uptime
            let data30d = stats.month;
            io.to(userID).emit("uptime", monitorID, 720, data30d.uptime);

            // Send 1-year uptime
            let data1y = stats.year;
            io.to(userID).emit("uptime", monitorID, "1y", data1y.uptime);

            // Send Cert Info
            await Monitor.sendCertInfo(heartbeatData.store, io, monitorID, userID);

            // Send domain info
            await Monitor.sendDomainInfo(heartbeatData.store, settings, io, monitorID, userID);
        } else {
            log.debug("monitor", "No clients in the room, no need to send stats");
        }
    }

    /**
     * Send certificate information to client
     * @param {Server} io Socket server instance
     * @param {number} monitorID ID of monitor to send
     * @param {number} userID ID of user to send to
     * @returns {void}
     */
    static async sendCertInfo(store, io, monitorID, userID) {
        let tlsInfo = await store.findOne("monitor_tls_info", "monitor_id = ?", [monitorID]);
        if (tlsInfo != null) {
            io.to(userID).emit("certInfo", monitorID, tlsInfo.info_json);
        }
    }

    /**
     * Send domain name information to client
     * @param {Server} io Socket server instance
     * @param {number} monitorID ID of monitor to send
     * @param {number} userID ID of user to send to
     * @returns {void}
     */
    static async sendDomainInfo(store, settings, io, monitorID, userID) {
        const monitor = await store.findOne("monitor", "id = ?", [monitorID]);

        try {
            const { default: DomainExpiry } = await import("@/server/model/domain_expiry");
            const supportInfo = await DomainExpiry.checkSupport(monitor, settings);
            const domain = await DomainExpiry.findByDomainNameOrCreate(supportInfo.domain, store);
            if (domain?.expiry) {
                io.to(userID).emit("domainInfo", monitorID, domain.daysRemaining, new Date(domain.expiry));
            }
        } catch (e) {}
    }

    /**
     * Has status of monitor changed since last beat?
     * @param {boolean} isFirstBeat Is this the first beat of this monitor?
     * @param {const} previousBeatStatus Status of the previous beat
     * @param {const} currentBeatStatus Status of the current beat
     * @returns {boolean} True if is an important beat else false
     */
    static isImportantBeat(isFirstBeat, previousBeatStatus, currentBeatStatus) {
        // * ? -> ANY STATUS = important [isFirstBeat]
        // UP -> PENDING = not important
        // * UP -> DOWN = important
        // UP -> UP = not important
        // PENDING -> PENDING = not important
        // * PENDING -> DOWN = important
        // PENDING -> UP = not important
        // DOWN -> PENDING = this case not exists
        // DOWN -> DOWN = not important
        // * DOWN -> UP = important
        // MAINTENANCE -> MAINTENANCE = not important
        // * MAINTENANCE -> UP = important
        // * MAINTENANCE -> DOWN = important
        // * DOWN -> MAINTENANCE = important
        // * UP -> MAINTENANCE = important
        return (
            isFirstBeat ||
            (previousBeatStatus === DOWN && currentBeatStatus === MAINTENANCE) ||
            (previousBeatStatus === UP && currentBeatStatus === MAINTENANCE) ||
            (previousBeatStatus === MAINTENANCE && currentBeatStatus === DOWN) ||
            (previousBeatStatus === MAINTENANCE && currentBeatStatus === UP) ||
            (previousBeatStatus === UP && currentBeatStatus === DOWN) ||
            (previousBeatStatus === DOWN && currentBeatStatus === UP) ||
            (previousBeatStatus === PENDING && currentBeatStatus === DOWN)
        );
    }

    /**
     * Check whether another notification is due while a monitor remains down.
     * The interval is configured in minutes and measured from the last notification attempt.
     * @param {Monitor} monitor Monitor to check
     * @param {number|Date|object} now Current time, useful for deterministic tests
     * @returns {boolean} True when a resend is due
     */
    static isResendDue(monitor, now = dayjs.utc()) {
        const resendInterval = Number(monitor.resendInterval);
        if (!Number.isSafeInteger(resendInterval) || resendInterval <= 0) {
            return false;
        }

        const lastNotificationAt = monitor.lastNotificationAt ?? monitor.last_notification_at;
        if (!lastNotificationAt) {
            return false;
        }

        const lastNotificationTime = dayjs.utc(lastNotificationAt).valueOf();
        const currentTime = dayjs.utc(now).valueOf();
        const intervalMilliseconds = resendInterval * 60 * 1000;

        return (
            Number.isFinite(lastNotificationTime) &&
            Number.isFinite(currentTime) &&
            currentTime - lastNotificationTime >= intervalMilliseconds
        );
    }

    /**
     * Persist the timestamp after a notification event so repeated checks do not send duplicates.
     * @param {Monitor} monitor Monitor that generated the notification
     * @param {object} store SQLite store
     * @returns {Promise<void>}
     */
    static async markNotificationSent(monitor, store) {
        const timestamp = store.isoDateTimeMillis(dayjs.utc());
        await store.exec("UPDATE monitor SET last_notification_at = ? WHERE id = ?", [timestamp, monitor.id]);
        monitor.last_notification_at = timestamp;
        monitor.lastNotificationAt = timestamp;
    }

    /**
     * Is this beat important for notifications?
     * @param {boolean} isFirstBeat Is this the first beat of this monitor?
     * @param {const} previousBeatStatus Status of the previous beat
     * @param {const} currentBeatStatus Status of the current beat
     * @returns {boolean} True if is an important beat else false
     */
    static isImportantForNotification(isFirstBeat, previousBeatStatus, currentBeatStatus) {
        // * ? -> ANY STATUS = important [isFirstBeat]
        // UP -> PENDING = not important
        // * UP -> DOWN = important
        // UP -> UP = not important
        // PENDING -> PENDING = not important
        // * PENDING -> DOWN = important
        // PENDING -> UP = not important
        // DOWN -> PENDING = this case not exists
        // DOWN -> DOWN = not important
        // * DOWN -> UP = important
        // MAINTENANCE -> MAINTENANCE = not important
        // MAINTENANCE -> UP = not important
        // * MAINTENANCE -> DOWN = important
        // DOWN -> MAINTENANCE = not important
        // UP -> MAINTENANCE = not important
        return (
            isFirstBeat ||
            (previousBeatStatus === MAINTENANCE && currentBeatStatus === DOWN) ||
            (previousBeatStatus === UP && currentBeatStatus === DOWN) ||
            (previousBeatStatus === DOWN && currentBeatStatus === UP) ||
            (previousBeatStatus === PENDING && currentBeatStatus === DOWN)
        );
    }

    /**
     * Send a notification about a monitor
     * @param {boolean} isFirstBeat Is this beat the first of this monitor?
     * @param {Monitor} monitor The monitor to send a notification about
     * @param {import("@/server/model/heartbeat")} bean Status information about monitor
     * @returns {Promise<void>}
     */
    static async sendNotification(isFirstBeat, monitor, bean, store, server) {
        if (!isFirstBeat || bean.status === DOWN) {
            const notificationList = await Monitor.getNotificationList(monitor, store);

            let text;
            if (bean.status === UP) {
                text = "✅ Up";
            } else {
                text = "🔴 Down";
            }

            let msg = `[${monitor.name}] [${text}] ${bean.msg}`;

            const heartbeatJSON = await bean.toJSONAsync({ decodeResponse: true });
            const monitorData = [{ id: monitor.id, active: monitor.active, name: monitor.name }];
            const preloadData = await Monitor.preparePreloadData(store, monitorData, server);
            // Prevent if the msg is undefined, notifications such as Discord cannot send out.
            if (!heartbeatJSON["msg"]) {
                heartbeatJSON["msg"] = "N/A";
            }

            // Also provide the time in server timezone
            heartbeatJSON["timezone"] = await server.getTimezone();
            heartbeatJSON["timezoneOffset"] = server.getTimezoneOffset();
            heartbeatJSON["localDateTime"] = dayjs
                .utc(heartbeatJSON["time"])
                .tz(heartbeatJSON["timezone"])
                .format(SQL_DATETIME_FORMAT);

            // Calculate downtime tracking information when service comes back up
            // This makes downtime information available to all notification providers
            if (bean.status === UP && monitor.id) {
                try {
                    // Filter by important = 1 to get the state transition heartbeat (e.g. UP→DOWN),
                    // not the most recent DOWN heartbeat which would be the last check before recovery.
                    const lastDownHeartbeat = await store.getRow(
                        "SELECT time FROM heartbeat WHERE monitor_id = ? AND status = ? AND important = 1 ORDER BY time DESC LIMIT 1",
                        [monitor.id, DOWN]
                    );

                    if (lastDownHeartbeat && lastDownHeartbeat.time) {
                        heartbeatJSON["lastDownTime"] = lastDownHeartbeat.time;
                    }
                } catch (error) {
                    // If we can't calculate downtime, just continue without it
                    // Silently fail to avoid disrupting notification sending
                    log.debug(
                        "monitor",
                        `[${monitor.name}] Could not calculate downtime information: ${error.message}`
                    );
                }
            }

            for (let notification of notificationList) {
                try {
                    await Notification.send(
                        server.notificationProviderRegistry,
                        JSON.parse(notification.config),
                        msg,
                        monitor.toJSON(preloadData, false),
                        heartbeatJSON
                    );
                } catch (e) {
                    log.error("monitor", "Cannot send notification to " + notification.name);
                    log.error("monitor", e);
                }
            }
        }
    }

    /**
     * Get list of notification providers for a given monitor
     * @param {Monitor} monitor Monitor to get notification providers for
     * @returns {Promise<LooseObject<any>[]>} List of notifications
     */
    static async getNotificationList(monitor, store) {
        let notificationList = await store.getAll(
            "SELECT notification.* FROM notification, monitor_notification WHERE monitor_id = ? AND monitor_notification.notification_id = notification.id ",
            [monitor.id]
        );
        return notificationList;
    }

    /**
     * Send a certificate notification when certificate expires in less
     * than target days
     * @param {string} certCN  Common Name attribute from the certificate subject
     * @param {string} certType  certificate type
     * @param {number} daysRemaining Number of days remaining on certificate
     * @param {number} targetDays Number of days to alert after
     * @param {LooseObject<any>[]} notificationList List of notification providers
     * @returns {Promise<void>}
     */
    async sendCertNotificationByTargetDays(
        certCN,
        certType,
        daysRemaining,
        targetDays,
        notificationList,
        providerRegistry,
        store
    ) {
        let row = await store.getRow(
            "SELECT * FROM notification_sent_history WHERE type = ? AND monitor_id = ? AND days <= ?",
            ["certificate", this.id, targetDays]
        );

        // Sent already, no need to send again
        if (row) {
            log.debug("monitor", "Sent already, no need to send again");
            return;
        }

        let sent = false;
        log.debug("monitor", "Send certificate notification");

        for (let notification of notificationList) {
            try {
                log.debug("monitor", "Sending to " + notification.name);
                await Notification.send(
                    providerRegistry,
                    JSON.parse(notification.config),
                    `[${this.name}][${this.url}] ${certType} certificate ${certCN} will expire in ${daysRemaining} days`
                );
                sent = true;
            } catch (e) {
                log.error("monitor", "Cannot send cert notification to " + notification.name);
                log.error("monitor", e);
            }
        }

        if (sent) {
            await store.exec("INSERT INTO notification_sent_history (type, monitor_id, days) VALUES(?, ?, ?)", [
                "certificate",
                this.id,
                targetDays,
            ]);
        }
    }

    /**
     * Get the status of the previous heartbeat
     * @param {number} monitorID ID of monitor to check
     * @returns {Promise<LooseObject<any>>} Previous heartbeat
     */
    static async getPreviousHeartbeat(store, monitorID) {
        return await store.findOne("heartbeat", " id = (select MAX(id) from heartbeat where monitor_id = ?)", [
            monitorID,
        ]);
    }

    /**
     * Check if monitor is under maintenance
     * @param {number} monitorID ID of monitor to check
     * @returns {Promise<boolean>} Is the monitor under maintenance
     */
    static async isUnderMaintenance(store, monitorID, server) {
        const maintenanceIDList = await store.getCol(
            `
            SELECT maintenance_id FROM monitor_maintenance
            WHERE monitor_id = ?
        `,
            [monitorID]
        );

        for (const maintenanceID of maintenanceIDList) {
            const maintenance = await server.getMaintenance(maintenanceID);
            if (maintenance && (await maintenance.isUnderMaintenance(server))) {
                return true;
            }
        }

        const parent = await store.getRow(
            `SELECT parent.* FROM monitor parent
             LEFT JOIN monitor child ON child.parent = parent.id
             WHERE child.id = ?`,
            [monitorID]
        );
        if (parent !== null) {
            return await Monitor.isUnderMaintenance(store, parent.id, server);
        }

        return false;
    }

    /**
     * Make sure monitor interval is between bounds
     * @returns {void}
     * @throws Interval is outside of range
     */
    validate() {
        this.interval = normalizeNumber(this.interval, {
            error: `Interval must be an integer between ${MIN_INTERVAL_SECOND} and ${MAX_INTERVAL_SECOND} seconds`,
            integer: true,
            min: MIN_INTERVAL_SECOND,
            max: MAX_INTERVAL_SECOND,
        });
        this.retryInterval = normalizeNumber(this.retryInterval, {
            error: `Retry interval must be an integer between ${MIN_INTERVAL_SECOND} and ${MAX_INTERVAL_SECOND} seconds`,
            integer: true,
            min: MIN_INTERVAL_SECOND,
            max: MAX_INTERVAL_SECOND,
        });
        this.resendInterval = normalizeNumber(this.resendInterval, {
            error: "Resend interval must be a non-negative integer number of minutes",
            safeInteger: true,
            min: 0,
            max: Number.MAX_SAFE_INTEGER,
        });
        this.maxretries = normalizeNumber(this.maxretries, {
            error: `Retries must be an integer between 0 and ${MAX_MONITOR_RETRIES}`,
            safeInteger: true,
            min: 0,
            max: MAX_MONITOR_RETRIES,
        });
        const minimumTimeout = this.type === "oracledb" ? 1 : MIN_PROVIDER_TIMEOUT_SECOND;
        this.timeout = normalizeNumber(this.timeout, {
            error: `${this.type === "oracledb" ? "Oracle timeout" : "Timeout"} must be 0 or a finite number between ${minimumTimeout} and ${MAX_INTERVAL_SECOND} seconds`,
            min: Number(this.timeout) === 0 ? 0 : minimumTimeout,
            max: MAX_INTERVAL_SECOND,
        });
        this.maxredirects = normalizeNumber(this.maxredirects, {
            error: `Max redirects must be an integer between 0 and ${MAX_MONITOR_REDIRECTS}`,
            safeInteger: true,
            min: 0,
            max: MAX_MONITOR_REDIRECTS,
        });
        this.response_max_length = normalizeNumber(
            this.response_max_length !== undefined ? this.response_max_length : this.responseMaxLength,
            {
                error: `Response max length must be an integer between 0 and ${RESPONSE_BODY_LENGTH_MAX} bytes`,
                integer: true,
                min: 0,
                max: RESPONSE_BODY_LENGTH_MAX,
            }
        );
        if (this.responseMaxLength !== undefined) {
            this.responseMaxLength = this.response_max_length;
        }
        if (this.port === null || this.port === undefined || (typeof this.port === "string" && !this.port.trim())) {
            this.port = null;
        } else {
            this.port = normalizeNumber(this.port, {
                error: "Port must be an integer between 0 and 65535",
                integer: true,
                min: 0,
                max: 65535,
            });
        }

        // Validate JSON fields to prevent invalid JSON from being stored in database
        if (this.kafkaProducerBrokers) {
            try {
                JSON.parse(this.kafkaProducerBrokers);
            } catch (e) {
                throw new Error(`Kafka Producer Brokers must be valid JSON: ${e.message}`);
            }
        }

        if (this.kafkaProducerSaslOptions) {
            try {
                JSON.parse(this.kafkaProducerSaslOptions);
            } catch (e) {
                throw new Error(`Kafka Producer SASL Options must be valid JSON: ${e.message}`);
            }
        }

        if (this.rabbitmqNodes) {
            try {
                JSON.parse(this.rabbitmqNodes);
            } catch (e) {
                throw new Error(`RabbitMQ Nodes must be valid JSON: ${e.message}`);
            }
        }

        if (this.conditions) {
            try {
                JSON.parse(this.conditions);
            } catch (e) {
                throw new Error(`Conditions must be valid JSON: ${e.message}`);
            }
        }

        if (this.headers) {
            try {
                JSON.parse(this.headers);
            } catch (e) {
                throw new Error(`Headers must be valid JSON: ${e.message}`);
            }
        }

        if (this.accepted_statuscodes_json) {
            try {
                JSON.parse(this.accepted_statuscodes_json);
            } catch (e) {
                throw new Error(`Accepted status codes must be valid JSON: ${e.message}`);
            }
        }

        if (this.type === "ping") {
            // ping parameters validation
            this.packetSize = normalizeNumber(this.packetSize, {
                error: `Packet size must be an integer between ${PING_PACKET_SIZE_MIN} and ${PING_PACKET_SIZE_MAX}`,
                integer: true,
                min: PING_PACKET_SIZE_MIN,
                max: PING_PACKET_SIZE_MAX,
            });
            this.ping_per_request_timeout = normalizeNumber(this.ping_per_request_timeout, {
                error: `Per-ping timeout must be an integer between ${PING_PER_REQUEST_TIMEOUT_MIN} and ${PING_PER_REQUEST_TIMEOUT_MAX} seconds`,
                integer: true,
                min: PING_PER_REQUEST_TIMEOUT_MIN,
                max: PING_PER_REQUEST_TIMEOUT_MAX,
            });
            this.ping_count = normalizeNumber(this.ping_count, {
                error: `Echo requests count must be an integer between ${PING_COUNT_MIN} and ${PING_COUNT_MAX}`,
                integer: true,
                min: PING_COUNT_MIN,
                max: PING_COUNT_MAX,
            });

            if (this.timeout) {
                const pingGlobalTimeout = Math.round(this.timeout);

                if (
                    pingGlobalTimeout < this.ping_per_request_timeout ||
                    pingGlobalTimeout < PING_GLOBAL_TIMEOUT_MIN ||
                    pingGlobalTimeout > PING_GLOBAL_TIMEOUT_MAX
                ) {
                    throw new Error(
                        `Timeout must be between ${PING_GLOBAL_TIMEOUT_MIN} and ${PING_GLOBAL_TIMEOUT_MAX} seconds (default: ${PING_GLOBAL_TIMEOUT_DEFAULT})`
                    );
                }

                this.timeout = pingGlobalTimeout;
            }
        }

        if (this.type === "real-browser") {
            // screenshot_delay validation
            const delay = normalizeNumber(this.screenshot_delay, {
                error: "Screenshot delay must be a non-negative safe integer",
                safeInteger: true,
                min: 0,
                max: Number.MAX_SAFE_INTEGER,
            });

            // Must not exceed 0.8 * timeout (page.goto timeout is interval * 1000 * 0.8)
            const maxDelayFromTimeout = this.interval * 1000 * 0.8;
            if (delay >= maxDelayFromTimeout) {
                throw new Error(`Screenshot delay must be less than ${maxDelayFromTimeout}ms (0.8 × interval)`);
            }

            // Must not exceed 0.5 * interval to prevent blocking next check
            const maxDelayFromInterval = this.interval * 1000 * 0.5;
            if (delay >= maxDelayFromInterval) {
                throw new Error(`Screenshot delay must be less than ${maxDelayFromInterval}ms (0.5 × interval)`);
            }
            this.screenshot_delay = delay;
        }

        if (this.type === "mongodb" && this.databaseQuery) {
            // Validate that databaseQuery is valid JSON
            try {
                JSON.parse(this.databaseQuery);
            } catch (error) {
                throw new Error(`Invalid JSON in database query: ${error.message}`);
            }
        }
    }

    /**
     * Gets monitor notification of multiple monitor
     * @param {Array} monitorIDs IDs of monitor to get
     * @returns {Promise<LooseObject<any>>} object
     */
    static async getMonitorNotification(store, monitorIDs) {
        return await store.getAll(
            `
            SELECT monitor_notification.monitor_id, monitor_notification.notification_id
            FROM monitor_notification
            WHERE monitor_notification.monitor_id IN (${monitorIDs.map((_) => "?").join(",")})
        `,
            monitorIDs
        );
    }

    /**
     * Gets monitor tags of multiple monitor
     * @param {Array} monitorIDs IDs of monitor to get
     * @returns {Promise<LooseObject<any>>} object
     */
    static async getMonitorTag(store, monitorIDs) {
        return await store.getAll(
            `
            SELECT monitor_tag.monitor_id, monitor_tag.tag_id, monitor_tag.value, tag.name, tag.color
            FROM monitor_tag
            JOIN tag ON monitor_tag.tag_id = tag.id
            WHERE monitor_tag.monitor_id IN (${monitorIDs.map((_) => "?").join(",")})
        `,
            monitorIDs
        );
    }

    /**
     * prepare preloaded data for efficient access
     * @param {Array} monitorData IDs & active field of monitor to get
     * @returns {Promise<LooseObject<any>>} object
     */
    static async preparePreloadData(store, monitorData, server) {
        const notificationsMap = new Map();
        const tagsMap = new Map();
        const maintenanceStatusMap = new Map();
        const childrenIDsMap = new Map();
        const activeStatusMap = new Map();
        const forceInactiveMap = new Map();
        const pathsMap = new Map();

        if (monitorData.length > 0) {
            const monitorIDs = monitorData.map((monitor) => monitor.id);
            const notifications = await Monitor.getMonitorNotification(store, monitorIDs);
            const tags = await Monitor.getMonitorTag(store, monitorIDs);
            const maintenanceStatuses = await Promise.all(
                monitorData.map((monitor) => Monitor.isUnderMaintenance(store, monitor.id, server))
            );
            const childrenIDs = await Promise.all(
                monitorData.map((monitor) => Monitor.getAllChildrenIDs(monitor.id, store))
            );
            const activeStatuses = await Promise.all(
                monitorData.map((monitor) => Monitor.isActive(monitor.id, monitor.active, store))
            );
            const forceInactiveStatuses = await Promise.all(
                monitorData.map((monitor) => Monitor.isParentActive(monitor.id, store))
            );
            const paths = await Promise.all(
                monitorData.map((monitor) => Monitor.getAllPath(monitor.id, monitor.name, store))
            );

            notifications.forEach((row) => {
                if (!notificationsMap.has(row.monitor_id)) {
                    notificationsMap.set(row.monitor_id, {});
                }
                notificationsMap.get(row.monitor_id)[row.notification_id] = true;
            });

            tags.forEach((row) => {
                if (!tagsMap.has(row.monitor_id)) {
                    tagsMap.set(row.monitor_id, []);
                }
                tagsMap.get(row.monitor_id).push({
                    tag_id: row.tag_id,
                    monitor_id: row.monitor_id,
                    value: row.value,
                    name: row.name,
                    color: row.color,
                });
            });

            monitorData.forEach((monitor, index) => {
                maintenanceStatusMap.set(monitor.id, maintenanceStatuses[index]);
            });

            monitorData.forEach((monitor, index) => {
                childrenIDsMap.set(monitor.id, childrenIDs[index]);
            });

            monitorData.forEach((monitor, index) => {
                activeStatusMap.set(monitor.id, activeStatuses[index]);
            });

            monitorData.forEach((monitor, index) => {
                forceInactiveMap.set(monitor.id, !forceInactiveStatuses[index]);
            });

            monitorData.forEach((monitor, index) => {
                pathsMap.set(monitor.id, paths[index]);
            });
        }

        return {
            jwtSecret: server.jwtSecret,
            notifications: notificationsMap,
            tags: tagsMap,
            maintenanceStatus: maintenanceStatusMap,
            childrenIDs: childrenIDsMap,
            activeStatus: activeStatusMap,
            forceInactive: forceInactiveMap,
            paths: pathsMap,
        };
    }

    /**
     * Gets Parent of the monitor
     * @param {number} monitorID ID of monitor to get
     * @returns {Promise<LooseObject<any>>} Parent
     */
    static async getParent(monitorID, store) {
        return await store.getRow(
            `
            SELECT parent.* FROM monitor parent
    		LEFT JOIN monitor child
    			ON child.parent = parent.id
            WHERE child.id = ?
        `,
            [monitorID]
        );
    }

    /**
     * Gets all Children of the monitor
     * @param {number} monitorID ID of monitor to get
     * @returns {Promise<LooseObject<any>[]>} Children
     */
    static async getChildren(monitorID, store) {
        return await store.getAll(
            `
            SELECT * FROM monitor
            WHERE parent = ?
        `,
            [monitorID]
        );
    }

    /**
     * Gets the full path
     * @param {number} monitorID ID of the monitor to get
     * @param {string} name of the monitor to get
     * @returns {Promise<string[]>} Full path (includes groups and the name) of the monitor
     */
    static async getAllPath(monitorID, name, store) {
        const path = [name];

        if (this.parent === null) {
            return path;
        }

        let parent = await Monitor.getParent(monitorID, store);
        while (parent !== null) {
            path.unshift(parent.name);
            parent = await Monitor.getParent(parent.id, store);
        }

        return path;
    }

    /**
     * Gets recursive all child ids
     * @param {number} monitorID ID of the monitor to get
     * @returns {Promise<Array>} IDs of all children
     */
    static async getAllChildrenIDs(monitorID, store) {
        const childs = await Monitor.getChildren(monitorID, store);

        if (childs === null) {
            return [];
        }

        let childrenIDs = [];

        for (const child of childs) {
            childrenIDs.push(child.id);
            childrenIDs = childrenIDs.concat(await Monitor.getAllChildrenIDs(child.id, store));
        }

        return childrenIDs;
    }

    /**
     * Unlinks all children of the group monitor
     * @param {number} groupID ID of group to remove children of
     * @returns {Promise<void>}
     */
    static async unlinkAllChildren(store, groupID) {
        return await store.exec("UPDATE `monitor` SET parent = ? WHERE parent = ? ", [null, groupID]);
    }

    /**
     * Delete a monitor from the system
     * @param {number} monitorID ID of the monitor to delete
     * @param {number} userID ID of the user who owns the monitor
     * @returns {Promise<void>}
     */
    static async deleteMonitor(store, server, monitorID, userID) {
        // Stop the monitor if it's running
        if (monitorID in server.monitorList) {
            await server.monitorList[monitorID].stop();
            delete server.monitorList[monitorID];
        }

        // Delete from database
        await store.exec("DELETE FROM monitor WHERE id = ? AND user_id = ? ", [monitorID, userID]);
    }

    /**
     * Recursively delete a monitor and all its descendants
     * @param {number} monitorID ID of the monitor to delete
     * @param {number} userID ID of the user who owns the monitor
     * @returns {Promise<void>}
     */
    static async deleteMonitorRecursively(store, server, monitorID, userID) {
        // Check if this monitor is a group
        const monitor = await store.findOne("monitor", " id = ? AND user_id = ? ", [monitorID, userID]);

        if (monitor && monitor.type === "group") {
            // Get all children and delete them recursively
            const children = await Monitor.getChildren(monitorID, store);
            if (children && children.length > 0) {
                for (const child of children) {
                    await Monitor.deleteMonitorRecursively(store, server, child.id, userID);
                }
            }
        }

        // Delete the monitor itself
        await Monitor.deleteMonitor(store, server, monitorID, userID);
    }

    /**
     * Checks recursive if parent (ancestors) are active
     * @param {number} monitorID ID of the monitor to get
     * @returns {Promise<boolean>} Is the parent monitor active?
     */
    static async isParentActive(monitorID, store) {
        const parent = await Monitor.getParent(monitorID, store);

        if (parent === null) {
            return true;
        }

        const parentActive = await Monitor.isParentActive(parent.id, store);
        return parent.active === 1 && parentActive;
    }

    /**
     * Obtains a new OAuth access token.
     * @returns {Promise<object>} OAuth token response
     */
    async makeOAuthClientCredentialsRequest(timeout = this.timeout * 1000) {
        log.debug("monitor", `[${this.name}] The oauth access-token undefined or expired. Requesting a new token`);
        const oAuthAccessToken = await getOAuthClientCredentialsToken(
            this.oauth_token_url,
            this.oauth_client_id,
            this.oauth_client_secret,
            this.oauth_scopes,
            this.oauth_audience,
            this.oauth_auth_method,
            timeout
        );
        if (this.oauthAccessToken?.expires_at) {
            log.debug(
                "monitor",
                `[${this.name}] Obtained oauth access-token. Expires at ${new Date(this.oauthAccessToken?.expires_at * 1000)}`
            );
        } else {
            log.debug("monitor", `[${this.name}] Obtained oauth access-token. Time until expiry was not provided`);
        }

        return oAuthAccessToken;
    }

    /**
     * Store TLS certificate information and check for expiry
     * @param {object} tlsInfo Information about the TLS connection
     * @returns {Promise<void>}
     */
    async handleTlsInfo(tlsInfo, providerRegistry, settings, store = this.__store) {
        if (!rootCertificates) {
            const { rootCertificatesFingerprints } = await import("@/server/tls-cert");
            rootCertificates ??= rootCertificatesFingerprints();
        }
        this.rootCertificates = rootCertificates;
        await this.updateTlsInfo(tlsInfo, store);
        this.prometheus?.update(null, tlsInfo, null);

        if (!this.getIgnoreTls() && this.isEnabledExpiryNotification()) {
            log.debug("monitor", `[${this.name}] call checkCertExpiryNotifications`);
            const { checkCertExpiryNotifications } = await import("@/server/tls-cert");
            await checkCertExpiryNotifications(store, settings, this, tlsInfo, providerRegistry);
        }
    }
}

export default Monitor;
