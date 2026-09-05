// @ts-nocheck

import httpClient from "@/server/http-client";
import { log } from "@/server/logger";
import packageJson from "@/package-meta";

export const version = packageJson.version;

const UPDATE_CHECKER_INTERVAL_MS = 1000 * 60 * 60 * 48;
const UPDATE_CHECKER_LATEST_VERSION_URL = "https://api.github.com/repos/iglo-tech/iglo.monitor/releases/latest";

export function createVersionChecker(settings) {
    let latestVersion = null;
    let interval = null;

    const check = async () => {
        if ((await settings.get("checkUpdate")) === false) {
            return;
        }

        log.debug("update-checker", "Retrieving latest versions");
        try {
            const res = await httpClient.get(UPDATE_CHECKER_LATEST_VERSION_URL);
            if (process.env.TEST_CHECK_VERSION === "1") {
                res.data.tag_name = "v1000.0.0";
            }
            if (typeof res.data?.tag_name === "string") {
                latestVersion = res.data.tag_name.replace(/^v/, "");
            }
        } catch (_) {
            log.info("update-checker", "Failed to check for new versions");
        }
    };

    return {
        version,
        get latestVersion() {
            return latestVersion;
        },
        start() {
            check();
            interval = setInterval(check, UPDATE_CHECKER_INTERVAL_MS);
        },
        async enable(value) {
            await settings.set("checkUpdate", value);
            clearInterval(interval);
            interval = null;
            if (value) {
                this.start();
            }
        },
        stop() {
            clearInterval(interval);
            interval = null;
        },
    };
}
