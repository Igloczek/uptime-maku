#!/usr/bin/env bun
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const decoder = new TextDecoder();
const projectRoot = path.resolve(import.meta.dirname, "../..");
const defaultTimeoutMs = 30_000;
const defaultWarmupMs = 1_000;
const sigtermGraceMs = 5_000;

function median(values) {
    if (!values.length) {
        throw new Error("Cannot calculate a median without values.");
    }

    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function parseReadyLine(line) {
    try {
        const value = JSON.parse(line);
        return value?.event === "ready" ? value : null;
    } catch {
        return null;
    }
}

function parseRssKb(text) {
    const value = Number.parseInt(text.trim(), 10);
    return Number.isFinite(value) ? value : null;
}

function parseFootprintBytes(text) {
    const match = text.match(/(?:physical\s+)?footprint\s*:\s*([\d,.]+)\s*([KMGT]?)/i);
    if (!match) {
        return null;
    }

    const value = Number(match[1].replaceAll(",", ""));
    const multiplier = 1024 ** " KMGT".indexOf(match[2].toUpperCase());
    return Number.isFinite(value) ? Math.round(value * multiplier) : null;
}

function commandOutput(command) {
    try {
        const result = Bun.spawnSync(command);
        return result.exitCode === 0 ? decoder.decode(result.stdout) : "";
    } catch {
        return "";
    }
}

function readExternalMetrics(pid) {
    const rssKb = parseRssKb(commandOutput(["ps", "-o", "rss=", "-p", String(pid)]));
    const footprintBytes =
        process.platform === "darwin"
            ? parseFootprintBytes(commandOutput(["footprint", "-p", String(pid), "-f", "bytes"]))
            : null;
    return { rssKb, footprintBytes };
}

function assertExternalMetricsAvailable() {
    const metrics = readExternalMetrics(process.pid);
    if (!Number.isFinite(metrics.rssKb)) {
        throw new Error("RSS unavailable: `ps -o rss= -p <pid>` returned no numeric value.");
    }
    if (process.platform === "darwin" && !Number.isFinite(metrics.footprintBytes)) {
        throw new Error("Physical footprint unavailable: macOS `footprint` returned no numeric value.");
    }
}

async function readStream(stream, onChunk) {
    const reader = stream.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                return;
            }
            onChunk(decoder.decode(value));
        }
    } finally {
        reader.releaseLock();
    }
}

function signalProcess(processHandle, signal, processGroup) {
    if (processGroup) {
        try {
            process.kill(-processHandle.pid, signal);
            return;
        } catch {
            // Fall back to the direct child when process-group signalling is unavailable.
        }
    }
    processHandle.kill(signal);
}

async function stopProcess(processHandle, exited, { processGroup = false } = {}) {
    let forcedKill = false;
    const isExited = () => exited.value || processHandle.exitCode !== null;
    if (!isExited()) {
        signalProcess(processHandle, "SIGTERM", processGroup);
        await Promise.race([processHandle.exited, Bun.sleep(sigtermGraceMs)]);
    }
    if (!isExited()) {
        forcedKill = true;
        console.error(`${processHandle.pid}: forced SIGKILL after ${sigtermGraceMs}ms SIGTERM grace`);
        signalProcess(processHandle, "SIGKILL", processGroup);
        await processHandle.exited;
    }
    return forcedKill;
}

async function waitForReady({ processHandle, exited, stdout, readiness, timeoutMs }) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (exited.value || processHandle.exitCode !== null) {
            throw new Error(`Process exited before readiness (code=${processHandle.exitCode}).\n${stdout.value}`);
        }

        if (readiness.kind === "stdout" && stdout.value.includes(readiness.marker)) {
            return;
        }

        if (readiness.kind === "http") {
            try {
                const response = await fetch(readiness.url);
                if (response.ok && response.status === (readiness.expectedStatus ?? 200)) {
                    return;
                }
            } catch {
                // The process is still starting.
            }
        }

        await Bun.sleep(50);
    }

    throw new Error(`Readiness timed out after ${timeoutMs}ms.`);
}

async function findFreePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
}

