// @ts-nocheck

import fs from "fs";
import { log } from "@/server/logger";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import httpClient from "@/server/http-client";
import { BunRealtimeAdapter } from "@/server/bun-websocket-server";
import { runCommandChecked } from "@/server/process-helper";
import { MonitorRuntimeRegistry } from "@/server/monitor-runtime-registry";
import { NotificationProviderRegistry } from "@/server/notification-provider-registry";
import Monitor from "@/server/model/monitor";
import packageJson from "@/package-meta";
import { isCompiledBinary } from "@/server/app-paths";

dayjs.extend(utc);
dayjs.extend(timezone);

class UptimeMakuServer {
    /**
     * Main monitor list
     * @type {{}}
     */
    monitorList = {};

    /**
     * Serializes start, restart, and pause operations per monitor.
     * @type {Map<number, Promise<void>>}
     */
    monitorLifecycleOperations = new Map();

    /**
     * Main maintenance list
     * @type {{}}
     */
    maintenanceList = {};

    /** @type {Record<string, string>} */
    statusPageDomainMappingList = {};

    entryPage = "dashboard";
    httpServer = undefined;
    bunHttpServer = undefined;
    io = undefined;

    /**
     * Cache Index HTML
     * @type {string}
     */
    indexHTML = "";

    /**
     * Use for decode the auth object
     * @type {null}
     */
    jwtSecret = null;

    constructor(store, settings) {
        this.store = store;
        this.settings = settings;
        this.environmentTimezone = process.env.TZ;
        this.timezone = null;

        httpClient.setDefaults({
            headers: {
                "User-Agent": this.getUserAgent(),
            },
            timeout: 300 * 1000,
        });

        log.info("server", "Creating Bun realtime instance");
        log.info("server", "Server Type: Bun.serve HTTP");
        this.io = new BunRealtimeAdapter(this, settings);

        this.monitorRuntimeRegistry = new MonitorRuntimeRegistry(this);
        this.notificationProviderRegistry = new NotificationProviderRegistry(settings);
        this.monitorTypeList = this.monitorRuntimeRegistry.monitorTypeList;
    }

    async loadFrontendAssets() {
        try {
            if (isCompiledBinary()) {
                const { getEmbeddedAssetRef } = await import("@/server/embedded-assets.js");
                const embeddedIndex = getEmbeddedAssetRef("index.html");
                if (!embeddedIndex) {
                    throw new Error("Embedded index.html is missing from the compiled binary.");
                }
                this.indexHTML = fs.readFileSync(embeddedIndex, "utf8");
            } else {
                this.indexHTML = fs.readFileSync("./dist/index.html", "utf8");
            }
        } catch (e) {
            // "dist/index.html" is not necessary for development
            if (process.env.NODE_ENV !== "development") {
                throw new Error("Cannot find frontend assets. Build the binary with `bun run build`.", {
                    cause: e,
                });
            }
        }
    }

    /**
     * Initialise app after the database has been set up
     * @returns {Promise<void>}
     */
    async initAfterDatabaseReady(responseCache) {
        const timezone = await this.getTimezone();
        log.debug("DEBUG", "Timezone: " + timezone);
        log.debug("DEBUG", "Current Time: " + dayjs().tz(timezone).format());

        await this.loadMaintenanceList(responseCache);
    }

    /**
     * Load an optional monitor implementation on demand.
     * @param {string} type Monitor type
     * @returns {Promise<import("@/server/monitor-types/monitor-type").MonitorType|null>} Monitor type instance
     */
    getMonitorType(type) {
        return this.monitorRuntimeRegistry.get(type);
    }

    getLoadedMonitorType(type) {
        return this.monitorRuntimeRegistry.getLoaded(type);
    }

    /**
     * Send list of monitors to client
     * @param {Socket} socket Socket to send list on
     * @returns {Promise<object>} List of monitors
     */
    async sendMonitorList(socket) {
        let list = await this.getMonitorJSONList(socket.userID);
        this.io.to(socket.userID).emit("monitorList", list);
        return list;
    }

    /**
     * Update Monitor into list
     * @param {Socket} socket Socket to send list on
     * @param {number} monitorID update or deleted monitor id
     * @returns {Promise<void>}
     */
    async sendUpdateMonitorIntoList(socket, monitorID) {
        let list = await this.getMonitorJSONList(socket.userID, monitorID);
        if (list && list[monitorID]) {
            this.io.to(socket.userID).emit("updateMonitorIntoList", list);
        }
    }

