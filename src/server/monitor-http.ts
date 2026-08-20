import dayjs from "dayjs";
import httpClient from "@/server/http-client";
import { checkStatusCode, encodeBase64 } from "@/server/http-utils";
import { getOAuthClientCredentialsToken } from "@/server/oauth-client-credentials";
import { buildProxyFetchOption, resolveCoreHttpProxy } from "@/server/proxy-validation";
import { log } from "@/server/logger";
import { UP } from "@/constants";

type HttpRequestOptions = {
    url?: string;
    method?: string;
    timeout?: number;
    headers?: Record<string, string>;
    maxRedirects?: number;
    validateStatus?: (status: number) => boolean;
    data?: unknown;
    params?: Record<string, string>;
    proxy?: string | { url: string; headers: Record<string, string> };
    rejectUnauthorized?: boolean;
};

type HttpResponse = {
    data: unknown;
    status: number;
    statusText: string;
};

type HttpStore = object;

type HttpServer = {
    notificationProviderRegistry: unknown;
    settings: unknown;
};

type HttpHeartbeat = {
    msg?: string;
    ping?: number;
    status?: number;
};

type HttpMonitor = {
    type: "http" | "keyword" | "json-query";
    id?: string | number;
    name?: string;
    __store?: HttpStore;
    url: string;
    timeout: number;
    auth_method?: string | null;
    basic_auth_user?: string | null;
    basic_auth_pass?: string | null;
    bearer_token?: string | null;
    oauthAccessToken?: {
        expires_at?: number;
        token_type: string;
        access_token: string;
    };
    oauth_token_url?: string;
    oauth_client_id?: string;
    oauth_client_secret?: string;
    oauth_scopes?: string;
    oauth_audience?: string;
    oauth_auth_method?: string;
    body?: string | null;
    httpBodyEncoding?: string | null;
    headers?: string | null;
    method?: string | null;
    maxredirects?: number;
    keyword?: string;
    jsonPath?: string;
    jsonPathOperator?: string;
    expectedValue?: string;
    cacheBust?: boolean;
    user_id?: number;
    proxy_id?: number | null;
    ipFamily?: string | null;
    ignoreTls?: boolean | number;
    isInvertKeyword(): boolean;
    getAcceptedStatuscodes(): string[];
    getIgnoreTls(): boolean;
    isEnabledExpiryNotification(): boolean;
    getSaveResponse(): boolean;
    getSaveErrorResponse(): boolean;
    saveResponseData(bean: HttpHeartbeat, data: unknown): Promise<void>;
    handleTlsInfo(tlsInfo: unknown, providerRegistry: unknown, settings: unknown, store: HttpStore): Promise<void>;
};

async function assertFetchHttpTransportSupported(
    monitor: HttpMonitor,
    options: HttpRequestOptions = {},
    store: HttpStore = monitor.__store
) {
    if (monitor.auth_method === "ntlm") {
        throw new Error("NTLM monitor authentication is not supported by the Bun fetch HTTP client");
    }

    if (monitor.auth_method === "mtls") {
        throw new Error("mTLS monitor authentication is not supported by the Bun fetch HTTP client");
    }

    if (monitor.ipFamily === "ipv4" || monitor.ipFamily === "ipv6") {
        throw new Error("Forced IP family selection is not supported by the Bun fetch HTTP client");
    }

    const proxy = await resolveCoreHttpProxy(
        store,
        monitor.type,
        monitor.proxy_id,
        monitor.user_id,
        monitor.getIgnoreTls()
    );
    if (proxy) {
        options.proxy = buildProxyFetchOption(proxy);
    }

    if (monitor.getIgnoreTls()) {
        options.rejectUnauthorized = false;
    }
}

