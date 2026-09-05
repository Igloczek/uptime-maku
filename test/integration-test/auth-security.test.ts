// @ts-nocheck

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const projectRoot = path.join(import.meta.dirname, "../..");
const binaryPath = process.env.IGLO_MONITOR_BINARY ? path.resolve(projectRoot, process.env.IGLO_MONITOR_BINARY) : null;

let appProcess;
let dataDir;
let sockets = [];

function withTimeout(promise, timeout, message) {
    let timeoutID;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timeoutID = setTimeout(() => reject(new Error(message)), timeout);
        }),
    ]).finally(() => clearTimeout(timeoutID));
}

function reservePort() {
    const listener = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: { data() {} },
    });
    const port = listener.port;
    listener.stop(true);
    return port;
}

async function waitForApp(url) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (appProcess.exitCode !== null) {
            throw new Error(`iglo.monitor exited before becoming ready (exit ${appProcess.exitCode})`);
        }
        try {
            if ((await fetch(url)).ok) {
                return;
            }
        } catch {}
        await Bun.sleep(100);
    }
    throw new Error("iglo.monitor did not become ready within 30 seconds");
}

async function startApp() {
    const port = reservePort();
    const command = binaryPath
        ? [binaryPath, `--port=${port}`, "--host=127.0.0.1", `--data-dir=${dataDir}`]
        : [process.execPath, "src/server/server.ts", `--port=${port}`, "--host=127.0.0.1", `--data-dir=${dataDir}`];
    appProcess = Bun.spawn(command, {
        cwd: projectRoot,
        env: {
            ...process.env,
            NODE_ENV: "production",
            IGLO_MONITOR_WS_ORIGIN_CHECK: "bypass",
        },
        stdout: "ignore",
        stderr: "ignore",
    });
    await waitForApp(`http://127.0.0.1:${port}`);
    return port;
}

async function stopApp() {
    const processToStop = appProcess;
    for (const socket of sockets.splice(0)) {
        socket.close();
    }
    if (!processToStop) {
        return;
    }
    if (processToStop.exitCode === null) {
        processToStop.kill("SIGTERM");
        try {
            await withTimeout(processToStop.exited, 5_000, "iglo.monitor did not stop after SIGTERM");
        } catch {
            processToStop.kill("SIGKILL");
            await processToStop.exited;
        }
    }

    appProcess = null;
}

async function connectRealtime(port, headers) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, headers ? { headers } : undefined);
    sockets.push(socket);
    const callbacks = new Map();
    let nextID = 1;

    const ready = new Promise((resolve, reject) => {
        socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
        socket.addEventListener("close", () => reject(new Error("WebSocket closed before handlers were ready")), {
            once: true,
        });
        socket.addEventListener("message", (event) => {
            const message = JSON.parse(String(event.data));
            if (message.type === "event" && (message.event === "loginRequired" || message.event === "autoLogin")) {
                resolve();
            } else if ((message.type === "reply" || message.type === "error") && message.id) {
                const callback = callbacks.get(message.id);
                if (callback) {
                    callbacks.delete(message.id);
                    message.type === "error"
                        ? callback.reject(new Error(message.message))
                        : callback.resolve(message.args?.[0]);
                }
            }
        });
    });

    await withTimeout(ready, 10_000, "WebSocket handlers were not ready");

    return {
        socket,
        request(event, ...args) {
            const id = String(nextID++);
            const reply = new Promise((resolve, reject) => callbacks.set(id, { resolve, reject }));
            socket.send(JSON.stringify({ type: "event", event, args, id }));
            return withTimeout(reply, 15_000, `No reply for WebSocket event ${event}`);
        },
    };
}

