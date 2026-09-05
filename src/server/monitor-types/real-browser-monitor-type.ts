// @ts-nocheck

/**
 * Cached instance of a browser
 * @type {import ("playwright-core").Browser}
 */
import { MonitorType } from "@/server/monitor-types/monitor-type";
import { UP } from "@/constants";
import { log } from "@/server/logger";
import path from "path";
import Database from "@/server/database";
import jwt from "@/server/jwt";
import config from "@/server/config";
import { RemoteBrowser } from "@/server/remote-browser";
import { commandExists, runCommand, runCommandChecked } from "@/server/process-helper";
import childProcess from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";

const BROWSER_CLEANUP_GRACE_MS = 100;
const BROWSER_ACQUISITION_TIMEOUT_MS = 5_000;
const BROWSER_RETIRE_TIMEOUT_MS = BROWSER_ACQUISITION_TIMEOUT_MS + 500;
const BROWSER_TEST_TIMEOUT_MS = 30_000;
const BROWSER_GROUP_SUPERVISOR = `
trap ':' TERM HUP INT
"$@" 5>&- &
exec 3>&- 4>&-
while IFS= read -r command <&5; do
    case "$command" in
        TERM) kill -TERM -$$ 2>/dev/null || true ;;
        KILL) kill -KILL -$$ 2>/dev/null || true ;;
    esac
done
kill -KILL -$$ 2>/dev/null || exit 0
`;
const localLaunchOwner = new AsyncLocalStorage();
let chromiumPromise = null;
let spawnCapture = null;

/**
 * Lazy-load playwright-core only when a real-browser check actually runs.
 * Keeps the compiled single binary bootable without shipping playwright next to it.
 * @returns {Promise<import("playwright-core").ChromiumBrowserType>}
 */
async function getChromium() {
    if (!chromiumPromise) {
        chromiumPromise = import("playwright-core")
            .then((mod) => mod.chromium)
            .catch((error) => {
                chromiumPromise = null;
                throw new Error(`playwright-core is required for real-browser monitors: ${error.message}`);
            });
    }
    return await chromiumPromise;
}

let allowedList = [];
let lastAutoDetectChromeExecutable = null;

