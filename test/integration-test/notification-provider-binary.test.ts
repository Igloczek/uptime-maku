// @ts-nocheck

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

const projectRoot = path.join(import.meta.dirname, "../..");
const binaryPath = process.env.UPTIME_MAKU_BINARY ? path.resolve(projectRoot, process.env.UPTIME_MAKU_BINARY) : null;

let appProcess;
let dataDir;
let realtimeSocket;
let smtpServer;
let standaloneDir;

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
        socket: {
            data() {},
        },
    });
    const port = listener.port;
    listener.stop(true);
    return port;
}

function startSMTPServer() {
    let receivedMessage = false;
    const state = new WeakMap();

    const server = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
            open(socket) {
                state.set(socket, { buffer: "", receivingData: false });
                socket.write("220 uptime-maku-test ESMTP\r\n");
            },
            data(socket, chunk) {
                const connection = state.get(socket);
                connection.buffer += chunk.toString();

                if (connection.receivingData) {
                    if (connection.buffer.includes("\r\n.\r\n")) {
                        receivedMessage = true;
                        connection.buffer = "";
                        connection.receivingData = false;
                        socket.write("250 Message accepted\r\n");
                    }
                    return;
                }

                let lineEnd;
                while ((lineEnd = connection.buffer.indexOf("\r\n")) !== -1) {
                    const command = connection.buffer.slice(0, lineEnd);
                    connection.buffer = connection.buffer.slice(lineEnd + 2);

                    if (/^EHLO\b/i.test(command)) {
                        socket.write("250-uptime-maku-test\r\n250 PIPELINING\r\n");
                    } else if (/^DATA$/i.test(command)) {
                        connection.receivingData = true;
                        socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
                        break;
                    } else if (/^QUIT$/i.test(command)) {
                        socket.end("221 Bye\r\n");
                    } else {
                        socket.write("250 OK\r\n");
                    }
                }
            },
            error() {},
        },
    });

    return {
        server,
        receivedMessage: () => receivedMessage,
    };
}

async function waitForApp(url) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (appProcess.exitCode !== null) {
            const stderr = appProcess.stderr ? await new Response(appProcess.stderr).text() : "";
            throw new Error(
                `Uptime Maku exited before becoming ready (exit ${appProcess.exitCode})${stderr ? `: ${stderr.trim()}` : ""}`
            );
        }
        try {
            const response = await fetch(url);
            if (response.ok) {
                return;
            }
        } catch {}
        await Bun.sleep(100);
    }
    throw new Error("Uptime Maku did not become ready within 30 seconds");
}

async function startApp({ executable = binaryPath, cwd = projectRoot } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const appPort = reservePort();
        appProcess = Bun.spawn([executable, `--port=${appPort}`, "--host=127.0.0.1", `--data-dir=${dataDir}`], {
            cwd,
            env: {
                ...process.env,
                NODE_ENV: "production",
                UPTIME_MAKU_WS_ORIGIN_CHECK: "bypass",
            },
            stdout: "ignore",
            stderr: "pipe",
        });

        try {
            await waitForApp(`http://127.0.0.1:${appPort}`);
            return appPort;
        } catch (error) {
            const retry = appProcess.exitCode !== null && /EADDRINUSE/.test(error.message) && attempt < 2;
            if (!retry) {
                throw error;
            }
            await appProcess.exited;
            appProcess = undefined;
        }
    }
}

