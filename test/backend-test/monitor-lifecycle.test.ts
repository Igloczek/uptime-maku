// @ts-nocheck

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { MAX_INTERVAL_SECOND } from "@/constants";

const projectRoot = path.join(import.meta.dirname, "../..");
const binaryPath = process.env.IGLO_MONITOR_BINARY ? path.resolve(projectRoot, process.env.IGLO_MONITOR_BINARY) : null;
const standaloneBinary = process.env.IGLO_MONITOR_STANDALONE_BINARY === "1";
const realBrowserExecutable = process.env.IGLO_MONITOR_REAL_BROWSER_CHROME || null;
const pendingBrowserAcquisition = process.env.IGLO_MONITOR_PENDING_BROWSER_ACQUISITION === "1";
const credentials = { username: "monitor-test", password: "monitor-test-password" };

let appProcess;
let appPort;
let dataDir;
let proxyServer;
let envProxyServer;
let envProxyUrl;
let targetServer;
let targetUrl;
let realtime;
let targetBarrier;
let appNoProxy = "";
const proxyRequests = [];
const envProxyRequests = [];
const targetRequests = [];
const appLogs = [];
let appLogReaders = [];
let standaloneDir;
let standaloneBinaryPath;
const parentProxyEnv = Object.fromEntries(
    ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"].map((name) => [name, process.env[name]])
);

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

function listen(server) {
    return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function closeServer(server) {
    if (!server?.listening) {
        return Promise.resolve();
    }
    return new Promise((resolve) => server.close(resolve));
}

async function createHangingTcpServer() {
    let requestArrived;
    let socketClosed;
    const arrived = new Promise((resolve) => {
        requestArrived = resolve;
    });
    const closed = new Promise((resolve) => {
        socketClosed = resolve;
    });
    const sockets = new Set();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        requestArrived();
        socket.on("close", () => {
            sockets.delete(socket);
            socketClosed();
        });
    });
    await listen(server);
    return {
        port: server.address().port,
        requestArrived: arrived,
        socketClosed: closed,
        destroySockets() {
            for (const socket of sockets) {
                socket.destroy();
            }
        },
        async close() {
            this.destroySockets();
            await closeServer(server);
        },
    };
}

async function createHangingUdpServer() {
    let requestArrived;
    const arrived = new Promise((resolve) => {
        requestArrived = resolve;
    });
    const server = dgram.createSocket("udp4");
    let requests = 0;
    server.on("message", () => {
        requests++;
        requestArrived();
    });
    await new Promise((resolve) => server.bind(0, "127.0.0.1", resolve));
    return {
        port: server.address().port,
        requestArrived: arrived,
        get requests() {
            return requests;
        },
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

async function collectProcessOutput(stream) {
    if (!stream) {
        return;
    }
    for await (const chunk of stream) {
        appLogs.push(Buffer.from(chunk).toString());
    }
}

function processTable() {
    const result = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,pgid=,command="], {
        stdout: "pipe",
        stderr: "pipe",
    });
    if (result.exitCode !== 0) {
        throw new Error(`ps failed: ${Buffer.from(result.stderr).toString()}`);
    }
    return Buffer.from(result.stdout)
        .toString()
        .split("\n")
        .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
        .filter(Boolean)
        .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] }));
}

function descendantProcesses(parentPID) {
    const rows = processTable();
    const descendants = new Set([parentPID]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const row of rows) {
            if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
                descendants.add(row.pid);
                changed = true;
            }
        }
    }
    return rows.filter((row) => row.pid !== parentPID && descendants.has(row.pid));
}

function preparePendingBrowserWrapper() {
    const executable = path.join(dataDir, "pending-chromium");
    const pidFile = path.join(dataDir, "pending-browser-pids");
    fs.rmSync(pidFile, { force: true });
    fs.writeFileSync(
        executable,
        '#!/bin/sh\ntrap \'\' TERM\nprintf \'%s\\n\' "$$" > "$IGLO_MONITOR_PENDING_BROWSER_PID_FILE"\nsh -c \'sleep 300 & printf "%s\\n" "$!" >> "$IGLO_MONITOR_PENDING_BROWSER_PID_FILE"; wait\' &\nprintf \'%s\\n\' "$!" >> "$IGLO_MONITOR_PENDING_BROWSER_PID_FILE"\nwait\n'
    );
    fs.chmodSync(executable, 0o755);
    return { executable, pidFile };
}

async function pendingBrowserProcesses(pidFile) {
    await withTimeout(
        (async () => {
            while (!fs.existsSync(pidFile) || fs.readFileSync(pidFile, "utf8").trim().split("\n").length < 3) {
                await Bun.sleep(10);
            }
        })(),
        10_000,
        "pending Chromium wrapper did not spawn its process tree"
    );
    const pids = fs.readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
    const processGroup = processTable().find((process) => process.pid === pids[0])?.pgid;
    if (!processGroup) {
        throw new Error("pending Chromium wrapper exited before its process group was observed");
    }
    return { processGroup, pids };
}

function processGroupSurvives(processGroup) {
    return processTable().some((process) => process.pgid === processGroup);
}

function startTargetServer() {
    return http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", async () => {
            const body = Buffer.concat(chunks).toString();
            targetRequests.push({
                url: req.url,
                method: req.method,
                body,
                authorization: req.headers.authorization,
                proxyAuthorization: req.headers["proxy-authorization"],
                contentType: req.headers["content-type"],
                lifecycleHeader: req.headers["x-lifecycle"],
            });

            if (req.url === "/first") {
                res.writeHead(200, { "Content-Type": "text/plain" });
                res.end("first target");
                return;
            }
            if (req.url === "/barrier") {
                targetBarrier?.arrive();
                await targetBarrier?.wait;
                res.writeHead(200, { "Content-Type": "text/plain" });
                res.end("released target");
                return;
            }
            if (req.url === "/edited") {
                const valid =
                    req.method === "POST" &&
                    req.headers.authorization === "Basic dXNlcjpwYXNz" &&
                    req.headers["x-lifecycle"] === "edited" &&
                    req.headers["content-type"] === "application/json" &&
                    body === '{"version":"edited"}';
                res.writeHead(valid ? 200 : 401, { "Content-Type": "application/json" });
                res.end(JSON.stringify(valid ? { version: "edited" } : { error: "invalid request" }));
                return;
            }
            if (req.url === "/keyword") {
                res.writeHead(200, { "Content-Type": "text/plain" });
                res.end("response contains lifecycle-keyword");
                return;
            }
            if (req.url === "/json") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ service: { status: "green" } }));
                return;
            }
            if (req.url === "/status") {
                res.writeHead(418, { "Content-Type": "text/plain" });
                res.end("teapot");
                return;
            }

            res.writeHead(404);
            res.end("not found");
        });
    });
}

function armTargetBarrier() {
    let arrive;
    let release;
    const arrived = new Promise((resolve) => {
        arrive = resolve;
    });
    const wait = new Promise((resolve) => {
        release = resolve;
    });
    targetBarrier = { arrive, arrived, release, wait };
    return targetBarrier;
}

function startProxyServer() {
    return http.createServer((req, res) => {
        let target;
        try {
            target = new URL(req.url);
        } catch {
            res.writeHead(400);
            res.end("absolute proxy URL required");
            return;
        }

        proxyRequests.push({
            url: target.toString(),
            proxyAuthorization: req.headers["proxy-authorization"] ?? null,
        });
        if (target.hostname !== "127.0.0.1") {
            res.writeHead(502);
            res.end("public network disabled by fixture");
            return;
        }

        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", async () => {
            const headers = new Headers(req.headers);
            headers.delete("host");
            headers.delete("proxy-connection");
            headers.delete("proxy-authorization");
            headers.delete("content-length");
            const body = Buffer.concat(chunks);
            const response = await fetch(target, {
                method: req.method,
                headers,
                body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
            });
            res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
            res.end(await response.arrayBuffer());
        });
    });
}

function startRejectingEnvProxyServer() {
    return http.createServer((req, res) => {
        envProxyRequests.push(req.url);
        res.writeHead(502);
        res.end("environment proxy must not receive assigned monitor traffic");
    });
}

async function waitForApp() {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (appProcess.exitCode !== null) {
            throw new Error(`iglo.monitor exited before readiness with code ${appProcess.exitCode}`);
        }
        try {
            if ((await fetch(`http://127.0.0.1:${appPort}/api/entry-page`)).ok) {
                return;
            }
        } catch {}
        await Bun.sleep(50);
    }
    throw new Error("iglo.monitor did not become ready within 30 seconds");
}

