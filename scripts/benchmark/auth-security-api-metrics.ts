// @ts-nocheck

import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scriptRoot = path.resolve(import.meta.dirname, "../..");
const encoder = new TextEncoder();
let appProcess = null;
let appPort = null;
const sockets = new Set();

function argument(name, fallback) {
    const prefix = `--${name}=`;
    const value = process.argv.find((item) => item.startsWith(prefix));
    return value ? value.slice(prefix.length) : fallback;
}

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

function gitRevision(repoRoot) {
    const result = Bun.spawnSync(["git", "-C", repoRoot, "rev-parse", "HEAD"], {
        stdout: "pipe",
        stderr: "ignore",
    });
    return new TextDecoder().decode(result.stdout).trim();
}

function processRssKB() {
    if (!appProcess?.pid) {
        return null;
    }

    const result = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(appProcess.pid)], {
        stdout: "pipe",
        stderr: "ignore",
    });
    const value = Number(new TextDecoder().decode(result.stdout).trim());
    return Number.isFinite(value) && value > 0 ? value : null;
}

async function waitForApp(port) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (appProcess?.exitCode !== null) {
            throw new Error(`iglo.monitor exited before becoming ready (exit ${appProcess.exitCode})`);
        }

        try {
            const response = await fetch(`http://127.0.0.1:${port}/metrics`);
            await response.body?.cancel();
            return;
        } catch {}

        await Bun.sleep(100);
    }

    throw new Error("iglo.monitor did not become ready within 30 seconds");
}

async function startApp(repoRoot, dataDir) {
    appPort = reservePort();
    appProcess = Bun.spawn(
        [process.execPath, "src/server/server.ts", `--port=${appPort}`, "--host=127.0.0.1", `--data-dir=${dataDir}`],
        {
            cwd: repoRoot,
            env: {
                ...process.env,
                NODE_ENV: "development",
                IGLO_MONITOR_WS_ORIGIN_CHECK: "bypass",
            },
            stdout: "ignore",
            stderr: "ignore",
        }
    );
    await waitForApp(appPort);
    return appPort;
}

async function stopApp() {
    for (const socket of sockets) {
        socket.close();
    }
    sockets.clear();

    const processToStop = appProcess;
    appProcess = null;
    appPort = null;
    if (!processToStop || processToStop.exitCode !== null) {
        return;
    }

    processToStop.kill("SIGTERM");
    try {
        await withTimeout(processToStop.exited, 5_000, "iglo.monitor did not stop after SIGTERM");
    } catch {
        processToStop.kill("SIGKILL");
        await processToStop.exited;
    }
}

async function seedFixtures(dataDir, sample) {
    const database = new Database(path.join(dataDir, "kuma.db"));
    const passwordA = "bench-a-password";
    const passwordB = "bench-b-password";
    const hashA = await Bun.password.hash(passwordA, { algorithm: "argon2id" });
    const hashB = await Bun.password.hash(passwordB, { algorithm: "argon2id" });

    database
        .query("INSERT INTO user (username, password) VALUES (?, ?), (?, ?)")
        .run("bench-a", hashA, "bench-b", hashB);

    const users = database.query("SELECT id, username FROM user WHERE username IN ('bench-a', 'bench-b')").all();
    const userIDs = Object.fromEntries(users.map((user) => [user.username, user.id]));
    const monitors = [
        {
            name: `benchmark-a-${sample}`,
            userID: userIDs["bench-a"],
            token: `bench-a-${sample}`,
            url: "https://bench-a:password-a@example.invalid/private?token=a-secret",
        },
        {
            name: `benchmark-b-${sample}`,
            userID: userIDs["bench-b"],
            token: `bench-b-${sample}`,
            url: "https://bench-b:password-b@example.invalid/private?token=b-secret",
        },
    ];

    for (const monitor of monitors) {
        database
            .query(
                `
                    INSERT INTO monitor (name, active, user_id, interval, url, type, push_token)
                    VALUES (?, 1, ?, 60, ?, 'push', ?)
                `
            )
            .run(monitor.name, monitor.userID, monitor.url, monitor.token);
    }

    const counts = database
        .query("SELECT (SELECT COUNT(*) FROM user) AS users, (SELECT COUNT(*) FROM monitor) AS monitors")
        .get();
    database.close();

    if (counts.users !== 2 || counts.monitors !== 2) {
        throw new Error(`Fixture count mismatch: ${JSON.stringify(counts)}`);
    }

    return { passwordA, passwordB, monitors };
}

