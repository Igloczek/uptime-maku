// @ts-nocheck
/*
 * Uptime Maku Server
 * bun "src/server/server.ts"
 * DO NOT require("./server") in other modules, it likely creates circular dependency!
 */
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import { getRuntimeInfo, isBunRuntime } from "@/server/runtime";
import { clearWithStoppedMonitors } from "@/server/monitor-clear";
import { args } from "@/server/args";
import { sleep } from "@/util/sleep";
import { log } from "@/server/logger";
import { getRandomInt, genSecret } from "@/util/random";
import config from "@/server/config";
import { createVersionChecker, version } from "@/server/check-version";
import { SQLiteStore } from "@/server/sqlite-store";
import { SQLITE_MODEL_MAPPING } from "@/server/sqlite-model-mapping";
import { Settings } from "@/server/settings";
import jwt from "@/server/jwt";

import TranslatableError from "@/server/translatable-error";

const PASSWORD_DIVERSITY_PATTERNS = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/];
const PASSWORD_STRENGTH_LEVELS = [
    { value: "Too weak", minDiversity: 0, minLength: 0 },
    { value: "Weak", minDiversity: 2, minLength: 6 },
    { value: "Medium", minDiversity: 3, minLength: 8 },
    { value: "Strong", minDiversity: 4, minLength: 10 },
];

/**
 * Measure password strength using the same rules as check-password-strength.
 * @param {string} password Password to evaluate.
 * @returns {{ value: string }} Strength label.
 */
function passwordStrength(password) {
    let diversity = 0;
    for (const pattern of PASSWORD_DIVERSITY_PATTERNS) {
        if (pattern.test(password)) {
            diversity++;
        }
    }

    let value = "Too weak";
    for (const level of PASSWORD_STRENGTH_LEVELS) {
        if (diversity >= level.minDiversity && password.length >= level.minLength) {
            value = level.value;
        }
    }

    return { value };
}
import { verify as verifyTotp, encodeSecretForUri } from "@/server/totp";
import { UptimeMakuServer } from "@/server/uptime-maku-server";
import { listenWithBunServe } from "@/server/bun-http-server";
import Monitor from "@/server/model/monitor";
import User from "@/server/model/user";
import { shake256, SHAKE256_LENGTH } from "@/server/hash";
import { initJWTSecret, doubleCheckPassword } from "@/server/server-auth-helpers";
import { checkLogin } from "@/server/socket-auth";
import { Notification } from "@/server/notification";
import { getWebpushVapidPublicKey } from "@/server/webpush-vapid";
import Database from "@/server/database";
import { DatabaseMaintenanceCoordinator } from "@/server/database-maintenance";
import { initBackgroundJobs, stopBackgroundJobs } from "@/server/jobs";
import { loginRateLimiter, twoFaRateLimiter } from "@/server/rate-limiter";
import { login } from "@/server/auth";
import * as passwordHash from "@/server/password-hash";
import { Prometheus } from "@/server/prometheus";
import { HeartbeatDataPlane } from "@/server/heartbeat-data-plane";
import {
    sendNotificationList,
    sendHeartbeatList,
    sendInfo,
    sendProxyList,
    sendDockerHostList,
    sendAPIKeyList,
    sendRemoteBrowserList,
    sendMonitorTypeList,
} from "@/server/client";
import { statusPageSocketHandler } from "@/server/socket-handlers/status-page-socket-handler";
import { databaseSocketHandler } from "@/server/socket-handlers/database-socket-handler";
import { remoteBrowserSocketHandler } from "@/server/socket-handlers/remote-browser-socket-handler";
import TwoFA from "@/server/2fa";
import StatusPage from "@/server/model/status_page";
import { createCloudflaredRuntime } from "@/server/socket-handlers/cloudflared-socket-handler";
import { proxySocketHandler } from "@/server/socket-handlers/proxy-socket-handler";
import { resolveCoreHttpProxy } from "@/server/proxy-validation";
import { dockerSocketHandler } from "@/server/socket-handlers/docker-socket-handler";
import { maintenanceSocketHandler } from "@/server/socket-handlers/maintenance-socket-handler";
import { apiKeySocketHandler } from "@/server/socket-handlers/api-key-socket-handler";
import { generalSocketHandler } from "@/server/socket-handlers/general-socket-handler";
import { clearResponseCache, createResponseCache } from "@/server/bun-response";
import { chartSocketHandler } from "@/server/socket-handlers/chart-socket-handler";
import { writeErrorLog } from "@/server/error-log";

console.log("Welcome to Uptime Maku");

// As the log function need to use dayjs, it should be very top
dayjs.extend(customParseFormat);

if (!isBunRuntime()) {
    console.error("Error: uptime-maku now requires Bun. Start it with `bun src/server/server.ts`.");
    process.exit(1);
}
const runtimeInfo = getRuntimeInfo();
console.log(`Your ${runtimeInfo.name} version: ${runtimeInfo.version}`);

process.title = "uptime-maku";

log.debug("server", "Arguments");
log.debug("server", args);

if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = "production";
}

if (!process.env.UPTIME_MAKU_WS_ORIGIN_CHECK) {
    process.env.UPTIME_MAKU_WS_ORIGIN_CHECK = "cors-like";
}

log.info("server", "Env: " + process.env.NODE_ENV);
log.debug("server", "Inside Container: " + (process.env.UPTIME_MAKU_IS_CONTAINER === "1"));

if (process.env.UPTIME_MAKU_WS_ORIGIN_CHECK === "bypass") {
    log.warn("server", "WebSocket Origin Check: " + process.env.UPTIME_MAKU_WS_ORIGIN_CHECK);
}

if (process.env.UPTIME_MAKU_DEBUG_INSPECTOR === "1") {
    log.warn("server", "UPTIME_MAKU_DEBUG_INSPECTOR is not supported under Bun. Start Bun with --inspect instead.");
}

log.info("server", "Uptime Maku Version:", version);

log.info("server", "Loading modules");

log.debug("server", "Creating database store");
log.debug("server", "Importing 2FA Modules");

const store = new SQLiteStore({ modelMapping: SQLITE_MODEL_MAPPING });
const settings = new Settings(store);
const server = new UptimeMakuServer(store, settings);
await server.loadFrontendAssets();
const databaseMaintenance = new DatabaseMaintenanceCoordinator();
const heartbeatData = new HeartbeatDataPlane(store);
const versionChecker = createVersionChecker(settings);
const backgroundJobs = [];
const responseCache = createResponseCache();
const runHeartbeatWrite = (operation) => databaseMaintenance.run(operation);
server.io.setDatabaseMaintenanceCoordinator(databaseMaintenance);
server.io.setMaintenanceEvents(["clearEvents", "clearHeartbeats", "clearStatistics"]);
const io = server.io;
const cloudflared = createCloudflaredRuntime(io, settings);