async function startApp() {
    appPort = reservePort();
    const executable = standaloneBinaryPath ?? binaryPath;
    const command = binaryPath
        ? [executable, `--port=${appPort}`, "--host=127.0.0.1", `--data-dir=${dataDir}`, "--test"]
        : ["bun", "src/server/server.ts", `--port=${appPort}`, "--host=127.0.0.1", `--data-dir=${dataDir}`, "--test"];
    const { BUN_INSTALL: _bunInstall, NODE_PATH: _nodePath, ...env } = process.env;
    appProcess = Bun.spawn(command, {
        cwd: standaloneDir ?? projectRoot,
        env: {
            ...env,
            NODE_ENV: binaryPath ? "production" : "development",
            HTTP_PROXY: envProxyUrl,
            HTTPS_PROXY: envProxyUrl,
            NO_PROXY: appNoProxy,
            IGLO_MONITOR_WS_ORIGIN_CHECK: "bypass",
            IGLO_MONITOR_LOG_FORMAT: "json",
            IGLO_MONITOR_ALLOW_ALL_CHROME_EXEC: pendingBrowserAcquisition
                ? "1"
                : process.env.IGLO_MONITOR_ALLOW_ALL_CHROME_EXEC,
            IGLO_MONITOR_PENDING_BROWSER_PID_FILE: pendingBrowserAcquisition
                ? path.join(dataDir, "pending-browser-pids")
                : undefined,
        },
        stdout: "pipe",
        stderr: "pipe",
    });
    appLogReaders = [collectProcessOutput(appProcess.stdout), collectProcessOutput(appProcess.stderr)];
    await waitForApp();
}

async function stopApp() {
    realtime?.close();
    realtime = null;
    if (!appProcess || appProcess.exitCode !== null) {
        return;
    }
    appProcess.kill("SIGTERM");
    try {
        await withTimeout(appProcess.exited, 6_000, "iglo.monitor did not stop after SIGTERM");
    } catch {
        appProcess.kill("SIGKILL");
        await appProcess.exited;
    }
    await Promise.allSettled(appLogReaders);
    appLogReaders = [];
}

