// @ts-nocheck

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import httpClient from "@/server/http-client";
import { BunSQLiteRedbean } from "@/server/sqlite-core";
import { MODEL_MAPPING } from "@/server/model-registry";

const store = new BunSQLiteRedbean({ modelMapping: MODEL_MAPPING });

let ipv6ProxyServer;
try {
    ipv6ProxyServer = Bun.serve({
        hostname: "::1",
        port: 0,
        fetch: async (request) => {
            const target = new URL(request.url);
            if (target.hostname !== "127.0.0.1") {
                return new Response("public network disabled by fixture", { status: 502 });
            }
            return fetch(target);
        },
    });
} catch (error) {
    throw new Error(`IPv6 loopback is required for the HTTP proxy test: ${error.message}`, { cause: error });
}

describe("fetch HTTP client", () => {
    let server;
    let baseUrl;
    let redirectTargetServer;
    let redirectTargetUrl;
    let proxyServer;
    let proxyUrl;
    let authenticatedProxyServer;
    let httpsProxyServer;
    let httpsProxyUrl;
    let tlsServer;
    let tlsUrl;
    const proxyRequests = [];
    const proxyAuthorizationHeaders = [];
    const authenticatedProxyRequests = [];
    const targetProxyAuthorizationHeaders = [];
    const redirectTargetProxyAuthorizationHeaders = [];
    const tlsTargetProxyAuthorizationHeaders = [];
    const proxyUsername = "u%@:/żółw";
    const proxyPassword = "p%@:/密碼";
    const expectedProxyAuthorization = `Basic ${Buffer.from(`${proxyUsername}:${proxyPassword}`).toString("base64")}`;

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            targetProxyAuthorizationHeaders.push(req.headers["proxy-authorization"] ?? null);
            if (req.url === "/ok") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
                return;
            }

            if (req.url === "/keyword") {
                res.writeHead(200, { "Content-Type": "text/plain" });
                res.end("service contains expected-keyword");
                return;
            }

            if (req.url === "/slow") {
                setTimeout(() => {
                    res.writeHead(200, { "Content-Type": "text/plain" });
                    res.end("late");
                }, 200);
                return;
            }

            if (req.url === "/redirect") {
                res.writeHead(302, { Location: "/ok" });
                res.end();
                return;
            }

            if (req.url === "/cross-origin-redirect") {
                res.writeHead(302, { Location: `${redirectTargetUrl}/redirect-target` });
                res.end();
                return;
            }

            if (req.url === "/post-redirect" && req.method === "POST") {
                res.writeHead(303, { Location: "/post-target" });
                res.end();
                return;
            }

            if (req.url === "/post-target" && req.method === "GET") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ method: "GET" }));
                return;
            }

            if (req.url === "/error") {
                res.writeHead(503, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "unavailable" }));
                return;
            }

            if (req.url === "/teapot") {
                res.writeHead(418, { "Content-Type": "text/plain" });
                res.end("teapot");
                return;
            }

            if (req.url === "/echo") {
                const chunks = [];
                req.on("data", (chunk) => chunks.push(chunk));
                req.on("end", () => {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(
                        JSON.stringify({
                            method: req.method,
                            body: Buffer.concat(chunks).toString(),
                            contentType: req.headers["content-type"] || null,
                            testHeader: req.headers["x-test-header"] || null,
                        })
                    );
                });
                return;
            }

            if (req.url === "/auth") {
                const authorized = req.headers.authorization === "Basic dXNlcjpwYXNz";
                res.writeHead(authorized ? 200 : 401, { "Content-Type": "text/plain" });
                res.end(authorized ? "authorized" : "unauthorized");
                return;
            }

            res.writeHead(404);
            res.end("not found");
        });

        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;

        redirectTargetServer = http.createServer((req, res) => {
            redirectTargetProxyAuthorizationHeaders.push(req.headers["proxy-authorization"] ?? null);
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("redirect-target-ok");
        });
        await new Promise((resolve) => redirectTargetServer.listen(0, "127.0.0.1", resolve));
        redirectTargetUrl = `http://127.0.0.1:${redirectTargetServer.address().port}`;

        proxyServer = http.createServer(async (req, res) => {
            proxyRequests.push(req.url);
            const response = await fetch(req.url);
            res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
            res.end(await response.arrayBuffer());
        });
        proxyServer.on("connect", (req, clientSocket, head) => {
            const [hostname, port] = req.url.split(":");
            if (hostname !== "127.0.0.1") {
                clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
                return;
            }
            const targetSocket = net.connect(Number(port), hostname, () => {
                clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                if (head.length > 0) {
                    targetSocket.write(head);
                }
                targetSocket.pipe(clientSocket);
                clientSocket.pipe(targetSocket);
            });
            targetSocket.on("error", () => clientSocket.destroy());
        });
        await new Promise((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
        proxyUrl = `http://127.0.0.1:${proxyServer.address().port}`;

        authenticatedProxyServer = http.createServer(async (req, res) => {
            proxyAuthorizationHeaders.push(req.headers["proxy-authorization"] ?? null);
            authenticatedProxyRequests.push({ method: req.method, url: req.url });
            if (req.headers["proxy-authorization"] !== expectedProxyAuthorization) {
                res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="fixture"' });
                res.end("proxy authentication required");
                return;
            }
            const target = new URL(req.url);
            if (target.hostname !== "127.0.0.1") {
                res.writeHead(502);
                res.end("public network disabled by fixture");
                return;
            }
            const response = await fetch(target);
            res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
            res.end(await response.arrayBuffer());
        });
        authenticatedProxyServer.on("connect", (req, clientSocket, head) => {
            proxyAuthorizationHeaders.push(req.headers["proxy-authorization"] ?? null);
            authenticatedProxyRequests.push({ method: "CONNECT", url: req.url });
            if (req.headers["proxy-authorization"] !== expectedProxyAuthorization) {
                clientSocket.end(
                    'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fixture"\r\n\r\n'
                );
                return;
            }
            const [hostname, port] = req.url.split(":");
            if (hostname !== "127.0.0.1") {
                clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
                return;
            }
            const targetSocket = net.connect(Number(port), hostname, () => {
                clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                if (head.length > 0) {
                    targetSocket.write(head);
                }
                targetSocket.pipe(clientSocket);
                clientSocket.pipe(targetSocket);
            });
            targetSocket.on("error", () => clientSocket.destroy());
        });
        await new Promise((resolve) => authenticatedProxyServer.listen(0, "127.0.0.1", resolve));

        const certDir = path.join(process.cwd(), "test/manual-test-radius-tls/certs");
        tlsServer = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            tls: {
                cert: fs.readFileSync(path.join(certDir, "redis.crt")),
                key: fs.readFileSync(path.join(certDir, "redis.key")),
            },
            fetch: (request) => {
                tlsTargetProxyAuthorizationHeaders.push(request.headers.get("proxy-authorization"));
                return new Response("self-signed-ok");
            },
        });
        tlsUrl = `https://127.0.0.1:${tlsServer.port}`;

        httpsProxyServer = https.createServer(
            {
                cert: fs.readFileSync(path.join(certDir, "redis.crt")),
                key: fs.readFileSync(path.join(certDir, "redis.key")),
            },
            async (req, res) => {
                const target = new URL(req.url);
                if (target.hostname !== "127.0.0.1") {
                    res.writeHead(502);
                    res.end("public network disabled by fixture");
                    return;
                }
                const response = await fetch(target);
                res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
                res.end(await response.arrayBuffer());
            }
        );
        await new Promise((resolve) => httpsProxyServer.listen(0, "127.0.0.1", resolve));
        httpsProxyUrl = `https://127.0.0.1:${httpsProxyServer.address().port}`;
    });

    afterAll(async () => {
        ipv6ProxyServer?.stop(true);
        tlsServer.stop(true);
        await new Promise((resolve) => httpsProxyServer.close(resolve));
        await new Promise((resolve) => authenticatedProxyServer.close(resolve));
        await new Promise((resolve) => proxyServer.close(resolve));
        await new Promise((resolve) => redirectTargetServer.close(resolve));
        await new Promise((resolve) => server.close(resolve));
    });

    test("returns parsed JSON on success", async () => {
        const res = await httpClient.request({
            url: `${baseUrl}/ok`,
            validateStatus: (status) => status === 200,
        });

        expect(res.status).toBe(200);
        expect(res.data).toEqual({ ok: true });
    });

    test("aborts requests on timeout", async () => {
        await expect(
            httpClient.request({
                url: `${baseUrl}/slow`,
                timeout: 25,
            })
        ).rejects.toThrow(/timeout/);
    });

    test("follows redirects up to maxRedirects", async () => {
        const res = await httpClient.request({
            url: `${baseUrl}/redirect`,
            maxRedirects: 1,
        });

        expect(res.status).toBe(200);
        expect(res.data).toEqual({ ok: true });
    });

    test("fails when maxRedirects is exceeded", async () => {
        await expect(
            httpClient.request({
                url: `${baseUrl}/redirect`,
                maxRedirects: 0,
            })
        ).rejects.toMatchObject({ code: "ERR_FR_TOO_MANY_REDIRECTS" });
    });

    test("exposes HTTP error response body", async () => {
        try {
            await httpClient.request({
                url: `${baseUrl}/error`,
                validateStatus: (status) => status < 500,
            });
            expect.unreachable();
        } catch (error) {
            expect(error.response.status).toBe(503);
            expect(error.response.data).toEqual({ error: "unavailable" });
        }
    });

    test("converts POST to GET when following 303 redirects", async () => {
        const res = await httpClient.post(`${baseUrl}/post-redirect`, { hello: "world" });

        expect(res.status).toBe(200);
        expect(res.data).toEqual({ method: "GET" });
    });

    test("preserves methods, custom headers, request bodies, and content types", async () => {
        const head = await httpClient.request({ url: `${baseUrl}/echo`, method: "HEAD" });
        const post = await httpClient.request({
            url: `${baseUrl}/echo`,
            method: "POST",
            data: { hello: "world" },
            headers: { "X-Test-Header": "present" },
        });

        expect(head.status).toBe(200);
        expect(head.data).toBe("");
        expect(post.data).toEqual({
            method: "POST",
            body: '{"hello":"world"}',
            contentType: "application/json",
            testHeader: "present",
        });
    });

    test("accepts configured status ranges and rejects the same status otherwise", async () => {
        const accepted = await httpClient.request({
            url: `${baseUrl}/teapot`,
            validateStatus: (status) => status >= 400 && status < 500,
        });
        expect(accepted.status).toBe(418);

        await expect(httpClient.get(`${baseUrl}/teapot`)).rejects.toMatchObject({
            response: { status: 418, data: "teapot" },
        });
    });

    test("sends HTTP basic authentication headers", async () => {
        const response = await httpClient.get(`${baseUrl}/auth`, {
            headers: { Authorization: "Basic dXNlcjpwYXNz" },
        });
        expect(response.data).toBe("authorized");

        await expect(httpClient.get(`${baseUrl}/auth`)).rejects.toMatchObject({ response: { status: 401 } });
    });

    test("detects timeout cancellations via isCancel", async () => {
        try {
            await httpClient.request({
                url: `${baseUrl}/slow`,
                timeout: 25,
            });
            expect.unreachable();
        } catch (error) {
            expect(httpClient.isCancel(error)).toBe(true);
        }
    });

    test("rejects unsupported Axios transport options explicitly", async () => {
        await expect(
            httpClient.request({
                url: `${baseUrl}/ok`,
                httpsAgent: {},
            })
        ).rejects.toMatchObject({ code: "ERR_UNSUPPORTED_HTTP_OPTION" });
    });

    test("monitor keyword path can read response text through fetch wrapper", async () => {
        const monitor = store.convertToBean("monitor");
        monitor.auth_method = null;

        const res = await monitor.makeHttpMonitorRequest({
            url: `${baseUrl}/keyword`,
            timeout: 1000,
            validateStatus: (status) => status === 200,
        });

        expect(res.data.includes("expected-keyword")).toBe(true);
    });

    test("monitor rejects unsupported fetch transport settings explicitly", async () => {
        const monitor = store.convertToBean("monitor");
        monitor.auth_method = "mtls";

        await expect(monitor.assertFetchHttpTransportSupported({}, store)).rejects.toThrow(
            /mTLS monitor authentication is not supported/
        );

        monitor.auth_method = "ntlm";
        await expect(monitor.assertFetchHttpTransportSupported({}, store)).rejects.toThrow(
            /NTLM monitor authentication is not supported/
        );
    });

    test("Bun HTTP client routes requests through a local proxy", async () => {
        const response = await httpClient.get(`${baseUrl}/ok`, { proxy: proxyUrl });

        expect(response.data).toEqual({ ok: true });
        expect(proxyRequests).toContain(`${baseUrl}/ok`);
    });

    test("monitor maps an active persisted proxy to Bun fetch options", async () => {
        const monitor = store.convertToBean("monitor", {
            type: "http",
            user_id: 1,
            auth_method: null,
            proxy_id: 7,
            ignore_tls: 0,
            ip_family: null,
        });
        const originalFindOne = store.findOne;
        store.findOne = async () => ({
            active: true,
            protocol: "http",
            host: "127.0.0.1",
            port: proxyServer.address().port,
            auth: false,
        });

        try {
            const options = { url: `${baseUrl}/ok` };
            await monitor.assertFetchHttpTransportSupported(options, store);
            expect(options.proxy).toBe(`${proxyUrl}/`);
            expect((await monitor.makeHttpMonitorRequest(options)).data).toEqual({ ok: true });
        } finally {
            store.findOne = originalFindOne;
        }
    });

    test("monitor scopes exact Basic proxy auth to a compliant proxy across targets and redirects", async () => {
        const monitor = store.convertToBean("monitor", {
            type: "http",
            user_id: 1,
            auth_method: null,
            proxy_id: 8,
            ignore_tls: 0,
            ip_family: null,
        });
        const originalFindOne = store.findOne;
        let loadedPassword = proxyPassword;
        store.findOne = async () => ({
            active: true,
            protocol: "http",
            host: "127.0.0.1",
            port: authenticatedProxyServer.address().port,
            auth: true,
            username: proxyUsername,
            password: loadedPassword,
        });

        try {
            const proxyHeaderStart = proxyAuthorizationHeaders.length;
            const proxyRequestStart = authenticatedProxyRequests.length;
            const targetHeaderStart = targetProxyAuthorizationHeaders.length;
            const redirectHeaderStart = redirectTargetProxyAuthorizationHeaders.length;
            const tlsHeaderStart = tlsTargetProxyAuthorizationHeaders.length;
            const options = { url: `${baseUrl}/ok` };
            await monitor.assertFetchHttpTransportSupported(options, store);
            const response = await monitor.makeHttpMonitorRequest(options);

            expect(response.data).toEqual({ ok: true });
            expect(proxyAuthorizationHeaders.at(-1)).toBe(expectedProxyAuthorization);
            expect(JSON.stringify(options.proxy)).not.toContain(proxyUsername);
            expect(JSON.stringify(options.proxy)).not.toContain(proxyPassword);

            const redirectOptions = { url: `${baseUrl}/cross-origin-redirect`, maxRedirects: 1 };
            await monitor.assertFetchHttpTransportSupported(redirectOptions, store);
            expect((await monitor.makeHttpMonitorRequest(redirectOptions)).data).toBe("redirect-target-ok");

            const tlsOptions = { url: tlsUrl };
            await monitor.assertFetchHttpTransportSupported(tlsOptions, store);
            tlsOptions.rejectUnauthorized = false;
            expect((await monitor.makeHttpMonitorRequest(tlsOptions)).data).toBe("self-signed-ok");

            expect(
                proxyAuthorizationHeaders.slice(proxyHeaderStart).every((value) => value === expectedProxyAuthorization)
            ).toBe(true);
            expect(authenticatedProxyRequests.slice(proxyRequestStart)).toContainEqual({
                method: "CONNECT",
                url: `127.0.0.1:${tlsServer.port}`,
            });
            expect(targetProxyAuthorizationHeaders.slice(targetHeaderStart)).toEqual([null, null]);
            expect(redirectTargetProxyAuthorizationHeaders.slice(redirectHeaderStart)).toEqual([null]);
            expect(tlsTargetProxyAuthorizationHeaders.slice(tlsHeaderStart)).toEqual([null]);

            loadedPassword = `${proxyPassword}-rejected`;
            const rejectedOptions = { url: `${baseUrl}/ok` };
            await monitor.assertFetchHttpTransportSupported(rejectedOptions, store);
            const rejection = await monitor.makeHttpMonitorRequest(rejectedOptions).catch((error) => error);
            const rejectedAuthorization = `Basic ${Buffer.from(`${proxyUsername}:${loadedPassword}`).toString("base64")}`;
            const serializedError = `${rejection.stack}\n${JSON.stringify(rejection)}`;
            expect(rejection).toBeInstanceOf(Error);
            expect(serializedError).not.toContain(proxyUsername);
            expect(serializedError).not.toContain(loadedPassword);
            expect(serializedError).not.toContain(rejectedAuthorization);
        } finally {
            store.findOne = originalFindOne;
        }
    });

    test("persisted SOCKS proxy is rejected before fetch without exposing credentials", async () => {
        const monitor = store.convertToBean("monitor", {
            type: "http",
            user_id: 1,
            auth_method: null,
            proxy_id: 9,
            ignore_tls: 0,
            ip_family: null,
        });
        const originalFindOne = store.findOne;
        const secret = "socks-secret%@:/密碼";
        store.findOne = async () => ({
            active: true,
            protocol: "socks5h",
            host: "127.0.0.1",
            port: 1080,
            auth: true,
            username: "socks-user",
            password: secret,
        });

        try {
            const error = await monitor
                .assertFetchHttpTransportSupported({ url: `${baseUrl}/ok` }, store)
                .catch((e) => e);
            expect(error).toBeInstanceOf(Error);
            expect(error.message).toMatch(/SOCKS proxy.*not supported.*Bun fetch/i);
            expect(error.message).not.toContain("socks-user");
            expect(error.message).not.toContain(secret);
            expect(monitor.proxy_id).toBe(9);
        } finally {
            store.findOne = originalFindOne;
        }
    });

    test("monitor brackets a raw IPv6 proxy host", async () => {
        const monitor = store.convertToBean("monitor", {
            type: "http",
            user_id: 1,
            auth_method: null,
            proxy_id: 10,
            ignore_tls: 0,
            ip_family: null,
        });
        const originalFindOne = store.findOne;
        store.findOne = async () => ({
            active: true,
            protocol: "http",
            host: "::1",
            port: ipv6ProxyServer.port,
            auth: false,
        });

        try {
            const options = { url: `${baseUrl}/ok` };
            await monitor.assertFetchHttpTransportSupported(options, store);
            expect(options.proxy).toBe(`http://[::1]:${ipv6ProxyServer.port}/`);
            expect((await monitor.makeHttpMonitorRequest(options)).data).toEqual({ ok: true });
        } finally {
            store.findOne = originalFindOne;
        }
    });

    test("Bun cannot scope rejectUnauthorized to the target instead of an HTTPS proxy", async () => {
        await expect(httpClient.get(`${baseUrl}/ok`, { proxy: httpsProxyUrl })).rejects.toThrow();
        expect(
            (await httpClient.get(`${baseUrl}/ok`, { proxy: httpsProxyUrl, rejectUnauthorized: false })).data
        ).toEqual({
            ok: true,
        });
    });

    test("monitor rejects ignoreTls with an HTTPS proxy instead of weakening proxy validation", async () => {
        const monitor = store.convertToBean("monitor", {
            type: "http",
            user_id: 1,
            auth_method: null,
            proxy_id: 11,
            ignore_tls: 1,
            ip_family: null,
        });
        const originalFindOne = store.findOne;
        store.findOne = async () => ({
            active: true,
            protocol: "https",
            host: "127.0.0.1",
            port: httpsProxyServer.address().port,
            auth: false,
        });

        try {
            await expect(monitor.assertFetchHttpTransportSupported({ url: `${baseUrl}/ok` }, store)).rejects.toThrow(
                /ignore TLS.*HTTPS proxy.*not supported/i
            );
        } finally {
            store.findOne = originalFindOne;
        }
    });

    test("monitor keeps ignoreTls working for a self-signed target through an HTTP proxy", async () => {
        const monitor = store.convertToBean("monitor", {
            type: "http",
            user_id: 1,
            auth_method: null,
            proxy_id: 12,
            ignore_tls: 1,
            ip_family: null,
        });
        const originalFindOne = store.findOne;
        store.findOne = async () => ({
            active: true,
            protocol: "http",
            host: "127.0.0.1",
            port: proxyServer.address().port,
            auth: false,
        });

        try {
            const options = { url: tlsUrl };
            await monitor.assertFetchHttpTransportSupported(options, store);
            expect((await monitor.makeHttpMonitorRequest(options)).data).toBe("self-signed-ok");
        } finally {
            store.findOne = originalFindOne;
        }
    });

    test("monitor honors ignoreTls against a deterministic self-signed TLS fixture", async () => {
        const monitor = store.convertToBean("monitor");
        monitor.auth_method = null;
        monitor.proxy_id = null;
        monitor.ignoreTls = true;
        monitor.ipFamily = null;
        const options = { url: tlsUrl };

        await expect(httpClient.get(tlsUrl)).rejects.toThrow();
        await monitor.assertFetchHttpTransportSupported(options, store);
        const response = await monitor.makeHttpMonitorRequest(options);

        expect(response.data).toBe("self-signed-ok");
    });

    test("persisted forced HTTP IP family remains explicitly rejected", async () => {
        const monitor = store.convertToBean("monitor");
        monitor.auth_method = null;
        monitor.proxy_id = null;
        monitor.ignoreTls = false;
        monitor.ipFamily = "ipv4";

        await expect(monitor.assertFetchHttpTransportSupported({}, store)).rejects.toThrow(/Forced IP family/);
    });

    test("saved response size behavior remains truncation after the response is read", async () => {
        const monitor = store.convertToBean("monitor");
        monitor.response_max_length = 5;
        const bean = {};

        await monitor.saveResponseData(bean, "abcdef");

        expect(await store.dispense("heartbeat").constructor.decodeResponseValue(bean.response)).toBe(
            "abcde... (truncated)"
        );
    });
});