log.debug("server", "Importing Monitor");
log.debug("server", "Importing Settings");
log.debug("server", "Importing Notification");
log.debug("server", "Importing Web-Push");
log.debug("server", "Importing Database");
log.debug("server", "Importing Background Jobs");

const hostname = config.hostname;

if (hostname) {
    log.info("server", "Custom hostname: " + hostname);
}

const port = config.port;

const disableFrameSameOrigin =
    !!process.env.UPTIME_MAKU_DISABLE_FRAME_SAMEORIGIN || args["disable-frame-sameorigin"] || false;
const cloudflaredToken = args["cloudflared-token"] || process.env.UPTIME_MAKU_CLOUDFLARED_TOKEN || undefined;

// 2FA / notp verification defaults
const twoFAVerifyOptions = {
    window: 1,
    time: 30,
};

let setupInProgress = false;

async function consumeTwoFAToken(userID, token) {
    return !!(await store.getRow(
        `
            UPDATE user
            SET twofa_last_token = ?
            WHERE id = ? AND (twofa_last_token IS NULL OR twofa_last_token != ?)
            RETURNING id
        `,
        [token, userID, token]
    ));
}

function clearTwoFAState(socket) {
    socket.pendingTwoFASecret = null;
    socket.twoFAVerified = false;
    socket.twoFAVerifiedSecret = null;
}

/**
 * Run unit test after the server is ready
 * @type {boolean}
 */
const testMode = !!args["test"] || false;

/**
 * Show Setup Page
 * @type {boolean}
 */
let needSetup = false;

