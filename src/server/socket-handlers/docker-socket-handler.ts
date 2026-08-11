// @ts-nocheck

/**
 * Handlers for docker hosts
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
import { sendDockerHostList } from "@/server/client";
import { checkLogin } from "@/server/socket-auth";
import { DockerHost } from "@/server/docker";
import { log } from "@/server/logger";

export const dockerSocketHandler = (socket, store, io) => {
    socket.on("addDockerHost", async (dockerHost, dockerHostID, callback) => {
        try {
            checkLogin(socket);

            let dockerHostModel = await DockerHost.save(store, dockerHost, dockerHostID, socket.userID);
            await sendDockerHostList(store, io, socket);

            callback({
                ok: true,
                msg: "Saved.",
                msgi18n: true,
                id: dockerHostModel.id,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("deleteDockerHost", async (dockerHostID, callback) => {
        try {
            checkLogin(socket);

            await DockerHost.delete(store, dockerHostID, socket.userID);
            await sendDockerHostList(store, io, socket);

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

    socket.on("testDockerHost", async (dockerHost, callback) => {
        try {
            checkLogin(socket);

            let amount = await DockerHost.testDockerHost(dockerHost);
            let msg;

            if (amount >= 1) {
                msg = "Connected Successfully. Amount of containers: " + amount;
            } else {
                msg = "Connected Successfully, but there are no containers?";
            }

            callback({
                ok: true,
                msg,
            });
        } catch (e) {
            log.error("docker", e);

            callback({
                ok: false,
                msg: e.message,
            });
        }
    });
};
