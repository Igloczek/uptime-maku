// @ts-nocheck

/**
 * Simulates non compliant WS Server, doesnt send Sec-WebSocket-Accept header
 * @returns {Promise<{server: net.Server, port: number}>} Promise that resolves to the created server and its port
 */
import { describe, test, expect } from "bun:test";
import { WebSocketMonitorType } from "@/server/monitor-types/websocket-upgrade";
import { UP, PENDING } from "@/constants";
import net from "node:net";
import http from "node:http";

function nonCompliantWS() {
    const srv = net.createServer((socket) => {
        socket.once("data", (buf) => {
            socket.write(
                "HTTP/1.1 101 Switching Protocols\r\n" + "Upgrade: websocket\r\n" + "Connection: Upgrade\r\n\r\n"
            );
            socket.destroy();
        });
    });
    return new Promise((resolve) => {
        srv.listen(0, () => {
            resolve({ server: srv, port: srv.address().port });
        });
    });
}

/**
 * Creates a regular HTTP server (non-WebSocket) for testing WebSocket rejection
 * @returns {Promise<{server: http.Server, port: number}>} Promise that resolves to the created server and its port
 */
function httpServer() {
    const srv = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("This is not a WebSocket server");
    });
    return new Promise((resolve) => {
        srv.listen(0, () => {
            resolve({ server: srv, port: srv.address().port });
        });
    });
}

/**
 * Creates a WebSocket server for testing
 * @param {object} options Options to pass to Bun.serve websocket handlers
 * @returns {Promise<{server: ReturnType<typeof Bun.serve>, port: number}>} Promise that resolves to the created server and its port
 */
function createWebSocketServer(options = {}) {
    return new Promise((resolve) => {
        const server = Bun.serve({
            port: 0,
            hostname: "127.0.0.1",
            fetch(req, bunServer) {
                const url = new URL(req.url);
                if (options.handleProtocols) {
                    const requestedProtocols = req.headers.get("sec-websocket-protocol");
                    const protocols = requestedProtocols
                        ? requestedProtocols.split(",").map((item) => item.trim())
                        : [];
                    const selectedProtocol = options.handleProtocols(new Set(protocols));
                    if (!selectedProtocol) {
                        return new Response("Server sent no subprotocol", { status: 400 });
                    }
                    if (
                        bunServer.upgrade(req, {
                            data: {},
                            headers: {
                                "Sec-WebSocket-Protocol": selectedProtocol,
                            },
                        })
                    ) {
                        return undefined;
                    }
                    return new Response("Upgrade failed", { status: 400 });
                }

                if (bunServer.upgrade(req, { data: {} })) {
                    return undefined;
                }
                return new Response("Expected websocket", { status: 400 });
            },
            websocket: {
                open(ws) {
                    ws.close(1000);
                },
            },
        });

        resolve({ server, port: server.port });
    });
}