async function runTrial({
    name,
    command,
    readiness,
    requiresPort = false,
    timeoutMs = defaultTimeoutMs,
    warmupMs = defaultWarmupMs,
    processGroup = false,
    measureMetrics = true,
}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iglo-monitor-startup-"));
    let port = 0;
    const stdout = { value: "" };
    const stderr = { value: "" };
    const exited = { value: false };
    let processHandle;
    let stdoutReader;
    let stderrReader;
    let result;

    try {
        if (requiresPort) {
            port = await findFreePort();
        }
        processHandle = Bun.spawn(command({ port, dataDir }), {
            cwd: projectRoot,
            env: { ...process.env, BENCHMARK_PORT: String(port) },
            stdout: "pipe",
            stderr: "pipe",
            detached: processGroup,
        });
        processHandle.exited.then(() => {
            exited.value = true;
        });
        stdoutReader = readStream(processHandle.stdout, (chunk) => {
            stdout.value += chunk;
        });
        stderrReader = readStream(processHandle.stderr, (chunk) => {
            stderr.value += chunk;
        });

        const startedAt = performance.now();
        await waitForReady({ processHandle, exited, stdout, readiness: readiness({ port }), timeoutMs });
        const readinessMs = Math.round(performance.now() - startedAt);
        await Bun.sleep(warmupMs);
        if (exited.value || processHandle.exitCode !== null) {
            throw new Error(`Process exited during warm-up (code=${processHandle.exitCode}).\n${stdout.value}`);
        }
        const metrics = measureMetrics ? readExternalMetrics(processHandle.pid) : { rssKb: null, footprintBytes: null };
        if (measureMetrics && !Number.isFinite(metrics.rssKb)) {
            throw new Error(`${name}: RSS unavailable for process ${processHandle.pid}.`);
        }
        if (measureMetrics && process.platform === "darwin" && !Number.isFinite(metrics.footprintBytes)) {
            throw new Error(`${name}: physical footprint unavailable on macOS.`);
        }
        const readyLine = stdout.value
            .split("\n")
            .map((line) => parseReadyLine(line))
            .find((value) => value);

        result = {
            name,
            port,
            readinessMs,
            ...metrics,
            synthetic: readyLine?.synthetic || null,
            stdout: stdout.value,
            stderr: stderr.value,
            dataDir,
        };
        return result;
    } finally {
        if (processHandle) {
            const forcedKill = await stopProcess(processHandle, exited, { processGroup });
            if (result) {
                result.forcedKill = forcedKill;
            }
            await Promise.all([stdoutReader, stderrReader]);
        }
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}

const variants = [
    {
        name: "minimal-bun",
        synthetic: true,
        command: () => [process.execPath, "scripts/benchmark/probes/minimal-bun.ts"],
        readiness: () => ({ kind: "stdout", marker: '"event":"ready"' }),
    },
    {
        name: "minimal-bun-serve",
        synthetic: true,
        requiresPort: true,
        command: () => [process.execPath, "scripts/benchmark/probes/minimal-bun-serve.ts"],
        readiness: ({ port }) => ({ kind: "http", url: `http://127.0.0.1:${port}/` }),
    },
    {
        name: "source-backend",
        synthetic: false,
        requiresPort: true,
        processGroup: true,
        command: ({ port, dataDir }) => [
            process.execPath,
            "src/server/server.ts",
            "--host=127.0.0.1",
            `--port=${port}`,
            `--data-dir=${dataDir}`,
        ],
        readiness: ({ port }) => ({ kind: "http", url: `http://127.0.0.1:${port}/` }),
    },
    {
        name: "compiled-binary",
        synthetic: false,
        requiresPort: true,
        processGroup: true,
        command: ({ port, dataDir }) => [
            path.join(projectRoot, "iglo.monitor"),
            "--host=127.0.0.1",
            `--port=${port}`,
            `--data-dir=${dataDir}`,
        ],
        readiness: ({ port }) => ({ kind: "http", url: `http://127.0.0.1:${port}/` }),
    },
];

async function runBenchmark({
    trials = 3,
    timeoutMs = defaultTimeoutMs,
    warmupMs = defaultWarmupMs,
    variantName,
    baselineSha,
} = {}) {
    if (trials < 3) {
        throw new Error("Startup benchmark requires at least 3 trials per variant.");
    }

    assertExternalMetricsAvailable();
    const gitSha = commandOutput(["git", "rev-parse", "HEAD"]).trim();
    if (baselineSha && gitSha !== baselineSha) {
        throw new Error(`Baseline SHA mismatch: expected ${baselineSha}, running at ${gitSha}.`);
    }

    const selectedVariants = variantName ? variants.filter((variant) => variant.name === variantName) : variants;
    if (!selectedVariants.length) {
        throw new Error(`Unknown benchmark variant: ${variantName}`);
    }

    for (const variant of selectedVariants) {
        if (variant.name === "compiled-binary" && !fs.existsSync(path.join(projectRoot, "iglo.monitor"))) {
            throw new Error("Compiled benchmark variant requires ./iglo.monitor. Run `bun run build` first.");
        }
    }

    const results = [];
    for (const variant of selectedVariants) {
        const samples = [];
        for (let trial = 1; trial <= trials; trial++) {
            console.error(`${variant.name}: trial ${trial}/${trials}`);
            samples.push(
                await runTrial({
                    name: variant.name,
                    command: variant.command,
                    readiness: variant.readiness,
                    requiresPort: variant.requiresPort,
                    processGroup: variant.processGroup,
                    timeoutMs,
                    warmupMs,
                })
            );
        }
        results.push({
            name: variant.name,
            synthetic: variant.synthetic,
            trials: samples.map(({ readinessMs, rssKb, footprintBytes, synthetic, forcedKill }) => ({
                readinessMs,
                rssKb,
                footprintBytes,
                synthetic,
                forcedKill,
            })),
            median: {
                readinessMs: median(samples.map((sample) => sample.readinessMs)),
                rssKb: median(samples.map((sample) => sample.rssKb)),
                footprintBytes:
                    process.platform === "darwin" ? median(samples.map((sample) => sample.footprintBytes)) : null,
            },
        });
    }

    return {
        schema: 1,
        measuredAt: new Date().toISOString(),
        bunVersion: Bun.version,
        os: `${os.platform()} ${os.release()}`,
        arch: process.arch,
        gitSha,
        baselineSha: baselineSha || null,
        trials,
        warmupMs,
        timeoutMs,
        metrics: {
            rss: "external process RSS in KiB (macOS/Linux)",
            physicalFootprint:
                process.platform === "darwin"
                    ? "external macOS physical footprint in bytes"
                    : "unavailable (macOS only)",
        },
        note: "Application variants use external RSS/footprint and existing GET / readiness. Synthetic variants also report Bun runtime metrics; those are separate metrics and are not application measurements. Results are a single-host baseline and must not be compared across hosts.",
        variants: results,
    };
}

function getOption(name, fallback) {
    const value = process.argv.find((arg) => arg.startsWith(`--${name}=`));
    return value ? value.slice(name.length + 3) : fallback;
}

async function main() {
    const baselineSha = getOption("baseline-sha", "");
    const report = await runBenchmark({
        trials: Number(getOption("trials", 3)),
        timeoutMs: Number(getOption("timeout-ms", defaultTimeoutMs)),
        warmupMs: Number(getOption("warmup-ms", defaultWarmupMs)),
        variantName: getOption("variant", ""),
        baselineSha,
    });
    const requestedOutfile = getOption("outfile", "");
    const outfile = requestedOutfile || `docs/perf/bun-startup-memory-${report.gitSha.slice(0, 12)}.json`;
    const absoluteOutfile = path.resolve(projectRoot, outfile);
    const baselineOutfile = path.resolve(projectRoot, "docs/perf/bun-startup-memory-baseline.json");
    if (absoluteOutfile === baselineOutfile) {
        if (!baselineSha) {
            throw new Error("Refusing to overwrite the baseline report without --baseline-sha=<current checkout SHA>.");
        }
        if (fs.existsSync(baselineOutfile)) {
            const recordedBaseline = JSON.parse(fs.readFileSync(baselineOutfile, "utf8"));
            if (recordedBaseline.gitSha !== baselineSha) {
                throw new Error(`Baseline report is bound to ${recordedBaseline.gitSha}, not ${baselineSha}.`);
            }
        }
    }
    fs.mkdirSync(path.dirname(absoluteOutfile), { recursive: true });
    fs.writeFileSync(absoluteOutfile, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
}

export {
    assertExternalMetricsAvailable,
    median,
    parseFootprintBytes,
    parseReadyLine,
    parseRssKb,
    readExternalMetrics,
    runTrial,
    stopProcess,
    variants,
};

if (import.meta.main) {
    await main();
}
