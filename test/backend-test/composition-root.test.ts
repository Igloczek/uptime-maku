// @ts-nocheck

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import "@/server/model-registry";
import { HeartbeatDataPlane } from "@/server/heartbeat-data-plane";
import StatusPage from "@/server/model/status_page";
import { IgloMonitorServer } from "@/server/iglo-monitor-server";
import { BunSQLiteRedbean } from "@/server/sqlite-core";
import { Settings } from "@/server/settings";
import { UP } from "@/constants";
import { createResponseCache } from "@/server/bun-response";

const runtimes = [];

async function createRuntime(name, timezone, trustProxy) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `iglo-monitor-composition-${name}-`));
    const store = new BunSQLiteRedbean();
    await store.connect({
        sqlitePath: path.join(directory, "kuma.db"),
        templatePath: path.join(process.cwd(), "src/db/kuma.db"),
        testMode: true,
    });
    const settings = new Settings(store);
    const server = new IgloMonitorServer(store, settings);
    const heartbeatData = new HeartbeatDataPlane(store);
    const responseCache = createResponseCache();
    const emissions = [];
    const scheduled = [];
    server.environmentTimezone = undefined;
    server.jwtSecret = `${name}-jwt`;
    server.io = {
        to(room) {
            return {
                emit(event, payload) {
                    emissions.push({ room, event, payload });
                },
            };
        },
    };

    await store.exec("INSERT INTO user (id, username, active) VALUES (1, ?, 1)", [`${name}-user`]);
    await store.exec(
        "INSERT INTO monitor (id, name, user_id, active, interval, type, conditions, kafka_producer_brokers, kafka_producer_sasl_options, rabbitmq_nodes) VALUES (1, ?, 1, 1, 60, 'push', '[]', '[]', '{}', '[]')",
        [`${name}-monitor`]
    );
    await store.exec(
        "INSERT INTO maintenance (id, title, description, user_id, active, strategy, start_time, end_time, weekdays, days_of_month, timezone, duration) VALUES (1, ?, '', 1, 0, 'manual', '00:00', '00:00', '[]', '[]', 'SAME_AS_SERVER', 0)",
        [`${name}-maintenance`]
    );
    await store.exec("INSERT INTO status_page (id, slug, title, icon, theme) VALUES (1, ?, ?, '/icon.svg', 'light')", [
        `${name}-status`,
        `${name}-status`,
    ]);
    await settings.set("serverTimezone", timezone, "general");
    await settings.set("trustProxy", trustProxy, "general");
    await settings.set("primaryBaseURL", `https://${name}.example`, "general");
    await settings.set("apiKey", `${name}-token`, "general");

    const runtime = { directory, emissions, heartbeatData, name, responseCache, scheduled, server, settings, store };
    runtimes.push(runtime);
    return runtime;
}

async function disposeRuntime(runtime) {
    runtime.settings.stopCacheCleaner();
    if (runtime.store.isOpen()) {
        await runtime.store.close();
    }
    fs.rmSync(runtime.directory, { recursive: true, force: true });
}

afterEach(async () => {
    for (const runtime of runtimes.splice(0)) {
        await disposeRuntime(runtime);
    }
});

