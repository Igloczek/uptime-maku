import { sendInfo, sendNotificationList } from "@/server/client";
import { log } from "@/server/logger";
import { Notification } from "@/server/notification";
import { passwordStrength } from "@/server/password-strength";
import { doubleCheckPassword } from "@/server/server-auth-helpers";
import { checkLogin } from "@/server/socket-auth";
import { getWebpushVapidPublicKey } from "@/server/webpush-vapid";
import TranslatableError from "@/server/translatable-error";
import User from "@/server/model/user";

/**
 * Register settings, password, and notification socket events.
 *
 * @param socket Socket.io-compatible socket
 * @param store Runtime SQLite store
 * @param server Runtime server
 * @param io Runtime socket adapter
 * @param settings Runtime settings store
 * @param versionChecker Runtime version checker
 * @param notificationProviderRegistry Runtime notification provider registry
 */
export function settingsSocketHandler(
    socket,
    store,
    server,
    io,
    settings,
    versionChecker,
    notificationProviderRegistry
) {
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

    socket.on("addNotification", async (notification, notificationID, callback) => {
        try {
            checkLogin(socket);

            let notificationBean = await Notification.save(store, notification, notificationID, socket.userID);
            await sendNotificationList(store, io, socket);

            callback({
                ok: true,
                msg: "Saved.",
                msgi18n: true,
                id: notificationBean.id,
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
                notificationProviderRegistry,
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
}
