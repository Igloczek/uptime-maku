// @ts-nocheck

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "@/server/model-registry";
import { HeartbeatDataPlane } from "@/server/heartbeat-data-plane";
import DomainExpiry from "@/server/model/domain_expiry";
import { MonitorRuntimeRegistry } from "@/server/monitor-runtime-registry";
import { NotificationProviderRegistry } from "@/server/notification-provider-registry";
import { UptimeMakuServer } from "@/server/uptime-maku-server";
import { Prometheus } from "@/server/prometheus";
import { handleApiRequest } from "@/server/routers/api-router";
import { BunSQLiteRedbean } from "@/server/sqlite-core";
import { Settings } from "@/server/settings";
import { checkCertExpiryNotifications } from "@/server/tls-cert";
import { UP } from "@/constants";
import { createResponseCache } from "@/server/bun-response";

const resources = [];
const mocks = [];
const originalPrometheusUpdate = Prometheus.prototype.update;

dayjs.extend(utc);
dayjs.extend(timezone);

async function createRuntime(name, type = "owned") {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `uptime-maku-registry-${name}-`));
    const store = new BunSQLiteRedbean();
    await store.connect({
        sqlitePath: path.join(directory, "kuma.db"),
        templatePath: path.join(process.cwd(), "out/kuma.db"),
        testMode: true,
    });
    await store.exec("INSERT INTO user (id, username, active) VALUES (1, ?, 1)", [`${name}-owner`]);
    await store.exec("INSERT INTO monitor (id, name, user_id, active, interval, type) VALUES (1, ?, 1, 1, 60, ?)", [
        `${name}-monitor`,
        type,
    ]);
    const heartbeatData = new HeartbeatDataPlane(store);
    const responseCache = createResponseCache();
    const settings = new Settings(store);
    resources.push({ directory, settings, store });
    return { heartbeatData, responseCache, settings, store };
}

function createServer(owner, store, settings, monitorInstances = [], sends = []) {
    const server = new UptimeMakuServer(store, settings);
    server.monitorRuntimeRegistry = new MonitorRuntimeRegistry(server, {
        owned: {
            load: async () => {
                const instance = {
                    owner,
                    check(_monitor, heartbeat) {
                        heartbeat.status = UP;
                        heartbeat.msg = owner;
                    },
                };
                monitorInstances.push(instance);
                return instance;
            },
        },
    });
    server.monitorTypeList = server.monitorRuntimeRegistry.monitorTypeList;
    const provider = (name) => () => ({
        default: class {
            name = name;
            send() {
                sends.push({ owner, name });
                return "sent";
            }
        },
    });
    server.notificationProviderRegistry = new NotificationProviderRegistry(settings, {
        domain: provider("domain"),
        normal: provider("normal"),
        cert: provider("cert"),
    });
    server.io = {
        rooms: new Map(),
        to: () => ({ emit() {} }),
    };
    server.getTimezone = async () => "UTC";
    server.getTimezoneOffset = () => "+00:00";
    server.sendMaintenanceListByUserID = async () => {};
    return server;
}