async function makeHttpMonitorRequest(
    monitor: HttpMonitor,
    options: HttpRequestOptions,
    finalCall = false,
    deadline = Date.now() + options.timeout
): Promise<HttpResponse> {
    try {
        return await httpClient.request(options);
    } catch (error) {
        if (monitor.auth_method === "oauth2-cc" && error.response?.status === 401 && !finalCall) {
            let remaining = deadline - Date.now();
            if (remaining <= 0) {
                throw new Error("HTTP monitor timed out while refreshing OAuth credentials");
            }
            monitor.oauthAccessToken = await makeOAuthClientCredentialsRequest(monitor, remaining);
            const oauth2AuthHeader = {
                Authorization: monitor.oauthAccessToken.token_type + " " + monitor.oauthAccessToken.access_token,
            };
            options.headers = { ...options.headers, ...oauth2AuthHeader };
            remaining = deadline - Date.now();
            if (remaining <= 0) {
                throw new Error("HTTP monitor timed out after refreshing OAuth credentials");
            }
            options.timeout = remaining;

            return makeHttpMonitorRequest(monitor, options, true, deadline);
        }

        throw error;
    }
}

async function makeOAuthClientCredentialsRequest(monitor: HttpMonitor, timeout = monitor.timeout * 1000) {
    log.debug("monitor", `[${monitor.name}] The oauth access-token undefined or expired. Requesting a new token`);
    const oAuthAccessToken = await getOAuthClientCredentialsToken(
        monitor.oauth_token_url,
        monitor.oauth_client_id,
        monitor.oauth_client_secret,
        monitor.oauth_scopes,
        monitor.oauth_audience,
        monitor.oauth_auth_method,
        timeout
    );
    if (monitor.oauthAccessToken?.expires_at) {
        log.debug(
            "monitor",
            `[${monitor.name}] Obtained oauth access-token. Expires at ${new Date(monitor.oauthAccessToken?.expires_at * 1000)}`
        );
    } else {
        log.debug("monitor", `[${monitor.name}] Obtained oauth access-token. Time until expiry was not provided`);
    }

    return oAuthAccessToken;
}