    /**
     * Delete Monitor from list
     * @param {Socket} socket Socket to send list on
     * @param {number} monitorID update or deleted monitor id
     * @returns {Promise<void>}
     */
    async sendDeleteMonitorFromList(socket, monitorID) {
        this.io.to(socket.userID).emit("deleteMonitorFromList", monitorID);
    }

    /**
     * Get a list of monitors for the given user.
     * @param {string} userID - The ID of the user to get monitors for.
     * @param {number} monitorID - The ID of monitor for.
     * @returns {Promise<object>} A promise that resolves to an object with monitor IDs as keys and monitor objects as values.
     *
     * Generated by Trelent
     */
    async getMonitorJSONList(userID, monitorID = null) {
        let query = " user_id = ? ";
        let queryParams = [userID];

        if (monitorID) {
            query += "AND id = ? ";
            queryParams.push(monitorID);
        }

        let monitorList = await this.store.find("monitor", query + "ORDER BY weight DESC, name", queryParams);

        const monitorData = monitorList.map((monitor) => ({
            id: monitor.id,
            active: monitor.active,
            name: monitor.name,
        }));
        const preloadData = await Monitor.preparePreloadData(this.store, monitorData, this);

        const result = {};
        monitorList.forEach((monitor) => (result[monitor.id] = monitor.toJSON(preloadData)));
        return result;
    }

    /**
     * Send maintenance list to client
     * @param {Socket} socket Socket.io instance to send to
     * @returns {Promise<object>} Maintenance list
     */
    async sendMaintenanceList(socket) {
        return await this.sendMaintenanceListByUserID(socket.userID);
    }

    /**
     * Send list of maintenances to user
     * @param {number} userID User to send list to
     * @returns {Promise<object>} Maintenance list
     */
    async sendMaintenanceListByUserID(userID) {
        let list = await this.getMaintenanceJSONList(userID);
        this.io.to(userID).emit("maintenanceList", list);
        return list;
    }

    /**
     * Get a list of maintenances for the given user.
     * @param {string} userID - The ID of the user to get maintenances for.
     * @returns {Promise<object>} A promise that resolves to an object with maintenance IDs as keys and maintenances objects as values.
     */
    async getMaintenanceJSONList(userID) {
        let result = {};
        for (let maintenanceID in this.maintenanceList) {
            const maintenance = this.maintenanceList[maintenanceID];
            if (maintenance.user_id === userID) {
                result[maintenanceID] = await maintenance.toJSON(this);
            }
        }
        return result;
    }

    /**
     * Load maintenance list and run
     * @param {any} userID Unused
     * @returns {Promise<void>}
     */
    async loadMaintenanceList(responseCache) {
        let maintenanceList = await this.store.findAll("maintenance", " ORDER BY end_date DESC, title", []);

        for (let maintenance of maintenanceList) {
            this.maintenanceList[maintenance.id] = maintenance;
            if (maintenance.active) {
                await maintenance.run(this.store, this, false, true, responseCache);
            }
        }
    }

    /**
     * Retrieve a specific maintenance
     * @param {number} maintenanceID ID of maintenance to retrieve
     * @returns {(object|null)} Maintenance if it exists
     */
    getMaintenance(maintenanceID) {
        if (this.maintenanceList[maintenanceID]) {
            return this.maintenanceList[maintenanceID];
        }
        return null;
    }

    /**
     * Get the IP of the client connected to the socket
     * @param {Socket} socket Socket to query
     * @returns {Promise<string>} IP of client
     */
    getClientIP(socket) {
        return this.getClientIPwithProxy(socket.client.conn.remoteAddress, socket.client.conn.request.headers);
    }

    /**
     * @param {string} clientIP Raw client IP
     * @param {IncomingHttpHeaders} headers HTTP headers
     * @returns {Promise<string>} Client IP with proxy (if trusted)
     */
    async getClientIPwithProxy(clientIP, headers) {
        if (clientIP === undefined) {
            clientIP = "";
        }

        if (await this.settings.get("trustProxy")) {
            const forwardedFor = headers["x-forwarded-for"];

            return (
                (typeof forwardedFor === "string" ? forwardedFor.split(",")[0].trim() : null) ||
                headers["x-real-ip"] ||
                clientIP.replace(/^::ffff:/, "")
            );
        } else {
            return clientIP.replace(/^::ffff:/, "");
        }
    }