(async () => {
    // Create a data directory
    Database.initDataDir(args);

    // Connect to database
    try {
        await initDatabase(testMode);
    } catch (e) {
        log.error("server", "Failed to prepare your database: " + e.message);
        process.exit(1);
    }

    // Database should be ready now
    await server.initAfterDatabaseReady(responseCache);
    server.entryPage = await settings.get("entryPage");
    await StatusPage.loadDomainMappingList(store, server.statusPageDomainMappingList);

    log.debug("server", "Initializing Prometheus");
    await Prometheus.init(store);

    log.debug("server", "Adding Bun.serve route handler");

    log.debug("server", "Adding socket handler");
    io.setConnectionInitializer(async (socket) => {
        clearTwoFAState(socket);
        socket.on("disconnect", () => clearTwoFAState(socket));
        await sendInfo(server, settings, versionChecker, socket, true);

        if (needSetup) {
            log.info("server", "Redirect to setup page");
            socket.emit("setup");
        }

        // ***************************
        // Public Socket API
        // ***************************

        socket.on("loginByToken", async (token, callback) => {
            const clientIP = await server.getClientIP(socket);

            log.info("auth", `Login by token. IP=${clientIP}`);

            try {
                let decoded = jwt.verify(token, server.jwtSecret);

                log.info("auth", "Username from JWT: " + decoded.username);

                let user = await store.findOne("user", " username = ? AND active = 1 ", [decoded.username]);

                if (user) {
                    // Check if the password changed
                    if (decoded.h !== shake256(user.password, SHAKE256_LENGTH)) {
                        throw new Error("The token is invalid due to password change or old token");
                    }
                    if (!(await User.hasSession(store, decoded.sid, user.id))) {
                        throw new Error("The session has been revoked");
                    }

                    log.debug("auth", "afterLogin");
                    socket.sessionID = decoded.sid;
                    await afterLogin(socket, user);
                    log.debug("auth", "afterLogin ok");

                    log.info("auth", `Successfully logged in user ${decoded.username}. IP=${clientIP}`);

                    callback({
                        ok: true,
                    });
                } else {
                    log.info("auth", `Inactive or deleted user ${decoded.username}. IP=${clientIP}`);

                    callback({
                        ok: false,
                        msg: "authUserInactiveOrDeleted",
                        msgi18n: true,
                    });
                }
            } catch (error) {
                log.error("auth", `Invalid token. IP=${clientIP}`);
                if (error.message) {
                    log.error("auth", error.message, `IP=${clientIP}`);
                }
                callback({
                    ok: false,
                    msg: "authInvalidToken",
                    msgi18n: true,
                });
            }
        });

        socket.on("login", async (data, callback) => {
            const clientIP = await server.getClientIP(socket);

            log.info("auth", `Login by username + password. IP=${clientIP}`);

            // Checking
            if (typeof callback !== "function") {
                return;
            }

            if (!data) {
                return;
            }

            const rateLimitKey = typeof data.username === "string" ? data.username.trim().toLowerCase() : "invalid";
            // Login Rate Limit
            if (!(await loginRateLimiter.pass(callback, 1, rateLimitKey, clientIP))) {
                log.info("auth", `Too many failed requests for user ${data.username}. IP=${clientIP}`);
                return;
            }

            let user = await login(store, data.username, data.password);

            if (user) {
                loginRateLimiter.reset(rateLimitKey);
                if (user.twofa_status === 0) {
                    const session = await User.createSession(store, user, server.jwtSecret);
                    socket.sessionID = session.id;
                    await afterLogin(socket, user);

                    log.info("auth", `Successfully logged in user ${data.username}. IP=${clientIP}`);

                    callback({
                        ok: true,
                        token: session.token,
                    });
                    return;
                }

                if (!data.token) {
                    log.info("auth", `2FA token required for user ${data.username}. IP=${clientIP}`);

                    callback({
                        tokenRequired: true,
                    });
                }

                if (data.token) {
                    if (!(await twoFaRateLimiter.pass(callback, 1, user.id))) {
                        return;
                    }
                    let verify = verifyTotp(data.token, user.twofa_secret, twoFAVerifyOptions);

                    if (verify && (await consumeTwoFAToken(user.id, data.token))) {
                        twoFaRateLimiter.reset(user.id);
                        const session = await User.createSession(store, user, server.jwtSecret);
                        socket.sessionID = session.id;
                        await afterLogin(socket, user);

                        log.info("auth", `Successfully logged in user ${data.username}. IP=${clientIP}`);

                        callback({
                            ok: true,
                            token: session.token,
                        });
                    } else {
                        log.warn("auth", `Invalid token provided for user ${data.username}. IP=${clientIP}`);

                        callback({
                            ok: false,
                            msg: "authInvalidToken",
                            msgi18n: true,
                        });
                    }
                }
            } else {
                log.warn("auth", `Incorrect username or password for user ${data.username}. IP=${clientIP}`);

                callback({
                    ok: false,
                    msg: "authIncorrectCreds",
                    msgi18n: true,
                });
            }
        });

        socket.on("logout", async (callback) => {
            const userID = socket.userID;
            const sessionID = socket.sessionID;
            await User.revokeSession(store, sessionID, userID);
            for (const connectedSocket of io.sockets.sockets.values()) {
                if (connectedSocket !== socket && connectedSocket.sessionID === sessionID) {
                    connectedSocket.disconnect();
                }
            }
            socket.leave(userID);
            socket.userID = null;
            socket.sessionID = null;
            clearTwoFAState(socket);

            if (typeof callback === "function") {
                callback();
            }
        });

        socket.on("prepare2FA", async (currentPassword, callback) => {
            try {
                checkLogin(socket);
                if (!(await twoFaRateLimiter.pass(callback, 1, socket.userID))) {
                    return;
                }
                await doubleCheckPassword(store, socket, currentPassword);

                let user = await store.findOne("user", " id = ? AND active = 1 ", [socket.userID]);

                if (user.twofa_status === 0) {
                    let newSecret = genSecret();
                    let encodedSecret = encodeSecretForUri(newSecret);

                    let uri = `otpauth://totp/Uptime Maku:${user.username}?secret=${encodedSecret}`;

                    await store.exec("UPDATE `user` SET twofa_secret = ?, twofa_last_token = NULL WHERE id = ? ", [
                        newSecret,
                        socket.userID,
                    ]);
                    socket.pendingTwoFASecret = newSecret;
                    socket.twoFAVerified = false;
                    socket.twoFAVerifiedSecret = null;
                    twoFaRateLimiter.reset(socket.userID);

                    callback({
                        ok: true,
                        uri: uri,
                    });
                } else {
                    callback({
                        ok: false,
                        msg: "2faAlreadyEnabled",
                        msgi18n: true,
                    });
                }
            } catch (error) {
                callback({
                    ok: false,
                    msg: error.message,
                });
            }
        });

        socket.on("save2FA", async (currentPassword, callback) => {
            const clientIP = await server.getClientIP(socket);

            try {
                checkLogin(socket);
                if (!(await twoFaRateLimiter.pass(callback, 1, socket.userID))) {
                    return;
                }
                await doubleCheckPassword(store, socket, currentPassword);
                if (
                    !socket.pendingTwoFASecret ||
                    !socket.twoFAVerified ||
                    socket.twoFAVerifiedSecret !== socket.pendingTwoFASecret
                ) {
                    throw new Error("Verify the 2FA token before enabling 2FA");
                }

                const saved = await store.getRow(
                    "UPDATE `user` SET twofa_status = 1 WHERE id = ? AND twofa_status = 0 AND twofa_secret = ? RETURNING id",
                    [socket.userID, socket.twoFAVerifiedSecret]
                );
                if (!saved) {
                    clearTwoFAState(socket);
                    throw new Error("2FA setup changed. Prepare a new token before enabling 2FA");
                }

                clearTwoFAState(socket);
                twoFaRateLimiter.reset(socket.userID);

                log.info("auth", `Saved 2FA token. IP=${clientIP}`);

                callback({
                    ok: true,
                    msg: "2faEnabled",
                    msgi18n: true,
                });
            } catch (error) {
                log.error("auth", `Error changing 2FA token. IP=${clientIP}`);

                callback({
                    ok: false,
                    msg: error.message,
                });
            }
        });

        socket.on("disable2FA", async (currentPassword, callback) => {
            const clientIP = await server.getClientIP(socket);

            try {
                checkLogin(socket);
                if (!(await twoFaRateLimiter.pass(callback, 1, socket.userID))) {
                    return;
                }
                await doubleCheckPassword(store, socket, currentPassword);
                await TwoFA.disable2FA(store, socket.userID);
                clearTwoFAState(socket);
                twoFaRateLimiter.reset(socket.userID);

                log.info("auth", `Disabled 2FA token. IP=${clientIP}`);

                callback({
                    ok: true,
                    msg: "2faDisabled",
                    msgi18n: true,
                });
            } catch (error) {
                log.error("auth", `Error disabling 2FA token. IP=${clientIP}`);

                callback({
                    ok: false,
                    msg: error.message,
                });
            }
        });

        socket.on("verifyToken", async (token, currentPassword, callback) => {
            try {
                checkLogin(socket);
                if (!(await twoFaRateLimiter.pass(callback, 1, socket.userID))) {
                    return;
                }
                await doubleCheckPassword(store, socket, currentPassword);

                let user = await store.findOne("user", " id = ? AND active = 1 ", [socket.userID]);
                if (!socket.pendingTwoFASecret) {
                    throw new Error("Prepare 2FA before verifying a token");
                }

                let verify = verifyTotp(token, socket.pendingTwoFASecret, twoFAVerifyOptions);

                if (verify && (await consumeTwoFAToken(user.id, token))) {
                    twoFaRateLimiter.reset(socket.userID);
                    socket.twoFAVerified = true;
                    socket.twoFAVerifiedSecret = socket.pendingTwoFASecret;
                    callback({
                        ok: true,
                        valid: true,
                    });
                } else {
                    callback({
                        ok: false,
                        msg: "authInvalidToken",
                        msgi18n: true,
                        valid: false,
                    });
                }
            } catch (error) {
                callback({
                    ok: false,
                    msg: error.message,
                });
            }
        });

        socket.on("twoFAStatus", async (callback) => {
            try {
                checkLogin(socket);

                let user = await store.findOne("user", " id = ? AND active = 1 ", [socket.userID]);

                if (user.twofa_status === 1) {
                    callback({
                        ok: true,
                        status: true,
                    });
                } else {
                    callback({
                        ok: true,
                        status: false,
                    });
                }
            } catch (error) {
                callback({
                    ok: false,
                    msg: error.message,
                });
            }
        });

        socket.on("needSetup", async (callback) => {
            callback(needSetup);
        });

        socket.on("setup", async (username, password, callback) => {
            try {
                if (typeof username !== "string" || !username.trim() || username.length > 255) {
                    throw new Error("Invalid username");
                }

                if (passwordStrength(password).value === "Too weak") {
                    throw new TranslatableError("passwordTooWeak");
                }

                if (!needSetup || setupInProgress) {
                    throw new Error(
                        "Uptime Maku has been initialized. If you want to run setup again, please delete the database."
                    );
                }

                setupInProgress = true;
                try {
                    if ((await store.count("user")) !== 0) {
                        throw new Error(
                            "Uptime Maku has been initialized. If you want to run setup again, please delete the database."
                        );
                    }

                    const hashedPassword = await passwordHash.generate(password);
                    const inserted = await store.getRow(
                        `
                            INSERT INTO user (username, password)
                            SELECT ?, ?
                            WHERE NOT EXISTS (SELECT 1 FROM user)
                            RETURNING id
                        `,
                        [username.trim(), hashedPassword]
                    );

                    if (!inserted) {
                        throw new Error(
                            "Uptime Maku has been initialized. If you want to run setup again, please delete the database."
                        );
                    }

                    needSetup = false;

                    callback({
                        ok: true,
                        msg: "successAdded",
                        msgi18n: true,
                    });
                } finally {
                    setupInProgress = false;
                }
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                    msgi18n: !!e.msgi18n,
                });
            }
        });

        // ***************************
        // Auth Only API
        // ***************************

        // Add a new monitor
        socket.on("add", async (monitor, callback) => {
            try {
                checkLogin(socket);
                await resolveCoreHttpProxy(store, monitor.type, monitor.proxyId, socket.userID, monitor.ignoreTls);
                let model = store.createModel("monitor");

                let notificationIDList = monitor.notificationIDList;
                delete monitor.notificationIDList;

                // Ensure status code ranges are strings
                if (!monitor.accepted_statuscodes.every((code) => typeof code === "string")) {
                    throw new Error("Accepted status codes are not all strings");
                }
                monitor.accepted_statuscodes_json = JSON.stringify(monitor.accepted_statuscodes);
                delete monitor.accepted_statuscodes;

                monitor.kafkaProducerBrokers = JSON.stringify(monitor.kafkaProducerBrokers);
                monitor.kafkaProducerSaslOptions = JSON.stringify(monitor.kafkaProducerSaslOptions);

                monitor.conditions = JSON.stringify(monitor.conditions);

                monitor.rabbitmqNodes = JSON.stringify(monitor.rabbitmqNodes);

                /*
                 * List of frontend-only properties that should not be saved to the database.
                 * Should clean up before saving to the database.
                 */
                const frontendOnlyProperties = [
                    "humanReadableInterval",
                    "globalpingdnsresolvetypeoptions",
                    "responsecheck",
                ];
                for (const prop of frontendOnlyProperties) {
                    if (prop in monitor) {
                        delete monitor[prop];
                    }
                }

                model.import(monitor);
                // Map camelCase frontend property to snake_case database column
                if (monitor.retryOnlyOnStatusCodeFailure !== undefined) {
                    model.retry_only_on_status_code_failure = monitor.retryOnlyOnStatusCodeFailure;
                }
                model.user_id = socket.userID;

                model.validate();

                await store.saveModel(model);

                await updateMonitorNotification(model.id, notificationIDList);

                await server.sendUpdateMonitorIntoList(socket, model.id);

                if (monitor.active !== false) {
                    await startMonitor(socket.userID, model.id);
                }

                log.info("monitor", `Added Monitor: ${model.id} User ID: ${socket.userID}`);

                callback({
                    ok: true,
                    msg: "successAdded",
                    msgi18n: true,
                    monitorID: model.id,
                });
            } catch (e) {
                log.error("monitor", `Error adding Monitor: ${monitor.id} User ID: ${socket.userID}`);

                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        // Edit a monitor
        socket.on("editMonitor", async (monitor, callback) => {
            try {
                let removeGroupChildren = false;
                checkLogin(socket);

                let model = await store.findOne("monitor", " id = ? ", [monitor.id]);

                if (model.user_id !== socket.userID) {
                    throw new Error("Permission denied.");
                }
                await resolveCoreHttpProxy(store, monitor.type, monitor.proxyId, socket.userID, monitor.ignoreTls);

                // Check if Parent is Descendant (would cause endless loop)
                if (monitor.parent !== null) {
                    const childIDs = await Monitor.getAllChildrenIDs(monitor.id, store);
                    if (childIDs.includes(monitor.parent)) {
                        throw new Error("Invalid Monitor Group");
                    }
                }

                // Remove children if monitor type has changed (from group to non-group)
                if (model.type === "group" && monitor.type !== model.type) {
                    removeGroupChildren = true;
                }

                // Ensure status code ranges are strings
                if (!monitor.accepted_statuscodes.every((code) => typeof code === "string")) {
                    throw new Error("Accepted status codes are not all strings");
                }

                model.name = monitor.name;
                model.description = monitor.description;
                model.parent = monitor.parent;
                model.type = monitor.type;
                model.subtype = monitor.subtype;
                model.url = monitor.url;
                model.wsIgnoreSecWebsocketAcceptHeader = monitor.wsIgnoreSecWebsocketAcceptHeader;
                model.wsSubprotocol = monitor.wsSubprotocol;
                model.method = monitor.method;
                model.body = monitor.body;
                model.ipFamily = monitor.ipFamily;
                model.headers = monitor.headers;
                model.basic_auth_user = monitor.basic_auth_user;
                model.basic_auth_pass = monitor.basic_auth_pass;
                model.bearer_token = monitor.bearer_token;
                model.timeout = monitor.timeout;
                model.oauth_client_id = monitor.oauth_client_id;
                model.oauth_client_secret = monitor.oauth_client_secret;
                model.oauth_auth_method = monitor.oauth_auth_method;
                model.oauth_token_url = monitor.oauth_token_url;
                model.oauth_scopes = monitor.oauth_scopes;
                model.oauth_audience = monitor.oauth_audience;
                model.tlsCa = monitor.tlsCa;
                model.tlsCert = monitor.tlsCert;
                model.tlsKey = monitor.tlsKey;
                model.interval = monitor.interval;
                model.retryInterval = monitor.retryInterval;
                model.resendInterval = monitor.resendInterval;
                model.hostname = monitor.hostname;
                model.game = monitor.game;
                model.maxretries = monitor.maxretries;
                model.port = monitor.port;
                model.location = monitor.location;
                model.protocol = monitor.protocol;

                model.keyword = monitor.keyword;
                model.invertKeyword = monitor.invertKeyword;
                model.ignoreTls = monitor.ignoreTls;
                model.expiryNotification = monitor.expiryNotification;
                model.domainExpiryNotification = monitor.domainExpiryNotification;
                model.upsideDown = monitor.upsideDown;
                model.packetSize = monitor.packetSize;
                model.maxredirects = monitor.maxredirects;
                model.accepted_statuscodes_json = JSON.stringify(monitor.accepted_statuscodes);
                model.save_response = monitor.saveResponse;
                model.save_error_response = monitor.saveErrorResponse;
                model.response_max_length = monitor.responseMaxLength;
                model.dns_resolve_type = monitor.dns_resolve_type;
                model.dns_resolve_server = monitor.dns_resolve_server;
                model.pushToken = monitor.pushToken;
                model.docker_container = monitor.docker_container;
                model.docker_host = monitor.docker_host;
                model.proxyId = Number.isInteger(monitor.proxyId) ? monitor.proxyId : null;
                model.mqttUsername = monitor.mqttUsername;
                model.mqttPassword = monitor.mqttPassword;
                model.mqttTopic = monitor.mqttTopic;
                model.mqttSuccessMessage = monitor.mqttSuccessMessage;
                model.mqttCheckType = monitor.mqttCheckType;
                model.mqttWebsocketPath = monitor.mqttWebsocketPath;
                model.databaseConnectionString = monitor.databaseConnectionString;
                model.databaseQuery = monitor.databaseQuery;
                model.authMethod = monitor.authMethod;
                model.authWorkstation = monitor.authWorkstation;
                model.authDomain = monitor.authDomain;
                model.grpcUrl = monitor.grpcUrl;
                model.grpcProtobuf = monitor.grpcProtobuf;
                model.grpcServiceName = monitor.grpcServiceName;
                model.grpcMethod = monitor.grpcMethod;
                model.grpcBody = monitor.grpcBody;
                model.grpcMetadata = monitor.grpcMetadata;
                model.grpcEnableTls = monitor.grpcEnableTls;
                model.radiusUsername = monitor.radiusUsername;
                model.radiusPassword = monitor.radiusPassword;
                model.radiusCalledStationId = monitor.radiusCalledStationId;
                model.radiusCallingStationId = monitor.radiusCallingStationId;
                model.radiusSecret = monitor.radiusSecret;
                model.httpBodyEncoding = monitor.httpBodyEncoding;
                model.expectedValue = monitor.expectedValue;
                model.jsonPath = monitor.jsonPath;
                model.kafkaProducerTopic = monitor.kafkaProducerTopic;
                model.kafkaProducerBrokers = JSON.stringify(monitor.kafkaProducerBrokers);
                model.kafkaProducerAllowAutoTopicCreation = monitor.kafkaProducerAllowAutoTopicCreation;
                model.kafkaProducerSaslOptions = JSON.stringify(monitor.kafkaProducerSaslOptions);
                model.kafkaProducerMessage = monitor.kafkaProducerMessage;
                model.cacheBust = monitor.cacheBust;
                model.kafkaProducerSsl = monitor.kafkaProducerSsl;
                model.kafkaProducerAllowAutoTopicCreation = monitor.kafkaProducerAllowAutoTopicCreation;
                model.gamedigGivenPortOnly = monitor.gamedigGivenPortOnly;
                model.gamedigToken = monitor.gamedigToken;
                model.remote_browser = monitor.remote_browser;
                model.smtpSecurity = monitor.smtpSecurity;
                model.snmpVersion = monitor.snmpVersion;
                model.snmpOid = monitor.snmpOid;
                model.jsonPathOperator = monitor.jsonPathOperator;
                model.retry_only_on_status_code_failure = Boolean(monitor.retryOnlyOnStatusCodeFailure);
                model.rabbitmqNodes = JSON.stringify(monitor.rabbitmqNodes);
                model.rabbitmqUsername = monitor.rabbitmqUsername;
                model.rabbitmqPassword = monitor.rabbitmqPassword;
                model.conditions = JSON.stringify(monitor.conditions);
                model.manual_status = monitor.manual_status;
                model.system_service_name = monitor.system_service_name;
                model.expected_tls_alert = monitor.expectedTlsAlert;
                model.screenshot_delay = monitor.screenshot_delay;
                model.screenshotDelay = monitor.screenshot_delay;

                // ping advanced options
                model.ping_numeric = monitor.ping_numeric;
                model.ping_count = monitor.ping_count;
                model.ping_per_request_timeout = monitor.ping_per_request_timeout;

                model.validate();

                await store.saveModel(model);

                if (removeGroupChildren) {
                    await Monitor.unlinkAllChildren(store, monitor.id);
                }

                await updateMonitorNotification(model.id, monitor.notificationIDList);

                if (await Monitor.isActive(model.id, model.active, store)) {
                    await restartMonitor(socket.userID, model.id);
                }

                await server.sendUpdateMonitorIntoList(socket, model.id);

                callback({
                    ok: true,
                    msg: "Saved.",
                    msgi18n: true,
                    monitorID: model.id,
                });
            } catch (e) {
                log.error("monitor", e);
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("getMonitorList", async (callback) => {
            try {
                checkLogin(socket);
                await server.sendMonitorList(socket);
                callback({
                    ok: true,
                });
            } catch (e) {
                log.error("monitor", e);
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("getMonitor", async (monitorID, callback) => {
            try {
                checkLogin(socket);

                log.info("monitor", `Get Monitor: ${monitorID} User ID: ${socket.userID}`);

                let monitor = await store.findOne("monitor", " id = ? AND user_id = ? ", [monitorID, socket.userID]);
                const monitorData = [{ id: monitor.id, active: monitor.active }];
                const preloadData = await Monitor.preparePreloadData(store, monitorData, server);
                callback({
                    ok: true,
                    monitor: monitor.toJSON(preloadData),
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        // partial { type, url, hostname, grpcUrl }
        socket.on("checkDomain", async (partial, callback) => {
            try {
                checkLogin(socket);
                const { default: DomainExpiry } = await import("@/server/model/domain_expiry");
                const supportInfo = await DomainExpiry.checkSupport(partial, settings);
                callback({
                    ok: true,
                    domain: supportInfo.domain,
                    tld: supportInfo.tld,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                    msgi18n: !!e.msgi18n,
                    meta: e.meta ?? {},
                });
            }
        });

        socket.on("getMonitorBeats", async (monitorID, period, callback) => {
            try {
                checkLogin(socket);

                log.info("monitor", `Get Monitor Beats: ${monitorID} User ID: ${socket.userID}`);

                if (period == null) {
                    throw new Error("Invalid period.");
                }

                const list = await heartbeatData.recentForOwner(socket.userID, monitorID, period);

                callback({
                    ok: true,
                    data: list,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        // Start or Resume the monitor
        socket.on("resumeMonitor", async (monitorID, callback) => {
            try {
                checkLogin(socket);
                await startMonitor(socket.userID, monitorID);
                await server.sendUpdateMonitorIntoList(socket, monitorID);

                callback({
                    ok: true,
                    msg: "successResumed",
                    msgi18n: true,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("pauseMonitor", async (monitorID, callback) => {
            try {
                checkLogin(socket);
                await pauseMonitor(socket.userID, monitorID);
                await server.sendUpdateMonitorIntoList(socket, monitorID);

                callback({
                    ok: true,
                    msg: "successPaused",
                    msgi18n: true,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("deleteMonitor", async (monitorID, deleteChildren, callback) => {
            try {
                // Backward compatibility: if deleteChildren is omitted, the second parameter is the callback
                if (typeof deleteChildren === "function") {
                    callback = deleteChildren;
                    deleteChildren = false;
                }

                checkLogin(socket);

                const startTime = Date.now();

                // Check if this is a group monitor
                const monitor = await store.findOne("monitor", " id = ? AND user_id = ? ", [monitorID, socket.userID]);

                // Log with context about deletion type
                if (monitor && monitor.type === "group") {
                    if (deleteChildren) {
                        log.info("manage", `Delete Group and Children: ${monitorID} User ID: ${socket.userID}`);
                    } else {
                        log.info("manage", `Delete Group (unlink children): ${monitorID} User ID: ${socket.userID}`);
                    }
                } else {
                    log.info("manage", `Delete Monitor: ${monitorID} User ID: ${socket.userID}`);
                }

                if (monitor && monitor.type === "group") {
                    // Get all children before processing
                    const children = await Monitor.getChildren(monitorID, store);

                    if (deleteChildren) {
                        // Delete all child monitors recursively
                        if (children && children.length > 0) {
                            for (const child of children) {
                                await Monitor.deleteMonitorRecursively(store, server, child.id, socket.userID);
                                await server.sendDeleteMonitorFromList(socket, child.id);
                            }
                        }
                    } else {
                        // Unlink all children from the group (set parent to null)
                        await Monitor.unlinkAllChildren(store, monitorID);

                        // Notify frontend to update each child monitor's parent to null
                        if (children && children.length > 0) {
                            for (const child of children) {
                                await server.sendUpdateMonitorIntoList(socket, child.id);
                            }
                        }
                    }
                }

                // Delete the monitor itself
                await Monitor.deleteMonitor(store, server, monitorID, socket.userID);

                // Fix #2880
                clearResponseCache(responseCache);

                const endTime = Date.now();

                // Log completion with context about children handling
                if (monitor && monitor.type === "group") {
                    if (deleteChildren) {
                        log.info(
                            "DB",
                            `Delete Monitor completed (group and children deleted) in: ${endTime - startTime} ms`
                        );
                    } else {
                        log.info(
                            "DB",
                            `Delete Monitor completed (group deleted, children unlinked) in: ${endTime - startTime} ms`
                        );
                    }
                } else {
                    log.info("DB", `Delete Monitor completed in: ${endTime - startTime} ms`);
                }

                callback({
                    ok: true,
                    msg: "successDeleted",
                    msgi18n: true,
                });
                await server.sendDeleteMonitorFromList(socket, monitorID);
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("getTags", async (callback) => {
            try {
                checkLogin(socket);

                const list = await store.findAll("tag");

                callback({
                    ok: true,
                    tags: list.map((model) => model.toJSON()),
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("addTag", async (tag, callback) => {
            try {
                checkLogin(socket);

                let model = store.createModel("tag");
                model.name = tag.name;
                model.color = tag.color;
                await store.saveModel(model);

                callback({
                    ok: true,
                    tag: await model.toJSON(),
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("editTag", async (tag, callback) => {
            try {
                checkLogin(socket);

                let model = await store.findOne("tag", " id = ? ", [tag.id]);
                if (model == null) {
                    callback({
                        ok: false,
                        msg: "tagNotFound",
                        msgi18n: true,
                    });
                    return;
                }
                model.name = tag.name;
                model.color = tag.color;
                await store.saveModel(model);

                callback({
                    ok: true,
                    msg: "Saved.",
                    msgi18n: true,
                    tag: await model.toJSON(),
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("deleteTag", async (tagID, callback) => {
            try {
                checkLogin(socket);

                await store.exec("DELETE FROM tag WHERE id = ? ", [tagID]);

                callback({
                    ok: true,
                    msg: "successDeleted",
                    msgi18n: true,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("addMonitorTag", async (tagID, monitorID, value, callback) => {
            try {
                checkLogin(socket);

                await store.exec("INSERT INTO monitor_tag (tag_id, monitor_id, value) VALUES (?, ?, ?)", [
                    tagID,
                    monitorID,
                    value,
                ]);

                await server.sendUpdateMonitorIntoList(socket, monitorID);

                callback({
                    ok: true,
                    msg: "successAdded",
                    msgi18n: true,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("editMonitorTag", async (tagID, monitorID, value, callback) => {
            try {
                checkLogin(socket);

                await store.exec("UPDATE monitor_tag SET value = ? WHERE tag_id = ? AND monitor_id = ?", [
                    value,
                    tagID,
                    monitorID,
                ]);

                await server.sendUpdateMonitorIntoList(socket, monitorID);

                callback({
                    ok: true,
                    msg: "successEdited",
                    msgi18n: true,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("deleteMonitorTag", async (tagID, monitorID, value, callback) => {
            try {
                checkLogin(socket);

                await store.exec("DELETE FROM monitor_tag WHERE tag_id = ? AND monitor_id = ? AND value = ?", [
                    tagID,
                    monitorID,
                    value,
                ]);

                await server.sendUpdateMonitorIntoList(socket, monitorID);

                callback({
                    ok: true,
                    msg: "successDeleted",
                    msgi18n: true,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("monitorImportantHeartbeatListCount", async (monitorID, callback) => {
            try {
                checkLogin(socket);

                const count = await heartbeatData.importantCount(socket.userID, monitorID);

                callback({
                    ok: true,
                    count: count,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("monitorImportantHeartbeatListPaged", async (monitorID, offset, count, callback) => {
            try {
                checkLogin(socket);

                const list = await heartbeatData.importantPage(socket.userID, monitorID, offset, count);

                callback({
                    ok: true,
                    data: list,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("changePassword", async (password, callback) => {
            try {
                checkLogin(socket);

                if (!password.newPassword) {
                    throw new Error("Invalid new password");
                }

                if (passwordStrength(password.newPassword).value === "Too weak") {
                    throw new TranslatableError("passwordTooWeak");
                }

                let user = await doubleCheckPassword(store, socket, password.currentPassword);
                await user.resetPassword(store, password.newPassword);
                await User.revokeAllSessions(store, user.id);
                const session = await User.createSession(store, user, server.jwtSecret);
                socket.sessionID = session.id;

                server.disconnectAllSocketClients(user.id, socket.id);

                callback({
                    ok: true,
                    token: session.token,
                    msg: "successAuthChangePassword",
                    msgi18n: true,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                    msgi18n: !!e.msgi18n,
                });
            }
        });

        socket.on("getSettings", async (callback) => {
            try {
                checkLogin(socket);
                const data = await settings.getSettings("general");

                if (!data.serverTimezone) {
                    data.serverTimezone = await server.getTimezone();
                }

                callback({
                    ok: true,
                    data: data,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("setSettings", async (data, currentPassword, callback) => {
            try {
                checkLogin(socket);

                // If currently is disabled auth, don't need to check
                // Disabled Auth + Want to Disable Auth => No Check
                // Disabled Auth + Want to Enable Auth => No Check
                // Enabled Auth + Want to Disable Auth => Check!!
                // Enabled Auth + Want to Enable Auth => No Check
                const currentDisabledAuth = await settings.get("disableAuth");
                if (!currentDisabledAuth && data.disableAuth) {
                    await doubleCheckPassword(store, socket, currentPassword);
                }

                // Log out all clients if enabling auth
                // GHSA-23q2-5gf8-gjpp
                if (currentDisabledAuth && !data.disableAuth) {
                    server.disconnectAllSocketClients(socket.userID, socket.id);
                }

                const previousChromeExecutable = await settings.get("chromeExecutable");
                const previousNSCDStatus = await settings.get("nscd");

                await settings.setSettings("general", data);
                server.entryPage = data.entryPage;

                // Also need to apply timezone globally
                if (data.serverTimezone) {
                    await server.setTimezone(data.serverTimezone);
                }

                // If Chrome Executable is changed, need to reset the browser
                if (previousChromeExecutable !== data.chromeExecutable) {
                    log.info("settings", "Chrome executable is changed. Resetting Chrome...");
                    await server.getLoadedMonitorType("real-browser")?.resetChrome();
                }

                // Update nscd status
                if (previousNSCDStatus !== data.nscd) {
                    if (data.nscd) {
                        await server.startNSCDServices();
                    } else {
                        await server.stopNSCDServices();
                    }
                }

                callback({
                    ok: true,
                    msg: "Saved.",
                    msgi18n: true,
                });

                await sendInfo(server, settings, versionChecker, socket);
                await server.sendMaintenanceList(socket);
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        // Add or Edit
        socket.on("addNotification", async (notification, notificationID, callback) => {
            try {
                checkLogin(socket);

                let notificationModel = await Notification.save(store, notification, notificationID, socket.userID);
                await sendNotificationList(store, io, socket);

                callback({
                    ok: true,
                    msg: "Saved.",
                    msgi18n: true,
                    id: notificationModel.id,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("deleteNotification", async (notificationID, callback) => {
            try {
                checkLogin(socket);

                await Notification.delete(store, notificationID, socket.userID);
                await sendNotificationList(store, io, socket);

                callback({
                    ok: true,
                    msg: "successDeleted",
                    msgi18n: true,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("testNotification", async (notification, callback) => {
            try {
                checkLogin(socket);

                let msg = await Notification.send(
                    server.notificationProviderRegistry,
                    notification,
                    notification.name + " Testing"
                );

                callback({
                    ok: true,
                    msg,
                });
            } catch (e) {
                log.error("server", e);

                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("checkApprise", async (callback) => {
            try {
                checkLogin(socket);
                callback(await Notification.checkApprise());
            } catch (e) {
                callback(false);
            }
        });

        socket.on("getWebpushVapidPublicKey", async (callback) => {
            try {
                const publicVapidKey = await getWebpushVapidPublicKey(settings);

                callback({
                    ok: true,
                    msg: publicVapidKey,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("clearEvents", async (monitorID, callback) => {
            try {
                checkLogin(socket);

                log.info("manage", `Clear Events Monitor: ${monitorID} User ID: ${socket.userID}`);

                await heartbeatData.clearEvents(socket.userID, monitorID);

                callback({
                    ok: true,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("clearHeartbeats", async (monitorID, callback) => {
            try {
                checkLogin(socket);

                log.info("manage", `Clear Heartbeats Monitor: ${monitorID} User ID: ${socket.userID}`);

                const monitor = server.monitorList[monitorID];
                const ownedMonitors = monitor?.user_id === socket.userID ? [monitor] : [];
                await clearWithStoppedMonitors(
                    ownedMonitors,
                    () => heartbeatData.clearMonitor(socket.userID, monitorID),
                    (runningMonitor) => restartMonitor(socket.userID, runningMonitor.id)
                );

                await sendHeartbeatList(heartbeatData, io, socket, monitorID, true, true);

                callback({
                    ok: true,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        socket.on("clearStatistics", async (callback) => {
            try {
                checkLogin(socket);

                log.info("manage", `Clear Statistics User ID: ${socket.userID}`);

                const ownedMonitors = Object.values(server.monitorList).filter(
                    (monitor) => monitor.user_id === socket.userID
                );
                await clearWithStoppedMonitors(
                    ownedMonitors,
                    () => heartbeatData.clearAll(socket.userID),
                    (monitor) => restartMonitor(socket.userID, monitor.id)
                );

                callback({
                    ok: true,
                });
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                });
            }
        });

        // Status Page Socket Handler for admin only
        statusPageSocketHandler(socket, store, server, settings, responseCache);
        cloudflared.socketHandler(socket, store);
        databaseSocketHandler(socket, store);
        proxySocketHandler(socket, store, io, server);
        dockerSocketHandler(socket, store, io);
        maintenanceSocketHandler(socket, store, server, responseCache);
        apiKeySocketHandler(socket, store, io, settings, responseCache);
        remoteBrowserSocketHandler(socket, store, io, server);
        generalSocketHandler(socket, server, settings, versionChecker);
        chartSocketHandler(socket, store, heartbeatData);

        log.debug("server", "added all socket handlers");

        // ***************************
        // Better do anything after added all socket handlers here
        // ***************************

        log.debug("auth", "check auto login");
        if (await settings.get("disableAuth")) {
            log.info("auth", "Disabled Auth: auto login to admin");
            await afterLogin(socket, await store.findOne("user"));
            socket.emit("autoLogin");
        } else {
            socket.emit("loginRequired");
            log.debug("auth", "need auth");
        }
    });

    log.debug("server", "Init the server");

    await server.start();

    const afterListen = async () => {
        await startMonitors();

        // Put this here. Start background jobs after the db and server is ready to prevent clear up during db migration.
        await initBackgroundJobs(
            store,
            databaseMaintenance,
            await server.getTimezone(),
            settings,
            heartbeatData,
            backgroundJobs
        );

        versionChecker.start();
    };

    listenWithBunServe({
        server,
        store: store,
        databaseMaintenance,
        heartbeatData,
        backgroundJobs,
        settings,
        responseCache,
        hostname,
        port,
        disableFrameSameOrigin,
    });
    await afterListen();

    // Start cloudflared at the end if configured
    await cloudflared.autoStart(cloudflaredToken);
})();

/**
 * Update notifications for a given monitor
 * @param {number} monitorID ID of monitor to update
 * @param {number[]} notificationIDList List of new notification
 * providers to add
 * @returns {Promise<void>}
 */
async function updateMonitorNotification(monitorID, notificationIDList) {
    await store.exec("DELETE FROM monitor_notification WHERE monitor_id = ? ", [monitorID]);

    for (let notificationID in notificationIDList) {
        if (notificationIDList[notificationID]) {
            let relation = store.createModel("monitor_notification");
            relation.monitor_id = monitorID;
            relation.notification_id = notificationID;
            await store.saveModel(relation);
        }
    }
}

/**
 * Check if a given user owns a specific monitor
 * @param {number} userID ID of user to check
 * @param {number} monitorID ID of monitor to check
 * @returns {Promise<void>}
 * @throws {Error} The specified user does not own the monitor
 */
async function checkOwner(userID, monitorID) {
    let row = await store.getRow("SELECT id FROM monitor WHERE id = ? AND user_id = ? ", [monitorID, userID]);

    if (!row) {
        throw new Error("You do not own this monitor.");
    }
}

/**
 * Function called after user login
 * This function is used to send the heartbeat list of a monitor.
 * @param {Socket} socket Socket.io instance
 * @param {object} user User object
 * @returns {Promise<void>}
 */
async function afterLogin(socket, user) {
    socket.userID = user.id;
    socket.join(user.id);

    let monitorList = await server.sendMonitorList(socket);
    await Promise.allSettled([
        sendInfo(server, settings, versionChecker, socket),
        server.sendMaintenanceList(socket),
        sendNotificationList(store, io, socket),
        sendProxyList(store, io, socket),
        sendDockerHostList(store, io, socket),
        sendAPIKeyList(store, io, socket),
        sendRemoteBrowserList(store, io, socket),
        sendMonitorTypeList(server.monitorTypeList, io, socket),
    ]);

    await StatusPage.sendStatusPageList(store, io, socket, server.statusPageDomainMappingList);

    // Push recent heartbeat history + stats so the dashboard/bars/charts are populated
    // immediately on login, not only after the next live check arrives.
    const monitorPromises = [];
    for (let monitorID in monitorList) {
        monitorPromises.push(sendHeartbeatList(heartbeatData, io, socket, monitorID));
        monitorPromises.push(Monitor.sendStats(heartbeatData, io, monitorID, user.id, settings));
    }

    await Promise.all(monitorPromises);

    // Set server timezone from client browser if not set
    // It should be run once only
    if (!(await settings.get("initServerTimezone"))) {
        log.debug("server", "emit initServerTimezone");
        socket.emit("initServerTimezone");
    }
}

/**
 * Initialize the database
 * @param {boolean} testMode Should the connection be
 * started in test mode?
 * @returns {Promise<void>}
 */
async function initDatabase(testMode = false) {
    log.debug("server", "Connecting to the database");
    await Database.connect(store, testMode);
    log.info("server", "Connected to the database");

    let jwtSecretModel = await store.findOne("setting", " `key` = ? ", ["jwtSecret"]);

    if (!jwtSecretModel) {
        log.info("server", "JWT secret is not found, generate one.");
        jwtSecretModel = await initJWTSecret(store);
        log.info("server", "Stored JWT secret into database");
    } else {
        log.debug("server", "Load JWT secret from database.");
    }

    // If there is no record in user table, it is a new Uptime Maku instance, need to setup
    if ((await store.count("user")) === 0) {
        log.info("server", "No user, need setup");
        needSetup = true;
    }

    server.jwtSecret = jwtSecretModel.value;
}

/**
 * Start the specified monitor
 * @param {number} userID ID of user who owns monitor
 * @param {number} monitorID ID of monitor to start
 * @returns {Promise<void>}
 */
async function startMonitor(userID, monitorID) {
    await checkOwner(userID, monitorID);

    log.info("manage", `Resume Monitor: ${monitorID} User ID: ${userID}`);

    await store.exec("UPDATE monitor SET active = 1 WHERE id = ? AND user_id = ? ", [monitorID, userID]);

    let monitor = await store.findOne("monitor", " id = ? ", [monitorID]);

    if (monitor.id in server.monitorList) {
        await server.monitorList[monitor.id].stop();
    }

    server.monitorList[monitor.id] = monitor;
    await monitor.start(io, heartbeatData, server, runHeartbeatWrite, responseCache);
}

/**
 * Restart a given monitor
 * @param {number} userID ID of user who owns monitor
 * @param {number} monitorID ID of monitor to start
 * @returns {Promise<void>}
 */
async function restartMonitor(userID, monitorID) {
    return await startMonitor(userID, monitorID);
}

/**
 * Pause a given monitor
 * @param {number} userID ID of user who owns monitor
 * @param {number} monitorID ID of monitor to start
 * @returns {Promise<void>}
 */
async function pauseMonitor(userID, monitorID) {
    await checkOwner(userID, monitorID);

    log.info("manage", `Pause Monitor: ${monitorID} User ID: ${userID}`);

    await store.exec("UPDATE monitor SET active = 0 WHERE id = ? AND user_id = ? ", [monitorID, userID]);

    if (monitorID in server.monitorList) {
        await server.monitorList[monitorID].stop();
        server.monitorList[monitorID].active = 0;
    }
}

/**
 * Resume active monitors
 * @returns {Promise<void>}
 */
async function startMonitors() {
    let list = await store.find("monitor", " active = 1 ");

    for (let monitor of list) {
        server.monitorList[monitor.id] = monitor;
    }

    for (let monitor of list) {
        try {
            await monitor.start(io, heartbeatData, server, runHeartbeatWrite, responseCache);
        } catch (e) {
            log.error("monitor", e);
        }
        // Give some delays, so all monitors won't make request at the same moment when just start the server.
        await sleep(getRandomInt(300, 1000));
    }
}

/**
 * Shutdown the application
 * Stops all monitors and closes the database connection.
 * @param {string} signal The signal that triggered this function to be called.
 * @returns {Promise<void>}
 */
async function shutdownFunction(signal) {
    log.info("server", "Shutdown requested");
    log.info("server", "Called signal: " + signal);

    await server.stop();

    log.info("server", "Stopping all monitors");
    for (let id in server.monitorList) {
        let monitor = server.monitorList[id];
        await monitor.stop();
    }
    await server.getLoadedMonitorType("real-browser")?.resetChrome();
    await sleep(2000);
    stopBackgroundJobs(backgroundJobs);
    versionChecker.stop();
    if (store.isOpen()) {
        await databaseMaintenance.maintain(() => Database.close(store));
    }

    await cloudflared.stop();
    settings.stopCacheCleaner();

    if (server.bunHttpServer) {
        server.bunHttpServer.stop(true);
    }
}

/**
 * Final function called before application exits
 * @returns {void}
 */
function finalFunction() {
    log.info("server", "Graceful shutdown successful!");
}

process.once("SIGINT", async () => {
    await shutdownFunction("SIGINT");
    finalFunction();
    process.exit(0);
});
process.once("SIGTERM", async () => {
    await shutdownFunction("SIGTERM");
    finalFunction();
    process.exit(0);
});

// Catch unexpected errors here
let unexpectedErrorHandler = (error, promise) => {
    console.trace(error);
    writeErrorLog(error, false);
    console.error("If you keep encountering errors, please report to https://github.com/Igloczek/uptime-maku/issues");
};
process.addListener("unhandledRejection", unexpectedErrorHandler);
process.addListener("uncaughtException", unexpectedErrorHandler);
