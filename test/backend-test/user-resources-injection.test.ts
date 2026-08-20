import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "@/server/model-registry";
import APIKey from "@/server/model/api_key";
import {
    sendAPIKeyList,
    sendDockerHostList,
    sendNotificationList,
    sendProxyList,
    sendRemoteBrowserList,
} from "@/server/client";
import { BunSQLiteRedbean } from "@/server/sqlite-core";
import { DockerHost } from "@/server/docker";
import { Notification } from "@/server/notification";
import { Proxy } from "@/server/proxy";
import { resolveCoreHttpProxy } from "@/server/proxy-validation";
import { RemoteBrowser } from "@/server/remote-browser";

const directories = [];

async function createStore() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "uptime-maku-user-resources-"));
    directories.push(directory);
    const store = new BunSQLiteRedbean();
    await store.connect({
        sqlitePath: path.join(directory, "kuma.db"),
        templatePath: path.join(process.cwd(), "src/db/kuma.db"),
        testMode: true,
    });
    await store.exec("INSERT INTO user (id, username, password, active) VALUES (?, ?, ?, ?)", [1, "owner", "x", 1]);
    await store.exec("INSERT INTO user (id, username, password, active) VALUES (?, ?, ?, ?)", [2, "other", "x", 1]);
    return store;
}

afterEach(async () => {
    for (const directory of directories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe("user resource storage injection", () => {
    test("keeps API keys and user resources isolated, including list emissions", async () => {
        const first = await createStore();
        const second = await createStore();
        const emissions = [];
        const io = { to: () => ({ emit: (event, payload) => emissions.push([event, payload]) }) };
        const socket = { userID: 1 };

        try {
            const key = await APIKey.save(first, { key: "hash", name: "first", active: true, expires: null }, 1);
            await APIKey.save(second, { key: "hash", name: "second", active: true, expires: null }, 1);
            const proxy = await Proxy.save(
                first,
                { protocol: "http", host: "proxy.example", port: 8080, auth: false, active: true, default: false },
                null,
                1
            );
            const notification = await Notification.save(
                first,
                { name: "mail", type: "smtp", isDefault: false },
                null,
                1
            );
            const docker = await DockerHost.save(
                first,
                { name: "docker", dockerDaemon: "/var/run/docker.sock", dockerType: "socket" },
                null,
                1
            );
            const browser = await RemoteBrowser.save(
                first,
                { name: "browser", url: "https://browser.example" },
                null,
                1
            );

            await Promise.all([
                sendAPIKeyList(first, io, socket),
                sendProxyList(first, io, socket),
                sendNotificationList(first, io, socket),
                sendDockerHostList(first, io, socket),
                sendRemoteBrowserList(first, io, socket),
            ]);

            expect(emissions).toEqual(
                expect.arrayContaining([
                    ["apiKeyList", [expect.objectContaining({ id: key.id, name: "first" })]],
                    ["proxyList", [expect.objectContaining({ id: proxy.id, host: "proxy.example" })]],
                    ["notificationList", [expect.objectContaining({ id: notification.id, name: "mail" })]],
                    ["dockerHostList", [expect.objectContaining({ id: docker.id, name: "docker" })]],
                    ["remoteBrowserList", [expect.objectContaining({ id: browser.id, name: "browser" })]],
                ])
            );
            expect(await second.count("api_key")).toBe(1);
            expect(await second.count("proxy")).toBe(0);
            expect(await second.count("notification")).toBe(0);
            expect(await second.count("docker_host")).toBe(0);
            expect(await second.count("remote_browser")).toBe(0);
        } finally {
            await first.close();
            await second.close();
        }
    });

    test("enforces resource ownership through the injected store", async () => {
        const store = await createStore();

        try {
            const proxy = await Proxy.save(
                store,
                { protocol: "http", host: "proxy.example", port: 8080, auth: false, active: true, default: false },
                null,
                1
            );
            const notification = await Notification.save(
                store,
                { name: "mail", type: "smtp", isDefault: false },
                null,
                1
            );
            const docker = await DockerHost.save(
                store,
                { name: "docker", dockerDaemon: "/socket", dockerType: "socket" },
                null,
                1
            );
            const browser = await RemoteBrowser.save(
                store,
                { name: "browser", url: "https://browser.example" },
                null,
                1
            );

            await expect(resolveCoreHttpProxy(store, "http", proxy.id, 2, false)).rejects.toThrow("unavailable");
            await expect(Notification.delete(store, notification.id, 2)).rejects.toThrow("not found");
            await expect(DockerHost.delete(store, docker.id, 2)).rejects.toThrow("not found");
            await expect(RemoteBrowser.delete(store, browser.id, 2)).rejects.toThrow("not found");
            await expect(Proxy.delete(store, proxy.id, 2)).rejects.toThrow("not found");
        } finally {
            await store.close();
        }
    });
});