function basic(username, password) {
    return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function totp(uri, offset = 0) {
    const encoded = new URL(uri).searchParams.get("secret");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";
    for (const character of encoded) {
        bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
    }
    const secret = Buffer.from(bits.match(/.{8}/g).map((byte) => Number.parseInt(byte, 2)));
    const counter = Math.floor(Date.now() / 30_000) + offset;
    const buffer = Buffer.alloc(8);
    buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    buffer.writeUInt32BE(counter >>> 0, 4);
    const digest = createHmac("sha1", secret).update(buffer).digest();
    const index = digest[digest.length - 1] & 0x0f;
    return String((digest.readUInt32BE(index) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function metrics(port, authorization, suffix = "") {
    return fetch(`http://127.0.0.1:${port}/metrics${suffix}`, {
        headers: authorization ? { authorization } : {},
    });
}

async function runAdminScript(script, args = [], stdin = null) {
    const child = Bun.spawn([process.execPath, script, ...args], {
        cwd: projectRoot,
        env: { ...process.env, NODE_ENV: "production" },
        stdin: stdin === null ? "ignore" : new Blob([stdin]),
        stdout: "pipe",
        stderr: "pipe",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) {
        throw new Error(
            `${script} exited ${exitCode}: ${await new Response(child.stderr).text()} ${await new Response(child.stdout).text()}`
        );
    }
}

afterEach(async () => {
    await stopApp();
    if (dataDir) {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

describe("production auth, API key, and metrics boundaries", () => {
    test("claims setup before hashing and releases the claim after concurrent setup attempts", async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-setup-concurrency-"));
        const port = await startApp();
        const results = await Promise.all(
            Array.from({ length: 32 }, async (_, index) => {
                const socket = await connectRealtime(port);
                return socket.request("setup", `admin-${index}`, `Setup-password-${index}!`);
            })
        );

        expect(results.filter((result) => result.ok)).toHaveLength(1);
        const database = new Database(path.join(dataDir, "kuma.db"), { readonly: true });
        expect(database.query("SELECT COUNT(*) AS count FROM user").get().count).toBe(1);
        database.close();
    }, 120_000);

    test("throttles HTTP Basic and API-key attempts before verification", async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-http-auth-concurrency-"));
        const port = await startApp();
        const socket = await connectRealtime(port);
        expect((await socket.request("setup", "admin", "admin-password")).ok).toBe(true);
        expect(
            (
                await socket.request("login", {
                    username: "admin",
                    password: "admin-password",
                    token: "",
                })
            ).ok
        ).toBe(true);
        const basicResults = await Promise.all(
            Array.from({ length: 25 }, () => metrics(port, basic("admin", "wrong-password")))
        );
        const ownerKey = await socket.request("addAPIKey", { name: "burst key", active: 1, expires: null });
        expect(ownerKey.ok).toBe(true);

        const wrongKey = `${ownerKey.key.slice(0, -1)}${ownerKey.key.endsWith("a") ? "b" : "a"}`;
        const apiResults = await Promise.all(Array.from({ length: 65 }, () => metrics(port, basic("", wrongKey))));
        expect(basicResults.every((response) => response.status === 401)).toBe(true);
        expect(apiResults.every((response) => response.status === 401)).toBe(true);

        expect((await metrics(port, basic("admin", "admin-password"))).status).toBe(401);
        expect((await metrics(port, basic("", ownerKey.key))).status).toBe(401);
    }, 120_000);

    test("setup, persistent sessions, ownership, and secret redaction", async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-auth-security-"));
        let port = await startApp();
        const first = await connectRealtime(port);
        const second = await connectRealtime(port);

        expect((await first.request("setup", "", "valid-password")).ok).toBe(false);
        expect((await first.request("setup", "x".repeat(256), "valid-password")).ok).toBe(false);
        expect((await first.request("setup", "admin", "")).ok).toBe(false);

        const setups = await Promise.all([
            first.request("setup", "admin-a", "admin-a-password"),
            second.request("setup", "admin-b", "admin-b-password"),
        ]);
        expect(setups.filter((result) => result.ok)).toHaveLength(1);

        const winner = setups[0].ok
            ? { socket: first, username: "admin-a", password: "admin-a-password" }
            : { socket: second, username: "admin-b", password: "admin-b-password" };
        const login = await winner.socket.request("login", {
            username: winner.username,
            password: winner.password,
            token: "",
        });
        expect(login.ok).toBe(true);

        await winner.socket.request("logout");
        const replaySocket = await connectRealtime(port);
        expect((await replaySocket.request("loginByToken", login.token)).ok).toBe(false);

        const freshLogin = await winner.socket.request("login", {
            username: winner.username,
            password: winner.password,
            token: "",
        });
        expect(freshLogin.ok).toBe(true);

        await stopApp();
        const db = new Database(path.join(dataDir, "kuma.db"));
        expect(db.query("SELECT * FROM setting WHERE `key` LIKE 'session:%'").all()).toHaveLength(1);
        const ownerID = db.query("SELECT id FROM user WHERE username = ?").get(winner.username).id;
        db.query(
            `
                INSERT INTO monitor (
                    name, active, user_id, interval, url, type, manual_status,
                    kafka_producer_brokers, kafka_producer_sasl_options, rabbitmq_nodes, conditions
                ) VALUES (?, 1, ?, 60, ?, 'manual', 1, '[]', '{}', '[]', '[]')
            `
        ).run('quoted \\"monitor\\"\nname', ownerID, "https://user:password@example.invalid/private?token=secret");
        db.query("INSERT INTO user (username, password) VALUES (?, ?)").run(
            "other-user",
            await Bun.password.hash("other-user-password", { algorithm: "argon2id" })
        );
        db.close();

        port = await startApp();
        const restarted = await connectRealtime(port);
        expect(await restarted.request("loginByToken", freshLogin.token)).toEqual({ ok: true });

        const basicMetrics = await metrics(port, basic(winner.username, winner.password));
        expect(basicMetrics.status).toBe(200);
        expect(basicMetrics.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
        const body = await basicMetrics.text();
        expect(body).toContain("# HELP monitor_status");
        expect(body).toContain('monitor_name="quoted \\\\\\\"monitor\\\\\\\"\\nname"');
        expect(body).not.toContain("password");
        expect(body).not.toContain("token=secret");

        expect((await metrics(port, `Bearer ${freshLogin.token}`)).status).toBe(401);
        expect((await metrics(port, null, `?api_key=${freshLogin.token}`)).status).toBe(401);
        expect((await metrics(port, null)).status).toBe(401);

        const ownerKey = await restarted.request("addAPIKey", {
            name: "owner key",
            active: 1,
            expires: null,
        });
        expect(ownerKey).toMatchObject({ ok: true });
        const ownerKeyMetrics = await metrics(port, basic("", ownerKey.key));
        expect(ownerKeyMetrics.status).toBe(200);
        expect(await ownerKeyMetrics.text()).not.toContain(ownerKey.key);
        expect((await metrics(port, basic("", ownerKey.key.replace(/^uk/, "xx")))).status).toBe(401);
        expect((await metrics(port, `bAsIc ${Buffer.from(`:${ownerKey.key}`).toString("base64")}`)).status).toBe(200);
        expect(
            (
                await fetch(`http://127.0.0.1:${port}/metrics`, {
                    headers: [
                        ["authorization", basic("", ownerKey.key)],
                        ["authorization", basic("", "wrong-key")],
                    ],
                })
            ).status
        ).toBe(401);
        const ownerKeySecret = ownerKey.key.split("_")[1];
        const nonCanonicalKeys = [
            `uk000${ownerKey.keyID}_${ownerKeySecret}`,
            `uk0_${ownerKeySecret}`,
            `UK${ownerKey.keyID}_${ownerKeySecret}`,
            `${ownerKey.key} `,
            `${ownerKey.key}x`,
            `${ownerKey.key}?query=secret`,
        ];
        for (const malformedKey of nonCanonicalKeys) {
            expect((await metrics(port, basic("", malformedKey))).status).toBe(401);
        }
        expect((await metrics(port, `Bearer ${ownerKey.key}`)).status).toBe(401);
        expect((await metrics(port, null, `?api_key=${ownerKey.key}`)).status).toBe(401);
        expect(
            (
                await fetch(`http://127.0.0.1:${port}/metrics`, {
                    headers: { cookie: `api_key=${ownerKey.key}` },
                })
            ).status
        ).toBe(401);
        const keyDatabase = new Database(path.join(dataDir, "kuma.db"), { readonly: true });
        const storedOwnerKey = keyDatabase.query("SELECT key, user_id FROM api_key WHERE id = ?").get(ownerKey.keyID);
        keyDatabase.close();
        expect(storedOwnerKey.key).not.toContain(ownerKey.key.split("_")[1]);
        expect(storedOwnerKey.key).toStartWith("$argon2id$");
        expect(storedOwnerKey.user_id).toBe(ownerID);
        const concurrentMetrics = await Promise.all(
            Array.from({ length: 20 }, () => metrics(port, basic("", ownerKey.key)))
        );
        expect(concurrentMetrics.every((response) => response.status === 200)).toBe(true);
        const headMetrics = await fetch(`http://127.0.0.1:${port}/metrics`, {
            method: "HEAD",
            headers: { authorization: basic("", ownerKey.key) },
        });
        expect(headMetrics.status).toBe(200);
        expect(await headMetrics.text()).toBe("");
        const ownerList = await restarted.request("getAPIKeyList");
        expect(ownerList.ok).toBe(true);

        await restarted.request("disableAPIKey", ownerKey.keyID);
        expect((await metrics(port, basic("", ownerKey.key))).status).toBe(401);
        await restarted.request("enableAPIKey", ownerKey.keyID);
        expect((await metrics(port, basic("", ownerKey.key))).status).toBe(200);

        const expiredKey = await restarted.request("addAPIKey", {
            name: "expired key",
            active: 1,
            expires: "2000-01-01 00:00:00",
        });
        expect(expiredKey.ok).toBe(true);
        expect((await metrics(port, basic("", expiredKey.key))).status).toBe(401);

        const other = await connectRealtime(port);
        expect(
            (
                await other.request("login", {
                    username: "other-user",
                    password: "other-user-password",
                    token: "",
                })
            ).ok
        ).toBe(true);
        const otherKey = await other.request("addAPIKey", {
            name: "other key",
            active: 1,
            expires: null,
        });
        const otherMetrics = await metrics(port, basic("", otherKey.key));
        expect(otherMetrics.status).toBe(200);
        expect(await otherMetrics.text()).not.toContain("quoted");

        await restarted.request("disableAPIKey", otherKey.keyID);
        expect((await metrics(port, basic("", otherKey.key))).status).toBe(200);

        await other.request("disableAPIKey", otherKey.keyID);
        expect((await metrics(port, basic("", otherKey.key))).status).toBe(401);
        await other.request("enableAPIKey", otherKey.keyID);
        expect((await metrics(port, basic("", otherKey.key))).status).toBe(200);
        await other.request("deleteAPIKey", otherKey.keyID);
        expect((await metrics(port, basic("", otherKey.key))).status).toBe(401);
        await restarted.request("deleteAPIKey", ownerKey.keyID);
        expect((await metrics(port, basic("", ownerKey.key))).status).toBe(401);
    }, 120_000);

    test("private events, password changes, and 2FA reject invalid and replayed credentials", async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-password-2fa-"));
        const port = await startApp();
        const socket = await connectRealtime(port);

        expect(await socket.request("getSettings")).toEqual({ ok: false, msg: "You are not logged in." });
        expect((await socket.request("setup", "admin", "admin-password")).ok).toBe(true);

        const wrongUser = await socket.request("login", {
            username: "missing",
            password: "admin-password",
            token: "",
        });
        const wrongPassword = await socket.request("login", {
            username: "admin",
            password: "wrong-password",
            token: "",
        });
        expect(wrongUser).toEqual(wrongPassword);

        const login = await socket.request("login", {
            username: "admin",
            password: "admin-password",
            token: "",
        });
        expect(login.ok).toBe(true);
        expect(
            (
                await socket.request("changePassword", {
                    currentPassword: "wrong-password",
                    newPassword: "new-admin-password",
                })
            ).ok
        ).toBe(false);
        const changed = await socket.request("changePassword", {
            currentPassword: "admin-password",
            newPassword: "new-admin-password",
        });
        expect(changed.ok).toBe(true);

        const oldSession = await connectRealtime(port);
        expect((await oldSession.request("loginByToken", login.token)).ok).toBe(false);
        expect(
            (
                await oldSession.request("login", {
                    username: "admin",
                    password: "admin-password",
                    token: "",
                })
            ).ok
        ).toBe(false);
        expect((await oldSession.request("loginByToken", changed.token)).ok).toBe(true);

        expect((await socket.request("prepare2FA", "wrong-password")).ok).toBe(false);
        const prepared = await socket.request("prepare2FA", "new-admin-password");
        expect(prepared.ok).toBe(true);
        expect((await socket.request("save2FA", "new-admin-password")).ok).toBe(false);
        expect((await socket.request("verifyToken", "000000", "new-admin-password")).valid).toBe(false);

        const token = totp(prepared.uri);
        expect((await socket.request("verifyToken", token, "new-admin-password")).valid).toBe(true);
        expect((await socket.request("verifyToken", token, "new-admin-password")).valid).toBe(false);
        expect((await socket.request("save2FA", "new-admin-password")).ok).toBe(true);

        await socket.request("logout");
        const twoFactorLogin = await connectRealtime(port);
        expect(
            await twoFactorLogin.request("login", {
                username: "admin",
                password: "new-admin-password",
                token: "",
            })
        ).toEqual({ tokenRequired: true });
        expect(
            (
                await twoFactorLogin.request("login", {
                    username: "admin",
                    password: "new-admin-password",
                    token: "000000",
                })
            ).ok
        ).toBe(false);

        const nextToken = totp(prepared.uri, 1);
        expect(
            (
                await twoFactorLogin.request("login", {
                    username: "admin",
                    password: "new-admin-password",
                    token: nextToken,
                })
            ).ok
        ).toBe(true);
        const replay = await connectRealtime(port);
        expect(
            (
                await replay.request("login", {
                    username: "admin",
                    password: "new-admin-password",
                    token: nextToken,
                })
            ).ok
        ).toBe(false);
        expect((await twoFactorLogin.request("disable2FA", "wrong-password")).ok).toBe(false);
        expect((await twoFactorLogin.request("disable2FA", "new-admin-password")).ok).toBe(true);
        const twoFactorDatabase = new Database(path.join(dataDir, "kuma.db"), { readonly: true });
        const disabledTwoFactor = twoFactorDatabase
            .query("SELECT twofa_status, twofa_secret, twofa_last_token FROM user WHERE username = 'admin'")
            .get();
        twoFactorDatabase.close();
        expect(disabledTwoFactor).toEqual({ twofa_status: 0, twofa_secret: null, twofa_last_token: null });
    }, 120_000);

    test("consumes one concurrent TOTP login code before issuing a session", async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-totp-concurrency-"));
        const port = await startApp();
        const setupSocket = await connectRealtime(port);
        expect((await setupSocket.request("setup", "admin", "admin-password")).ok).toBe(true);
        expect(
            (
                await setupSocket.request("login", {
                    username: "admin",
                    password: "admin-password",
                    token: "",
                })
            ).ok
        ).toBe(true);

        const prepared = await setupSocket.request("prepare2FA", "admin-password");
        expect(prepared.ok).toBe(true);
        const setupToken = totp(prepared.uri);
        expect((await setupSocket.request("verifyToken", setupToken, "admin-password")).valid).toBe(true);
        expect((await setupSocket.request("save2FA", "admin-password")).ok).toBe(true);
        await setupSocket.request("logout");

        const loginToken = totp(prepared.uri, 1);
        const first = await connectRealtime(port);
        const second = await connectRealtime(port);
        const results = await Promise.all(
            [first, second].map((socket) =>
                socket.request("login", {
                    username: "admin",
                    password: "admin-password",
                    token: loginToken,
                })
            )
        );

        expect(results.filter((result) => result.ok)).toHaveLength(1);
        expect(results.filter((result) => !result.ok)).toHaveLength(1);
        const winner = results.find((result) => result.ok);
        const database = new Database(path.join(dataDir, "kuma.db"), { readonly: true });
        expect(database.query("SELECT `key` FROM setting WHERE `key` LIKE 'session:%'").all()).toHaveLength(1);
        database.close();

        const replay = await connectRealtime(port);
        expect((await replay.request("loginByToken", winner.token)).ok).toBe(true);
    }, 120_000);

    test("binds a pending 2FA secret to its socket and rejects replacement saves", async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-2fa-socket-state-"));
        const port = await startApp();
        const first = await connectRealtime(port);
        expect((await first.request("setup", "admin", "admin-password")).ok).toBe(true);
        expect(
            (
                await first.request("login", {
                    username: "admin",
                    password: "admin-password",
                    token: "",
                })
            ).ok
        ).toBe(true);

        const second = await connectRealtime(port);
        expect(
            (
                await second.request("login", {
                    username: "admin",
                    password: "admin-password",
                    token: "",
                })
            ).ok
        ).toBe(true);

        const preparedA = await first.request("prepare2FA", "admin-password");
        expect(preparedA.ok).toBe(true);

        const tokenA = totp(preparedA.uri);
        expect((await first.request("verifyToken", tokenA, "admin-password")).valid).toBe(true);
        expect((await first.request("verifyToken", tokenA, "admin-password")).valid).toBe(false);

        const preparedB = await second.request("prepare2FA", "admin-password");
        expect(preparedB.ok).toBe(true);
        expect(preparedA.uri).not.toBe(preparedB.uri);
        const resetDatabase = new Database(path.join(dataDir, "kuma.db"), { readonly: true });
        expect(resetDatabase.query("SELECT twofa_last_token FROM user WHERE username = 'admin'").get()).toEqual({
            twofa_last_token: null,
        });
        resetDatabase.close();

        expect((await first.request("save2FA", "admin-password")).ok).toBe(false);

        const database = new Database(path.join(dataDir, "kuma.db"), { readonly: true });
        expect(database.query("SELECT twofa_status FROM user WHERE username = 'admin'").get().twofa_status).toBe(0);
        database.close();

        const tokenB = totp(preparedB.uri, tokenA === totp(preparedB.uri) ? 1 : 0);
        expect((await second.request("verifyToken", tokenB, "admin-password")).valid).toBe(true);
        expect((await second.request("save2FA", "admin-password")).ok).toBe(true);

        first.socket.close();
        expect((await second.request("disable2FA", "admin-password")).ok).toBe(true);
        const cleanupDatabase = new Database(path.join(dataDir, "kuma.db"), { readonly: true });
        expect(
            cleanupDatabase
                .query("SELECT twofa_status, twofa_secret, twofa_last_token FROM user WHERE username = 'admin'")
                .get()
        ).toEqual({ twofa_status: 0, twofa_secret: null, twofa_last_token: null });
        cleanupDatabase.close();
    }, 120_000);

    test("reserves a password-login token before concurrent credential verification", async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-login-concurrency-"));
        const port = await startApp();
        const socket = await connectRealtime(port);
        expect((await socket.request("setup", "admin", "admin-password")).ok).toBe(true);

        const results = await Promise.all(
            Array.from({ length: 35 }, () =>
                socket.request("login", {
                    username: "admin",
                    password: "wrong-password",
                    token: "",
                })
            )
        );

        expect(results.filter((result) => result.msg === "Too frequently, try again later.")).not.toHaveLength(0);
    }, 120_000);

    test("login throttling does not let unrelated usernames exhaust the admin bucket", async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-login-rate-limit-"));
        const port = await startApp();
        const socket = await connectRealtime(port);
        expect((await socket.request("setup", "admin", "admin-password")).ok).toBe(true);

        for (let index = 0; index < 21; index++) {
            await socket.request("login", {
                username: `missing-${index}`,
                password: "wrong-password",
                token: "",
            });
        }

        expect(
            (
                await socket.request("login", {
                    username: "admin",
                    password: "admin-password",
                    token: "",
                })
            ).ok
        ).toBe(true);
    }, 120_000);

    test("uses the real WebSocket peer for source fallback despite rotated forwarding headers", async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-ws-peer-source-"));
        const port = await startApp();
        const setup = await connectRealtime(port);
        expect((await setup.request("setup", "admin", "admin-password")).ok).toBe(true);
        const spoofedSockets = await Promise.all(
            Array.from({ length: 5 }, (_, index) =>
                connectRealtime(port, {
                    "x-forwarded-for": `203.0.113.${index + 1}`,
                    "x-real-ip": `198.51.100.${index + 1}`,
                })
            )
        );

        for (let identity = 0; identity < 100; identity++) {
            await spoofedSockets[identity % spoofedSockets.length].request("login", {
                username: `exact-${identity}`,
                password: "wrong-password",
                token: "",
            });
        }

        const overflow = [];
        for (let attempt = 0; attempt < 250; attempt++) {
            overflow.push(
                await spoofedSockets[attempt % spoofedSockets.length].request("login", {
                    username: `overflow-${attempt}`,
                    password: "wrong-password",
                    token: "",
                })
            );
        }

        const blocked = overflow.filter((result) => result.msg === "Too frequently, try again later.").length;
        expect(blocked).toBe(50);
        expect(overflow.length - blocked).toBe(200);
        expect(
            await spoofedSockets[0].request("login", {
                username: "admin",
                password: "admin-password",
                token: "",
            })
        ).toMatchObject({ msg: "Too frequently, try again later." });
    }, 120_000);

    test("preserves WebSocket, HTTP Basic, and API-key partial penalties through adversarial churn", async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-rate-limit-churn-"));
        let port = await startApp();
        let socket = await connectRealtime(port);
        expect((await socket.request("setup", "admin", "admin-password")).ok).toBe(true);
        await stopApp();
        const database = new Database(path.join(dataDir, "kuma.db"));
        database
            .query("INSERT INTO user (username, password) VALUES (?, ?)")
            .run("other", await Bun.password.hash("other-password", { algorithm: "argon2id" }));
        database.close();
        port = await startApp();
        socket = await connectRealtime(port);
        expect(
            (
                await socket.request("login", {
                    username: "admin",
                    password: "admin-password",
                    token: "",
                })
            ).ok
        ).toBe(true);

        for (let attempt = 0; attempt < 19; attempt++) {
            await socket.request("login", { username: "admin", password: "wrong-password", token: "" });
        }
        for (let identity = 0; identity < 100; identity++) {
            await socket.request("login", { username: `ws-churn-${identity}`, password: "wrong-password", token: "" });
        }
        const wsAttemptsAfterChurn = await Promise.all(
            Array.from({ length: 20 }, () =>
                socket.request("login", { username: "admin", password: "wrong-password", token: "" })
            )
        );
        expect(wsAttemptsAfterChurn.filter((result) => result.msg === "Too frequently, try again later.")).toHaveLength(
            19
        );
        expect(
            await socket.request("login", { username: "admin", password: "admin-password", token: "" })
        ).toMatchObject({
            msg: "Too frequently, try again later.",
        });

        for (let attempt = 0; attempt < 19; attempt++) {
            expect((await metrics(port, basic("admin", "wrong-password"))).status).toBe(401);
        }
        for (let identity = 0; identity < 100; identity++) {
            expect((await metrics(port, basic(`basic-churn-${identity}`, "wrong-password"))).status).toBe(401);
        }
        const basicAttemptsAfterChurn = await Promise.all(
            Array.from({ length: 10 }, () => metrics(port, basic("admin", "wrong-password")))
        );
        expect(basicAttemptsAfterChurn.every((response) => response.status === 401)).toBe(true);
        expect((await metrics(port, basic("admin", "admin-password"))).status).toBe(401);
        expect((await metrics(port, basic("other", "other-password"))).status).toBe(200);

        const ownerKey = await socket.request("addAPIKey", { name: "churn owner", active: 1, expires: null });
        const otherKey = await socket.request("addAPIKey", { name: "churn other", active: 1, expires: null });
        const wrongOwnerKey = `${ownerKey.key.slice(0, -1)}${ownerKey.key.endsWith("a") ? "b" : "a"}`;
        for (let attempt = 0; attempt < 59; attempt++) {
            expect((await metrics(port, basic("", wrongOwnerKey))).status).toBe(401);
        }
        for (let identity = 0; identity < 100; identity++) {
            const secret = "a".repeat(40);
            expect((await metrics(port, basic("", `uk${100_000 + identity}_${secret}`))).status).toBe(401);
        }
        const apiAttemptsAfterChurn = await Promise.all(
            Array.from({ length: 40 }, () => metrics(port, basic("", wrongOwnerKey)))
        );
        expect(apiAttemptsAfterChurn.every((response) => response.status === 401)).toBe(true);
        expect((await metrics(port, basic("", ownerKey.key))).status).toBe(401);
        expect((await metrics(port, basic("", otherKey.key))).status).toBe(200);
    }, 120_000);

    test("disabled authentication requires a password to enter and restores the boundary when re-enabled", async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-disabled-auth-"));
        const port = await startApp();
        const socket = await connectRealtime(port);
        expect((await socket.request("setup", "admin", "admin-password")).ok).toBe(true);
        expect(
            (
                await socket.request("login", {
                    username: "admin",
                    password: "admin-password",
                    token: "",
                })
            ).ok
        ).toBe(true);

        expect((await socket.request("setSettings", { disableAuth: true }, "wrong-password")).ok).toBe(false);
        expect((await socket.request("setSettings", { disableAuth: true }, "admin-password")).ok).toBe(true);
        expect((await metrics(port, null)).status).toBe(200);

        const autoLogin = await connectRealtime(port);
        expect((await autoLogin.request("getSettings")).ok).toBe(true);
        expect((await autoLogin.request("setSettings", { disableAuth: false }, "")).ok).toBe(true);

        const protectedAgain = await connectRealtime(port);
        expect(await protectedAgain.request("getSettings")).toEqual({
            ok: false,
            msg: "You are not logged in.",
        });
        expect((await metrics(port, null)).status).toBe(401);
    }, 120_000);

    test("a successful legacy SHA-1 login migrates the stored password to Argon2id", async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-legacy-password-"));
        let port = await startApp();
        const setupSocket = await connectRealtime(port);
        expect((await setupSocket.request("setup", "admin", "initial-password")).ok).toBe(true);
        await stopApp();

        const password = "legacy-password";
        const salt = "legacy-salt";
        const digest = createHmac("sha1", salt).update(password).digest("hex");
        const legacyHash = `sha1$${salt}$1$${digest}`;
        const db = new Database(path.join(dataDir, "kuma.db"));
        db.query("UPDATE user SET password = ? WHERE username = 'admin'").run(legacyHash);
        db.close();

        port = await startApp();
        const loginSocket = await connectRealtime(port);
        expect(
            (
                await loginSocket.request("login", {
                    username: "admin",
                    password,
                    token: "",
                })
            ).ok
        ).toBe(true);
        await stopApp();

        const migratedDatabase = new Database(path.join(dataDir, "kuma.db"), { readonly: true });
        const migratedHash = migratedDatabase
            .query("SELECT password FROM user WHERE username = 'admin'")
            .get().password;
        migratedDatabase.close();
        expect(migratedHash).toStartWith("$argon2id$");
        expect(migratedHash).not.toBe(legacyHash);
    }, 120_000);

    test("admin CLIs remove 2FA and reset the password in the production database", async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-admin-cli-"));
        let port = await startApp();
        const socket = await connectRealtime(port);
        expect((await socket.request("setup", "admin", "admin-password")).ok).toBe(true);
        expect(
            (
                await socket.request("login", {
                    username: "admin",
                    password: "admin-password",
                    token: "",
                })
            ).ok
        ).toBe(true);
        const prepared = await socket.request("prepare2FA", "admin-password");
        const token = totp(prepared.uri);
        expect((await socket.request("verifyToken", token, "admin-password")).valid).toBe(true);
        expect((await socket.request("save2FA", "admin-password")).ok).toBe(true);
        await stopApp();

        await runAdminScript("scripts/admin/remove-2fa.ts", [`--data-dir=${dataDir}`], "y\n");
        port = await startApp();
        const noTwoFactor = await connectRealtime(port);
        expect(
            await noTwoFactor.request("login", {
                username: "admin",
                password: "admin-password",
                token: "",
            })
        ).toMatchObject({ ok: true });
        await stopApp();

        await runAdminScript("scripts/admin/reset-password.ts", [
            `--data-dir=${dataDir}`,
            "--new-password=reset-password",
        ]);
        port = await startApp();
        const resetPassword = await connectRealtime(port);
        expect(
            (
                await resetPassword.request("login", {
                    username: "admin",
                    password: "admin-password",
                    token: "",
                })
            ).ok
        ).toBe(false);
        expect(
            (
                await resetPassword.request("login", {
                    username: "admin",
                    password: "reset-password",
                    token: "",
                })
            ).ok
        ).toBe(true);
    }, 120_000);
});
