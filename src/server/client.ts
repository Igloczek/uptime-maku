// @ts-nocheck
/*
 * For Client Socket
 */

/**
 * Send list of notification providers to client
 * @param {Socket} socket Socket.io socket instance
 * @returns {Promise<Bean[]>} List of notifications
 */
import { TimeLogger } from "@/server/time-logger";
import { getRuntimeInfo } from "@/server/runtime";

async function sendNotificationList(store, io, socket) {
    const timeLogger = new TimeLogger();

    let result = [];
    let list = await store.find("notification", " user_id = ? ", [socket.userID]);

    for (let bean of list) {
        let notificationObject = bean.export();
        notificationObject.isDefault = notificationObject.isDefault === 1;
        notificationObject.active = notificationObject.active === 1;
        result.push(notificationObject);
    }

    io.to(socket.userID).emit("notificationList", result);

    timeLogger.print("Send Notification List");

    return list;
}

/**
 * Send Heartbeat History list to socket
 * @param {Socket} socket Socket.io instance
 * @param {number} monitorID ID of monitor to send heartbeat history
 * @param {boolean} toUser  True = send to all browsers with the same user id, False = send to the current browser only
 * @param {boolean} overwrite Overwrite client-side's heartbeat list
 * @returns {Promise<void>}
 */
async function sendHeartbeatList(heartbeatData, io, socket, monitorID, toUser = false, overwrite = false) {
    const result = (await heartbeatData.list(monitorID)).map((bean) => bean.toJSON());

    if (toUser) {
        io.to(socket.userID).emit("heartbeatList", monitorID, result, overwrite);
    } else {
        socket.emit("heartbeatList", monitorID, result, overwrite);
    }
}

/**
 * Important Heart beat list (aka event list)
 * @param {Socket} socket Socket.io instance
 * @param {number} monitorID ID of monitor to send heartbeat history
 * @param {boolean} toUser  True = send to all browsers with the same user id, False = send to the current browser only
 * @param {boolean} overwrite Overwrite client-side's heartbeat list
 * @returns {Promise<void>}
 */
async function sendImportantHeartbeatList(heartbeatData, io, socket, monitorID, toUser = false, overwrite = false) {
    const timeLogger = new TimeLogger();

    const list = await heartbeatData.importantPage(socket.userID, monitorID, 0, 500);

    timeLogger.print(`[Monitor: ${monitorID}] sendImportantHeartbeatList`);

    const result = list.map((bean) => bean.toJSON());

    if (toUser) {
        io.to(socket.userID).emit("importantHeartbeatList", monitorID, result, overwrite);
    } else {
        socket.emit("importantHeartbeatList", monitorID, result, overwrite);
    }
}

/**
 * Emit proxy list to client
 * @param {Socket} socket Socket.io socket instance
 * @returns {Promise<Bean[]>} List of proxies
 */
async function sendProxyList(store, io, socket) {
    const timeLogger = new TimeLogger();

    const list = await store.find("proxy", " user_id = ? ", [socket.userID]);
    io.to(socket.userID).emit(
        "proxyList",
        list.map((bean) => bean.export())
    );

    timeLogger.print("Send Proxy List");

    return list;
}

/**
 * Emit API key list to client
 * @param {Socket} socket Socket.io socket instance
 * @returns {Promise<void>}
 */
async function sendAPIKeyList(store, io, socket) {
    const timeLogger = new TimeLogger();

    let result = [];
    const list = await store.find("api_key", "user_id=?", [socket.userID]);

    for (let bean of list) {
        result.push(bean.toPublicJSON());
    }

    io.to(socket.userID).emit("apiKeyList", result);
    timeLogger.print("Sent API Key List");

    return list;
}

/**
 * Emits the version information to the client.
 * @param {Socket} socket Socket.io socket instance
 * @param {boolean} hideVersion Should we hide the version information in the response?
 * @returns {Promise<void>}
 */
async function sendInfo(server, settings, versionChecker, socket, hideVersion = false) {
    const info = {
        primaryBaseURL: await settings.get("primaryBaseURL"),
        serverTimezone: await server.getTimezone(),
        serverTimezoneOffset: server.getTimezoneOffset(),
    };
    if (!hideVersion) {
        info.version = versionChecker.version;
        info.latestVersion = versionChecker.latestVersion;
        info.isContainer = process.env.IGLO_MONITOR_IS_CONTAINER === "1";
        info.dbType = "sqlite";
        info.runtime = getRuntimeInfo();
    }

    socket.emit("info", info);
}

/**
 * Send list of docker hosts to client
 * @param {Socket} socket Socket.io socket instance
 * @returns {Promise<Bean[]>} List of docker hosts
 */
async function sendDockerHostList(store, io, socket) {
    const timeLogger = new TimeLogger();

    let result = [];
    let list = await store.find("docker_host", " user_id = ? ", [socket.userID]);

    for (let bean of list) {
        result.push(bean.toJSON());
    }

    io.to(socket.userID).emit("dockerHostList", result);

    timeLogger.print("Send Docker Host List");

    return list;
}

/**
 * Send list of docker hosts to client
 * @param {Socket} socket Socket.io socket instance
 * @returns {Promise<Bean[]>} List of docker hosts
 */
async function sendRemoteBrowserList(store, io, socket) {
    const timeLogger = new TimeLogger();

    let result = [];
    let list = await store.find("remote_browser", " user_id = ? ", [socket.userID]);

    for (let bean of list) {
        result.push(bean.toJSON());
    }

    io.to(socket.userID).emit("remoteBrowserList", result);

    timeLogger.print("Send Remote Browser List");

    return list;
}

/**
 * Send list of monitor types to client
 * @param {Socket} socket Socket.io socket instance
 * @returns {Promise<void>}
 */
async function sendMonitorTypeList(monitorTypeList, io, socket) {
    const result = Object.entries(monitorTypeList).map(([key, type]) => {
        return [
            key,
            {
                supportsConditions: type.supportsConditions,
                conditionVariables: type.conditionVariables.map((v) => {
                    return {
                        id: v.id,
                        operators: v.operators.map((o) => {
                            return {
                                id: o.id,
                                caption: o.caption,
                            };
                        }),
                    };
                }),
            },
        ];
    });

    io.to(socket.userID).emit("monitorTypeList", Object.fromEntries(result));
}

export {
    sendNotificationList,
    sendImportantHeartbeatList,
    sendHeartbeatList,
    sendProxyList,
    sendAPIKeyList,
    sendInfo,
    sendDockerHostList,
    sendRemoteBrowserList,
    sendMonitorTypeList,
};
