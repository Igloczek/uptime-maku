// @ts-nocheck
"use strict";

import { filterAndJoin, percentageToColor, renderBadge } from "@/server/badge-renderer";
import Monitor from "@/server/model/monitor";
import dayjs from "dayjs";
import { UP, MAINTENANCE, DOWN, PENDING, badgeConstants } from "@/constants";
import { flipStatus } from "@/util/status";
import { log } from "@/server/logger";
import { Prometheus } from "@/server/prometheus";
import Database from "@/server/database";
import {
    cachedResponse,
    decodePathParam,
    httpErrorResponse,
    jsonResponse,
    queryObject,
    textResponse,
} from "@/server/bun-response";

function getHostname(request) {
    const url = new URL(request.url);
    const host = request.headers.get("host");
    if (!host) {
        return url.hostname;
    }

    if (host.startsWith("[")) {
        const end = host.indexOf("]");
        return end === -1 ? host : host.slice(1, end);
    }

    return host.split(":")[0];
}

async function resolveTrustedHostname(request, settings) {
    let hostname = getHostname(request);
    const forwardedHost = request.headers.get("x-forwarded-host");
    if ((await settings.get("trustProxy")) && forwardedHost) {
        hostname = forwardedHost;
    }
    return hostname;
}

async function entryPageResponse(request, server, settings, disableFrameSameOrigin) {
    const result = {};
    const hostname = await resolveTrustedHostname(request, settings);

    if (hostname in server.statusPageDomainMappingList) {
        result.type = "statusPageMatchedDomain";
        result.statusPageSlug = server.statusPageDomainMappingList[hostname];
    } else {
        result.type = "entryPage";
        result.entryPage = server.entryPage;
    }

    return jsonResponse(result, {
        devCors: true,
        disableFrameSameOrigin,
    });
}

async function pushResponse(url, pushToken, server, store, heartbeatData, settings, disableFrameSameOrigin) {
    try {
        let msg = url.searchParams.get("msg") || "OK";
        const pingParam = url.searchParams.get("ping");
        let ping = pingParam === null || pingParam === "" ? null : Number.parseFloat(pingParam);
        let statusString = url.searchParams.get("status") || "up";
        const statusFromParam = statusString === "up" ? UP : DOWN;

        // Validate ping value - max 100 billion ms (~3.17 years).
        // Fits safely in both BIGINT and FLOAT(20,2).
        const MAX_PING_MS = 100000000000;
        if (ping !== null && (!Number.isFinite(ping) || ping < 0 || ping > MAX_PING_MS)) {
            throw new Error(`Invalid ping value. Must be between 0 and ${MAX_PING_MS} ms.`);
        }

        let monitor = await store.findOne("monitor", " push_token = ? AND active = 1 ", [pushToken]);

        if (!monitor) {
            throw new Error("Monitor not found or not active.");
        }
        const monitorID = monitor.id;

        await heartbeatData.runOperation(monitorID, async () => {
            // Reload inside the per-monitor queue so concurrent push requests see the latest notification timestamp.
            monitor = await store.findOne("monitor", " id = ? AND active = 1 ", [monitorID]);
            if (!monitor) {
                throw new Error("Monitor not found or not active.");
            }
            monitor.normalizeRuntimeConfig();

            const previousHeartbeat = await heartbeatData.latest(monitorID);

            let isFirstBeat = true;

            let bean = store.dispense("heartbeat");
            bean.time = store.isoDateTimeMillis(dayjs.utc());
            bean.monitor_id = monitorID;
            bean.ping = ping;
            bean.msg = msg;
            bean.downCount = 0;

            if (previousHeartbeat) {
                isFirstBeat = false;
                bean.duration = dayjs(bean.time).diff(dayjs(previousHeartbeat.time), "second");
            }

            if (await Monitor.isUnderMaintenance(store, monitor.id, server)) {
                msg = "Monitor under maintenance";
                bean.status = MAINTENANCE;
            } else {
                determineStatus(statusFromParam, previousHeartbeat, monitor.maxretries, monitor.isUpsideDown(), bean);
            }

            log.debug("router", `/api/push/ called at ${dayjs().format("YYYY-MM-DD HH:mm:ss.SSS")}`);
            log.debug("router", "PreviousStatus: " + previousHeartbeat?.status);
            log.debug("router", "Current Status: " + bean.status);

            bean.important = Monitor.isImportantBeat(isFirstBeat, previousHeartbeat?.status, bean.status);
            let shouldNotify = false;

            if (Monitor.isImportantForNotification(isFirstBeat, previousHeartbeat?.status, bean.status)) {
                shouldNotify = true;
            } else if (bean.status === DOWN && Monitor.isResendDue(monitor)) {
                log.debug(
                    "monitor",
                    `[${monitor.name}] sendNotification again: Resend Interval: ${monitor.resendInterval} minutes`
                );
                shouldNotify = true;
            }

            await heartbeatData.commitWrite(bean);

            if (shouldNotify) {
                log.debug("monitor", `[${monitor.name}] sendNotification`);
                await Monitor.sendNotification(isFirstBeat, monitor, bean, store, server);
                if (!isFirstBeat || bean.status === DOWN) {
                    await Monitor.markNotificationSent(monitor, store);
                }
            }

            server.io.to(monitor.user_id).emit("heartbeat", bean.toJSON());

            await Monitor.sendStats(heartbeatData, server.io, monitor.id, monitor.user_id, settings);

            try {
                new Prometheus(monitor, await monitor.getTags(store)).update(bean, undefined);
            } catch (e) {
                log.error(
                    "prometheus",
                    "Please submit an issue to our GitHub repo. Prometheus update error: ",
                    e.message
                );
            }
        });

        return jsonResponse(
            {
                ok: true,
            },
            {
                disableFrameSameOrigin,
            }
        );
    } catch (e) {
        return jsonResponse(
            {
                ok: false,
                msg: e.message,
            },
            {
                status: 404,
                disableFrameSameOrigin,
            }
        );
    }
}