afterEach(async () => {
    Prometheus.prototype.update = originalPrometheusUpdate;
    for (const mock of mocks.splice(0)) {
        mock.mockRestore();
    }
    for (const { directory, settings, store } of resources.splice(0)) {
        settings.stopCacheCleaner();
        await store.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe("runtime registry production call sites", () => {
    test("parallel scheduler checks use their own monitor and domain provider owners", async () => {
        Prometheus.prototype.update = () => {};
        const firstInstances = [];
        const secondInstances = [];
        const firstRuntime = await createRuntime("first");
        const secondRuntime = await createRuntime("second");
        const first = createServer("first", firstRuntime.store, firstRuntime.settings, firstInstances);
        const second = createServer("second", secondRuntime.store, secondRuntime.settings, secondInstances);
        await Promise.all([
            firstRuntime.store.exec("UPDATE monitor SET domain_expiry_notification = 1 WHERE id = 1"),
            secondRuntime.store.exec("UPDATE monitor SET domain_expiry_notification = 1 WHERE id = 1"),
        ]);

        mocks.push(spyOn(DomainExpiry, "checkSupport").mockResolvedValue({ domain: "example.com" }));
        mocks.push(spyOn(DomainExpiry, "checkExpiry").mockResolvedValue(new Date("2030-01-01T00:00:00Z")));
        const domainLoads = [];
        mocks.push(
            spyOn(DomainExpiry, "sendNotifications").mockImplementation((registry) => {
                const load = registry.get("domain");
                domainLoads.push(load);
                return load;
            })
        );

        const firstMonitor = await firstRuntime.store.load("monitor", 1);
        const secondMonitor = await secondRuntime.store.load("monitor", 1);
        firstMonitor.scheduleHeartbeat = () => {};
        secondMonitor.scheduleHeartbeat = () => {};
        await Promise.all([
            firstMonitor.start(first.io, firstRuntime.heartbeatData, first, undefined, firstRuntime.responseCache),
            secondMonitor.start(second.io, secondRuntime.heartbeatData, second, undefined, secondRuntime.responseCache),
        ]);
        await Promise.all([firstMonitor.activeHeartbeat, secondMonitor.activeHeartbeat].filter(Boolean));
        await Promise.all(domainLoads);

        expect(first.monitorRuntimeRegistry.getLoadedTypes()).toEqual(["owned"]);
        expect(second.monitorRuntimeRegistry.getLoadedTypes()).toEqual(["owned"]);
        expect(firstInstances).toHaveLength(1);
        expect(secondInstances).toHaveLength(1);
        expect(firstInstances[0]).not.toBe(secondInstances[0]);
        expect(first.notificationProviderRegistry.getLoadedProviders()).toEqual(["domain"]);
        expect(second.notificationProviderRegistry.getLoadedProviders()).toEqual(["domain"]);
    });

    test("API push and certificate notifications resolve providers from the passed runtime", async () => {
        const sends = [];
        const { heartbeatData, settings, store } = await createRuntime("notifications", "push");
        const runtimeServer = createServer("runtime", store, settings, [], sends);
        Prometheus.prototype.update = () => {};
        await store.exec(
            "UPDATE monitor SET push_token = 'owner-token', maxretries = 0, kafka_producer_brokers = '[]', rabbitmq_nodes = '[]', conditions = '[]' WHERE id = 1"
        );
        await store.exec("INSERT INTO notification (id, name, user_id, config) VALUES (1, 'normal', 1, ?)", [
            JSON.stringify({ type: "normal" }),
        ]);
        await store.exec("INSERT INTO monitor_notification (monitor_id, notification_id) VALUES (1, 1)");
        const previous = store.dispense("heartbeat");
        Object.assign(previous, {
            monitor_id: 1,
            status: UP,
            msg: "up",
            ping: 1,
            important: 1,
            duration: 60,
            retries: 0,
            time: store.isoDateTimeMillis(dayjs.utc().subtract(1, "minute")),
        });
        await heartbeatData.write(previous);

        const response = await handleApiRequest(
            new Request("http://localhost/api/push/owner-token?status=down&msg=down"),
            {
                server: runtimeServer,
                store,
                heartbeatData,
                settings,
                disableFrameSameOrigin: false,
            }
        );
        expect(await response.json()).toEqual({ ok: true });
        expect(runtimeServer.notificationProviderRegistry.getLoadedProviders()).toEqual(["normal"]);

        await store.exec("INSERT INTO notification (id, name, user_id, config) VALUES (2, 'cert', 1, ?)", [
            JSON.stringify({ type: "cert" }),
        ]);
        await store.exec("INSERT INTO monitor_notification (monitor_id, notification_id) VALUES (1, 2)");
        const monitor = await store.load("monitor", 1);
        monitor.rootCertificates = new Set();
        await checkCertExpiryNotifications(
            store,
            { get: async () => [7], set: async () => {} },
            monitor,
            {
                certInfo: {
                    subject: { CN: "example.com" },
                    fingerprint256: "leaf",
                    certType: "server",
                    daysRemaining: 1,
                },
            },
            runtimeServer.notificationProviderRegistry
        );

        expect(runtimeServer.notificationProviderRegistry.getLoadedProviders().sort()).toEqual(["cert", "normal"]);
        expect(sends.map(({ name }) => name)).toEqual(["normal", "normal", "cert"]);
    });
});
