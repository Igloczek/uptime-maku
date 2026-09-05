// @ts-nocheck

import { log } from "@/server/logger";
import { sendInfo } from "@/server/client";
import { checkLogin } from "@/server/socket-auth";
import fs from "fs";
import path from "path";

const fsAsync = fs.promises;
const pushExamplesDir = path.join(import.meta.dirname, "../assets/push-examples");

/**
 * Get a game list via GameDig
 * @returns {object} list of games supported by GameDig
 */
async function getGameList() {
    const { games } = await import("gamedig");
    let gameList = [];
    gameList = Object.keys(games).map((key) => {
        const item = games[key];
        return {
            keys: [key],
            pretty: item.name,
            options: item.options,
            extra: item.extra || {},
        };
    });
    gameList.sort((a, b) => {
        if (a.pretty < b.pretty) {
            return -1;
        }
        if (a.pretty > b.pretty) {
            return 1;
        }
        return 0;
    });
    return gameList;
}

/**
 * Handler for general events
 * @param {Socket} socket Socket.io instance
 * @param {IgloMonitorServer} server iglo.monitor server
 * @returns {void}
 */
export const generalSocketHandler = (socket, server, settings, versionChecker) => {
    socket.on("initServerTimezone", async (timezone) => {
        try {
            checkLogin(socket);
            log.debug("generalSocketHandler", "Timezone: " + timezone);
            await settings.set("initServerTimezone", true);
            await server.setTimezone(timezone);
            await sendInfo(server, settings, versionChecker, socket);
        } catch (e) {
            log.warn("initServerTimezone", e.message);
        }
    });

    socket.on("getGameList", async (callback) => {
        try {
            checkLogin(socket);
            callback({
                ok: true,
                gameList: await getGameList(),
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("testChrome", (executable, callback) => {
        try {
            checkLogin(socket);
            server
                .getMonitorType("real-browser")
                .then((monitorType) => monitorType.testChrome(executable))
                .then((version) => {
                    callback({
                        ok: true,
                        msg: {
                            key: "foundChromiumVersion",
                            values: [version],
                        },
                    });
                })
                .catch((e) => {
                    callback({
                        ok: false,
                        msg: e.message,
                    });
                });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("getPushExample", async (type, callback) => {
        try {
            checkLogin(socket);
            const filename = path.join(pushExamplesDir, type + ".json");
            const content = await fsAsync.readFile(filename, "utf8");
            callback({
                ok: true,
                content,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("getPushExampleList", async (callback) => {
        try {
            checkLogin(socket);
            const files = await fsAsync.readdir(pushExamplesDir);
            callback({
                ok: true,
                list: files.map((file) => file.replace(".json", "")),
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    // Disconnect all other socket clients of the user
    socket.on("disconnectOtherSocketClients", async () => {
        try {
            checkLogin(socket);
            server.disconnectAllSocketClients(socket.userID, socket.id);
        } catch (e) {
            log.warn("disconnectAllSocketClients", e.message);
        }
    });
};
