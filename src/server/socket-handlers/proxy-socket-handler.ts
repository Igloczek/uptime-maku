// @ts-nocheck

import { checkLogin } from "@/server/socket-auth";
import { Proxy } from "@/server/proxy";
import { sendProxyList } from "@/server/client";

/**
 * Handlers for proxy
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
export const proxySocketHandler = (socket, store, io, server) => {
    socket.on("addProxy", async (proxy, proxyID, callback) => {
        try {
            checkLogin(socket);

            const proxyModel = await Proxy.save(store, proxy, proxyID, socket.userID);
            await sendProxyList(store, io, socket);

            if (proxy.applyExisting) {
                await Proxy.reloadProxy(store, server.monitorList);
                await server.sendMonitorList(socket);
            }

            callback({
                ok: true,
                msg: "Saved.",
                msgi18n: true,
                id: proxyModel.id,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("deleteProxy", async (proxyID, callback) => {
        try {
            checkLogin(socket);

            await Proxy.delete(store, proxyID, socket.userID);
            await sendProxyList(store, io, socket);
            await Proxy.reloadProxy(store, server.monitorList);

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
};
