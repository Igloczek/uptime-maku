// @ts-nocheck

import { describe, test, expect } from "bun:test";
import { MonitorRuntimeRegistry } from "@/server/monitor-runtime-registry";
import { NotificationProviderRegistry } from "@/server/notification-provider-registry";
import { IgloMonitorServer } from "@/server/iglo-monitor-server";
import { sendMonitorTypeList } from "@/server/client";
import { BunSQLiteRedbean } from "@/server/sqlite-core";
import { Settings } from "@/server/settings";

function createServer() {
    const store = new BunSQLiteRedbean();
    return new IgloMonitorServer(store, new Settings(store));
}

describe("runtime-owned lazy registries", () => {
    test("metadata construction does not run injected monitor or provider loaders", () => {
        let monitorLoads = 0;
        let providerLoads = 0;
        const monitors = new MonitorRuntimeRegistry(
            {},
            {
                heavy: {
                    supportsConditions: true,
                    conditionVariables: [],
                    allowCustomStatus: true,
                    load: () => {
                        monitorLoads++;
                    },
                },
            }
        );
        const providers = new NotificationProviderRegistry(
            {},
            {
                heavy: () => {
                    providerLoads++;
                },
            }
        );

        expect(monitors.monitorTypeList.heavy).toEqual({
            supportsConditions: true,
            conditionVariables: [],
            allowCustomStatus: true,
        });
        expect(monitors.getLoadedTypes()).toEqual([]);
        expect(providers.getLoadedProviders()).toEqual([]);
        expect([monitorLoads, providerLoads]).toEqual([0, 0]);
    });

    test("each IgloMonitorServer owns isolated monitor and provider instances", async () => {
        const first = createServer();
        const second = createServer();

        expect(first.monitorRuntimeRegistry).not.toBe(second.monitorRuntimeRegistry);
        expect(first.notificationProviderRegistry).not.toBe(second.notificationProviderRegistry);
        expect(first.monitorRuntimeRegistry.getLoadedTypes()).toEqual([]);
        expect(first.notificationProviderRegistry.getLoadedProviders()).toEqual([]);

        const firstMonitorLoad = first.getMonitorType("smtp");
        expect(first.getMonitorType("smtp")).toBe(firstMonitorLoad);
        const firstMonitors = await Promise.all(Array.from({ length: 20 }, () => first.getMonitorType("smtp")));
        const firstMonitor = await firstMonitorLoad;
        const secondMonitor = await second.getMonitorType("smtp");
        expect(firstMonitors.every((monitor) => monitor === firstMonitor)).toBe(true);
        expect(firstMonitor).not.toBe(secondMonitor);

        const firstProviderLoad = first.notificationProviderRegistry.get("smtp");
        expect(first.notificationProviderRegistry.get("smtp")).toBe(firstProviderLoad);
        const firstProviders = await Promise.all(
            Array.from({ length: 20 }, () => first.notificationProviderRegistry.get("smtp"))
        );
        const firstProvider = await firstProviderLoad;
        const secondProvider = await second.notificationProviderRegistry.get("smtp");
        expect(firstProviders.every((provider) => provider === firstProvider)).toBe(true);
        expect(firstProvider).not.toBe(secondProvider);
        expect(first.monitorRuntimeRegistry.getLoadedTypes()).toEqual(["smtp"]);
        expect(second.monitorRuntimeRegistry.getLoadedTypes()).toEqual(["smtp"]);
        expect(first.notificationProviderRegistry.getLoadedProviders()).toEqual(["smtp"]);
        expect(second.notificationProviderRegistry.getLoadedProviders()).toEqual(["smtp"]);
    });

    test("failed monitor and provider loads retry without poisoning another runtime", async () => {
        let monitorAttempts = 0;
        let providerAttempts = 0;
        class Provider {
            name = "retry";
            send() {}
        }
        const monitorDefinitions = {
            retry: {
                load: async () => {
                    if (++monitorAttempts === 1) {
                        throw new Error("monitor failed");
                    }
                    return { attempt: monitorAttempts, check() {} };
                },
            },
        };
        const providerLoaders = {
            retry: async () => {
                if (++providerAttempts === 1) {
                    throw new Error("provider failed");
                }
                return { default: Provider };
            },
        };
        const firstMonitors = new MonitorRuntimeRegistry({}, monitorDefinitions);
        const secondMonitors = new MonitorRuntimeRegistry({}, monitorDefinitions);
        const firstProviders = new NotificationProviderRegistry({}, providerLoaders);
        const secondProviders = new NotificationProviderRegistry({}, providerLoaders);

        await expect(firstMonitors.get("retry")).rejects.toThrow("monitor failed");
        await expect(firstProviders.get("retry")).rejects.toThrow("provider failed");
        expect(firstMonitors.getLoadedTypes()).toEqual([]);
        expect(firstProviders.getLoadedProviders()).toEqual([]);
        const secondMonitor = await secondMonitors.get("retry");
        const secondProvider = await secondProviders.get("retry");
        const retriedMonitor = await firstMonitors.get("retry");
        const retriedProvider = await firstProviders.get("retry");
        expect(secondMonitor).not.toBe(retriedMonitor);
        expect(secondProvider).not.toBe(retriedProvider);
    });

    test("invalid factory results never enter owner caches and can be retried", async () => {
        let monitorAttempt = 0;
        const monitors = new MonitorRuntimeRegistry(
            {},
            {
                retry: {
                    load: () => {
                        monitorAttempt++;
                        if (monitorAttempt === 1) {
                            throw new Error("sync monitor failure");
                        }
                        if (monitorAttempt === 2) {
                            return Promise.reject(new Error("async monitor failure"));
                        }
                        if (monitorAttempt === 3) {
                            return undefined;
                        }
                        if (monitorAttempt === 4) {
                            return {};
                        }
                        return { check() {} };
                    },
                },
            }
        );

        await expect(monitors.get("retry")).rejects.toThrow("sync monitor failure");
        await expect(monitors.get("retry")).rejects.toThrow("async monitor failure");
        await expect(monitors.get("retry")).rejects.toThrow('Invalid monitor type factory for "retry"');
        await expect(monitors.get("retry")).rejects.toThrow('Invalid monitor type factory for "retry"');
        expect(monitors.getLoadedTypes()).toEqual([]);
        expect(typeof (await monitors.get("retry")).check).toBe("function");
        expect(monitors.getLoadedTypes()).toEqual(["retry"]);

        let providerAttempt = 0;
        const providers = new NotificationProviderRegistry(
            {},
            {
                retry: () => {
                    providerAttempt++;
                    if (providerAttempt === 1) {
                        throw new Error("sync provider failure");
                    }
                    if (providerAttempt === 2) {
                        return Promise.reject(new Error("async provider failure"));
                    }
                    if (providerAttempt === 3) {
                        return undefined;
                    }
                    if (providerAttempt === 4) {
                        return {};
                    }
                    if (providerAttempt === 5) {
                        return { default: {} };
                    }
                    if (providerAttempt === 6) {
                        return {
                            default: class {
                                name = "retry";
                            },
                        };
                    }
                    if (providerAttempt === 7) {
                        return {
                            default: class {
                                send() {}
                            },
                        };
                    }
                    return {
                        default: class {
                            name = "retry";
                            send() {}
                        },
                    };
                },
            }
        );

        await expect(providers.get("retry")).rejects.toThrow("sync provider failure");
        await expect(providers.get("retry")).rejects.toThrow("async provider failure");
        for (let attempt = 0; attempt < 3; attempt++) {
            await expect(providers.get("retry")).rejects.toThrow('Invalid notification provider factory for "retry"');
        }
        await expect(providers.get("retry")).rejects.toThrow('expected name "retry" and send()');
        await expect(providers.get("retry")).rejects.toThrow('expected name "retry" and send()');
        expect(providers.getLoadedProviders()).toEqual([]);
        expect((await providers.get("retry")).name).toBe("retry");
        expect(providers.getLoadedProviders()).toEqual(["retry"]);

        const otherMonitors = new MonitorRuntimeRegistry({}, { retry: { load: () => ({ check() {} }) } });
        const otherProviders = new NotificationProviderRegistry(
            {},
            {
                retry: () => ({
                    default: class {
                        name = "retry";
                        send() {}
                    },
                }),
            }
        );
        expect(typeof (await otherMonitors.get("retry")).check).toBe("function");
        expect((await otherProviders.get("retry")).name).toBe("retry");
    });

    test("unknown keys return null without changing owner caches", async () => {
        const monitors = new MonitorRuntimeRegistry({}, {});
        const providers = new NotificationProviderRegistry({}, {});

        expect(await monitors.get("missing")).toBeNull();
        expect(await providers.get("missing")).toBeNull();
        expect(monitors.getLoadedTypes()).toEqual([]);
        expect(providers.getLoadedProviders()).toEqual([]);
    });

    test("socket monitor metadata payload stays compatible", async () => {
        const emissions = [];
        const io = { to: () => ({ emit: (...args) => emissions.push(args) }) };
        const monitorTypeList = {
            custom: {
                supportsConditions: true,
                conditionVariables: [{ id: "result", operators: [{ id: "equals", caption: "Equals" }] }],
                allowCustomStatus: true,
            },
        };

        await sendMonitorTypeList(monitorTypeList, io, { userID: 1 });

        expect(emissions).toEqual([
            [
                "monitorTypeList",
                {
                    custom: {
                        supportsConditions: true,
                        conditionVariables: [{ id: "result", operators: [{ id: "equals", caption: "Equals" }] }],
                    },
                },
            ],
        ]);
    });
});
