import {
    sendAPIKeyList,
    sendDockerHostList,
    sendHeartbeatList,
    sendInfo,
    sendMonitorTypeList,
    sendNotificationList,
    sendProxyList,
    sendRemoteBrowserList,
} from "@/server/client";
import { log } from "@/server/logger";
import Monitor from "@/server/model/monitor";
import StatusPage from "@/server/model/status_page";
import User from "@/server/model/user";
import TwoFA from "@/server/2fa";
import { login } from "@/server/auth";
import jwt from "@/server/jwt";
import { passwordStrength } from "@/server/password-strength";
import { doubleCheckPassword } from "@/server/server-auth-helpers";
import { checkLogin } from "@/server/socket-auth";
import { encodeSecretForUri, verify as verifyTotp } from "@/server/totp";
import TranslatableError from "@/server/translatable-error";
import * as passwordHash from "@/server/password-hash";
import { SHAKE256_LENGTH, shake256 } from "@/server/hash";
import { genSecret } from "@/util/random";

const twoFAVerifyOptions = {
    window: 1,
    time: 30,
};

export function clearTwoFAState(socket) {
    socket.pendingTwoFASecret = null;
    socket.twoFAVerified = false;
    socket.twoFAVerifiedSecret = null;
}

/**
 * Register login, setup, logout, and 2FA socket events.
 *
 * @param socket Socket.io-compatible socket
 * @param store Runtime SQLite store
 * @param server Runtime server
 * @param io Runtime socket adapter
 * @param settings Runtime settings store
 * @param versionChecker Runtime version checker
 * @param heartbeatData Runtime heartbeat data plane
 * @param authState Scoped setup state owned by the composition root
 * @param loginRateLimiter Login rate limiter
 * @param twoFaRateLimiter Two-factor rate limiter
 */
export function authSocketHandler(
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
) {
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

    async function afterLogin(user) {
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
                await afterLogin(user);
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
                await afterLogin(user);

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
                    await afterLogin(user);

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
        callback(authState.needSetup);
    });

    socket.on("setup", async (username, password, callback) => {
        try {
            if (typeof username !== "string" || !username.trim() || username.length > 255) {
                throw new Error("Invalid username");
            }

            if (passwordStrength(password).value === "Too weak") {
                throw new TranslatableError("passwordTooWeak");
            }

            if (!authState.needSetup || authState.setupInProgress) {
                throw new Error(
                    "Uptime Maku has been initialized. If you want to run setup again, please delete the database."
                );
            }

            authState.setupInProgress = true;
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

                authState.needSetup = false;

                callback({
                    ok: true,
                    msg: "successAdded",
                    msgi18n: true,
                });
            } finally {
                authState.setupInProgress = false;
            }
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
                msgi18n: !!e.msgi18n,
            });
        }
    });

    return { afterLogin };
}