async function connectRealtime() {
    const socket = new WebSocket(`ws://127.0.0.1:${appPort}/ws`);
    const callbacks = new Map();
    const events = [];
    const waiters = new Set();
    let nextID = 1;

    const ready = new Promise((resolve, reject) => {
        socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
        socket.addEventListener("message", (event) => {
            const message = JSON.parse(String(event.data));
            if (message.type === "event") {
                const item = { event: message.event, args: message.args || [] };
                events.push(item);
                for (const waiter of waiters) {
                    if (waiter.event === item.event && waiter.predicate(item.args)) {
                        waiters.delete(waiter);
                        waiter.resolve(item.args);
                    }
                }
                if (message.event === "loginRequired") {
                    resolve();
                }
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
        events,
        close: () => socket.close(),
        mark: () => events.length,
        request(event, ...args) {
            const id = String(nextID++);
            const reply = new Promise((resolve, reject) => callbacks.set(id, { resolve, reject }));
            socket.send(JSON.stringify({ type: "event", event, args, id }));
            return withTimeout(reply, 10_000, `No reply for WebSocket event ${event}`);
        },
        waitFor(event, predicate, after = 0, timeout = 10_000) {
            const found = events.slice(after).find((item) => item.event === event && predicate(item.args));
            if (found) {
                return Promise.resolve(found.args);
            }
            const pending = new Promise((resolve) => waiters.add({ event, predicate, resolve }));
            return withTimeout(pending, timeout, `No matching WebSocket event ${event}`);
        },
    };
}

async function login({ setup = false } = {}) {
    realtime = await connectRealtime();
    if (setup) {
        expect((await realtime.request("setup", credentials.username, credentials.password)).ok).toBe(true);
    }
    expect(
        (
            await realtime.request("login", {
                username: credentials.username,
                password: credentials.password,
                token: "",
            })
        ).ok
    ).toBe(true);
}

async function reconnectAndGetProxyList() {
    realtime?.close();
    realtime = null;
    await login();
    return realtime.events.filter((item) => item.event === "proxyList").at(-1)?.args?.[0] ?? [];
}

function updateMonitorAssignment(monitorID, proxyID, { ignoreTls = false } = {}) {
    const db = new BunDatabase(path.join(dataDir, "kuma.db"), { strict: true });
    try {
        db.exec("PRAGMA foreign_keys = OFF");
        db.run("UPDATE monitor SET proxy_id = ?, ignore_tls = ? WHERE id = ?", [proxyID, ignoreTls ? 1 : 0, monitorID]);
    } finally {
        db.close();
    }
}

function queryMonitorStorage(monitorID) {
    const db = new BunDatabase(path.join(dataDir, "kuma.db"), { readonly: true, strict: true });
    try {
        return db
            .query(
                `SELECT timeout, typeof(timeout) AS timeout_type,
                        interval, typeof(interval) AS interval_type,
                        retry_interval, typeof(retry_interval) AS retry_interval_type,
                        resend_interval, typeof(resend_interval) AS resend_interval_type,
                        maxretries, typeof(maxretries) AS maxretries_type,
                        maxredirects, typeof(maxredirects) AS maxredirects_type,
                        port, typeof(port) AS port_type
                 FROM monitor WHERE id = ?`
            )
            .get(monitorID);
    } finally {
        db.close();
    }
}

function countMonitors() {
    const db = new BunDatabase(path.join(dataDir, "kuma.db"), { readonly: true, strict: true });
    try {
        return db.query("SELECT COUNT(*) AS count FROM monitor").get().count;
    } finally {
        db.close();
    }
}

function queryScreenshotDelay(monitorID) {
    const db = new BunDatabase(path.join(dataDir, "kuma.db"), { readonly: true, strict: true });
    try {
        return db.query("SELECT screenshot_delay FROM monitor WHERE id = ?").get(monitorID)?.screenshot_delay;
    } finally {
        db.close();
    }
}

function updateMonitorStorage(monitorID, values) {
    const db = new BunDatabase(path.join(dataDir, "kuma.db"), { strict: true });
    try {
        const assignments = Object.keys(values)
            .map((column) => `"${column}" = ?`)
            .join(", ");
        db.run(`UPDATE monitor SET ${assignments} WHERE id = ?`, [...Object.values(values), monitorID]);
    } finally {
        db.close();
    }
}

function insertForeignProxy(port) {
    const db = new BunDatabase(path.join(dataDir, "kuma.db"), { strict: true });
    try {
        db.run("INSERT OR IGNORE INTO user (username, password, active) VALUES (?, ?, 1)", [
            "foreign-proxy-owner",
            "not-used",
        ]);
        const userID = db.query("SELECT id FROM user WHERE username = ?").get("foreign-proxy-owner").id;
        const proxy = db.run(
            "INSERT INTO proxy (user_id, protocol, host, port, auth, username, password, active, `default`) VALUES (?, 'http', '127.0.0.1', ?, 1, ?, ?, 1, 0)",
            [userID, port, "foreign-user%@:/żółw", "foreign-password%@:/密碼"]
        );
        return Number(proxy.lastInsertRowid);
    } finally {
        db.close();
    }
}

function monitorPayload(overrides = {}) {
    return {
        type: "http",
        name: "Lifecycle monitor",
        parent: null,
        url: `${targetUrl}/first`,
        method: "GET",
        interval: 1,
        retryInterval: 1,
        resendInterval: 0,
        maxretries: 0,
        retryOnlyOnStatusCodeFailure: false,
        notificationIDList: {},
        ignoreTls: false,
        upsideDown: false,
        expiryNotification: false,
        domainExpiryNotification: false,
        maxredirects: 2,
        accepted_statuscodes: ["200-299"],
        saveResponse: false,
        saveErrorResponse: true,
        responseMaxLength: 1024,
        proxyId: null,
        authMethod: null,
        httpBodyEncoding: "json",
        kafkaProducerBrokers: [],
        kafkaProducerSaslOptions: { mechanism: "None" },
        rabbitmqNodes: [],
        conditions: [],
        cacheBust: false,
        timeout: 1,
        ...overrides,
    };
}

function heartbeatFor(monitorID, status) {
    return ([heartbeat]) => heartbeat.monitorID === monitorID && heartbeat.status === status;
}

beforeAll(async () => {
    if (standaloneBinary) {
        if (!binaryPath) {
            throw new Error("IGLO_MONITOR_STANDALONE_BINARY requires IGLO_MONITOR_BINARY");
        }
        standaloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-standalone-"));
        standaloneBinaryPath = path.join(standaloneDir, "iglo.monitor");
        fs.copyFileSync(binaryPath, standaloneBinaryPath);
        fs.chmodSync(standaloneBinaryPath, 0o755);
        expect(fs.readdirSync(standaloneDir)).toEqual(["iglo.monitor"]);
    }
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-monitor-lifecycle-"));
    targetServer = startTargetServer();
    await listen(targetServer);
    targetUrl = `http://127.0.0.1:${targetServer.address().port}`;
    proxyServer = startProxyServer();
    await listen(proxyServer);
    envProxyServer = startRejectingEnvProxyServer();
    await listen(envProxyServer);
    envProxyUrl = `http://127.0.0.1:${envProxyServer.address().port}`;
    await startApp();
    await login({ setup: true });
});

afterAll(async () => {
    await stopApp();
    await Promise.all([closeServer(targetServer), closeServer(proxyServer), closeServer(envProxyServer)]);
    if (dataDir) {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
    if (standaloneDir) {
        fs.rmSync(standaloneDir, { recursive: true, force: true });
    }
    expect(
        Object.fromEntries(["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"].map((name) => [name, process.env[name]]))
    ).toEqual(parentProxyEnv);
});

describe("monitor lifecycle over the production WebSocket transport", () => {
    test("real-browser monitor responses preserve the configured screenshot delay", async () => {
        const created = await realtime.request(
            "add",
            monitorPayload({
                type: "real-browser",
                active: false,
                interval: 2,
                screenshot_delay: 250,
            })
        );
        expect(created.ok).toBe(true);
        try {
            const response = await realtime.request("getMonitor", created.monitorID);
            expect(response.ok).toBe(true);
            expect(response.monitor.screenshot_delay).toBe(250);
        } finally {
            await realtime.request("deleteMonitor", created.monitorID, false);
        }
    });

    test("real-browser monitor edits persist a changed screenshot delay", async () => {
        const created = await realtime.request(
            "add",
            monitorPayload({
                type: "real-browser",
                active: false,
                interval: 2,
                screenshot_delay: 250,
            })
        );
        expect(created.ok).toBe(true);
        try {
            const response = await realtime.request("getMonitor", created.monitorID);
            expect(response.ok).toBe(true);
            const edited = await realtime.request("editMonitor", {
                ...response.monitor,
                screenshot_delay: 500,
            });
            expect(edited.ok).toBe(true);
            expect(queryScreenshotDelay(created.monitorID)).toBe(500);

            const current = await realtime.request("getMonitor", created.monitorID);
            const rejected = await realtime.request("editMonitor", {
                ...current.monitor,
                screenshot_delay: 1_000,
            });
            expect(rejected.ok).toBe(false);
            expect(rejected.msg).toBe("Screenshot delay must be less than 1000ms (0.5 × interval)");
            expect(queryScreenshotDelay(created.monitorID)).toBe(500);
        } finally {
            await realtime.request("deleteMonitor", created.monitorID, false);
        }
    });

    test("add and edit normalize numeric strings and reject invalid timeouts without partial writes", async () => {
        const timeoutError = `Timeout must be 0 or a finite number between 0.1 and ${MAX_INTERVAL_SECOND} seconds`;
        const countBefore = countMonitors();
        const invalidValues = ["", "   ", "bogus", -1, 0.001, MAX_INTERVAL_SECOND + 1, null];
        const invalidAdds = [];

        for (const timeout of invalidValues) {
            invalidAdds.push(await realtime.request("add", monitorPayload({ active: false, timeout })));
        }
        const missingTimeoutPayload = monitorPayload({ active: false });
        delete missingTimeoutPayload.timeout;
        invalidAdds.push(await realtime.request("add", missingTimeoutPayload));

        for (const result of invalidAdds) {
            if (result.ok) {
                await realtime.request("deleteMonitor", result.monitorID, false);
            }
        }

        expect(invalidAdds.every((result) => !result.ok)).toBe(true);
        expect(invalidAdds.map((result) => result.msg)).toEqual(invalidAdds.map(() => timeoutError));
        expect(countMonitors()).toBe(countBefore);

        const created = await realtime.request(
            "add",
            monitorPayload({
                active: false,
                interval: "60",
                retryInterval: "20",
                resendInterval: "3",
                maxretries: "2",
                timeout: "0.25",
                port: "8080",
            })
        );
        expect(created.ok).toBe(true);
        const monitorID = created.monitorID;
        expect(queryMonitorStorage(monitorID)).toEqual({
            timeout: 0.25,
            timeout_type: "real",
            interval: 60,
            interval_type: "integer",
            retry_interval: 20,
            retry_interval_type: "integer",
            resend_interval: 3,
            resend_interval_type: "integer",
            maxretries: 2,
            maxretries_type: "integer",
            maxredirects: 2,
            maxredirects_type: "integer",
            port: 8080,
            port_type: "integer",
        });

        const before = (await realtime.request("getMonitor", monitorID)).monitor;
        const invalidEdits = [];
        for (const timeout of invalidValues) {
            const result = await realtime.request("editMonitor", { ...before, timeout });
            invalidEdits.push(result);
            if (result.ok) {
                await realtime.request("editMonitor", { ...before, timeout: "0.25" });
            }
        }
        const missingEdit = { ...before };
        delete missingEdit.timeout;
        const missingResult = await realtime.request("editMonitor", missingEdit);
        invalidEdits.push(missingResult);
        if (missingResult.ok) {
            await realtime.request("editMonitor", { ...before, timeout: "0.25" });
        }

        expect(invalidEdits.every((result) => !result.ok)).toBe(true);
        expect(invalidEdits.map((result) => result.msg)).toEqual(invalidEdits.map(() => timeoutError));
        expect((await realtime.request("getMonitor", monitorID)).monitor).toMatchObject({
            interval: 60,
            retryInterval: 20,
            resendInterval: 3,
            maxretries: 2,
            timeout: 0.25,
            port: 8080,
        });
        expect(queryMonitorStorage(monitorID)).toMatchObject({ timeout: 0.25, timeout_type: "real" });

        expect((await realtime.request("editMonitor", { ...before, timeout: "0" })).ok).toBe(true);
        expect(queryMonitorStorage(monitorID)).toMatchObject({ timeout: 0, timeout_type: "real" });
        expect((await realtime.request("deleteMonitor", monitorID, false)).ok).toBe(true);
        expect(countMonitors()).toBe(countBefore);
    }, 30_000);

    test("add and edit reject excessive retries and redirects atomically", async () => {
        const countBefore = countMonitors();
        const invalidValues = [101, 1000, Number.MAX_SAFE_INTEGER];
        const cases = [
            ["maxretries", "Retries must be an integer between 0 and 100"],
            ["maxredirects", "Max redirects must be an integer between 0 and 100"],
        ];

        for (const [field, message] of cases) {
            for (const value of invalidValues) {
                const result = await realtime.request("add", monitorPayload({ active: false, [field]: value }));
                expect(result.ok, `${field}=${value}`).toBe(false);
                expect(result.msg).toBe(message);
            }
        }
        expect(countMonitors()).toBe(countBefore);

        const created = await realtime.request(
            "add",
            monitorPayload({ active: false, maxretries: "100", maxredirects: "100" })
        );
        expect(created.ok).toBe(true);
        const monitorID = created.monitorID;
        expect(queryMonitorStorage(monitorID)).toMatchObject({
            maxretries: 100,
            maxretries_type: "integer",
            maxredirects: 100,
            maxredirects_type: "integer",
        });

        const before = (await realtime.request("getMonitor", monitorID)).monitor;
        for (const [field, message] of cases) {
            for (const value of invalidValues) {
                const result = await realtime.request("editMonitor", { ...before, [field]: value });
                expect(result.ok, `${field}=${value}`).toBe(false);
                expect(result.msg).toBe(message);
            }
        }
        expect((await realtime.request("getMonitor", monitorID)).monitor).toMatchObject({
            maxretries: 100,
            maxredirects: 100,
        });
        expect(queryMonitorStorage(monitorID)).toMatchObject({ maxretries: 100, maxredirects: 100 });
        expect((await realtime.request("deleteMonitor", monitorID, false)).ok).toBe(true);
        expect(countMonitors()).toBe(countBefore);
    }, 30_000);

    test("legacy malformed timeout still bounds a PostgreSQL check and monitor stop", async () => {
        const fixture = await createHangingTcpServer();
        let monitorID;
        let pause;
        try {
            const created = await realtime.request(
                "add",
                monitorPayload({
                    type: "postgres",
                    active: false,
                    interval: 1,
                    timeout: 1,
                    databaseConnectionString: `postgresql://user:pass@127.0.0.1:${fixture.port}/db`,
                    databaseQuery: "SELECT 1",
                })
            );
            expect(created.ok).toBe(true);
            monitorID = created.monitorID;

            await stopApp();
            updateMonitorStorage(monitorID, { timeout: "bogus", active: 1 });
            expect(queryMonitorStorage(monitorID)).toMatchObject({ timeout: "bogus", timeout_type: "text" });
            await startApp();
            await login();
            await withTimeout(fixture.requestArrived, 5_000, "legacy PostgreSQL monitor did not connect");

            const started = performance.now();
            pause = realtime.request("pauseMonitor", monitorID);
            const stoppedByDeadline = await Promise.race([pause.then(() => true), Bun.sleep(1_500).then(() => false)]);
            if (!stoppedByDeadline) {
                fixture.destroySockets();
            }
            const paused = await pause;

            expect(stoppedByDeadline).toBe(true);
            expect(performance.now() - started).toBeLessThan(1_500);
            expect(paused.ok).toBe(true);
            expect(queryMonitorStorage(monitorID)).toMatchObject({ timeout: "bogus", timeout_type: "text" });
        } finally {
            fixture.destroySockets();
            await pause?.catch(() => {});
            if (!appProcess || appProcess.exitCode !== null) {
                await startApp();
                await login();
            }
            if (monitorID) {
                await realtime.request("deleteMonitor", monitorID, false).catch(() => {});
            }
            await fixture.close();
        }
    }, 20_000);

    test("legacy excessive SNMP retries stay bounded across restart and pause", async () => {
        const fixture = await createHangingUdpServer();
        let monitorID;
        try {
            const created = await realtime.request(
                "add",
                monitorPayload({
                    type: "snmp",
                    active: false,
                    hostname: "127.0.0.1",
                    port: fixture.port,
                    timeout: 0.1,
                    maxretries: 100,
                    radiusPassword: "public",
                    snmpVersion: "2c",
                    snmpOid: "1.3.6.1.2.1.1.1.0",
                    jsonPath: "$",
                    jsonPathOperator: "!=",
                    expectedValue: "",
                })
            );
            expect(created.ok).toBe(true);
            monitorID = created.monitorID;

            await stopApp();
            updateMonitorStorage(monitorID, { maxretries: 1000, active: 1 });
            await startApp();
            await login();
            await withTimeout(fixture.requestArrived, 5_000, "legacy SNMP monitor did not send a request");

            const started = performance.now();
            expect(
                (await withTimeout(realtime.request("pauseMonitor", monitorID), 500, "SNMP pause timed out")).ok
            ).toBe(true);
            expect(performance.now() - started).toBeLessThan(500);
            expect(queryMonitorStorage(monitorID)).toMatchObject({ maxretries: 1000, maxretries_type: "integer" });
            const requestsAfterPause = fixture.requests;
            await Bun.sleep(200);
            expect(fixture.requests).toBe(requestsAfterPause);
        } finally {
            if (!appProcess || appProcess.exitCode !== null) {
                await startApp();
                await login();
            }
            if (monitorID) {
                await realtime.request("deleteMonitor", monitorID, false).catch(() => {});
            }
            await fixture.close();
        }
    }, 20_000);

    test("delete waits for an in-flight heartbeat and prevents stale writes", async () => {
        const barrier = armTargetBarrier();
        const logMark = appLogs.length;
        const eventMark = realtime.mark();
        const proxy = await realtime.request(
            "addProxy",
            { protocol: "http", host: "127.0.0.1", port: proxyServer.address().port, auth: false, active: true },
            null
        );
        const created = await realtime.request(
            "add",
            monitorPayload({ url: `${targetUrl}/barrier`, proxyId: proxy.id, timeout: 0 })
        );
        let deletion;
        let deleted;
        try {
            expect(created.ok).toBe(true);
            await withTimeout(barrier.arrived, 5_000, "barrier heartbeat did not start");

            deletion = realtime.request("deleteMonitor", created.monitorID, false);
            expect((await realtime.request("getMonitor", created.monitorID)).ok).toBe(true);
            deleted = await withTimeout(deletion, 2_500, "delete did not enforce the active heartbeat timeout");
        } finally {
            barrier.release();
        }

        expect(deleted.ok).toBe(true);
        expect((await realtime.request("getMonitor", created.monitorID)).ok).toBe(false);
        expect(
            realtime.events
                .slice(eventMark)
                .some((item) => item.event === "heartbeat" && item.args[0].monitorID === created.monitorID)
        ).toBe(false);
        expect(appLogs.slice(logMark).join("")).not.toMatch(
            /SQLITE_CONSTRAINT_FOREIGNKEY|FOREIGN KEY constraint failed/
        );
        targetBarrier = null;
    }, 15_000);

    test("create, heartbeat, edit, HTTP contracts, pause/resume, reload, and delete", async () => {
        const proxy = await realtime.request(
            "addProxy",
            { protocol: "http", host: "127.0.0.1", port: proxyServer.address().port, auth: false, active: true },
            null
        );
        expect(proxy.ok).toBe(true);

        let payload = monitorPayload({ proxyId: proxy.id });
        const created = await realtime.request("add", payload);
        expect(created.ok).toBe(true);
        const monitorID = created.monitorID;
        await realtime.waitFor("heartbeat", heartbeatFor(monitorID, 1));
        expect(proxyRequests.some(({ url }) => url.endsWith("/first"))).toBe(true);
        expect(envProxyRequests.some((url) => url?.endsWith("/first"))).toBe(false);

        const loaded = await realtime.request("getMonitor", monitorID);
        expect(loaded.ok).toBe(true);
        expect(loaded.monitor.url).toBe(`${targetUrl}/first`);

        let mark = realtime.mark();
        payload = {
            ...loaded.monitor,
            url: `${targetUrl}/edited`,
            method: "POST",
            body: '{"version":"edited"}',
            headers: '{"X-Lifecycle":"edited"}',
            authMethod: "basic",
            basic_auth_user: "user",
            basic_auth_pass: "pass",
            httpBodyEncoding: "json",
        };
        expect((await realtime.request("editMonitor", payload)).ok).toBe(true);
        await realtime.waitFor("heartbeat", heartbeatFor(monitorID, 1), mark);
        expect(targetRequests.at(-1)).toMatchObject({
            url: "/edited",
            method: "POST",
            body: '{"version":"edited"}',
            authorization: "Basic dXNlcjpwYXNz",
            contentType: "application/json",
            lifecycleHeader: "edited",
        });

        mark = realtime.mark();
        payload = {
            ...(await realtime.request("getMonitor", monitorID)).monitor,
            type: "keyword",
            url: `${targetUrl}/keyword`,
            method: "GET",
            body: null,
            headers: null,
            authMethod: null,
            keyword: "lifecycle-keyword",
        };
        expect((await realtime.request("editMonitor", payload)).ok).toBe(true);
        await realtime.waitFor("heartbeat", heartbeatFor(monitorID, 1), mark);

        mark = realtime.mark();
        payload.keyword = "missing-keyword";
        expect((await realtime.request("editMonitor", payload)).ok).toBe(true);
        await realtime.waitFor("heartbeat", heartbeatFor(monitorID, 0), mark);

        mark = realtime.mark();
        payload = {
            ...(await realtime.request("getMonitor", monitorID)).monitor,
            type: "json-query",
            url: `${targetUrl}/json`,
            jsonPath: "service.status",
            jsonPathOperator: "==",
            expectedValue: "green",
        };
        expect((await realtime.request("editMonitor", payload)).ok).toBe(true);
        await realtime.waitFor("heartbeat", heartbeatFor(monitorID, 1), mark);

        mark = realtime.mark();
        payload.expectedValue = "red";
        expect((await realtime.request("editMonitor", payload)).ok).toBe(true);
        await realtime.waitFor("heartbeat", heartbeatFor(monitorID, 0), mark);

        mark = realtime.mark();
        payload = {
            ...(await realtime.request("getMonitor", monitorID)).monitor,
            type: "http",
            url: `${targetUrl}/status`,
            accepted_statuscodes: ["418"],
        };
        expect((await realtime.request("editMonitor", payload)).ok).toBe(true);
        await realtime.waitFor("heartbeat", heartbeatFor(monitorID, 1), mark);

        mark = realtime.mark();
        payload.accepted_statuscodes = ["200-299"];
        expect((await realtime.request("editMonitor", payload)).ok).toBe(true);
        await realtime.waitFor("heartbeat", heartbeatFor(monitorID, 0), mark);

        mark = realtime.mark();
        payload = {
            ...(await realtime.request("getMonitor", monitorID)).monitor,
            type: "http",
            url: `${targetUrl}/edited`,
            method: "POST",
            body: '{"version":"edited"}',
            headers: '{"X-Lifecycle":"edited"}',
            authMethod: "basic",
            basic_auth_user: "user",
            basic_auth_pass: "pass",
            accepted_statuscodes: ["200-299"],
        };
        expect((await realtime.request("editMonitor", payload)).ok).toBe(true);
        await realtime.waitFor("heartbeat", heartbeatFor(monitorID, 1), mark);

        mark = realtime.mark();
        expect((await realtime.request("pauseMonitor", monitorID)).ok).toBe(true);
        await Bun.sleep(1_300);
        expect(
            realtime.events
                .slice(mark)
                .some((item) => item.event === "heartbeat" && item.args[0].monitorID === monitorID)
        ).toBe(false);

        mark = realtime.mark();
        expect((await realtime.request("resumeMonitor", monitorID)).ok).toBe(true);
        await realtime.waitFor("heartbeat", heartbeatFor(monitorID, 1), mark);

        for (let restart = 0; restart < 3; restart++) {
            const requestsBeforeReload = {
                assigned: proxyRequests.length,
                env: envProxyRequests.length,
                target: targetRequests.length,
            };
            await stopApp();
            await startApp();
            await login();
            await withTimeout(
                (async () => {
                    while (proxyRequests.length === requestsBeforeReload.assigned) {
                        await Bun.sleep(25);
                    }
                })(),
                5_000,
                `active monitor did not resume after reload ${restart + 1}`
            );
            expect(proxyRequests.length).toBeGreaterThan(requestsBeforeReload.assigned);
            expect(envProxyRequests.length).toBe(requestsBeforeReload.env);
            expect(targetRequests.length).toBeGreaterThan(requestsBeforeReload.target);
            expect(proxyRequests.at(-1).url.endsWith("/edited")).toBe(true);
        }
        const persisted = await realtime.request("getMonitor", monitorID);
        expect(persisted.ok).toBe(true);
        expect(persisted.monitor).toMatchObject({
            active: true,
            url: `${targetUrl}/edited`,
            method: "POST",
            proxyId: proxy.id,
        });
        const beats = await realtime.request("getMonitorBeats", monitorID, 1);
        expect(beats.ok).toBe(true);
        expect(beats.data.some((beat) => beat.status === 1)).toBe(true);

        expect((await realtime.request("deleteMonitor", monitorID, false)).ok).toBe(true);
        const requestsAfterDelete = targetRequests.length;
        await Bun.sleep(1_300);
        expect(targetRequests.length).toBe(requestsAfterDelete);
        expect((await realtime.request("getMonitor", monitorID)).ok).toBe(false);
    }, 60_000);

    test("proxy saves validate endpoints and authentication without mutating rejected updates", async () => {
        const validCases = [
            ["http", "proxy.example"],
            ["https", "127.0.0.1"],
            ["socks", "::1"],
            ["socks5", "[2001:db8::1]"],
            ["socks5h", "localhost"],
            ["socks4", "proxy.internal"],
        ];
        const validIDs = [];
        for (const [protocol, host] of validCases) {
            const response = await realtime.request(
                "addProxy",
                { protocol, host, port: 1080, auth: false, active: true, default: false },
                null
            );
            expect(response.ok).toBe(true);
            validIDs.push(response.id);
        }

        let proxyList = await reconnectAndGetProxyList();
        expect(proxyList.find((proxy) => proxy.id === validIDs[2]).host).toBe("::1");
        expect(proxyList.find((proxy) => proxy.id === validIDs[3]).host).toBe("2001:db8::1");

        for (const protocol of [null, "HTTP", "ftp"]) {
            const response = await realtime.request(
                "addProxy",
                { protocol, host: "proxy.example", port: 8080, auth: false, active: true },
                null
            );
            expect(response.ok).toBe(false);
            expect(response.msg).toMatch(/unsupported proxy protocol/i);
        }

        for (const host of [
            "",
            " proxy.example",
            "proxy.example ",
            "proxy host",
            "http://proxy.example",
            "proxy.example/path",
            "user@proxy.example",
            "proxy.example:8080",
            "bad:host",
            "bad..host",
            "[not-ipv6]",
        ]) {
            const response = await realtime.request(
                "addProxy",
                { protocol: "http", host, port: 8080, auth: false, active: true },
                null
            );
            expect(response.ok).toBe(false);
            expect(response.msg).toMatch(/proxy host/i);
        }

        for (const port of [null, "8080", 0, -1, 1.5, 65536]) {
            const response = await realtime.request(
                "addProxy",
                { protocol: "http", host: "proxy.example", port, auth: false, active: true },
                null
            );
            expect(response.ok).toBe(false);
            expect(response.msg).toMatch(/proxy port/i);
        }

        for (const [username, password] of [
            ["", "secret"],
            ["user", ""],
            [null, "secret"],
            ["user", null],
        ]) {
            const response = await realtime.request(
                "addProxy",
                { protocol: "http", host: "proxy.example", port: 8080, auth: true, username, password, active: true },
                null
            );
            expect(response.ok).toBe(false);
            expect(response.msg).toMatch(/username and password/i);
        }

        const inactive = await realtime.request(
            "addProxy",
            {
                protocol: "http",
                host: "inactive.example",
                port: 8080,
                auth: false,
                username: "stale-user",
                password: "stale-password",
                active: false,
            },
            null
        );
        expect(inactive.ok).toBe(true);
        proxyList = await reconnectAndGetProxyList();
        expect(proxyList.find((proxy) => proxy.id === inactive.id)).toMatchObject({
            active: 0,
            username: null,
            password: null,
        });

        const authenticated = await realtime.request(
            "addProxy",
            {
                protocol: "http",
                host: "auth.example",
                port: 8080,
                auth: true,
                username: "u%@:/żółw",
                password: "p%@:/密碼",
                active: true,
            },
            null
        );
        expect(authenticated.ok).toBe(true);
        proxyList = await reconnectAndGetProxyList();
        expect(proxyList.find((proxy) => proxy.id === authenticated.id)).toMatchObject({
            username: "u%@:/żółw",
            password: "p%@:/密碼",
        });

        const unchanged = await realtime.request(
            "addProxy",
            { protocol: "http", host: "unchanged.example", port: 8080, auth: false, active: true },
            null
        );
        expect(unchanged.ok).toBe(true);
        const rejectedUpdate = await realtime.request(
            "addProxy",
            { protocol: "http", host: "http://mutated.example", port: 3128, auth: false, active: false },
            unchanged.id
        );
        expect(rejectedUpdate.ok).toBe(false);
        proxyList = await reconnectAndGetProxyList();
        expect(proxyList.find((proxy) => proxy.id === unchanged.id)).toMatchObject({
            host: "unchanged.example",
            port: 8080,
            active: 1,
        });

        const deactivated = await realtime.request(
            "addProxy",
            { protocol: "http", host: "deactivated.example", port: 3128, auth: false, active: false },
            unchanged.id
        );
        expect(deactivated.ok).toBe(true);
        proxyList = await reconnectAndGetProxyList();
        expect(proxyList.find((proxy) => proxy.id === unchanged.id)).toMatchObject({
            host: "deactivated.example",
            port: 3128,
            active: 0,
        });
    }, 30_000);

    test("core HTTP monitor saves reject unavailable proxies before persistence", async () => {
        const activeHttp = await realtime.request(
            "addProxy",
            { protocol: "http", host: "127.0.0.1", port: proxyServer.address().port, auth: false, active: true },
            null
        );
        const inactiveHttp = await realtime.request(
            "addProxy",
            { protocol: "http", host: "127.0.0.1", port: proxyServer.address().port, auth: false, active: false },
            null
        );
        const socks = await realtime.request(
            "addProxy",
            {
                protocol: "socks5h",
                host: "127.0.0.1",
                port: 1080,
                auth: true,
                username: "socks-user%@:/żółw",
                password: "socks-password%@:/密碼",
                active: true,
            },
            null
        );
        const httpsProxy = await realtime.request(
            "addProxy",
            { protocol: "https", host: "127.0.0.1", port: 8443, auth: false, active: true },
            null
        );
        for (const response of [activeHttp, inactiveHttp, socks, httpsProxy]) {
            expect(response.ok).toBe(true);
        }
        const foreignProxyID = insertForeignProxy(proxyServer.address().port);
        const missingProxyID = 2_147_483_646;
        const networkBefore = [proxyRequests.length, envProxyRequests.length, targetRequests.length];

        for (const type of ["http", "keyword", "json-query"]) {
            for (const [proxyId, message] of [
                [missingProxyID, /proxy.*unavailable/i],
                [foreignProxyID, /proxy.*unavailable/i],
                [inactiveHttp.id, /proxy.*inactive/i],
                [socks.id, /SOCKS.*not supported/i],
            ]) {
                const response = await realtime.request("add", monitorPayload({ type, proxyId, active: false }));
                expect(response.ok).toBe(false);
                expect(response.msg).toMatch(message);
            }
            const tlsResponse = await realtime.request(
                "add",
                monitorPayload({ type, proxyId: httpsProxy.id, ignoreTls: true, active: false })
            );
            expect(tlsResponse.ok).toBe(false);
            expect(tlsResponse.msg).toMatch(/ignore TLS.*HTTPS proxy.*not supported/i);
        }

        const created = await realtime.request("add", monitorPayload({ proxyId: activeHttp.id, active: false }));
        expect(created.ok).toBe(true);
        const before = (await realtime.request("getMonitor", created.monitorID)).monitor;
        for (const [type, proxyId, ignoreTls, message] of [
            ["http", missingProxyID, false, /proxy.*unavailable/i],
            ["keyword", foreignProxyID, false, /proxy.*unavailable/i],
            ["json-query", inactiveHttp.id, false, /proxy.*inactive/i],
            ["http", socks.id, false, /SOCKS.*not supported/i],
            ["http", httpsProxy.id, true, /ignore TLS.*HTTPS proxy.*not supported/i],
        ]) {
            const response = await realtime.request("editMonitor", {
                ...before,
                type,
                proxyId,
                ignoreTls,
            });
            expect(response.ok).toBe(false);
            expect(response.msg).toMatch(message);
            expect((await realtime.request("getMonitor", created.monitorID)).monitor).toMatchObject({
                type: before.type,
                proxyId: before.proxyId,
                ignoreTls: before.ignoreTls,
                url: before.url,
            });
        }
        expect([proxyRequests.length, envProxyRequests.length, targetRequests.length]).toEqual(networkBefore);
        expect((await realtime.request("deleteMonitor", created.monitorID, false)).ok).toBe(true);
    }, 30_000);

    test("invalid existing assignments stay stored and fail redacted without direct fallback", async () => {
        const activeHttp = await realtime.request(
            "addProxy",
            { protocol: "http", host: "127.0.0.1", port: proxyServer.address().port, auth: false, active: true },
            null
        );
        const inactiveHttp = await realtime.request(
            "addProxy",
            { protocol: "http", host: "127.0.0.1", port: proxyServer.address().port, auth: false, active: false },
            null
        );
        const socks = await realtime.request(
            "addProxy",
            {
                protocol: "socks5h",
                host: "127.0.0.1",
                port: 1080,
                auth: true,
                username: "socks-user%@:/żółw",
                password: "socks-password%@:/密碼",
                active: true,
            },
            null
        );
        const httpsProxy = await realtime.request(
            "addProxy",
            { protocol: "https", host: "127.0.0.1", port: 8443, auth: false, active: true },
            null
        );
        for (const response of [activeHttp, inactiveHttp, socks, httpsProxy]) {
            expect(response.ok).toBe(true);
        }
        const foreignProxyID = insertForeignProxy(proxyServer.address().port);
        const missingProxyID = 2_147_483_645;
        const created = await realtime.request("add", monitorPayload({ proxyId: activeHttp.id }));
        expect(created.ok).toBe(true);
        await realtime.waitFor("heartbeat", heartbeatFor(created.monitorID, 1));
        await stopApp();

        const cases = [
            [socks.id, false, /SOCKS.*not supported/i],
            [inactiveHttp.id, false, /proxy.*inactive/i],
            [missingProxyID, false, /proxy.*unavailable/i],
            [foreignProxyID, false, /proxy.*unavailable/i],
            [httpsProxy.id, true, /ignore TLS.*HTTPS proxy.*not supported/i],
        ];
        for (const [proxyID, ignoreTls, message] of cases) {
            updateMonitorAssignment(created.monitorID, proxyID, { ignoreTls });
            const before = {
                assigned: proxyRequests.length,
                env: envProxyRequests.length,
                target: targetRequests.length,
                logs: appLogs.length,
            };
            await startApp();
            await login();
            const [heartbeat] = await realtime.waitFor("heartbeat", heartbeatFor(created.monitorID, 0));
            expect(heartbeat.msg).toMatch(message);
            expect((await realtime.request("getMonitor", created.monitorID)).monitor.proxyId).toBe(proxyID);
            expect(proxyRequests.length).toBe(before.assigned);
            expect(envProxyRequests.length).toBe(before.env);
            expect(targetRequests.length).toBe(before.target);
            await Bun.sleep(50);
            const phaseLogs = appLogs.slice(before.logs).join("");
            expect(phaseLogs).toMatch(message);
            for (const secret of [
                "socks-user%@:/żółw",
                "socks-password%@:/密碼",
                encodeURIComponent("socks-password%@:/密碼"),
                "foreign-user%@:/żółw",
                "foreign-password%@:/密碼",
                Buffer.from("foreign-user%@:/żółw:foreign-password%@:/密碼").toString("base64"),
            ]) {
                expect(phaseLogs).not.toContain(secret);
            }
            await stopApp();
        }

        updateMonitorAssignment(created.monitorID, null);
        await startApp();
        await login();
        expect((await realtime.request("deleteMonitor", created.monitorID, false)).ok).toBe(true);
        const allLogs = appLogs.join("");
        expect(allLogs).toContain("Fetch Options prepared (proxy: true)");
        for (const basicValue of [
            `Basic ${Buffer.from("socks-user%@:/żółw:socks-password%@:/密碼").toString("base64")}`,
            `Basic ${Buffer.from("foreign-user%@:/żółw:foreign-password%@:/密碼").toString("base64")}`,
        ]) {
            expect(allLogs).not.toContain(basicValue);
        }
    }, 60_000);

    test.skipIf(!realBrowserExecutable || process.platform === "win32")(
        standaloneBinary
            ? "copied standalone binary completes a real-browser monitor without node_modules"
            : "real-browser monitor completes screenshots, cancels navigation, relaunches, and cleans Chromium",
        async () => {
            fs.accessSync(realBrowserExecutable, fs.constants.X_OK);
            const settings = await realtime.request("getSettings");
            expect(settings.ok).toBe(true);
            expect(
                (
                    await realtime.request(
                        "setSettings",
                        { ...settings.data, chromeExecutable: realBrowserExecutable },
                        credentials.password
                    )
                ).ok
            ).toBe(true);
            const chromeTest = await realtime.request("testChrome", realBrowserExecutable);
            expect(chromeTest.ok, JSON.stringify(chromeTest)).toBe(true);

            let monitorID;
            let barrier;
            try {
                const mark = realtime.mark();
                const created = await realtime.request(
                    "add",
                    monitorPayload({
                        type: "real-browser",
                        name: "Compiled real-browser lifecycle",
                        interval: 2,
                        timeout: 5,
                        screenshot_delay: 100,
                        remote_browser: null,
                    })
                );
                expect(created.ok).toBe(true);
                monitorID = created.monitorID;
                await realtime
                    .waitFor("heartbeat", heartbeatFor(monitorID, 1), mark, 20_000)
                    .catch((error) => Promise.reject(new Error(`${error.message}\n${appLogs.join("")}`)));

                const configuredBrowserPIDs = descendantProcesses(appProcess.pid)
                    .filter((process) => process.command.includes("playwright_chromiumdev_profile"))
                    .map((process) => process.pid);
                expect(configuredBrowserPIDs.length).toBeGreaterThan(0);
                const currentSettings = await realtime.request("getSettings");
                const relaunchedMark = realtime.mark();
                expect(
                    (
                        await realtime.request(
                            "setSettings",
                            { ...currentSettings.data, chromeExecutable: null },
                            credentials.password
                        )
                    ).ok
                ).toBe(true);
                expect(processTable().some((process) => configuredBrowserPIDs.includes(process.pid))).toBe(false);
                expect((await realtime.request("getSettings")).data.chromeExecutable).toBeNull();
                await realtime.waitFor("heartbeat", heartbeatFor(monitorID, 1), relaunchedMark, 20_000);
                const autoDetectedBrowserPIDs = descendantProcesses(appProcess.pid)
                    .filter((process) => process.command.includes("playwright_chromiumdev_profile"))
                    .map((process) => process.pid);
                expect(autoDetectedBrowserPIDs.length).toBeGreaterThan(0);
                expect(autoDetectedBrowserPIDs.some((pid) => configuredBrowserPIDs.includes(pid))).toBe(false);

                const response = await realtime.request("getMonitor", monitorID);
                expect(response.ok).toBe(true);
                expect(response.monitor.screenshot_delay).toBe(100);
                const screenshot = await fetch(`http://127.0.0.1:${appPort}${response.monitor.screenshot}`);
                expect(screenshot.status).toBe(200);
                expect(screenshot.headers.get("content-type")).toBe("image/png");
                expect(Array.from(new Uint8Array(await screenshot.arrayBuffer()).slice(0, 8))).toEqual([
                    137, 80, 78, 71, 13, 10, 26, 10,
                ]);

                barrier = armTargetBarrier();
                const monitor = (await realtime.request("getMonitor", monitorID)).monitor;
                expect(
                    (
                        await realtime.request("editMonitor", {
                            ...monitor,
                            url: `${targetUrl}/barrier`,
                            screenshot_delay: 0,
                        })
                    ).ok
                ).toBe(true);
                await withTimeout(barrier.arrived, 10_000, "real-browser navigation did not reach the barrier");

                const pauseStarted = performance.now();
                expect(
                    (
                        await withTimeout(
                            realtime.request("pauseMonitor", monitorID),
                            2_000,
                            "real-browser pause did not cancel active navigation"
                        )
                    ).ok
                ).toBe(true);
                expect(performance.now() - pauseStarted).toBeLessThan(2_000);
                barrier.release();
                barrier = null;
                targetBarrier = null;

                const paused = (await realtime.request("getMonitor", monitorID)).monitor;
                expect(
                    (
                        await realtime.request("editMonitor", {
                            ...paused,
                            url: `${targetUrl}/first`,
                            screenshot_delay: 100,
                        })
                    ).ok
                ).toBe(true);
                const resumedMark = realtime.mark();
                expect((await realtime.request("resumeMonitor", monitorID)).ok).toBe(true);
                await realtime.waitFor("heartbeat", heartbeatFor(monitorID, 1), resumedMark, 20_000);

                expect((await realtime.request("deleteMonitor", monitorID, false)).ok).toBe(true);
                monitorID = null;
                const ownedBrowserPIDs = descendantProcesses(appProcess.pid)
                    .filter((process) => process.command.includes("playwright_chromiumdev_profile"))
                    .map((process) => process.pid);
                expect(ownedBrowserPIDs.length).toBeGreaterThan(0);

                await stopApp();
                await withTimeout(
                    (async () => {
                        while (processTable().some((process) => ownedBrowserPIDs.includes(process.pid))) {
                            await Bun.sleep(25);
                        }
                    })(),
                    5_000,
                    "Chromium processes survived iglo.monitor shutdown"
                );
            } finally {
                barrier?.release();
                targetBarrier = null;
                if (monitorID && appProcess?.exitCode === null) {
                    await realtime.request("deleteMonitor", monitorID, false).catch(() => {});
                }
            }
        },
        60_000
    );

    test.skipIf(!pendingBrowserAcquisition || process.platform === "win32")(
        "settings reset retires a pre-handshake browser process tree before replying",
        async () => {
            const { executable, pidFile } = preparePendingBrowserWrapper();

            const settings = await realtime.request("getSettings");
            expect(settings.ok).toBe(true);
            expect(
                (
                    await realtime.request(
                        "setSettings",
                        { ...settings.data, chromeExecutable: executable },
                        credentials.password
                    )
                ).ok
            ).toBe(true);

            let monitorID;
            let processGroup;
            try {
                const created = await realtime.request(
                    "add",
                    monitorPayload({
                        type: "real-browser",
                        name: "Pending browser acquisition",
                        interval: 30,
                        timeout: 30,
                        screenshot_delay: 0,
                        remote_browser: null,
                    })
                );
                expect(created.ok).toBe(true);
                monitorID = created.monitorID;
                const pending = await pendingBrowserProcesses(pidFile);
                processGroup = pending.processGroup;
                const ownedPIDs = pending.pids;
                expect(ownedPIDs.every((pid) => processTable().some((process) => process.pid === pid))).toBe(true);

                const current = await realtime.request("getSettings");
                const reset = await realtime.request(
                    "setSettings",
                    { ...current.data, chromeExecutable: null },
                    credentials.password
                );

                expect(reset.ok).toBe(true);
                expect(processTable().some((process) => ownedPIDs.includes(process.pid))).toBe(false);
                expect(processGroupSurvives(processGroup)).toBe(false);
            } finally {
                if (processGroup) {
                    try {
                        process.kill(-processGroup, "SIGKILL");
                    } catch {}
                }
                if (monitorID) {
                    await realtime.request("deleteMonitor", monitorID, false).catch(() => {});
                }
            }
        },
        30_000
    );

    test.skipIf(!pendingBrowserAcquisition || process.platform === "win32")(
        "Chromium test callback waits for a pre-handshake process tree to retire",
        async () => {
            const { executable, pidFile } = preparePendingBrowserWrapper();
            let processGroup;
            try {
                const testing = realtime.request("testChrome", executable);
                processGroup = (await pendingBrowserProcesses(pidFile)).processGroup;

                const result = await testing;

                expect(result.ok).toBe(false);
                expect(processGroupSurvives(processGroup)).toBe(false);
            } finally {
                if (processGroup) {
                    try {
                        process.kill(-processGroup, "SIGKILL");
                    } catch {}
                }
            }
        },
        15_000
    );

    test.skipIf(!pendingBrowserAcquisition)(
        "remote-browser test callback waits for its pending WebSocket to close",
        async () => {
            await stopApp();
            appNoProxy = "127.0.0.1,localhost";
            let fixture;
            try {
                await startApp();
                await login();
                fixture = await createHangingTcpServer();
                const testing = realtime.request("testRemoteBrowser", {
                    name: "Pending remote browser",
                    url: `ws://127.0.0.1:${fixture.port}`,
                });
                const opened = await Promise.race([
                    fixture.requestArrived.then(() => true),
                    testing.then(() => false),
                    Bun.sleep(2_000).then(() => false),
                ]);

                const result = await testing;

                expect(opened, JSON.stringify(result)).toBe(true);
                expect(result.ok).toBe(false);
                await withTimeout(fixture.socketClosed, 1_000, "remote-browser test left its WebSocket open");
            } finally {
                await fixture?.close();
                await stopApp();
                appNoProxy = "";
                await startApp();
                await login();
            }
        },
        15_000
    );

    test.skipIf(!pendingBrowserAcquisition)(
        "remote-browser edit and delete callbacks retire their pending WebSockets",
        async () => {
            await stopApp();
            appNoProxy = "127.0.0.1,localhost";
            let firstFixture;
            let secondFixture;
            let monitorID;
            let remoteBrowserID;
            try {
                await startApp();
                await login();
                firstFixture = await createHangingTcpServer();
                secondFixture = await createHangingTcpServer();

                const added = await realtime.request(
                    "addRemoteBrowser",
                    {
                        name: "Pending remote browser",
                        url: `ws://127.0.0.1:${firstFixture.port}`,
                    },
                    null
                );
                expect(added.ok).toBe(true);
                remoteBrowserID = added.id;

                const created = await realtime.request(
                    "add",
                    monitorPayload({
                        type: "real-browser",
                        name: "Pending remote-browser lifecycle",
                        interval: 1,
                        timeout: 30,
                        screenshot_delay: 0,
                        remote_browser: remoteBrowserID,
                    })
                );
                expect(created.ok).toBe(true);
                monitorID = created.monitorID;
                await withTimeout(
                    firstFixture.requestArrived,
                    5_000,
                    "remote-browser monitor did not start its first connection"
                );

                const editOrder = [];
                firstFixture.socketClosed.then(() => editOrder.push("socket closed"));
                const editing = realtime
                    .request(
                        "addRemoteBrowser",
                        {
                            name: "Updated pending remote browser",
                            url: `ws://127.0.0.1:${secondFixture.port}`,
                        },
                        remoteBrowserID
                    )
                    .then((result) => {
                        editOrder.push("callback");
                        return result;
                    });
                expect((await editing).ok).toBe(true);
                expect(editOrder).toEqual(["socket closed", "callback"]);
                await withTimeout(
                    secondFixture.requestArrived,
                    10_000,
                    "remote-browser monitor did not use its edited connection"
                );

                const deleteOrder = [];
                secondFixture.socketClosed.then(() => deleteOrder.push("socket closed"));
                const deleting = realtime.request("deleteRemoteBrowser", remoteBrowserID).then((result) => {
                    deleteOrder.push("callback");
                    return result;
                });
                expect((await deleting).ok).toBe(true);
                remoteBrowserID = null;
                expect(deleteOrder).toEqual(["socket closed", "callback"]);
                expect((await realtime.request("getMonitor", monitorID)).monitor.remote_browser).toBeNull();
            } finally {
                if (monitorID && appProcess?.exitCode === null) {
                    await realtime.request("deleteMonitor", monitorID, false).catch(() => {});
                }
                if (remoteBrowserID && appProcess?.exitCode === null) {
                    await realtime.request("deleteRemoteBrowser", remoteBrowserID).catch(() => {});
                }
                await Promise.all([firstFixture?.close(), secondFixture?.close()]);
                await stopApp();
                appNoProxy = "";
                await startApp();
                await login();
            }
        },
        30_000
    );

    test.skipIf(binaryPath || !pendingBrowserAcquisition || process.platform === "win32")(
        "SQLite restore retires a pre-handshake browser process tree before replying",
        async () => {
            const baseline = await realtime.request("getSettings");
            expect(baseline.ok).toBe(true);
            expect((await fetch(`http://127.0.0.1:${appPort}/_e2e/take-sqlite-snapshot`)).ok).toBe(true);
            const { executable, pidFile } = preparePendingBrowserWrapper();
            expect(
                (
                    await realtime.request(
                        "setSettings",
                        { ...baseline.data, chromeExecutable: executable },
                        credentials.password
                    )
                ).ok
            ).toBe(true);

            let monitorID;
            let processGroup;
            try {
                const created = await realtime.request(
                    "add",
                    monitorPayload({
                        type: "real-browser",
                        name: "Pending browser snapshot restore",
                        interval: 30,
                        timeout: 30,
                        screenshot_delay: 0,
                        remote_browser: null,
                    })
                );
                expect(created.ok).toBe(true);
                monitorID = created.monitorID;
                processGroup = (await pendingBrowserProcesses(pidFile)).processGroup;

                const restored = await fetch(`http://127.0.0.1:${appPort}/_e2e/restore-sqlite-snapshot`);

                expect(restored.ok).toBe(true);
                expect(processGroupSurvives(processGroup)).toBe(false);
                monitorID = null;
                expect((await realtime.request("getSettings")).data.chromeExecutable).toBe(
                    baseline.data.chromeExecutable
                );
            } finally {
                if (processGroup) {
                    try {
                        process.kill(-processGroup, "SIGKILL");
                    } catch {}
                }
                if (monitorID) {
                    await realtime.request("deleteMonitor", monitorID, false).catch(() => {});
                }
            }
        },
        30_000
    );

    test.skipIf(binaryPath || !pendingBrowserAcquisition || process.platform === "win32")(
        "SQLite restore rollback retires the old pre-handshake process tree before replying",
        async () => {
            const baseline = await realtime.request("getSettings");
            expect(baseline.ok).toBe(true);
            expect((await fetch(`http://127.0.0.1:${appPort}/_e2e/take-sqlite-snapshot`)).ok).toBe(true);
            const snapshotPath = path.join(dataDir, "kuma.db.e2e-snapshot");
            const malformed = new BunDatabase(snapshotPath, { strict: true });
            malformed.run("DROP TABLE setting");
            malformed.run("CREATE TABLE setting (id INTEGER PRIMARY KEY)");
            malformed.close();
            const { executable, pidFile } = preparePendingBrowserWrapper();
            expect(
                (
                    await realtime.request(
                        "setSettings",
                        { ...baseline.data, chromeExecutable: executable },
                        credentials.password
                    )
                ).ok
            ).toBe(true);

            let monitorID;
            let processGroup;
            try {
                const created = await realtime.request(
                    "add",
                    monitorPayload({
                        type: "real-browser",
                        name: "Pending browser snapshot rollback",
                        interval: 30,
                        timeout: 30,
                        screenshot_delay: 0,
                        remote_browser: null,
                    })
                );
                expect(created.ok).toBe(true);
                monitorID = created.monitorID;
                processGroup = (await pendingBrowserProcesses(pidFile)).processGroup;

                const restored = await fetch(`http://127.0.0.1:${appPort}/_e2e/restore-sqlite-snapshot`);

                expect(restored.status).toBe(500);
                expect(processGroupSurvives(processGroup)).toBe(false);
                expect((await realtime.request("getSettings")).data.chromeExecutable).toBe(executable);
            } finally {
                if (processGroup) {
                    try {
                        process.kill(-processGroup, "SIGKILL");
                    } catch {}
                }
                if (monitorID) {
                    await realtime.request("deleteMonitor", monitorID, false).catch(() => {});
                }
                const current = await realtime.request("getSettings").catch(() => null);
                if (current?.ok) {
                    await realtime
                        .request(
                            "setSettings",
                            { ...current.data, chromeExecutable: baseline.data.chromeExecutable },
                            credentials.password
                        )
                        .catch(() => {});
                }
            }
        },
        30_000
    );

    test.skipIf(binaryPath || !realBrowserExecutable || process.platform === "win32")(
        "SQLite restore retires an idle real-browser owner before using restored settings",
        async () => {
            fs.accessSync(realBrowserExecutable, fs.constants.X_OK);
            if (!appProcess || appProcess.exitCode !== null) {
                await startApp();
                await login();
            }
            const currentSettings = await realtime.request("getSettings");
            expect(currentSettings.ok).toBe(true);
            expect(
                (
                    await realtime.request(
                        "setSettings",
                        { ...currentSettings.data, chromeExecutable: null },
                        credentials.password
                    )
                ).ok
            ).toBe(true);
            expect((await fetch(`http://127.0.0.1:${appPort}/_e2e/take-sqlite-snapshot`)).ok).toBe(true);
            const baselineSettings = await realtime.request("getSettings");
            expect(baselineSettings.ok).toBe(true);
            expect(baselineSettings.data.chromeExecutable).toBeNull();
            expect(
                (
                    await realtime.request(
                        "setSettings",
                        { ...baselineSettings.data, chromeExecutable: realBrowserExecutable },
                        credentials.password
                    )
                ).ok
            ).toBe(true);

            let firstMonitorID;
            let secondMonitorID;
            try {
                const firstMark = realtime.mark();
                const first = await realtime.request(
                    "add",
                    monitorPayload({
                        type: "real-browser",
                        name: "Browser owner before SQLite restore",
                        interval: 30,
                        timeout: 5,
                        screenshot_delay: 0,
                        remote_browser: null,
                    })
                );
                expect(first.ok).toBe(true);
                firstMonitorID = first.monitorID;
                await realtime.waitFor("heartbeat", heartbeatFor(firstMonitorID, 1), firstMark, 20_000);
                const oldBrowserPIDs = descendantProcesses(appProcess.pid)
                    .filter((process) => process.command.includes("playwright_chromiumdev_profile"))
                    .map((process) => process.pid);
                expect(oldBrowserPIDs.length).toBeGreaterThan(0);

                const snapshotPath = path.join(dataDir, "kuma.db.e2e-snapshot");
                const validSnapshot = fs.readFileSync(snapshotPath);
                const malformed = new BunDatabase(snapshotPath, { strict: true });
                malformed.run("DROP TABLE setting");
                malformed.run("CREATE TABLE setting (id INTEGER PRIMARY KEY)");
                malformed.close();
                const recoveryMark = realtime.mark();
                expect((await fetch(`http://127.0.0.1:${appPort}/_e2e/restore-sqlite-snapshot`)).status).toBe(500);
                expect(processTable().some((process) => oldBrowserPIDs.includes(process.pid))).toBe(false);
                expect((await realtime.request("getSettings")).data.chromeExecutable).toBe(realBrowserExecutable);
                await realtime.waitFor("heartbeat", heartbeatFor(firstMonitorID, 1), recoveryMark, 20_000);
                const recoveredBrowserPIDs = descendantProcesses(appProcess.pid)
                    .filter((process) => process.command.includes("playwright_chromiumdev_profile"))
                    .map((process) => process.pid);
                expect(recoveredBrowserPIDs.length).toBeGreaterThan(0);
                expect(recoveredBrowserPIDs.some((pid) => oldBrowserPIDs.includes(pid))).toBe(false);
                fs.writeFileSync(snapshotPath, validSnapshot);

                const restored = await fetch(`http://127.0.0.1:${appPort}/_e2e/restore-sqlite-snapshot`);
                expect(restored.ok).toBe(true);
                expect(processTable().some((process) => recoveredBrowserPIDs.includes(process.pid))).toBe(false);
                firstMonitorID = null;
                expect((await realtime.request("getSettings")).data.chromeExecutable).toBe(
                    baselineSettings.data.chromeExecutable
                );

                expect(
                    (
                        await realtime.request(
                            "setSettings",
                            { ...baselineSettings.data, chromeExecutable: realBrowserExecutable },
                            credentials.password
                        )
                    ).ok
                ).toBe(true);
                const secondMark = realtime.mark();
                const second = await realtime.request(
                    "add",
                    monitorPayload({
                        type: "real-browser",
                        name: "Browser owner after SQLite restore",
                        interval: 30,
                        timeout: 5,
                        screenshot_delay: 0,
                        remote_browser: null,
                    })
                );
                expect(second.ok).toBe(true);
                secondMonitorID = second.monitorID;
                await realtime.waitFor("heartbeat", heartbeatFor(secondMonitorID, 1), secondMark, 20_000);
                const newBrowserPIDs = descendantProcesses(appProcess.pid)
                    .filter((process) => process.command.includes("playwright_chromiumdev_profile"))
                    .map((process) => process.pid);
                expect(newBrowserPIDs.length).toBeGreaterThan(0);
                expect(newBrowserPIDs.some((pid) => oldBrowserPIDs.includes(pid))).toBe(false);
                expect(newBrowserPIDs.some((pid) => recoveredBrowserPIDs.includes(pid))).toBe(false);
            } finally {
                if (secondMonitorID) {
                    await realtime.request("deleteMonitor", secondMonitorID, false).catch(() => {});
                }
                if (firstMonitorID) {
                    await realtime.request("deleteMonitor", firstMonitorID, false).catch(() => {});
                }
            }
        },
        60_000
    );

    test.skipIf(!pendingBrowserAcquisition || process.platform === "win32")(
        "SIGTERM retires a pre-handshake browser process tree before iglo.monitor exits",
        async () => {
            const baseline = await realtime.request("getSettings");
            expect(baseline.ok).toBe(true);
            const { executable, pidFile } = preparePendingBrowserWrapper();
            expect(
                (
                    await realtime.request(
                        "setSettings",
                        { ...baseline.data, chromeExecutable: executable },
                        credentials.password
                    )
                ).ok
            ).toBe(true);

            let processGroup;
            try {
                const created = await realtime.request(
                    "add",
                    monitorPayload({
                        type: "real-browser",
                        name: "Pending browser shutdown",
                        interval: 30,
                        timeout: 30,
                        screenshot_delay: 0,
                        remote_browser: null,
                    })
                );
                expect(created.ok).toBe(true);
                processGroup = (await pendingBrowserProcesses(pidFile)).processGroup;

                await stopApp();

                expect(processGroupSurvives(processGroup)).toBe(false);
            } finally {
                if (processGroup) {
                    try {
                        process.kill(-processGroup, "SIGKILL");
                    } catch {}
                }
            }
        },
        30_000
    );
});
