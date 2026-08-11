import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import TwoFA from "@/server/2fa";
import { login } from "@/server/auth";
import { BunSQLiteRedbean } from "@/server/sqlite-core";
import User from "@/server/model/user";
import passwordHash from "@/server/password-hash";
import jwt from "@/server/jwt";
import { initJWTSecret } from "@/server/server-auth-helpers";
import { checkLogin } from "@/server/socket-auth";
import { authSocketHandler } from "@/server/socket-handlers/auth-socket-handler";
import { settingsSocketHandler } from "@/server/socket-handlers/settings-socket-handler";
import { Settings } from "@/server/settings";
import "@/server/model-registry";

const directories = [];

async function createStore() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "uptime-maku-auth-settings-"));
    directories.push(directory);
    const store = new BunSQLiteRedbean();
    await store.connect({
        sqlitePath: path.join(directory, "kuma.db"),
        templatePath: path.join(process.cwd(), "src/db/kuma.db"),
        testMode: true,
    });
    return store;
}

function totp(uri) {
    const encoded = new URL(uri).searchParams.get("secret");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";
    for (const character of encoded) {
        bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
    }
    const secret = Buffer.from(bits.match(/.{8}/g).map((byte) => Number.parseInt(byte, 2)));
    const counter = Math.floor(Date.now() / 30_000);
    const buffer = Buffer.alloc(8);
    buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    buffer.writeUInt32BE(counter >>> 0, 4);
    const digest = createHmac("sha1", secret).update(buffer).digest();
    const index = digest[digest.length - 1] & 0x0f;
    return String((digest.readUInt32BE(index) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

afterEach(async () => {
    for (const directory of directories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe("auth and settings storage injection", () => {
    test("rejects an unauthenticated socket", () => {
        expect(() => checkLogin({ userID: null })).toThrow("You are not logged in.");
        expect(() => checkLogin({ userID: 1 })).not.toThrow();
    });

    test("keeps auth, persistent sessions, 2FA, and settings isolated per store", async () => {
        const first = await createStore();
        const second = await createStore();
        const firstSettings = new Settings(first);
        const secondSettings = new Settings(second);
        const password = "correct horse battery staple";
        const hash = await passwordHash.generate(password);

        try {
            await first.exec("INSERT INTO user (id, username, password, active, twofa_status) VALUES (?, ?, ?, ?, ?)", [
                1,
                "admin",
                hash,
                1,
                1,
            ]);
            await second.exec(
                "INSERT INTO user (id, username, password, active, twofa_status) VALUES (?, ?, ?, ?, ?)",
                [1, "admin", hash, 1, 1]
            );

            await firstSettings.set("entryPage", "first", "general");
            expect(await secondSettings.get("entryPage")).toBeNull();
            expect((await login(first, "admin", password))?.id).toBe(1);
            expect(await User.hasSession(second, "missing", 1)).toBe(false);

            const session = await User.createSession(first, { id: 1, username: "admin", password: hash }, "jwt-secret");
            expect(await User.hasSession(first, session.id, 1)).toBe(true);
            expect(await User.hasSession(second, session.id, 1)).toBe(false);

            await TwoFA.disable2FA(first, 1);
            expect(await first.getCell("SELECT twofa_status FROM user WHERE id = ?", [1])).toBe(0);
            expect(await second.getCell("SELECT twofa_status FROM user WHERE id = ?", [1])).toBe(1);

            await initJWTSecret(first);
            const jwtSecret = await first.getCell("SELECT value FROM setting WHERE `key` = ?", ["jwtSecret"]);
            expect(jwtSecret).toMatch(/^[A-Za-z0-9]{64}$/);
            expect(jwt.verify(jwt.sign({ user: "admin" }, jwtSecret), jwtSecret)).toEqual({ user: "admin" });
            expect(await second.getCell("SELECT value FROM setting WHERE `key` = ?", ["jwtSecret"])).toBeNull();
        } finally {
            firstSettings.stopCacheCleaner();
            secondSettings.stopCacheCleaner();
            await first.close();
            await second.close();
        }
    });

    test("keeps migrated auth, settings, password, and notification socket contracts", async () => {
        const store = await createStore();
        const settings = new Settings(store);
        const handlers = {};
        const emitted = [];
        const socket = {
            id: "auth-settings-socket",
            userID: null,
            sessionID: null,
            on(event, handler) {
                handlers[event] = handler;
            },
            emit(...args) {
                emitted.push(args);
            },
            join() {},
            leave() {},
        };
        const io = {
            sockets: { sockets: new Map() },
            to() {
                return { emit: (...args) => emitted.push(args) };
            },
        };
        const server = {
            jwtSecret: "socket-contract-secret",
            entryPage: "dashboard",
            monitorTypeList: {},
            statusPageDomainMappingList: {},
            getClientIP: async () => "127.0.0.1",
            getTimezone: async () => "UTC",
            getTimezoneOffset: () => "+00:00",
            sendMonitorList: async () => ({}),
            sendMaintenanceList: async () => {},
            disconnectAllSocketClients: () => {},
            setTimezone: async () => {},
            getLoadedMonitorType: () => null,
            startNSCDServices: async () => {},
            stopNSCDServices: async () => {},
        };
        const versionChecker = { version: "test", latestVersion: "test" };
        const rateLimiter = { pass: async () => true, reset: () => {} };
        const authState = { setupInProgress: false, needSetup: true };
        const providerRegistry = {
            get: async () => ({
                send: async (_notification, message) => `sent:${message}`,
            }),
        };

        authSocketHandler(
            socket,
            store,
            server,
            io,
            settings,
            versionChecker,
            { list: async () => [] },
            authState,
            rateLimiter,
            rateLimiter
        );
        settingsSocketHandler(socket, store, server, io, settings, versionChecker, providerRegistry);

        try {
            let response;
            await handlers.setup("admin", "Initial-pass1!", (result) => {
                response = result;
            });
            expect(response).toEqual({ ok: true, msg: "successAdded", msgi18n: true });
            expect(authState).toEqual({ setupInProgress: false, needSetup: false });

            await handlers.login({ username: "admin", password: "Initial-pass1!" }, (result) => {
                response = result;
            });
            expect(response.ok).toBe(true);
            expect(socket.userID).toBe(1);
            expect(typeof response.token).toBe("string");

            await handlers.getSettings((result) => {
                response = result;
            });
            expect(response).toMatchObject({ ok: true, data: { serverTimezone: "UTC" } });

            await handlers.setSettings({ entryPage: "settings" }, null, (result) => {
                response = result;
            });
            expect(response).toEqual({ ok: true, msg: "Saved.", msgi18n: true });
            expect(server.entryPage).toBe("settings");
            expect(await settings.get("entryPage")).toBe("settings");

            await handlers.addNotification({ name: "Test", type: "test" }, null, (result) => {
                response = result;
            });
            expect(response).toMatchObject({ ok: true, msg: "Saved.", msgi18n: true });
            const notificationID = response.id;
            expect(await store.getCell("SELECT name FROM notification WHERE id = ?", [notificationID])).toBe("Test");

            await handlers.testNotification({ name: "Test", type: "test" }, (result) => {
                response = result;
            });
            expect(response).toEqual({ ok: true, msg: "sent:Test Testing" });

            await handlers.deleteNotification(notificationID, (result) => {
                response = result;
            });
            expect(response).toEqual({ ok: true, msg: "successDeleted", msgi18n: true });

            await settings.set("webpushPublicVapidKey", "public-key");
            await handlers.getWebpushVapidPublicKey((result) => {
                response = result;
            });
            expect(response).toEqual({ ok: true, msg: "public-key" });

            await handlers.changePassword(
                { currentPassword: "Initial-pass1!", newPassword: "Changed-pass2!" },
                (result) => {
                    response = result;
                }
            );
            expect(response).toMatchObject({ ok: true, msg: "successAuthChangePassword", msgi18n: true });
            expect(await login(store, "admin", "Initial-pass1!")).toBeNull();
            expect((await login(store, "admin", "Changed-pass2!")).id).toBe(1);

            await handlers.prepare2FA("Changed-pass2!", (result) => {
                response = result;
            });
            expect(response.ok).toBe(true);
            expect(response.uri).toMatch(/^otpauth:\/\/totp\//);

            await handlers.verifyToken(totp(response.uri), "Changed-pass2!", (result) => {
                response = result;
            });
            expect(response).toEqual({ ok: true, valid: true });

            await handlers.save2FA("Changed-pass2!", (result) => {
                response = result;
            });
            expect(response).toEqual({ ok: true, msg: "2faEnabled", msgi18n: true });
            expect(socket.pendingTwoFASecret).toBeNull();

            await handlers.twoFAStatus((result) => {
                response = result;
            });
            expect(response).toEqual({ ok: true, status: true });

            await handlers.disable2FA("Changed-pass2!", (result) => {
                response = result;
            });
            expect(response).toEqual({ ok: true, msg: "2faDisabled", msgi18n: true });

            await handlers.logout(() => {});
            expect(socket.userID).toBeNull();
            expect(socket.pendingTwoFASecret).toBeNull();
            expect(emitted.some(([event]) => event === "notificationList")).toBe(true);
        } finally {
            settings.stopCacheCleaner();
            await store.close();
        }
    });
});