describe("explicit composition root", () => {
    test("fresh processes import the store, registry, models, and scheduler boundaries in any order", () => {
        const modules = [
            "src/server/sqlite-core.ts",
            "src/server/model-registry.ts",
            "src/server/model/monitor.ts",
            "src/server/model/domain_expiry.ts",
            "src/server/jobs.ts",
        ].map((modulePath) => pathToFileURL(path.join(process.cwd(), modulePath)).href);
        const orders = [modules, [...modules].reverse(), [modules[3], modules[0], modules[4], modules[2], modules[1]]];

        for (const order of orders) {
            const imports = order.map((modulePath) => `await import(${JSON.stringify(modulePath)});`).join("");
            const result = Bun.spawnSync([process.execPath, "-e", imports]);
            expect(new TextDecoder().decode(result.stderr)).toBe("");
            expect(result.exitCode).toBe(0);
        }
    });

    test("two real runtimes keep settings, models, data planes, registries, and emissions isolated", async () => {
        const first = await createRuntime("first", "UTC", false);
        const second = await createRuntime("second", "Asia/Tokyo", true);

        expect(await Promise.all([first.server.getTimezone(), second.server.getTimezone()])).toEqual([
            "UTC",
            "Asia/Tokyo",
        ]);
        expect(await Promise.all([first.settings.get("trustProxy"), second.settings.get("trustProxy")])).toEqual([
            false,
            true,
        ]);
        expect(
            await Promise.all([first.settings.get("primaryBaseURL"), second.settings.get("primaryBaseURL")])
        ).toEqual(["https://first.example", "https://second.example"]);

        const firstBeat = first.store.dispense("heartbeat");
        Object.assign(firstBeat, {
            monitor_id: 1,
            status: UP,
            msg: "first-heartbeat",
            time: first.store.isoDateTimeMillis(new Date("2026-01-01T00:00:00Z")),
            ping: 11,
            duration: 60,
            important: 1,
            retries: 0,
        });
        const secondBeat = second.store.dispense("heartbeat");
        Object.assign(secondBeat, {
            monitor_id: 1,
            status: UP,
            msg: "second-heartbeat",
            time: second.store.isoDateTimeMillis(new Date("2026-01-01T00:00:00Z")),
            ping: 22,
            duration: 60,
            important: 1,
            retries: 0,
        });
        await Promise.all([first.heartbeatData.write(firstBeat), second.heartbeatData.write(secondBeat)]);
        expect((await first.heartbeatData.latest(1)).msg).toBe("first-heartbeat");
        expect((await second.heartbeatData.latest(1)).msg).toBe("second-heartbeat");
        expect((await first.heartbeatData.stats(1)).day.avgPing).toBe(11);
        expect((await second.heartbeatData.stats(1)).day.avgPing).toBe(22);

        const firstMonitor = await first.store.load("monitor", 1);
        const secondMonitor = await second.store.load("monitor", 1);
        firstMonitor.scheduleHeartbeat = (_callback, delay) => first.scheduled.push(delay);
        secondMonitor.scheduleHeartbeat = (_callback, delay) => second.scheduled.push(delay);
        await Promise.all([
            firstMonitor.start(first.server.io, first.heartbeatData, first.server, undefined, first.responseCache),
            secondMonitor.start(second.server.io, second.heartbeatData, second.server, undefined, second.responseCache),
        ]);
        expect(first.scheduled).toEqual([60_000]);
        expect(second.scheduled).toEqual([60_000]);

        await Promise.all([
            first.server.loadMaintenanceList(first.responseCache),
            second.server.loadMaintenanceList(second.responseCache),
        ]);
        await Promise.all([
            first.server.sendMonitorList({ userID: 1 }),
            second.server.sendMonitorList({ userID: 1 }),
            first.server.sendMaintenanceListByUserID(1),
            second.server.sendMaintenanceListByUserID(1),
            StatusPage.sendStatusPageList(
                first.store,
                first.server.io,
                { userID: 1 },
                first.server.statusPageDomainMappingList
            ),
            StatusPage.sendStatusPageList(
                second.store,
                second.server.io,
                { userID: 1 },
                second.server.statusPageDomainMappingList
            ),
        ]);
        expect(JSON.stringify(first.emissions)).toContain("first-monitor");
        expect(JSON.stringify(first.emissions)).toContain("first-maintenance");
        expect(JSON.stringify(first.emissions)).toContain("first-status");
        expect(JSON.stringify(first.emissions)).not.toContain("second-");
        expect(JSON.stringify(second.emissions)).toContain("second-monitor");
        expect(JSON.stringify(second.emissions)).toContain("second-maintenance");
        expect(JSON.stringify(second.emissions)).toContain("second-status");
        expect(JSON.stringify(second.emissions)).not.toContain("first-");

        const [firstDns, secondDns, firstSmtp, secondSmtp] = await Promise.all([
            first.server.getMonitorType("dns"),
            second.server.getMonitorType("dns"),
            first.server.notificationProviderRegistry.get("smtp"),
            second.server.notificationProviderRegistry.get("smtp"),
        ]);
        expect(firstDns).not.toBe(secondDns);
        expect(firstDns.store).toBe(first.store);
        expect(secondDns.store).toBe(second.store);
        expect(firstSmtp).not.toBe(secondSmtp);
        expect(firstSmtp.settings).toBe(first.settings);
        expect(secondSmtp.settings).toBe(second.settings);
        expect(first.server.monitorRuntimeRegistry.getLoadedTypes()).toEqual(["dns"]);
        expect(second.server.monitorRuntimeRegistry.getLoadedTypes()).toEqual(["dns"]);
        expect(first.server.notificationProviderRegistry.getLoadedProviders()).toEqual(["smtp"]);
        expect(second.server.notificationProviderRegistry.getLoadedProviders()).toEqual(["smtp"]);

        first.settings.stopCacheCleaner();
        await first.store.close();
        expect(second.store.isOpen()).toBe(true);
        expect(await second.settings.get("apiKey")).toBe("second-token");
    });
});
