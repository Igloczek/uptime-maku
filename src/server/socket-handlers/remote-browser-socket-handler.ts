// @ts-nocheck

/**
 * Handlers for docker hosts
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
import { sendRemoteBrowserList } from "@/server/client";
import { checkLogin } from "@/server/socket-auth";
import { RemoteBrowser } from "@/server/remote-browser";
import { log } from "@/server/logger";

export const remoteBrowserSocketHandler = (socket, store, io, server) => {
    socket.on("addRemoteBrowser", async (remoteBrowser, remoteBrowserID, callback) => {
        try {
            checkLogin(socket);

            let remoteBrowserModel = await RemoteBrowser.save(store, remoteBrowser, remoteBrowserID, socket.userID);
            if (remoteBrowserID) {
                await server.getLoadedMonitorType("real-browser")?.resetRemoteBrowser(remoteBrowserID, socket.userID);
            }
            await sendRemoteBrowserList(store, io, socket);

            callback({
                ok: true,
                msg: "Saved.",
                msgi18n: true,
                id: remoteBrowserModel.id,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("deleteRemoteBrowser", async (dockerHostID, callback) => {
        try {
            checkLogin(socket);

            await RemoteBrowser.delete(store, dockerHostID, socket.userID);
            await server.getLoadedMonitorType("real-browser")?.resetRemoteBrowser(dockerHostID, socket.userID);
            await sendRemoteBrowserList(store, io, socket);

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

    socket.on("testRemoteBrowser", async (remoteBrowser, callback) => {
        try {
            checkLogin(socket);

            const monitorType = await server.getMonitorType("real-browser");
            let check = await monitorType.testRemoteBrowser(remoteBrowser.url);
            log.info("remoteBrowser", "Tested remote browser: " + check);
            let msg;

            if (check) {
                msg = "Connected Successfully.";
            }

            callback({
                ok: true,
                msg,
            });
        } catch (e) {
            log.error("remoteBrowser", e);

            callback({
                ok: false,
                msg: e.message,
            });
        }
    });
};