async function badgeStatusResponse(store, heartbeatData, url, id, disableFrameSameOrigin) {
    const {
        label,
        upLabel = "Up",
        downLabel = "Down",
        pendingLabel = "Pending",
        maintenanceLabel = "Maintenance",
        upColor = badgeConstants.defaultUpColor,
        downColor = badgeConstants.defaultDownColor,
        pendingColor = badgeConstants.defaultPendingColor,
        maintenanceColor = badgeConstants.defaultMaintenanceColor,
        style = badgeConstants.defaultStyle,
        value,
    } = queryObject(url.searchParams);

    try {
        const requestedMonitorId = parseInt(id, 10);
        if (Number.isNaN(requestedMonitorId)) {
            throw new Error("Invalid monitor ID");
        }
        const overrideValue = value !== undefined ? parseInt(value) : undefined;
        const publicMonitor = await isMonitorPublic(store, requestedMonitorId);
        const badgeValues = { style };

        if (!publicMonitor) {
            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            const heartbeat = await heartbeatData.latest(requestedMonitorId);
            const state = overrideValue !== undefined ? overrideValue : heartbeat.status;

            badgeValues.label = label === undefined ? "Status" : label;
            switch (state) {
                case DOWN:
                    badgeValues.color = downColor;
                    badgeValues.message = downLabel;
                    break;
                case UP:
                    badgeValues.color = upColor;
                    badgeValues.message = upLabel;
                    break;
                case PENDING:
                    badgeValues.color = pendingColor;
                    badgeValues.message = pendingLabel;
                    break;
                case MAINTENANCE:
                    badgeValues.color = maintenanceColor;
                    badgeValues.message = maintenanceLabel;
                    break;
                default:
                    badgeValues.color = badgeConstants.naColor;
                    badgeValues.message = "N/A";
            }
        }

        return svgResponse(renderBadge(badgeValues), disableFrameSameOrigin);
    } catch (error) {
        return httpErrorResponse(error.message, {
            cors: true,
            disableFrameSameOrigin,
        });
    }
}

async function badgeUptimeResponse(store, heartbeatData, url, id, duration, disableFrameSameOrigin) {
    const {
        label,
        labelPrefix,
        labelSuffix = badgeConstants.defaultUptimeLabelSuffix,
        prefix,
        suffix = badgeConstants.defaultUptimeValueSuffix,
        color,
        labelColor,
        style = badgeConstants.defaultStyle,
        value,
    } = queryObject(url.searchParams);

    try {
        const requestedMonitorId = parseInt(id, 10);
        if (Number.isNaN(requestedMonitorId)) {
            throw new Error("Invalid monitor ID");
        }

        let requestedDuration = duration !== undefined ? duration : "24h";
        const overrideValue = value && parseFloat(value);

        if (/^[0-9]+$/.test(requestedDuration)) {
            requestedDuration = `${requestedDuration}h`;
        }

        const publicMonitor = await isMonitorPublic(store, requestedMonitorId);
        const badgeValues = { style };

        if (!publicMonitor) {
            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            const uptimeCalculator = await heartbeatData.uptime.get(requestedMonitorId);
            const uptime = overrideValue ?? uptimeCalculator.getDataByDuration(requestedDuration).uptime;
            const cleanUptime = (uptime * 100).toPrecision(4);

            badgeValues.color = color ?? percentageToColor(uptime);
            badgeValues.labelColor = labelColor ?? "";
            badgeValues.label = filterAndJoin([
                labelPrefix,
                label ?? `Uptime (${requestedDuration.slice(0, -1)}${labelSuffix})`,
            ]);
            badgeValues.message = filterAndJoin([prefix, cleanUptime, suffix]);
        }

        return svgResponse(renderBadge(badgeValues), disableFrameSameOrigin);
    } catch (error) {
        return httpErrorResponse(error.message, {
            cors: true,
            disableFrameSameOrigin,
        });
    }
}