async function connectRealtime(url) {
    const socket = new WebSocket(url);
    const callbacks = new Map();
    let nextID = 1;
    let handlersReady;

    const ready = new Promise((resolve, reject) => {
        socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
        socket.addEventListener("close", () => reject(new Error("WebSocket closed before login handlers were ready")), {
            once: true,
        });
        socket.addEventListener("message", (event) => {
            const message = JSON.parse(String(event.data));
            if (message.type === "event" && message.event === "loginRequired") {
                handlersReady = true;
                resolve();
            } else if ((message.type === "reply" || message.type === "error") && message.id) {
                const callback = callbacks.get(message.id);
                if (callback) {
                    callbacks.delete(message.id);
                    if (message.type === "error") {
                        callback.reject(new Error(message.message));
                    } else {
                        callback.resolve(message.args?.[0]);
                    }
                }
            }
        });
    });

    await withTimeout(ready, 10_000, "WebSocket login handlers were not ready");

    return {
        socket,
        request(event, ...args) {
            if (!handlersReady) {
                throw new Error("WebSocket handlers are not ready");
            }
            const id = String(nextID++);
            const reply = new Promise((resolve, reject) => callbacks.set(id, { resolve, reject }));
            socket.send(JSON.stringify({ type: "event", event, args, id }));
            return withTimeout(reply, 10_000, `No reply for WebSocket event ${event}`);
        },
    };
}

async function stopApp() {
    if (!appProcess || appProcess.exitCode !== null) {
        return;
    }
    appProcess.kill("SIGTERM");
    try {
        await withTimeout(appProcess.exited, 5_000, "Uptime Maku did not stop after SIGTERM");
    } catch {
        appProcess.kill("SIGKILL");
        await appProcess.exited;
    }
}

async function waitForHeartbeat(monitorID) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        const database = new Database(path.join(dataDir, "kuma.db"), { readonly: true });
        const heartbeat = database
            .query("SELECT status, msg FROM heartbeat WHERE monitor_id = ? ORDER BY id DESC LIMIT 1")
            .get(monitorID);
        database.close();
        if (heartbeat) {
            return heartbeat;
        }
        await Bun.sleep(100);
    }
    throw new Error("Monitor did not write a heartbeat");
}

