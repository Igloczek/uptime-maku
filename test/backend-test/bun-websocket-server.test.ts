// @ts-nocheck

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BunRealtimeAdapter } from "@/server/bun-websocket-server";
import { BunSQLiteRedbean } from "@/server/sqlite-core";
import { UptimeMakuServer } from "@/server/uptime-maku-server";
import { Settings } from "@/server/settings";

async function upgrade({ peer, headers = {}, trustProxy = false }) {
    const settings = { get: async () => trustProxy };
    const server = {
        settings,
        getClientIPwithProxy: UptimeMakuServer.prototype.getClientIPwithProxy,
    };
    const adapter = new BunRealtimeAdapter(server, settings);
    let data;
    const upgraded = await adapter.canUpgrade(new Request("http://uptime-maku.test/ws", { headers }), {
        requestIP: () => (peer ? { address: peer } : undefined),
        upgrade: (_, options) => {
            data = options.data;
            return true;
        },
    });
    return { data, upgraded };
}

describe("Bun WebSocket client source", () => {
    test("uses the Bun peer and ignores spoofed forwarding headers without trustProxy", async () => {
        const { data, upgraded } = await upgrade({
            peer: "127.0.0.1",
            headers: {
                "x-forwarded-for": "203.0.113.9",
                "x-real-ip": "198.51.100.7",
            },
        });

        expect(upgraded).toBe(true);
        expect(data.remoteAddress).toBe("127.0.0.1");
    });

    test("uses configured forwarding headers when trustProxy is enabled", async () => {
        const { data } = await upgrade({
            peer: "127.0.0.1",
            headers: { "x-forwarded-for": "203.0.113.9, 198.51.100.7" },
            trustProxy: true,
        });

        expect(data.remoteAddress).toBe("203.0.113.9");
    });

    test("keeps the existing empty source when Bun cannot provide a peer", async () => {
        const { data } = await upgrade({
            headers: { "x-forwarded-for": "203.0.113.9", "x-real-ip": "198.51.100.7" },
        });

        expect(data.remoteAddress).toBe("");
    });

    test("shares trustProxy invalidation and snapshot cache clears with injected settings", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "uptime-maku-settings-ws-"));
        const store = new BunSQLiteRedbean();
        const settings = new Settings(store);
        await store.connect({
            sqlitePath: path.join(directory, "kuma.db"),
            templatePath: path.join(process.cwd(), "out/kuma.db"),
            testMode: true,
        });

        try {
            const server = { settings, getClientIPwithProxy: UptimeMakuServer.prototype.getClientIPwithProxy };
            const forwardedHeaders = { "x-forwarded-for": "203.0.113.9" };
            await settings.set("trustProxy", true);
            expect(await server.getClientIPwithProxy("127.0.0.1", forwardedHeaders)).toBe("203.0.113.9");

            await settings.set("trustProxy", false);
            const adapter = new BunRealtimeAdapter(server, settings);
            let remoteAddress;
            await adapter.canUpgrade(new Request("http://uptime-maku.test/ws", { headers: forwardedHeaders }), {
                requestIP: () => ({ address: "127.0.0.1" }),
                upgrade: (_, options) => {
                    remoteAddress = options.data.remoteAddress;
                    return true;
                },
            });
            expect(remoteAddress).toBe("127.0.0.1");

            await settings.set("trustProxy", true);
            expect(await server.getClientIPwithProxy("127.0.0.1", forwardedHeaders)).toBe("203.0.113.9");
            await store.exec("UPDATE setting SET value = ? WHERE `key` = ?", [JSON.stringify(false), "trustProxy"]);
            settings.cacheList = {};
            expect(await server.getClientIPwithProxy("127.0.0.1", forwardedHeaders)).toBe("127.0.0.1");
            remoteAddress = null;
            await adapter.canUpgrade(new Request("http://uptime-maku.test/ws", { headers: forwardedHeaders }), {
                requestIP: () => ({ address: "127.0.0.1" }),
                upgrade: (_, options) => {
                    remoteAddress = options.data.remoteAddress;
                    return true;
                },
            });
            expect(remoteAddress).toBe("127.0.0.1");
        } finally {
            settings.stopCacheCleaner();
            await store.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