async function badgePingResponse(store, heartbeatData, url, id, duration, disableFrameSameOrigin) {
    const {
        label,
        labelPrefix,
        labelSuffix = badgeConstants.defaultPingLabelSuffix,
        prefix,
        suffix = badgeConstants.defaultPingValueSuffix,
        color = badgeConstants.defaultPingColor,
        labelColor,
        style = badgeConstants.defaultStyle,
        value,
    } = queryObject(url.searchParams);

    try {
        const requestedMonitorId = parseInt(id, 10);
        if (Number.isNaN(requestedMonitorId)) {
            throw new Error("Invalid monitor ID");
        }

        let requestedDuration = duration !== undefined ? duration : "24h";
        const overrideValue = value && parseFloat(value);

        if (/^[0-9]+$/.test(requestedDuration)) {
            requestedDuration = `${requestedDuration}h`;
        }

        const publicMonitor = await isMonitorPublic(store, requestedMonitorId);

        const badgeValues = { style };

        if (!publicMonitor) {
            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            const uptimeCalculator = await heartbeatData.uptime.get(requestedMonitorId);
            const avgPing = uptimeCalculator.getDataByDuration(requestedDuration).avgPing;
            const avgPingValue = parseInt(overrideValue ?? avgPing);

            badgeValues.color = color;
            badgeValues.labelColor = labelColor ?? "";
            badgeValues.label = filterAndJoin([
                labelPrefix,
                label ?? `Avg. Ping (${requestedDuration.slice(0, -1)}${labelSuffix})`,
            ]);
            badgeValues.message = filterAndJoin([prefix, avgPingValue, suffix]);
        }

        return svgResponse(renderBadge(badgeValues), disableFrameSameOrigin);
    } catch (error) {
        return httpErrorResponse(error.message, {
            cors: true,
            disableFrameSameOrigin,
        });
    }
}

async function badgeAvgResponseResponse(store, url, id, duration, disableFrameSameOrigin) {
    const {
        label,
        labelPrefix,
        labelSuffix,
        prefix,
        suffix = badgeConstants.defaultPingValueSuffix,
        color = badgeConstants.defaultPingColor,
        labelColor,
        style = badgeConstants.defaultStyle,
        value,
    } = queryObject(url.searchParams);

    try {
        const requestedMonitorId = parseInt(id, 10);
        if (Number.isNaN(requestedMonitorId)) {
            throw new Error("Invalid monitor ID");
        }

        const requestedDuration = Math.min(duration ? parseInt(duration, 10) : 24, 720);
        const overrideValue = value && parseFloat(value);

        const sqlHourOffset = Database.sqlHourOffset();

        const publicAvgPing = parseInt(
            await store.getCell(
                `
            SELECT AVG(ping) FROM monitor_group, \`group\`, heartbeat
            WHERE monitor_group.group_id = \`group\`.id
            AND heartbeat.time > ${sqlHourOffset}
            AND heartbeat.ping IS NOT NULL
            AND public = 1
            AND heartbeat.monitor_id = ?
            `,
                [-requestedDuration, requestedMonitorId]
            )
        );

        const badgeValues = { style };

        if (!Number.isFinite(publicAvgPing)) {
            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            const avgPing = parseInt(overrideValue ?? publicAvgPing);

            badgeValues.color = color;
            badgeValues.labelColor = labelColor ?? "";
            badgeValues.label = filterAndJoin([
                labelPrefix,
                label ?? `Avg. Response (${requestedDuration}h)`,
                labelSuffix,
            ]);
            badgeValues.message = filterAndJoin([prefix, avgPing, suffix]);
        }

        return svgResponse(renderBadge(badgeValues), disableFrameSameOrigin);
    } catch (error) {
        return httpErrorResponse(error.message, {
            cors: true,
            disableFrameSameOrigin,
        });
    }
}