async function pushSample(port, monitor, sample) {
    const response = await fetch(
        `http://127.0.0.1:${port}/api/push/${monitor.token}?status=up&ping=${17 + sample}&msg=benchmark-${sample}`
    );
    const body = await response.text();
    if (response.status !== 200) {
        throw new Error(`Push sample failed for ${monitor.name}: ${response.status} ${body}`);
    }
    return response.status;
}

function basic(username, password) {
    return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

async function readMetrics(port, username, password) {
    const started = performance.now();
    const response = await fetch(`http://127.0.0.1:${port}/metrics`, {
        headers: { authorization: basic(username, password) },
    });
    const body = await response.text();
    return {
        status: response.status,
        milliseconds: Number((performance.now() - started).toFixed(3)),
        bytes: encoder.encode(body).byteLength,
        body,
    };
}

function ownership(body, ownedName, foreignName) {
    return {
        ownedPresent: body.includes(`monitor_name="${ownedName}"`),
        foreignPresent: body.includes(`monitor_name="${foreignName}"`),
    };
}

export function assertMetricsIsolated({ ownershipA, ownershipB, secretsA, secretsB }) {
    if (
        !ownershipA.ownedPresent ||
        ownershipA.foreignPresent ||
        !ownershipB.ownedPresent ||
        ownershipB.foreignPresent ||
        secretsA ||
        secretsB
    ) {
        throw new Error(`Metrics isolation failed: ${JSON.stringify({ ownershipA, ownershipB, secretsA, secretsB })}`);
    }
}

async function runSample(repoRoot, sample, expectIsolated) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-auth-metrics-bench-"));
    try {
        await startApp(repoRoot, dataDir);
        await stopApp();
        const fixtures = await seedFixtures(dataDir, sample);
        const port = await startApp(repoRoot, dataDir);

        const pushStatuses = await Promise.all(fixtures.monitors.map((monitor) => pushSample(port, monitor, sample)));
        await readMetrics(port, "bench-a", fixtures.passwordA);
        await readMetrics(port, "bench-b", fixtures.passwordB);

        const rssBeforeKB = processRssKB();
        const pairStarted = performance.now();
        const [ownerA, ownerB] = await Promise.all([
            readMetrics(port, "bench-a", fixtures.passwordA),
            readMetrics(port, "bench-b", fixtures.passwordB),
        ]);
        const pairMilliseconds = Number((performance.now() - pairStarted).toFixed(3));
        const rssAfterKB = processRssKB();
        const expectedA = fixtures.monitors[0].name;
        const expectedB = fixtures.monitors[1].name;
        const ownershipA = ownership(ownerA.body, expectedA, expectedB);
        const ownershipB = ownership(ownerB.body, expectedB, expectedA);
        const secretsA = ownerA.body.includes("password-a") || ownerA.body.includes("a-secret");
        const secretsB = ownerB.body.includes("password-b") || ownerB.body.includes("b-secret");

        if (ownerA.status !== 200 || ownerB.status !== 200) {
            throw new Error(`Metrics request failed: ${ownerA.status}/${ownerB.status}`);
        }
        if (expectIsolated) {
            assertMetricsIsolated({ ownershipA, ownershipB, secretsA, secretsB });
        }

        return {
            revision: gitRevision(repoRoot),
            sample,
            users: 2,
            monitors: 2,
            pushStatuses,
            ownerA: {
                milliseconds: ownerA.milliseconds,
                bytes: ownerA.bytes,
                owned: expectedA,
                ...ownershipA,
                secretsPresent: secretsA,
            },
            ownerB: {
                milliseconds: ownerB.milliseconds,
                bytes: ownerB.bytes,
                owned: expectedB,
                ...ownershipB,
                secretsPresent: secretsB,
            },
            pairMilliseconds,
            rssBeforeKB,
            rssAfterKB,
        };
    } finally {
        await stopApp();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}

async function main() {
    const repoRoot = path.resolve(argument("repo", scriptRoot));
    const samples = Number(argument("samples", "3"));
    const expectIsolated = argument("expect-isolated", "0") === "1";
    if (!Number.isInteger(samples) || samples < 1) {
        throw new Error("--samples must be a positive integer");
    }

    for (let sample = 1; sample <= samples; sample++) {
        console.log(JSON.stringify(await runSample(repoRoot, sample, expectIsolated)));
    }
}

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error.stack || error);
        await stopApp();
        process.exitCode = 1;
    }
}