    /**
     * Attempt to get the current server timezone
     * If this fails, fall back to environment variables and then make a
     * guess.
     * @returns {Promise<string>} Current timezone
     */
    async getTimezone() {
        // From process.env.TZ
        try {
            if (this.environmentTimezone) {
                this.checkTimezone(this.environmentTimezone);
                this.timezone = this.environmentTimezone;
                return this.environmentTimezone;
            }
        } catch (e) {
            log.warn("timezone", e.message + " in process.env.TZ");
        }

        let timezone = await this.settings.get("serverTimezone");

        // From Settings
        try {
            log.debug("timezone", "Using timezone from settings: " + timezone);
            if (timezone) {
                this.checkTimezone(timezone);
                this.timezone = timezone;
                return timezone;
            }
        } catch (e) {
            log.warn("timezone", e.message + " in settings");
        }

        // Guess
        try {
            let guess = dayjs.tz.guess();
            log.debug("timezone", "Guessing timezone: " + guess);
            if (guess) {
                this.checkTimezone(guess);
                this.timezone = guess;
                return guess;
            } else {
                this.timezone = "UTC";
                return "UTC";
            }
        } catch (e) {
            // Guess failed, fall back to UTC
            log.debug("timezone", "Guessed an invalid timezone. Use UTC as fallback");
            this.timezone = "UTC";
            return "UTC";
        }
    }

    /**
     * Get the current offset
     * @returns {string} Time offset
     */
    getTimezoneOffset() {
        return dayjs()
            .tz(this.timezone || this.environmentTimezone || dayjs.tz.guess())
            .format("Z");
    }

    /**
     * Throw an error if the timezone is invalid
     * @param {string} timezone Timezone to test
     * @returns {void}
     * @throws The timezone is invalid
     */
    checkTimezone(timezone) {
        try {
            dayjs.utc("2013-11-18 11:55").tz(timezone).format();
        } catch (e) {
            throw new Error("Invalid timezone:" + timezone);
        }
    }

    /**
     * Set the current server timezone and environment variables
     * @param {string} timezone Timezone to set
     * @returns {Promise<void>}
     */
    async setTimezone(timezone) {
        this.checkTimezone(timezone);
        await this.settings.set("serverTimezone", timezone, "general");
        this.timezone = timezone;
    }

    /**
     * TODO: Listen logic should be moved to here
     * @returns {Promise<void>}
     */
    async start() {
        let enable = await this.settings.get("nscd");

        if (enable || enable === null) {
            await this.startNSCDServices();
        }
    }

    /**
     * Stop the server
     * @returns {Promise<void>}
     */
    async stop() {
        if (!this.store.isOpen()) {
            return;
        }

        let enable = await this.settings.get("nscd");

        if (enable || enable === null) {
            await this.stopNSCDServices();
        }
    }

    /**
     * Start all system services (e.g. nscd)
     * For now, only used in Docker
     * @returns {void}
     */
    async startNSCDServices() {
        if (process.env.UPTIME_MAKU_IS_CONTAINER) {
            try {
                log.info("services", "Starting nscd");
                await runCommandChecked("sudo", ["service", "nscd", "start"]);
            } catch (e) {
                log.info("services", "Failed to start nscd");
            }
        }
    }

    /**
     * Stop all system services
     * @returns {void}
     */
    async stopNSCDServices() {
        if (process.env.UPTIME_MAKU_IS_CONTAINER) {
            try {
                log.info("services", "Stopping nscd");
                await runCommandChecked("sudo", ["service", "nscd", "stop"]);
            } catch (e) {
                log.info("services", "Failed to stop nscd");
            }
        }
    }

    /**
     * Default User-Agent when making HTTP requests
     * @returns {string} User-Agent
     */
    getUserAgent() {
        return "Uptime Maku/" + packageJson.version;
    }

    /**
     * Force connected sockets of a user to refresh and disconnect.
     * Used for resetting password.
     * @param {string} userID User ID
     * @param {string?} currentSocketID Current socket ID
     * @returns {void}
     */
    disconnectAllSocketClients(userID, currentSocketID = undefined) {
        for (const socket of this.io.sockets.sockets.values()) {
            if (socket.userID === userID && socket.id !== currentSocketID) {
                try {
                    socket.emit("refresh");
                    socket.disconnect();
                } catch (e) {}
            }
        }
    }
}

export { UptimeMakuServer };