async function badgeCertExpResponse(store, url, id, disableFrameSameOrigin) {
    const query = queryObject(url.searchParams);
    const date = query.date;

    const {
        label,
        labelPrefix,
        labelSuffix,
        prefix,
        suffix = date ? "" : badgeConstants.defaultCertExpValueSuffix,
        upColor = badgeConstants.defaultUpColor,
        warnColor = badgeConstants.defaultWarnColor,
        downColor = badgeConstants.defaultDownColor,
        warnDays = badgeConstants.defaultCertExpireWarnDays,
        downDays = badgeConstants.defaultCertExpireDownDays,
        labelColor,
        style = badgeConstants.defaultStyle,
        value,
    } = query;

    try {
        const requestedMonitorId = parseInt(id, 10);
        if (Number.isNaN(requestedMonitorId)) {
            throw new Error("Invalid monitor ID");
        }

        const overrideValue = value && parseFloat(value);
        const publicMonitor = await isMonitorPublic(store, requestedMonitorId);
        const badgeValues = { style };

        if (!publicMonitor) {
            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            const tlsInfoBean = await store.findOne("monitor_tls_info", "monitor_id = ?", [requestedMonitorId]);

            if (!tlsInfoBean) {
                badgeValues.message = "No/Bad Cert";
                badgeValues.color = badgeConstants.naColor;
            } else {
                const tlsInfo = JSON.parse(tlsInfoBean.info_json);

                if (!tlsInfo.valid) {
                    badgeValues.message = "Bad Cert";
                    badgeValues.color = downColor;
                } else {
                    const daysRemaining = parseInt(overrideValue ?? tlsInfo.certInfo.daysRemaining);

                    if (daysRemaining > warnDays) {
                        badgeValues.color = upColor;
                    } else if (daysRemaining > downDays) {
                        badgeValues.color = warnColor;
                    } else {
                        badgeValues.color = downColor;
                    }
                    badgeValues.labelColor = labelColor ?? "";
                    badgeValues.label = filterAndJoin([labelPrefix, label ?? "Cert Exp.", labelSuffix]);
                    badgeValues.message = filterAndJoin([
                        prefix,
                        date ? tlsInfo.certInfo.validTo : daysRemaining,
                        suffix,
                    ]);
                }
            }
        }

        return svgResponse(renderBadge(badgeValues), disableFrameSameOrigin);
    } catch (error) {
        return httpErrorResponse(error.message, {
            cors: true,
            disableFrameSameOrigin,
        });
    }
}

async function badgeResponseResponse(store, heartbeatData, url, id, disableFrameSameOrigin) {
    const {
        label,
        labelPrefix,
        labelSuffix,
        prefix,
        suffix = badgeConstants.defaultPingValueSuffix,
        color = badgeConstants.defaultPingColor,
        labelColor,
        style = badgeConstants.defaultStyle,
        value,
    } = queryObject(url.searchParams);

    try {
        const requestedMonitorId = parseInt(id, 10);
        if (Number.isNaN(requestedMonitorId)) {
            throw new Error("Invalid monitor ID");
        }

        const overrideValue = value && parseFloat(value);
        const publicMonitor = await isMonitorPublic(store, requestedMonitorId);
        const badgeValues = { style };

        if (!publicMonitor) {
            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            const heartbeat = await heartbeatData.latest(requestedMonitorId);

            if (heartbeat.ping === null || heartbeat.ping === undefined) {
                badgeValues.message = "N/A";
                badgeValues.color = badgeConstants.naColor;
            } else {
                const ping = parseInt(overrideValue ?? heartbeat.ping);

                badgeValues.color = color;
                badgeValues.labelColor = labelColor ?? "";
                badgeValues.label = filterAndJoin([labelPrefix, label ?? "Response", labelSuffix]);
                badgeValues.message = filterAndJoin([prefix, ping, suffix]);
            }
        }

        return svgResponse(renderBadge(badgeValues), disableFrameSameOrigin);
    } catch (error) {
        return httpErrorResponse(error.message, {
            cors: true,
            disableFrameSameOrigin,
        });
    }
}

function svgResponse(body, disableFrameSameOrigin) {
    return textResponse(body, {
        type: "image/svg+xml",
        cors: true,
        disableFrameSameOrigin,
    });
}

/**
 * Determines the status of the next beat in the push route handling.
 * @param {string} status The reported new status.
 * @param {object} previousHeartbeat The previous heartbeat object.
 * @param {number} maxretries The maximum number of retries allowed.
 * @param {boolean} isUpsideDown Indicates if the monitor is upside down.
 * @param {object} bean The new heartbeat object.
 * @returns {void}
 */