async function checkHttpMonitor(
    monitor: HttpMonitor,
    bean: HttpHeartbeat,
    store: HttpStore,
    server: HttpServer,
    startTime: number,
    deadline: number
) {
    let tlsInfo;
    const remainingTimeout = () => {
        const remaining = deadline - dayjs().valueOf();
        if (remaining <= 0) {
            throw new Error("HTTP monitor timed out");
        }
        return remaining;
    };

    let basicAuthHeader = {};
    if (monitor.auth_method === "basic") {
        basicAuthHeader = {
            Authorization: "Basic " + encodeBase64(monitor.basic_auth_user, monitor.basic_auth_pass),
        };
    }

    let bearerAuthHeader = {};
    if (monitor.auth_method === "bearer") {
        bearerAuthHeader = {
            Authorization: "Bearer " + monitor.bearer_token,
        };
    }

    let oauth2AuthHeader = {};
    if (monitor.auth_method === "oauth2-cc") {
        try {
            if (
                monitor.oauthAccessToken === undefined ||
                new Date(monitor.oauthAccessToken.expires_at * 1000) <= new Date()
            ) {
                monitor.oauthAccessToken = await makeOAuthClientCredentialsRequest(monitor, remainingTimeout());
            }
            oauth2AuthHeader = {
                Authorization: monitor.oauthAccessToken.token_type + " " + monitor.oauthAccessToken.access_token,
            };
        } catch (error) {
            throw new Error("The oauth config is invalid. " + error.message);
        }
    }

    let contentType = null;
    let bodyValue = null;

    if (monitor.body && typeof monitor.body === "string" && monitor.body.trim().length > 0) {
        if (!monitor.httpBodyEncoding || monitor.httpBodyEncoding === "json") {
            try {
                bodyValue = JSON.parse(monitor.body);
                contentType = "application/json";
            } catch (error) {
                throw new Error("Your JSON body is invalid. " + error.message);
            }
        } else if (monitor.httpBodyEncoding === "form") {
            bodyValue = monitor.body;
            contentType = "application/x-www-form-urlencoded";
        } else if (monitor.httpBodyEncoding === "xml") {
            bodyValue = monitor.body;
            contentType = "text/xml; charset=utf-8";
        }
    }

    const options: HttpRequestOptions = {
        url: monitor.url,
        method: (monitor.method || "get").toLowerCase(),
        timeout: remainingTimeout(),
        headers: {
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
            ...(contentType ? { "Content-Type": contentType } : {}),
            ...basicAuthHeader,
            ...bearerAuthHeader,
            ...oauth2AuthHeader,
            ...(monitor.headers ? JSON.parse(monitor.headers) : {}),
        },
        maxRedirects: monitor.maxredirects,
        validateStatus: (status) => checkStatusCode(status, monitor.getAcceptedStatuscodes()),
    };

    if (bodyValue) {
        options.data = bodyValue;
    }

    if (monitor.cacheBust) {
        const randomFloatString = Math.random().toString(36);
        const cacheBust = randomFloatString.substring(2);
        options.params = {
            uptime_maku_cachebuster: cacheBust,
        };
    }

    log.debug("monitor", `[${monitor.name}] Prepare Options for fetch`);
    await assertFetchHttpTransportSupported(monitor, options, store);

    log.debug("monitor", `[${monitor.name}] Fetch Options prepared (proxy: ${Boolean(options.proxy)})`);
    log.debug("monitor", `[${monitor.name}] Fetch Request`);

    const res = await makeHttpMonitorRequest(monitor, options, false, deadline);

    bean.msg = `${res.status} - ${res.statusText}`;
    bean.ping = dayjs().valueOf() - startTime;

    if (monitor.isEnabledExpiryNotification()) {
        try {
            const target = new URL(monitor.url);
            if (target.protocol === "https:") {
                const port = target.port ? Number(target.port) : 443;
                const { inspectRemoteCertificate } = await import("@/server/tls-cert");
                const inspected = await inspectRemoteCertificate(target.hostname, port, remainingTimeout());
                if (inspected) {
                    tlsInfo = inspected;
                    await monitor.handleTlsInfo(tlsInfo, server.notificationProviderRegistry, server.settings, store);
                }
            }
        } catch (error) {
            log.debug("monitor", `[${monitor.name}] TLS certificate inspection skipped: ${error.message}`);
        }
    }

    if (monitor.getSaveResponse() && monitor.getSaveErrorResponse()) {
        await monitor.saveResponseData(bean, res.data);
    }

    // eslint-disable-next-line eqeqeq
    if (process.env.UPTIME_MAKU_LOG_RESPONSE_BODY_MONITOR_ID == monitor.id) {
        log.info("monitor", res.data);
    }

    if (monitor.type === "http") {
        bean.status = UP;
    } else if (monitor.type === "keyword") {
        let data = typeof res.data === "string" ? res.data : (JSON.stringify(res.data) as string);

        let keywordFound = data.includes(monitor.keyword);
        if (keywordFound === !monitor.isInvertKeyword()) {
            bean.msg += ", keyword " + (keywordFound ? "is" : "not") + " found";
            bean.status = UP;
        } else {
            data = data.replace(/<[^>]*>?|[\n\r]|\s+/gm, " ").trim();
            if (data.length > 50) {
                data = data.substring(0, 47) + "...";
            }
            throw new Error(bean.msg + ", but keyword is " + (keywordFound ? "present" : "not") + " in [" + data + "]");
        }
    } else {
        const { evaluateJsonQuery } = await import("@/server/json-query");
        const { status, response } = await evaluateJsonQuery(
            res.data,
            monitor.jsonPath,
            monitor.jsonPathOperator,
            monitor.expectedValue
        );

        if (status) {
            bean.status = UP;
            bean.msg = `JSON query passes (comparing ${response} ${monitor.jsonPathOperator} ${monitor.expectedValue})`;
        } else {
            throw new Error(
                `JSON query does not pass (comparing ${response} ${monitor.jsonPathOperator} ${monitor.expectedValue})`
            );
        }
    }

    return tlsInfo;
}

export {
    assertFetchHttpTransportSupported,
    checkHttpMonitor,
    makeHttpMonitorRequest,
    makeOAuthClientCredentialsRequest,
};