describe("WebSocket Monitor", () => {
    test("check() rejects with unexpected server response when connecting to non-WebSocket server", async () => {
        const websocketMonitor = new WebSocketMonitorType();
        const { server: srv, port } = await httpServer();
        try {
            const monitor = {
                url: `ws://localhost:${port}`,
                wsIgnoreSecWebsocketAcceptHeader: false,
                accepted_statuscodes_json: JSON.stringify(["1000"]),
                timeout: 1,
            };

            const heartbeat = {
                msg: "",
                status: PENDING,
            };

            await expect(websocketMonitor.check(monitor, heartbeat, {})).rejects.toThrow(
                /Expected 101 status code|Timeout/
            );
        } finally {
            srv.close();
        }
    });

    test("check() sets status to UP when connecting to WebSocket server", async () => {
        const websocketMonitor = new WebSocketMonitorType();
        const { server: wss, port } = await createWebSocketServer();
        try {
            const monitor = {
                url: `ws://127.0.0.1:${port}`,
                wsIgnoreSecWebsocketAcceptHeader: false,
                accepted_statuscodes_json: JSON.stringify(["1000"]),
                timeout: 30,
            };

            const heartbeat = {
                msg: "",
                status: PENDING,
            };

            const expected = {
                msg: "1000 - OK",
                status: UP,
            };

            await websocketMonitor.check(monitor, heartbeat, {});
            expect(heartbeat).toEqual(expected);
        } finally {
            wss.stop();
        }
    });

    test("check() sets status to UP when connecting to insecure WebSocket server", async () => {
        const websocketMonitor = new WebSocketMonitorType();
        const { server: wss, port } = await createWebSocketServer();
        try {
            const monitor = {
                url: `ws://127.0.0.1:${port}`,
                wsIgnoreSecWebsocketAcceptHeader: false,
                accepted_statuscodes_json: JSON.stringify(["1000"]),
                timeout: 30,
            };

            const heartbeat = {
                msg: "",
                status: PENDING,
            };

            const expected = {
                msg: "1000 - OK",
                status: UP,
            };

            await websocketMonitor.check(monitor, heartbeat, {});
            expect(heartbeat).toEqual(expected);
        } finally {
            wss.stop();
        }
    });

    test("check() rejects when status code does not match expected value", async () => {
        const websocketMonitor = new WebSocketMonitorType();
        const { server: wss, port } = await createWebSocketServer();
        try {
            const monitor = {
                url: `ws://127.0.0.1:${port}`,
                wsIgnoreSecWebsocketAcceptHeader: false,
                accepted_statuscodes_json: JSON.stringify(["1001"]),
                timeout: 30,
            };

            const heartbeat = {
                msg: "",
                status: PENDING,
            };

            await expect(websocketMonitor.check(monitor, heartbeat, {})).rejects.toEqual(
                new Error("Unexpected status code: 1000")
            );
        } finally {
            wss.stop();
        }
    });

    test("check() rejects when expected status code is empty", async () => {
        const websocketMonitor = new WebSocketMonitorType();
        const { server: wss, port } = await createWebSocketServer();
        try {
            const monitor = {
                url: `ws://127.0.0.1:${port}`,
                wsIgnoreSecWebsocketAcceptHeader: false,
                accepted_statuscodes_json: JSON.stringify([""]),
                timeout: 30,
            };

            const heartbeat = {
                msg: "",
                status: PENDING,
            };

            await expect(websocketMonitor.check(monitor, heartbeat, {})).rejects.toEqual(
                new Error("Unexpected status code: 1000")
            );
        } finally {
            wss.stop();
        }
    });

    test("check() rejects when Sec-WebSocket-Accept header is invalid", async () => {
        const websocketMonitor = new WebSocketMonitorType();
        const { server: wss, port } = await nonCompliantWS();
        try {
            const monitor = {
                url: `ws://localhost:${port}`,
                wsIgnoreSecWebsocketAcceptHeader: false,
                accepted_statuscodes_json: JSON.stringify(["1000"]),
                timeout: 30,
            };

            const heartbeat = {
                msg: "",
                status: PENDING,
            };

            await expect(websocketMonitor.check(monitor, heartbeat, {})).rejects.toThrow(
                /missing websocket accept header/i
            );
        } finally {
            wss.close();
        }
    });

    test("check() sets status to UP when ignoring invalid Sec-WebSocket-Accept header", async () => {
        const websocketMonitor = new WebSocketMonitorType();
        const { server: wss, port } = await nonCompliantWS();
        try {
            const monitor = {
                url: `ws://localhost:${port}`,
                wsIgnoreSecWebsocketAcceptHeader: true,
                accepted_statuscodes_json: JSON.stringify(["1000"]),
                timeout: 30,
            };

            const heartbeat = {
                msg: "",
                status: PENDING,
            };

            const expected = {
                msg: "1000 - OK",
                status: UP,
            };

            await websocketMonitor.check(monitor, heartbeat, {});
            expect(heartbeat).toEqual(expected);
        } finally {
            wss.close();
        }
    });

    test("check() sets status to UP for compliant WebSocket server when ignoring Sec-WebSocket-Accept", async () => {
        const websocketMonitor = new WebSocketMonitorType();
        const { server: wss, port } = await createWebSocketServer();
        try {
            const monitor = {
                url: `ws://127.0.0.1:${port}`,
                wsIgnoreSecWebsocketAcceptHeader: true,
                accepted_statuscodes_json: JSON.stringify(["1000"]),
                timeout: 30,
            };

            const heartbeat = {
                msg: "",
                status: PENDING,
            };

            const expected = {
                msg: "1000 - OK",
                status: UP,
            };

            await websocketMonitor.check(monitor, heartbeat, {});
            expect(heartbeat).toEqual(expected);
        } finally {
            wss.stop();
        }
    });

    test("check() rejects non-WebSocket server even when ignoring Sec-WebSocket-Accept", async () => {
        const websocketMonitor = new WebSocketMonitorType();
        const { server: srv, port } = await httpServer();
        try {
            const monitor = {
                url: `ws://localhost:${port}`,
                wsIgnoreSecWebsocketAcceptHeader: true,
                accepted_statuscodes_json: JSON.stringify(["1000"]),
                timeout: 1,
            };

            const heartbeat = {
                msg: "",
                status: PENDING,
            };

            await expect(websocketMonitor.check(monitor, heartbeat, {})).rejects.toThrow(
                /Expected 101 status code|Timeout/
            );
        } finally {
            srv.close();
        }
    });

    test("check() rejects when server does not support requested subprotocol", async () => {
        const websocketMonitor = new WebSocketMonitorType();
        const { server: wss, port } = await createWebSocketServer({
            handleProtocols: () => null,
        });
        try {
            const monitor = {
                url: `ws://127.0.0.1:${port}`,
                wsIgnoreSecWebsocketAcceptHeader: false,
                wsSubprotocol: "ocpp1.6",
                accepted_statuscodes_json: JSON.stringify(["1000"]),
                timeout: 30,
            };

            const heartbeat = {
                msg: "",
                status: PENDING,
            };

            await expect(websocketMonitor.check(monitor, heartbeat, {})).rejects.toThrow(/Expected 101 status code/);
        } finally {
            wss.stop();
        }
    });

    test("check() rejects when multiple subprotocols contain invalid characters", async () => {
        const websocketMonitor = new WebSocketMonitorType();
        const { server: wss, port } = await createWebSocketServer();
        try {
            const monitor = {
                url: `ws://127.0.0.1:${port}`,
                wsIgnoreSecWebsocketAcceptHeader: false,
                wsSubprotocol: "  # &  ,ocpp2.0   []  ,     ocpp1.6 ,  ,,     ;      ",
                accepted_statuscodes_json: JSON.stringify(["1000"]),
                timeout: 30,
            };

            const heartbeat = {
                msg: "",
                status: PENDING,
            };

            await expect(websocketMonitor.check(monitor, heartbeat, {})).rejects.toThrow(
                /Wrong protocol for WebSocket 'ocpp2\.0\[\]'/
            );
        } finally {
            wss.stop();
        }
    });

    test("check() sets status to UP when subprotocol with multiple spaces is accepted", async () => {
        const websocketMonitor = new WebSocketMonitorType();
        const { server: wss, port } = await createWebSocketServer({
            handleProtocols: (protocols) => {
                return Array.from(protocols).includes("test") ? "test" : null;
            },
        });
        try {
            const monitor = {
                url: `ws://127.0.0.1:${port}`,
                wsIgnoreSecWebsocketAcceptHeader: false,
                wsSubprotocol: "invalid                        ,              test  ",
                accepted_statuscodes_json: JSON.stringify(["1000"]),
                timeout: 30,
            };

            const heartbeat = {
                msg: "",
                status: PENDING,
            };

            const expected = {
                msg: "1000 - OK",
                status: UP,
            };

            await websocketMonitor.check(monitor, heartbeat, {});
            expect(heartbeat).toEqual(expected);
        } finally {
            wss.stop();
        }
    });

    test("check() sets status to UP when server supports requested subprotocol", async () => {
        const websocketMonitor = new WebSocketMonitorType();
        const { server: wss, port } = await createWebSocketServer({
            handleProtocols: (protocols) => {
                return Array.from(protocols).includes("test") ? "test" : null;
            },
        });
        try {
            const monitor = {
                url: `ws://127.0.0.1:${port}`,
                wsIgnoreSecWebsocketAcceptHeader: false,
                wsSubprotocol: "invalid,test",
                accepted_statuscodes_json: JSON.stringify(["1000"]),
                timeout: 30,
            };

            const heartbeat = {
                msg: "",
                status: PENDING,
            };

            const expected = {
                msg: "1000 - OK",
                status: UP,
            };

            await websocketMonitor.check(monitor, heartbeat, {});
            expect(heartbeat).toEqual(expected);
        } finally {
            wss.stop();
        }
    });

    test("buildWsOptions() includes custom headers", async () => {
        const websocketMonitor = new WebSocketMonitorType();

        const options = await websocketMonitor.buildWsOptions({
            headers: JSON.stringify({
                "X-Test": "test-value",
            }),
        });

        expect(options.headers).toEqual({
            "X-Test": "test-value",
        });
    });

    test("buildWsOptions() ignores invalid custom headers JSON", async () => {
        const websocketMonitor = new WebSocketMonitorType();

        const options = await websocketMonitor.buildWsOptions({
            headers: "{ invalid-json",
        });

        expect(options.headers).toEqual({});
    });

    test("buildWsOptions() rejects mTLS configuration", async () => {
        const websocketMonitor = new WebSocketMonitorType();

        await expect(
            websocketMonitor.buildWsOptions({
                authMethod: "mtls",
                tlsCert: "cert",
                tlsKey: "key",
                getIgnoreTls: () => false,
            })
        ).rejects.toThrow(/mTLS WebSocket authentication is not supported/);
    });

    test("buildWsOptions() authentication header overrides custom Authorization header", async () => {
        const websocketMonitor = new WebSocketMonitorType();

        const options = await websocketMonitor.buildWsOptions({
            headers: JSON.stringify({
                Authorization: "Bearer custom-token",
                "X-Test": "test-value",
            }),
            authMethod: "basic",
            basic_auth_user: "user",
            basic_auth_pass: "pass",
        });

        expect(options.headers).toEqual({
            Authorization: "Basic dXNlcjpwYXNz",
            "X-Test": "test-value",
        });
    });
});