function determineStatus(status, previousHeartbeat, maxretries, isUpsideDown, bean) {
    if (isUpsideDown) {
        status = flipStatus(status);
    }

    if (previousHeartbeat) {
        if (previousHeartbeat.status === UP && status === DOWN) {
            if (maxretries > 0 && previousHeartbeat.retries < maxretries) {
                bean.retries = previousHeartbeat.retries + 1;
                bean.status = PENDING;
            } else {
                bean.retries = 0;
                bean.status = DOWN;
            }
        } else if (previousHeartbeat.status === PENDING && status === DOWN && previousHeartbeat.retries < maxretries) {
            bean.retries = previousHeartbeat.retries + 1;
            bean.status = PENDING;
        } else if (status === DOWN) {
            bean.retries = previousHeartbeat.retries + 1;
            bean.status = status;
        } else {
            bean.retries = 0;
            bean.status = status;
        }
    } else if (status === DOWN && maxretries > 0) {
        bean.retries = 1;
        bean.status = PENDING;
    } else {
        bean.retries = 0;
        bean.status = status;
    }
}

/**
 * Check whether a monitor is public.
 * @param {number} monitorID Monitor id
 * @returns {Promise<boolean>} true if the monitor is public, otherwise false
 */
async function isMonitorPublic(store, monitorID) {
    const publicMonitor = await store.getRow(
        `
            SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
            WHERE monitor_group.group_id = \`group\`.id
            AND monitor_group.monitor_id = ?
            AND public = 1
        `,
        [monitorID]
    );
    return !!publicMonitor;
}

async function handleApiRequest(
    request,
    { server, store, heartbeatData, settings, responseCache, disableFrameSameOrigin }
) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if ((request.method === "GET" || request.method === "HEAD") && pathname === "/api/entry-page") {
        return entryPageResponse(request, server, settings, disableFrameSameOrigin);
    }

    let match = pathname.match(/^\/api\/push\/([^/]+)$/);
    if (match) {
        const pushToken = decodePathParam(match[1]);
        return pushResponse(url, pushToken, server, store, heartbeatData, settings, disableFrameSameOrigin);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
        return null;
    }

    const cacheKey = `api:${request.method}:${url.pathname}:${url.search}`;

    match = pathname.match(/^\/api\/badge\/([^/]+)\/status$/);
    if (match) {
        const id = decodePathParam(match[1]);
        return cachedResponse(responseCache, cacheKey, "5 minutes", () =>
            badgeStatusResponse(store, heartbeatData, url, id, disableFrameSameOrigin)
        );
    }

    match = pathname.match(/^\/api\/badge\/([^/]+)\/uptime(?:\/([^/]+))?$/);
    if (match) {
        const id = decodePathParam(match[1]);
        const duration = match[2] === undefined ? undefined : decodePathParam(match[2]);
        return cachedResponse(responseCache, cacheKey, "5 minutes", () =>
            badgeUptimeResponse(store, heartbeatData, url, id, duration, disableFrameSameOrigin)
        );
    }

    match = pathname.match(/^\/api\/badge\/([^/]+)\/ping(?:\/([^/]+))?$/);
    if (match) {
        const id = decodePathParam(match[1]);
        const duration = match[2] === undefined ? undefined : decodePathParam(match[2]);
        return cachedResponse(responseCache, cacheKey, "5 minutes", () =>
            badgePingResponse(store, heartbeatData, url, id, duration, disableFrameSameOrigin)
        );
    }

    match = pathname.match(/^\/api\/badge\/([^/]+)\/avg-response(?:\/([^/]+))?$/);
    if (match) {
        const id = decodePathParam(match[1]);
        const duration = match[2] === undefined ? undefined : decodePathParam(match[2]);
        return cachedResponse(responseCache, cacheKey, "5 minutes", () =>
            badgeAvgResponseResponse(store, url, id, duration, disableFrameSameOrigin)
        );
    }

    match = pathname.match(/^\/api\/badge\/([^/]+)\/cert-exp$/);
    if (match) {
        const id = decodePathParam(match[1]);
        return cachedResponse(responseCache, cacheKey, "5 minutes", () =>
            badgeCertExpResponse(store, url, id, disableFrameSameOrigin)
        );
    }

    match = pathname.match(/^\/api\/badge\/([^/]+)\/response$/);
    if (match) {
        const id = decodePathParam(match[1]);
        return cachedResponse(responseCache, cacheKey, "5 minutes", () =>
            badgeResponseResponse(store, heartbeatData, url, id, disableFrameSameOrigin)
        );
    }

    return null;
}

export { handleApiRequest };
