// @ts-nocheck
/*
 * Uptime Maku Server
 * bun "src/server/server.ts"
 * DO NOT require("./server") in other modules, it likely creates circular dependency!
 */
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import { getRuntimeInfo, isBunRuntime } from "@/server/runtime";
import { args } from "@/server/args";
import { sleep } from "@/util/sleep";
import { log } from "@/server/logger";
import { getRandomInt } from "@/util/random";
import config from "@/server/config";
import { createVersionChecker, version } from "@/server/check-version";
import { BunSQLiteRedbean } from "@/server/sqlite-core";
import "@/server/model-registry";
import { Settings } from "@/server/settings";
import { UptimeMakuServer } from "@/server/uptime-maku-server";
import { listenWithBunServe } from "@/server/bun-http-server";
import { initJWTSecret } from "@/server/server-auth-helpers";
import Database from "@/server/database";
import { DatabaseMaintenanceCoordinator } from "@/server/database-maintenance";
import { initBackgroundJobs, stopBackgroundJobs } from "@/server/jobs";
import { Prometheus } from "@/server/prometheus";
import { HeartbeatDataPlane } from "@/server/heartbeat-data-plane";
import { sendInfo } from "@/server/client";
import { statusPageSocketHandler } from "@/server/socket-handlers/status-page-socket-handler";
import { databaseSocketHandler } from "@/server/socket-handlers/database-socket-handler";
import { remoteBrowserSocketHandler } from "@/server/socket-handlers/remote-browser-socket-handler";
import StatusPage from "@/server/model/status_page";
import { createCloudflaredRuntime } from "@/server/socket-handlers/cloudflared-socket-handler";
import { proxySocketHandler } from "@/server/socket-handlers/proxy-socket-handler";
import { dockerSocketHandler } from "@/server/socket-handlers/docker-socket-handler";
import { maintenanceSocketHandler } from "@/server/socket-handlers/maintenance-socket-handler";
import { apiKeySocketHandler } from "@/server/socket-handlers/api-key-socket-handler";
import { generalSocketHandler } from "@/server/socket-handlers/general-socket-handler";
import { createResponseCache } from "@/server/bun-response";
import { chartSocketHandler } from "@/server/socket-handlers/chart-socket-handler";
import { clearSocketHandler } from "@/server/socket-handlers/clear-socket-handler";
import { settingsSocketHandler } from "@/server/socket-handlers/settings-socket-handler";
import { authSocketHandler, clearTwoFAState } from "@/server/socket-handlers/auth-socket-handler";
import { monitorSocketHandler } from "@/server/socket-handlers/monitor-socket-handler";
import { loginRateLimiter, twoFaRateLimiter } from "@/server/rate-limiter";
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

const store = new BunSQLiteRedbean();
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
const authState = {
    setupInProgress: false,
    needSetup: false,
};

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

/**
 * Run unit test after the server is ready
 * @type {boolean}
 */
const testMode = !!args["test"] || false;

/**
 * Show Setup Page
 * @type {boolean}
 */
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

        if (authState.needSetup) {
            log.info("server", "Redirect to setup page");
            socket.emit("setup");
        }

        // ***************************
        // Public Socket API
        // ***************************

        const authRuntime = authSocketHandler(
            socket,
            store,
            server,
            io,
            settings,
            versionChecker,
            heartbeatData,
            authState,
            loginRateLimiter,
            twoFaRateLimiter
        );

        // ***************************
        // Auth Only API
        // ***************************

        monitorSocketHandler(
            socket,
            store,
            server,
            settings,
            heartbeatData,
            responseCache,
            startMonitor,
            restartMonitor,
            pauseMonitor
        );

        settingsSocketHandler(
            socket,
            store,
            server,
            io,
            settings,
            versionChecker,
            server.notificationProviderRegistry
        );

        clearSocketHandler(socket, heartbeatData, io, server, restartMonitor);

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
            await authRuntime.afterLogin(await store.findOne("user"));
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
 * Initialize the database
 * @param {boolean} testMode Should the connection be
 * started in test mode?
 * @returns {Promise<void>}
 */
async function initDatabase(testMode = false) {
    log.debug("server", "Connecting to the database");
    await Database.connect(store, testMode);
    log.info("server", "Connected to the database");

    let jwtSecretBean = await store.findOne("setting", " `key` = ? ", ["jwtSecret"]);

    if (!jwtSecretBean) {
        log.info("server", "JWT secret is not found, generate one.");
        jwtSecretBean = await initJWTSecret(store);
        log.info("server", "Stored JWT secret into database");
    } else {
        log.debug("server", "Load JWT secret from database.");
    }

    // If there is no record in user table, it is a new Uptime Maku instance, need to setup
    if ((await store.count("user")) === 0) {
        log.info("server", "No user, need setup");
        authState.needSetup = true;
    }

    server.jwtSecret = jwtSecretBean.value;
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
