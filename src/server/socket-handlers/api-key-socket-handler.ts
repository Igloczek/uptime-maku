// @ts-nocheck

/**
 * Handlers for API keys
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
import { checkLogin } from "@/server/socket-auth";
import { log } from "@/server/logger";
import passwordHash from "@/server/password-hash";
import { clearResponseCache } from "@/server/bun-response";
import APIKey from "@/server/model/api_key";
import { sendAPIKeyList } from "@/server/client";

export const apiKeySocketHandler = (socket, store, io, settings, responseCache) => {
    // Add a new api key
    socket.on("addAPIKey", async (key, callback) => {
        try {
            checkLogin(socket);

            let clearKey = "";
            while (clearKey.length < 40) {
                clearKey += crypto.randomUUID().replace(/-/g, "");
            }
            clearKey = clearKey.slice(0, 40);
            let hashedKey = await passwordHash.generate(clearKey);
            key["key"] = hashedKey;
            let model = await APIKey.save(store, key, socket.userID);

            log.debug("apikeys", "Added API Key");

            // Append key ID and prefix to start of key separated by _, used to get
            // correct hash when validating key.
            let formattedKey = "uk" + model.id + "_" + clearKey;
            await sendAPIKeyList(store, io, socket);

            // Enable API auth if the user creates a key, otherwise only basic
            // auth will be used for API.
            await settings.set("apiKeysEnabled", true);

            callback({
                ok: true,
                msg: "successAdded",
                msgi18n: true,
                key: formattedKey,
                keyID: model.id,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("getAPIKeyList", async (callback) => {
        try {
            checkLogin(socket);
            await sendAPIKeyList(store, io, socket);
            callback({
                ok: true,
            });
        } catch (e) {
            log.error("apikeys", e);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("deleteAPIKey", async (keyID, callback) => {
        try {
            checkLogin(socket);

            log.debug("apikeys", `Deleted API Key: ${keyID} User ID: ${socket.userID}`);

            await store.exec("DELETE FROM api_key WHERE id = ? AND user_id = ? ", [keyID, socket.userID]);

            clearResponseCache(responseCache);

            callback({
                ok: true,
                msg: "successDeleted",
                msgi18n: true,
            });

            await sendAPIKeyList(store, io, socket);
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("disableAPIKey", async (keyID, callback) => {
        try {
            checkLogin(socket);

            log.debug("apikeys", `Disabled Key: ${keyID} User ID: ${socket.userID}`);

            await store.exec("UPDATE api_key SET active = 0 WHERE id = ? AND user_id = ? ", [keyID, socket.userID]);

            clearResponseCache(responseCache);

            callback({
                ok: true,
                msg: "successDisabled",
                msgi18n: true,
            });

            await sendAPIKeyList(store, io, socket);
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("enableAPIKey", async (keyID, callback) => {
        try {
            checkLogin(socket);

            log.debug("apikeys", `Enabled Key: ${keyID} User ID: ${socket.userID}`);

            await store.exec("UPDATE api_key SET active = 1 WHERE id = ? AND user_id = ? ", [keyID, socket.userID]);

            clearResponseCache(responseCache);

            callback({
                ok: true,
                msg: "successEnabled",
                msgi18n: true,
            });

            await sendAPIKeyList(store, io, socket);
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });
};