afterEach(async () => {
    realtimeSocket?.close();
    smtpServer?.stop(true);
    await stopApp();
    if (dataDir) {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
    if (standaloneDir) {
        fs.rmSync(standaloneDir, { recursive: true, force: true });
    }
});

describe("compiled runtime loading", () => {
    test("compiled executable runs SMTP provider and monitor factories through production flows", async () => {
        expect(binaryPath, "UPTIME_MAKU_BINARY must point to a compiled Uptime Maku executable").toBeTruthy();
        expect(fs.existsSync(binaryPath)).toBe(true);

        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uptime-maku-compiled-smtp-"));
        const smtp = startSMTPServer();
        smtpServer = smtp.server;

        const appPort = await startApp();

        const realtime = await connectRealtime(`ws://127.0.0.1:${appPort}/ws`);
        realtimeSocket = realtime.socket;

        const setup = await realtime.request("setup", "compiled-test", "compiled-test-password");
        expect(setup.ok).toBe(true);

        const login = await realtime.request("login", {
            username: "compiled-test",
            password: "compiled-test-password",
            token: "",
        });
        expect(login.ok).toBe(true);

        const result = await realtime.request("testNotification", {
            type: "smtp",
            name: "Compiled SMTP",
            smtpHost: "127.0.0.1",
            smtpPort: smtpServer.port,
            smtpSecure: false,
            smtpIgnoreSTARTTLS: true,
            smtpFrom: "sender@example.invalid",
            smtpTo: "recipient@example.invalid",
        });

        expect(result).toEqual({ ok: true, msg: "Sent Successfully." });
        expect(smtp.receivedMessage()).toBe(true);

        const monitor = await realtime.request("add", {
            type: "smtp",
            name: "Compiled SMTP monitor",
            active: true,
            parent: null,
            hostname: "127.0.0.1",
            port: smtpServer.port,
            smtpSecurity: "nostarttls",
            interval: 60,
            retryInterval: 60,
            maxretries: 0,
            retryOnlyOnStatusCodeFailure: false,
            notificationIDList: {},
            ignoreTls: false,
            upsideDown: false,
            expiryNotification: false,
            domainExpiryNotification: false,
            maxredirects: 0,
            accepted_statuscodes: ["200-299"],
            saveResponse: false,
            saveErrorResponse: true,
            responseMaxLength: 1024,
            proxyId: null,
            kafkaProducerBrokers: [],
            kafkaProducerSaslOptions: { mechanism: "None" },
            rabbitmqNodes: [],
            conditions: [],
            timeout: 1,
        });
        expect(monitor.ok).toBe(true);
        expect(await waitForHeartbeat(monitor.monitorID)).toEqual({
            status: 1,
            msg: "SMTP connection verifies successfully",
        });
    }, 60_000);

    test("standalone executable serves embedded assets and records a ping heartbeat", async () => {
        expect(binaryPath, "UPTIME_MAKU_BINARY must point to a compiled Uptime Maku executable").toBeTruthy();
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uptime-maku-compiled-ping-"));
        standaloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "uptime-maku-compiled-standalone-"));
        const standaloneBinary = path.join(standaloneDir, path.basename(binaryPath));
        fs.copyFileSync(binaryPath, standaloneBinary);
        if (process.platform !== "win32") {
            fs.chmodSync(standaloneBinary, 0o755);
        }
        expect(fs.readdirSync(standaloneDir)).toEqual([path.basename(binaryPath)]);

        const appPort = await startApp({ executable: standaloneBinary, cwd: standaloneDir });
        const entryPage = await fetch(`http://127.0.0.1:${appPort}/api/entry-page`);
        expect(entryPage.status).toBe(200);
        expect((await entryPage.json()).type).toBe("entryPage");

        const dashboard = await fetch(`http://127.0.0.1:${appPort}/dashboard`);
        expect(dashboard.status).toBe(200);
        const frontendAsset = (await dashboard.text()).match(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/)?.[1];
        expect(frontendAsset).toBeTruthy();
        expect((await fetch(`http://127.0.0.1:${appPort}${frontendAsset}`)).status).toBe(200);

        const realtime = await connectRealtime(`ws://127.0.0.1:${appPort}/ws`);
        realtimeSocket = realtime.socket;
        expect((await realtime.request("setup", "compiled-ping", "compiled-ping-password")).ok).toBe(true);
        expect(
            (
                await realtime.request("login", {
                    username: "compiled-ping",
                    password: "compiled-ping-password",
                    token: "",
                })
            ).ok
        ).toBe(true);

        const monitor = await realtime.request("add", {
            type: "ping",
            name: "Compiled ping monitor",
            active: true,
            parent: null,
            hostname: "127.0.0.1",
            interval: 60,
            retryInterval: 60,
            maxretries: 0,
            retryOnlyOnStatusCodeFailure: false,
            notificationIDList: {},
            ignoreTls: false,
            upsideDown: false,
            expiryNotification: false,
            domainExpiryNotification: false,
            maxredirects: 0,
            accepted_statuscodes: ["200-299"],
            saveResponse: false,
            saveErrorResponse: true,
            responseMaxLength: 1024,
            proxyId: null,
            kafkaProducerBrokers: [],
            kafkaProducerSaslOptions: { mechanism: "None" },
            rabbitmqNodes: [],
            conditions: [],
            timeout: 1,
            ping_count: 1,
            ping_numeric: false,
            packetSize: 56,
            ping_per_request_timeout: 1,
        });
        expect(monitor.ok).toBe(true);
        expect((await waitForHeartbeat(monitor.monitorID)).status).toBe(1);

        const database = new Database(path.join(dataDir, "kuma.db"));
        const groupID = Number(
            database.query('INSERT INTO "group" (name, public) VALUES (?, 1)').run("Public").lastInsertRowid
        );
        database
            .query("INSERT INTO monitor_group (monitor_id, group_id) VALUES (?, ?)")
            .run(monitor.monitorID, groupID);
        database.close();

        const badge = await fetch(
            `http://127.0.0.1:${appPort}/api/badge/${monitor.monitorID}/status?style=for-the-badge&label=Compiled`
        );
        expect(badge.status).toBe(200);
        expect(badge.headers.get("content-type")).toBe("image/svg+xml");
        expect(badge.headers.get("access-control-allow-origin")).toBe("*");
        expect(await badge.text()).toContain("COMPILED");
    }, 60_000);
});