if (process.platform === "win32") {
    allowedList.push(process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe");
    allowedList.push(process.env.PROGRAMFILES + "\\Google\\Chrome\\Application\\chrome.exe");
    allowedList.push(process.env["ProgramFiles(x86)"] + "\\Google\\Chrome\\Application\\chrome.exe");

    // Allow Chromium too
    allowedList.push(process.env.LOCALAPPDATA + "\\Chromium\\Application\\chrome.exe");
    allowedList.push(process.env.PROGRAMFILES + "\\Chromium\\Application\\chrome.exe");
    allowedList.push(process.env["ProgramFiles(x86)"] + "\\Chromium\\Application\\chrome.exe");

    // Allow MS Edge
    allowedList.push(process.env["ProgramFiles(x86)"] + "\\Microsoft\\Edge\\Application\\msedge.exe");

    // For Loop A to Z
    for (let i = 65; i <= 90; i++) {
        let drive = String.fromCharCode(i);
        allowedList.push(drive + ":\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
        allowedList.push(drive + ":\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe");
    }
} else if (process.platform === "linux") {
    allowedList = [
        "chromium",
        "chromium-browser",
        "google-chrome",

        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
        "/snap/bin/chromium", // Ubuntu
    ];
} else if (process.platform === "darwin") {
    allowedList = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
}

/**
 * Is the executable path allowed?
 * @param {string} executablePath Path to executable
 * @returns {Promise<boolean>} The executable is allowed?
 */
async function isAllowedChromeExecutable(executablePath) {
    if (config.args["allow-all-chrome-exec"] || process.env.IGLO_MONITOR_ALLOW_ALL_CHROME_EXEC === "1") {
        return true;
    }

    // Check if the executablePath is in the list of allowed executables
    return allowedList.includes(executablePath);
}

/**
 * Get the current instance of the browser. If there isn't one, create
 * it.
 * @returns {Promise<import ("playwright-core").Browser>} The browser
 */
async function createLocalBrowser(owner, executablePath, deadline) {
    executablePath = await prepareChromeExecutable(executablePath, deadline);
    assertOwnerActive(owner, deadline);

    const chromium = await getChromium();
    assertOwnerActive(owner, deadline);
    const launchedBrowser = await launchLocalBrowser(owner, chromium, {
        executablePath,
        timeout: acquisitionTimeout(deadline),
    });
    await attachBrowser(owner, launchedBrowser, ownedBrowserProcess(launchedBrowser), deadline);
    return launchedBrowser;
}

/**
 * Get the current instance of the browser. If there isn't one, create it
 * @param {integer} remoteBrowserID Path to executable
 * @param {integer} userId User ID
 * @returns {Promise<Browser>} The browser
 */
async function createRemoteBrowser(owner, remoteBrowser, deadline) {
    log.debug("chromium", `Using remote browser: ${remoteBrowser.name} (${remoteBrowser.id})`);
    const chromium = await getChromium();
    assertOwnerActive(owner, deadline);
    const connectedBrowser = await chromium.connect(remoteBrowser.url, { timeout: acquisitionTimeout(deadline) });
    await attachBrowser(owner, connectedBrowser, null, deadline);
    return connectedBrowser;
}

function remaining(deadline) {
    const milliseconds = deadline - Date.now();
    if (milliseconds <= 0) {
        throw new Error("Browser monitor timed out");
    }
    return milliseconds;
}

function acquisitionTimeout(deadline) {
    return Math.min(remaining(deadline), BROWSER_ACQUISITION_TIMEOUT_MS);
}

function captureBrowserProcess(owner, process) {
    if (!process?.pid) {
        return;
    }
    const browserProcess = { process, retirePromise: null, exited: false };
    const finished = () => {
        browserProcess.exited = true;
        owner.acquiredProcesses.delete(browserProcess);
    };
    process.once?.("exit", finished);
    process.once?.("close", finished);
    process.stdio?.[5]?.on?.("error", () => {});
    owner.acquiredProcesses.add(browserProcess);
    if (childProcessHasExited(process)) {
        finished();
    }
    if (owner.invalidated) {
        void retireCapturedProcess(browserProcess).catch((error) => log.error("chromium", error));
    }
}

function startSpawnCapture() {
    if (spawnCapture) {
        spawnCapture.users++;
        return;
    }
    const original = childProcess.spawn;
    const patched = function (...args) {
        const owner = localLaunchOwner.getStore();
        const processArgs = args[1];
        const options = args[2];
        const capturesBrowser =
            owner &&
            options?.detached === (globalThis.process.platform !== "win32") &&
            Array.isArray(processArgs) &&
            processArgs.includes("--remote-debugging-pipe");
        if (capturesBrowser && globalThis.process.platform !== "win32") {
            const stdio = Array.isArray(options.stdio)
                ? [...options.stdio]
                : Array.from({ length: 5 }, () => options.stdio ?? "pipe");
            stdio[5] = "pipe";
            args = [
                "/bin/sh",
                ["-c", BROWSER_GROUP_SUPERVISOR, "iglo-monitor-browser-supervisor", args[0], ...processArgs],
                { ...options, stdio },
            ];
        }
        const process = original.apply(this, args);
        if (capturesBrowser) {
            captureBrowserProcess(owner, process);
        }
        return process;
    };
    childProcess.spawn = patched;
    spawnCapture = { original, patched, users: 1 };
}

function stopSpawnCapture() {
    if (!spawnCapture || --spawnCapture.users > 0) {
        return;
    }
    if (childProcess.spawn === spawnCapture.patched) {
        childProcess.spawn = spawnCapture.original;
    }
    spawnCapture = null;
}

async function launchLocalBrowser(owner, chromium, options) {
    startSpawnCapture();
    try {
        return await localLaunchOwner.run(owner, () => chromium.launch(options));
    } finally {
        stopSpawnCapture();
    }
}

function assertOwnerActive(owner, deadline) {
    if (owner.invalidated) {
        throw owner.reason;
    }
    remaining(deadline);
}

function forceDisconnect(browser, reason) {
    try {
        // Playwright 1.61 has no public remote-disconnect API. Keep this isolated while the dependency is exactly pinned.
        browser?._connection?.close?.(reason);
    } catch {}
}

function ownedBrowserProcess(browser) {
    try {
        // Bun cannot pass Playwright's required headers through BrowserType.connect(), so launchServer() is unusable.
        // This is the single version-pinned Playwright 1.61 adapter that exposes the locally owned process for SIGKILL.
        return browser?._connection?.toImpl?.(browser)?.options?.browserProcess ?? null;
    } catch {
        return null;
    }
}

async function attachBrowser(owner, browser, browserProcess, deadline) {
    if (owner.invalidated || deadline <= Date.now()) {
        await disposeBrowser(browser, browserProcess, owner.reason ?? new Error("Browser monitor timed out"), owner);
        throw owner.reason ?? new Error("Browser monitor timed out");
    }
    owner.browser = browser;
    owner.browserProcess = browserProcess;
}

function capturedProcessIsLive(browserProcess) {
    const process = browserProcess.process;
    return Boolean(process?.pid && !browserProcess.exited && process.exitCode === null && process.signalCode === null);
}

function childProcessHasExited(process) {
    return Boolean(
        process &&
        ((process.exitCode !== null && process.exitCode !== undefined) ||
            (process.signalCode !== null && process.signalCode !== undefined))
    );
}

async function signalCapturedProcess(browserProcess, signal) {
    if (!capturedProcessIsLive(browserProcess)) {
        return false;
    }
    try {
        if (globalThis.process.platform === "win32") {
            return browserProcess.process.kill(signal);
        }
        const control = browserProcess.process.stdio?.[5];
        if (!control?.writable || control.destroyed || control.writableEnded) {
            return false;
        }
        return await new Promise((resolve) => {
            control.write(`${signal === "SIGTERM" ? "TERM" : "KILL"}\n`, (error) => resolve(!error));
        });
    } catch {
        return false;
    }
}

async function waitForCapturedProcess(browserProcess, timeout) {
    const deadline = Date.now() + timeout;
    while (capturedProcessIsLive(browserProcess) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return !capturedProcessIsLive(browserProcess);
}

async function retireCapturedProcess(browserProcess) {
    if (browserProcess.retirePromise) {
        return await browserProcess.retirePromise;
    }
    browserProcess.retirePromise = (async () => {
        const pid = browserProcess.process?.pid;
        if (!pid || !capturedProcessIsLive(browserProcess)) {
            return;
        }
        if (!(await signalCapturedProcess(browserProcess, "SIGTERM"))) {
            if (!capturedProcessIsLive(browserProcess)) {
                return;
            }
            throw new Error(`Chromium process group ${pid} has no owned control channel`);
        }
        if (await waitForCapturedProcess(browserProcess, BROWSER_CLEANUP_GRACE_MS)) {
            return;
        }
        if (!(await signalCapturedProcess(browserProcess, "SIGKILL"))) {
            if (!capturedProcessIsLive(browserProcess)) {
                return;
            }
            throw new Error(`Chromium process group ${pid} lost its owned control channel`);
        }
        if (!(await waitForCapturedProcess(browserProcess, BROWSER_CLEANUP_GRACE_MS * 5))) {
            throw new Error(`Chromium process group ${pid} did not exit after SIGKILL`);
        }
    })();
    return await browserProcess.retirePromise;
}

async function bounded(promise, timeout = BROWSER_CLEANUP_GRACE_MS) {
    let timer;
    try {
        return await Promise.race([
            Promise.resolve(promise).then(
                () => true,
                () => false
            ),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(false), timeout);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function invalidateBrowser(owner, reason = new Error("Browser monitor cancelled")) {
    if (!owner) {
        return;
    }
    owner.invalidated = true;
    owner.reason ??= reason;
    owner.abortController.abort(owner.reason);
    if (owner.owners.get(owner.key) === owner) {
        owner.owners.delete(owner.key);
    }
    if (owner.closePromise) {
        return await owner.closePromise;
    }

    owner.closePromise = retireBrowserOwner(owner);
    return await owner.closePromise;
}

async function retireBrowserOwner(owner) {
    const browser = owner.browser;
    const browserProcess = owner.browserProcess;
    owner.browser = null;
    owner.browserProcess = null;
    await disposeBrowser(browser, browserProcess, owner.reason, owner);
    await Promise.all(Array.from(owner.acquiredProcesses, retireCapturedProcess));
    if (
        !(await bounded(
            owner.acquisition.catch(() => {}),
            BROWSER_RETIRE_TIMEOUT_MS
        ))
    ) {
        throw new Error("Browser acquisition did not retire within 5.5 seconds");
    }
    await Promise.all(Array.from(owner.acquiredProcesses, retireCapturedProcess));
}

async function disposeBrowser(browser, browserProcess, reason, owner) {
    if (!browser) {
        return;
    }
    let closePromise;
    try {
        closePromise = browser.close({ reason: reason.message });
    } catch {}
    let closed = await bounded(closePromise);
    if (!closed && owner?.acquiredProcesses.size) {
        await Promise.all(Array.from(owner.acquiredProcesses, retireCapturedProcess));
        closed = await bounded(closePromise, BROWSER_CLEANUP_GRACE_MS * 5);
    }
    if (!closed && browserProcess) {
        let killed = false;
        const child = browserProcess.process;
        if (childProcessHasExited(child)) {
            killed = true;
        } else if (globalThis.process.platform === "win32") {
            try {
                killed = await bounded(browserProcess.kill());
            } catch {}
        }
        if (!killed) {
            // The captured POSIX supervisor owns descendant cleanup. A direct PID retry could target a reused PID.
            if (globalThis.process.platform === "win32" && child && !childProcessHasExited(child)) {
                try {
                    child.kill("SIGKILL");
                    await bounded(new Promise((resolve) => child.once("exit", resolve)));
                } catch {}
            }
        }
    }
    if (!closed) {
        forceDisconnect(browser, reason.message);
    }
}

function newBrowserOwner(owners, key, create) {
    const owner = {
        owners,
        key,
        browser: null,
        browserProcess: null,
        closePromise: null,
        invalidated: false,
        reason: null,
        acquisition: null,
        acquiredProcesses: new Set(),
        ready: null,
        abortController: new AbortController(),
    };
    owners.set(key, owner);
    owner.acquisition = Promise.resolve().then(() => create(owner));
    owner.ready = owner.acquisition;
    owner.acquisition.catch((error) => invalidateBrowser(owner, error)).catch(() => {});
    return owner;
}

async function getBrowserOwner(owners, key, create, signal) {
    let owner = owners.get(key);
    if (owner?.invalidated || (owner?.browser && !owner.browser.isConnected())) {
        await invalidateBrowser(owner, new Error("Browser disconnected"));
        owner = null;
    }
    owner ??= newBrowserOwner(owners, key, create);
    const combinedSignal = AbortSignal.any([signal, owner.abortController.signal]);
    await cancellable(owner.ready, combinedSignal, () => invalidateBrowser(owner, combinedSignal.reason));
    return owner;
}

async function cancellable(promise, signal, cancel, lateValue) {
    if (signal.aborted) {
        await cancel();
        throw signal.reason;
    }
    let abort;
    const aborted = new Promise((_, reject) => {
        abort = () => {
            Promise.resolve(cancel()).then(
                () => reject(signal.reason),
                () => reject(signal.reason)
            );
        };
        signal.addEventListener("abort", abort, { once: true });
    });
    promise
        .then(
            (value) => {
                if (signal.aborted) {
                    return lateValue?.(value);
                }
            },
            () => {}
        )
        .catch(() => {});
    try {
        return await Promise.race([promise, aborted]);
    } finally {
        signal.removeEventListener("abort", abort);
    }
}

/**
 * Prepare the chrome executable path
 * @param {string} executablePath Path to chrome executable
 * @returns {Promise<string>} Executable path
 */
async function prepareChromeExecutable(executablePath, deadline = Date.now() + BROWSER_TEST_TIMEOUT_MS) {
    // Special code for using the playwright_chromium
    if (typeof executablePath === "string" && executablePath.toLocaleLowerCase() === "#playwright_chromium") {
        // Set to undefined = use playwright_chromium
        executablePath = undefined;
    } else if (!executablePath) {
        if (process.env.IGLO_MONITOR_IS_CONTAINER) {
            executablePath = "/usr/bin/chromium";
            await installChromiumViaApt(executablePath, deadline);
        } else {
            executablePath = await findChrome(allowedList, deadline);
        }
    } else {
        // User specified a path
        // Check if the executablePath is in the list of allowed
        if (!(await isAllowedChromeExecutable(executablePath))) {
            throw new Error(
                "This Chromium executable path is not allowed by default. If you are sure this is safe, please add an environment variable IGLO_MONITOR_ALLOW_ALL_CHROME_EXEC=1 to allow it."
            );
        }
    }
    return executablePath;
}

/**
 * Installs Chromium and required font packages via APT if the Chromium executable
 * is not already available.
 * @async
 * @param {string} executablePath - Path to the Chromium executable used to check
 * whether Chromium is available and to query its version after installation.
 * @returns {Promise<void>} Resolves when Chromium is successfully installed or
 * when no installation is required.
 * @throws {Error} If the APT installation fails or exits with an unexpected
 * exit code.
 */
async function installChromiumViaApt(executablePath, deadline) {
    if (await commandExists(executablePath, remaining(deadline))) {
        return;
    }
    log.info("chromium", "Installing Chromium...");
    const result = await runCommand(
        "sh",
        [
            "-c",
            "apt update && apt --yes --no-install-recommends install chromium fonts-indic fonts-noto fonts-noto-cjk",
        ],
        { timeout: remaining(deadline) }
    );

    log.info("chromium", "apt install chromium exited with code " + result.code);

    if (result.code === 0) {
        log.info("chromium", "Installed Chromium");
        let version = (await runCommandChecked(executablePath, ["--version"], { timeout: remaining(deadline) })).stdout;
        log.info("chromium", "Chromium version: " + version);
    } else if (result.code === 100) {
        throw new Error("Installing Chromium, please wait...");
    } else {
        throw new Error("apt install chromium failed with code " + result.code);
    }
}

/**
 * Find the chrome executable
 * @param {string[]} executables Executables to search through
 * @returns {Promise<string>} Executable
 * @throws {Error} Could not find executable
 */
async function findChrome(executables, deadline = Date.now() + BROWSER_TEST_TIMEOUT_MS) {
    // Use the last working executable, so we don't have to search for it again
    if (lastAutoDetectChromeExecutable) {
        if (await commandExists(lastAutoDetectChromeExecutable, remaining(deadline))) {
            return lastAutoDetectChromeExecutable;
        }
    }

    for (let executable of executables) {
        if (await commandExists(executable, remaining(deadline))) {
            lastAutoDetectChromeExecutable = executable;
            return executable;
        }
    }
    throw new Error("Chromium not found, please specify Chromium executable path in the settings page.");
}

/**
 * Reset chrome
 * @returns {Promise<void>}
 */
async function resetChrome(browserOwners) {
    await Promise.all(
        Array.from(browserOwners.values(), (owner) => invalidateBrowser(owner, new Error("Browser reset requested")))
    );
}

async function resetRemoteBrowser(browserOwners, remoteBrowserID, userID) {
    const prefix = `remote:${userID}:${remoteBrowserID}:`;
    await Promise.all(
        Array.from(browserOwners, ([key, owner]) =>
            key.startsWith(prefix) ? invalidateBrowser(owner, new Error("Remote browser reset requested")) : undefined
        )
    );
}

/**
 * Test if the chrome executable is valid and return the version
 * @param {string} executablePath Path to executable
 * @returns {Promise<string>} Chrome version
 */
async function testChrome(browserOwners, executablePath) {
    const deadline = Date.now() + BROWSER_TEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Chromium test timed out")), BROWSER_TEST_TIMEOUT_MS);
    const owner = newBrowserOwner(browserOwners, `test-local:${crypto.randomUUID()}`, async (candidate) => {
        executablePath = await prepareChromeExecutable(executablePath, deadline);
        const chromium = await getChromium();
        assertOwnerActive(candidate, deadline);
        const launchedBrowser = await launchLocalBrowser(candidate, chromium, {
            executablePath,
            timeout: acquisitionTimeout(deadline),
        });
        await attachBrowser(candidate, launchedBrowser, ownedBrowserProcess(launchedBrowser), deadline);
        return launchedBrowser;
    });
    try {
        log.info("chromium", "Testing Chromium executable: " + executablePath);
        const launchedBrowser = await cancellable(owner.ready, controller.signal, () =>
            invalidateBrowser(owner, controller.signal.reason)
        );
        const version = launchedBrowser.version();
        return version;
    } catch (e) {
        throw new Error(e.message);
    } finally {
        clearTimeout(timer);
        await invalidateBrowser(owner, new Error("Chromium test complete"));
    }
}
// test remote browser
/**
 * @param {string} remoteBrowserURL Remote Browser URL
 * @returns {Promise<boolean>} Returns if connection worked
 */
async function testRemoteBrowser(browserOwners, remoteBrowserURL) {
    const deadline = Date.now() + BROWSER_TEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(
        () => controller.abort(new Error("Remote browser test timed out")),
        BROWSER_TEST_TIMEOUT_MS
    );
    const owner = newBrowserOwner(browserOwners, `test-remote:${crypto.randomUUID()}`, async (candidate) => {
        const chromium = await getChromium();
        assertOwnerActive(candidate, deadline);
        const connectedBrowser = await chromium.connect(remoteBrowserURL, { timeout: acquisitionTimeout(deadline) });
        await attachBrowser(candidate, connectedBrowser, null, deadline);
        return connectedBrowser;
    });
    try {
        const connectedBrowser = await cancellable(owner.ready, controller.signal, () =>
            invalidateBrowser(owner, controller.signal.reason)
        );
        connectedBrowser.version();
        return true;
    } catch (e) {
        throw new Error(e.message);
    } finally {
        clearTimeout(timer);
        await invalidateBrowser(owner, new Error("Remote browser test complete"));
    }
}
class RealBrowserMonitorType extends MonitorType {
    name = "real-browser";

    constructor(store, settings) {
        super();
        this.store = store;
        this.settings = settings;
        this.browserOwners = new Map();
    }

    resetChrome() {
        return resetChrome(this.browserOwners);
    }

    resetRemoteBrowser(remoteBrowserID, userID) {
        return resetRemoteBrowser(this.browserOwners, remoteBrowserID, userID);
    }

    testChrome(executablePath) {
        return testChrome(this.browserOwners, executablePath);
    }

    testRemoteBrowser(remoteBrowserURL) {
        return testRemoteBrowser(this.browserOwners, remoteBrowserURL);
    }

    /**
     * @inheritdoc
     */
    async check(monitor, heartbeat, server) {
        const configuredTimeout = monitor.getEffectiveTimeout?.() ?? Number(monitor.timeout);
        const timeout = (Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 20) * 1000;
        const deadline = Date.now() + timeout;
        const controller = new AbortController();
        const deadlineTimer = setTimeout(
            () => controller.abort(new Error("Browser monitor timed out")),
            Math.max(1, timeout)
        );
        const heartbeatSignal = monitor.activeHeartbeatAbortController?.signal;
        const stop = () => controller.abort(heartbeatSignal.reason ?? new Error("Browser monitor stopped"));
        heartbeatSignal?.addEventListener("abort", stop, { once: true });
        let owner;
        let ownerInvalidated;
        let context;
        let success;
        try {
            // Prevent Local File Inclusion
            // Accept only http:// and https://
            // https://github.com/louislam/uptime-kuma/security/advisories/GHSA-2qgm-m29m-cj2h
            let url = new URL(monitor.url);
            if (url.protocol !== "http:" && url.protocol !== "https:") {
                throw new Error("Invalid url protocol, only http and https are allowed.");
            }

            if (monitor.remote_browser) {
                const remoteBrowser = await cancellable(
                    RemoteBrowser.get(this.store, monitor.remote_browser, monitor.user_id),
                    controller.signal,
                    async () => {}
                );
                const prefix = `remote:${monitor.user_id}:${monitor.remote_browser}:`;
                const key = prefix + remoteBrowser.url;
                for (const [existingKey, existingOwner] of this.browserOwners) {
                    if (existingKey.startsWith(prefix) && existingKey !== key) {
                        await invalidateBrowser(existingOwner, new Error("Remote browser configuration changed"));
                    }
                }
                owner = await getBrowserOwner(
                    this.browserOwners,
                    key,
                    (candidate) => createRemoteBrowser(candidate, remoteBrowser, deadline),
                    controller.signal
                );
            } else {
                const executablePath = await cancellable(
                    this.settings.get("chromeExecutable"),
                    controller.signal,
                    async () => {}
                );
                const key = `local:${JSON.stringify(executablePath ?? null)}`;
                for (const [existingKey, existingOwner] of this.browserOwners) {
                    if (existingKey.startsWith("local:") && existingKey !== key) {
                        await invalidateBrowser(existingOwner, new Error("Chrome executable changed"));
                    }
                }
                owner = await getBrowserOwner(
                    this.browserOwners,
                    key,
                    (candidate) => createLocalBrowser(candidate, executablePath, deadline),
                    controller.signal
                );
            }
            ownerInvalidated = () => controller.abort(owner.reason);
            owner.abortController.signal.addEventListener("abort", ownerInvalidated, { once: true });
            if (owner.invalidated) {
                ownerInvalidated();
            }

            context = await cancellable(
                owner.browser.newContext(),
                controller.signal,
                () => invalidateBrowser(owner, controller.signal.reason),
                (lateContext) => lateContext.close().catch(() => {})
            );
            const page = await cancellable(context.newPage(), controller.signal, () =>
                invalidateBrowser(owner, controller.signal.reason)
            );
            page.setDefaultTimeout(remaining(deadline));

            const res = await cancellable(
                page.goto(monitor.url, {
                    waitUntil: "networkidle",
                    timeout: remaining(deadline),
                }),
                controller.signal,
                () => invalidateBrowser(owner, controller.signal.reason)
            );

            // Wait for additional time before taking screenshot if configured
            if (monitor.screenshot_delay > 0) {
                const remainingTime = remaining(deadline);
                await cancellable(
                    page.waitForTimeout(Math.min(monitor.screenshot_delay, remainingTime)),
                    controller.signal,
                    () => invalidateBrowser(owner, controller.signal.reason)
                );
                if (monitor.screenshot_delay >= remainingTime) {
                    throw new Error("Browser monitor timed out before screenshot");
                }
            }

            let filename = jwt.sign(monitor.id, server.jwtSecret) + ".png";

            await cancellable(
                page.screenshot({
                    path: path.join(Database.screenshotDir, filename),
                    timeout: remaining(deadline),
                }),
                controller.signal,
                () => invalidateBrowser(owner, controller.signal.reason)
            );

            if (controller.signal.aborted) {
                throw controller.signal.reason;
            }

            if (res.status() >= 200 && res.status() < 400) {
                const timing = res.request().timing();
                success = { status: UP, msg: res.status(), ping: timing.responseEnd };
            } else {
                throw new Error(res.status() + "");
            }
        } finally {
            try {
                if (context) {
                    await cancellable(context.close(), controller.signal, () =>
                        invalidateBrowser(owner, controller.signal.reason)
                    );
                }
            } finally {
                clearTimeout(deadlineTimer);
                owner?.abortController.signal.removeEventListener("abort", ownerInvalidated);
                heartbeatSignal?.removeEventListener("abort", stop);
            }
        }
        if (controller.signal.aborted) {
            throw controller.signal.reason;
        }
        Object.assign(heartbeat, success);
    }
}

export { RealBrowserMonitorType };
