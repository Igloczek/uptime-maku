// @ts-nocheck

import { beforeAll, describe, expect, jest, test } from "bun:test";
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import snmp from "net-snmp";
import { GrpcKeywordMonitorType } from "@/server/monitor-types/grpc";
import { MongodbMonitorType } from "@/server/monitor-types/mongodb";
import { MqttMonitorType } from "@/server/monitor-types/mqtt";
import { MysqlMonitorType } from "@/server/monitor-types/mysql";
import { PostgresMonitorType } from "@/server/monitor-types/postgres";
import { RedisMonitorType } from "@/server/monitor-types/redis";
import { SMTPMonitorType } from "@/server/monitor-types/smtp";
import { SNMPMonitorType } from "@/server/monitor-types/snmp";
import { runCommand } from "@/server/process-helper";

let Monitor;

beforeAll(async () => {
    await import("@/server/sqlite-store");
    Monitor = (await import("@/server/model/monitor")).default;
});

const testProto = `
syntax = "proto3";
package test;
service TestService { rpc Echo (EchoRequest) returns (EchoResponse); }
message EchoRequest { string message = 1; }
message EchoResponse { string message = 1; }
`;

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function settleWithin(promise, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            promise.then(() => true),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(false), timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function createHangingGrpcServer() {
    const protoPath = path.join(os.tmpdir(), `uptime-maku-timeout-${process.pid}-${Date.now()}.proto`);
    fs.writeFileSync(protoPath, testProto);
    const packageDefinition = protoLoader.loadSync(protoPath);
    const descriptor = grpc.loadPackageDefinition(packageDefinition);
    const requestArrived = deferred();
    const requestCanceled = deferred();
    const server = new grpc.Server();
    server.addService(descriptor.test.TestService.service, {
        Echo(call) {
            requestArrived.resolve();
            call.on("cancelled", requestCanceled.resolve);
        },
    });
    const port = await new Promise((resolve, reject) => {
        server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, assignedPort) =>
            error ? reject(error) : resolve(assignedPort)
        );
    });
    server.start();
    fs.rmSync(protoPath, { force: true });
    return { port, requestArrived, requestCanceled, server };
}

async function createHangingTcpServer() {
    const requestArrived = deferred();
    const socketClosed = deferred();
    const sockets = new Set();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        requestArrived.resolve();
        socket.on("close", () => {
            sockets.delete(socket);
            socketClosed.resolve();
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        port: server.address().port,
        requestArrived,
        socketClosed,
        sockets,
        async close() {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise((resolve) => server.close(resolve));
        },
    };
}

async function createHangingUdpServer() {
    const requestArrived = deferred();
    const server = dgram.createSocket("udp4");
    let requests = 0;
    server.on("message", () => {
        requests++;
        requestArrived.resolve();
    });
    await new Promise((resolve) => server.bind(0, "127.0.0.1", resolve));
    return {
        port: server.address().port,
        requestArrived,
        get requests() {
            return requests;
        },
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

function snmpMonitor(overrides = {}) {
    return {
        hostname: "127.0.0.1",
        snmpVersion: "2c",
        radiusPassword: "public",
        snmpOid: "1.3.6.1.2.1.1.1.0",
        timeout: 0.1,
        maxretries: 100,
        jsonPath: "$",
        jsonPathOperator: "!=",
        expectedValue: "",
        ...overrides,
    };
}

async function captureRealSnmpSession(run) {
    const originalCreateSession = snmp.createSession;
    const created = deferred();
    let capture;
    snmp.createSession = (...args) => {
        const session = originalCreateSession(...args);
        const socketClosed = deferred();
        const originalCancelRequests = session.cancelRequests.bind(session);
        const originalClose = session.close.bind(session);
        capture = {
            session,
            socketClosed,
            closeCalls: 0,
            canceledPendingRequestCounts: [],
        };
        session.cancelRequests = (error) => {
            capture.canceledPendingRequestCounts.push(session.reqCount);
            return originalCancelRequests(error);
        };
        session.close = () => {
            capture.closeCalls++;
            return originalClose();
        };
        session.once("close", socketClosed.resolve);
        created.resolve(capture);
        return session;
    };

    try {
        return await run(created);
    } finally {
        if (capture?.session.reqCount) {
            capture.session.cancelRequests(new Error("test cleanup"));
        }
        if (capture?.closeCalls === 0) {
            await settleWithin(capture.socketClosed.promise, 50);
        }
        if (capture?.closeCalls === 0) {
            try {
                capture.session.close();
            } catch {}
        }
        snmp.createSession = originalCreateSession;
    }
}

async function expectProviderStop(monitor, check, fixture) {
    const result = check().catch((error) => error);
    monitor.activeHeartbeat = result.then(() => {});
    await fixture.requestArrived.promise;
    const stopping = monitor.stop();
    expect(await settleWithin(stopping, 500)).toBe(true);
    await stopping;
    expect(await result).toBeInstanceOf(Error);
}

describe("monitor provider timeout cleanup", () => {
    test("SNMP enforces one deadline for 100 retries and closes the live UDP session", async () => {
        const fixture = await createHangingUdpServer();
        try {
            await captureRealSnmpSession(async (created) => {
                const started = performance.now();
                const result = new SNMPMonitorType()
                    .check(snmpMonitor({ port: fixture.port }), {})
                    .catch((error) => error);
                const capture = await created.promise;
                await fixture.requestArrived.promise;

                expect(await settleWithin(result, 120)).toBe(true);
                expect(await result).toBeInstanceOf(Error);
                expect(performance.now() - started).toBeLessThan(160);
                expect(await settleWithin(capture.socketClosed.promise, 100)).toBe(true);
                expect(capture.closeCalls).toBe(1);
                expect(capture.canceledPendingRequestCounts).toContain(1);
                expect(capture.session.reqCount).toBe(0);
                expect(fixture.requests).toBeGreaterThan(0);
            });
        } finally {
            await fixture.close();
        }
    });

    test("SNMP sanitizes legacy 1000 retries and lets monitor stop await real cleanup", async () => {
        const fixture = await createHangingUdpServer();
        try {
            await captureRealSnmpSession(async (created) => {
                const monitor = new Monitor();
                Object.assign(monitor, snmpMonitor({ port: fixture.port, maxretries: 1000 }));
                const check = new SNMPMonitorType().check(monitor, {});
                let settlements = 0;
                const result = check.then(
                    () => {
                        settlements++;
                    },
                    (error) => {
                        settlements++;
                        return error;
                    }
                );
                monitor.activeHeartbeat = result.then(() => {});
                const capture = await created.promise;
                await fixture.requestArrived.promise;

                const stopping = monitor.stop();
                expect(await settleWithin(stopping, 300)).toBe(true);
                await stopping;
                expect(await result).toBeInstanceOf(Error);
                expect(capture.session.retries).toBe(0);
                expect(await settleWithin(capture.socketClosed.promise, 100)).toBe(true);
                expect(capture.closeCalls).toBe(1);
                expect(capture.canceledPendingRequestCounts).toContain(1);
                await Bun.sleep(25);
                expect(settlements).toBe(1);
                expect(capture.session.reqCount).toBe(0);
            });
        } finally {
            await fixture.close();
        }
    });

    test("SNMP closes once across success, callback error, and synchronous session creation failure", async () => {
        const originalCreateSession = snmp.createSession;
        try {
            for (const outcome of ["success", "error", "empty"]) {
                const session = new EventEmitter();
                let callbacks = 0;
                let closeCalls = 0;
                session.close = () => {
                    closeCalls++;
                };
                session.cancelRequests = () => {};
                session.get = (_oids, callback) => {
                    callbacks++;
                    if (outcome === "success") {
                        callback(null, [{ type: snmp.ObjectType.OctetString, value: "ok" }]);
                        callback(new Error("late callback"));
                    } else if (outcome === "error") {
                        callback(new Error("expected callback error"));
                        callback(null, [{ type: snmp.ObjectType.OctetString, value: "late" }]);
                    } else {
                        callback(null, []);
                    }
                };
                snmp.createSession = () => session;
                const heartbeat = {};
                const check = new SNMPMonitorType().check(snmpMonitor(), heartbeat);
                if (outcome === "success") {
                    await check;
                    expect(heartbeat.status).toBe(1);
                } else if (outcome === "empty") {
                    await expect(check).rejects.toThrow("No varbinds returned from SNMP session");
                } else {
                    await expect(check).rejects.toThrow("expected callback error");
                }
                expect(callbacks).toBe(1);
                expect(closeCalls).toBe(1);
            }

            snmp.createSession = () => {
                throw new Error("session creation failed");
            };
            await expect(new SNMPMonitorType().check(snmpMonitor(), {})).rejects.toThrow("session creation failed");
        } finally {
            snmp.createSession = originalCreateSession;
        }
    });

    test("SNMP deadline deterministically cancels once and ignores a late callback", async () => {
        const originalCreateSession = snmp.createSession;
        const session = new EventEmitter();
        let callback;
        let cancelCalls = 0;
        let closeCalls = 0;
        let settlements = 0;
        session.get = (_oids, response) => {
            callback = response;
        };
        session.cancelRequests = (error) => {
            cancelCalls++;
            callback(error);
        };
        session.close = () => {
            closeCalls++;
        };
        snmp.createSession = () => session;
        jest.useFakeTimers();
        try {
            const result = new SNMPMonitorType().check(snmpMonitor(), {}).then(
                () => {
                    settlements++;
                },
                (error) => {
                    settlements++;
                    return error;
                }
            );
            jest.advanceTimersByTime(99);
            await Promise.resolve();
            expect(settlements).toBe(0);
            jest.advanceTimersByTime(1);
            expect(await result).toBeInstanceOf(Error);
            expect(cancelCalls).toBe(1);
            expect(closeCalls).toBe(1);
            expect(settlements).toBe(1);

            callback(null, [{ type: snmp.ObjectType.OctetString, value: "late" }]);
            await Promise.resolve();
            expect(settlements).toBe(1);
            expect(closeCalls).toBe(1);
        } finally {
            jest.useRealTimers();
            snmp.createSession = originalCreateSession;
        }
    });

    test("gRPC stop enforces monitor timeout and cancels the active call", async () => {
        const fixture = await createHangingGrpcServer();
        const monitor = new Monitor();
        Object.assign(monitor, {
            timeout: 0.1,
            grpcUrl: `127.0.0.1:${fixture.port}`,
            grpcProtobuf: testProto,
            grpcServiceName: "test.TestService",
            grpcMethod: "echo",
            grpcBody: JSON.stringify({ message: "test" }),
            keyword: "SUCCESS",
            grpcEnableTls: false,
            isInvertKeyword: () => false,
        });
        const result = new GrpcKeywordMonitorType().check(monitor, {}).catch((error) => error);
        monitor.activeHeartbeat = result.then(() => {});
        await fixture.requestArrived.promise;

        const stopping = monitor.stop();
        const stoppedByDeadline = await settleWithin(stopping, 500);
        if (!stoppedByDeadline) {
            fixture.server.forceShutdown();
        }
        await stopping;

        try {
            expect(stoppedByDeadline).toBe(true);
            expect(await settleWithin(fixture.requestCanceled.promise, 100)).toBe(true);
            expect(await result).toBeInstanceOf(Error);
        } finally {
            fixture.server.forceShutdown();
        }
    });

    test("PostgreSQL stop enforces monitor timeout and destroys the active socket", async () => {
        const fixture = await createHangingTcpServer();
        const monitor = new Monitor();
        Object.assign(monitor, {
            timeout: 0.1,
            databaseConnectionString: `postgresql://user:pass@127.0.0.1:${fixture.port}/db`,
            databaseQuery: "SELECT 1",
        });
        try {
            await expectProviderStop(monitor, () => new PostgresMonitorType().check(monitor, {}), fixture);
        } finally {
            await fixture.close();
        }
    });

    test("PostgreSQL legacy malformed timeout falls back and lets stop close the socket", async () => {
        const fixture = await createHangingTcpServer();
        const monitor = new Monitor();
        Object.assign(monitor, {
            interval: 1,
            timeout: "bogus",
            databaseConnectionString: `postgresql://user:pass@127.0.0.1:${fixture.port}/db`,
            databaseQuery: "SELECT 1",
        });
        const result = new PostgresMonitorType().check(monitor, {}).catch((error) => error);
        monitor.activeHeartbeat = result.then(() => {});
        let stopping;
        let stoppedByDeadline;
        try {
            await fixture.requestArrived.promise;
            stopping = monitor.stop();
            stoppedByDeadline = await settleWithin(stopping, 1_500);
            if (!stoppedByDeadline) {
                for (const socket of fixture.sockets) {
                    socket.destroy();
                }
            }
            await stopping;

            expect(stoppedByDeadline).toBe(true);
            expect(await result).toBeInstanceOf(Error);
        } finally {
            for (const socket of fixture.sockets) {
                socket.destroy();
            }
            await stopping?.catch(() => {});
            await fixture.close();
        }
    });

    test("MongoDB stop enforces monitor timeout and closes the active socket", async () => {
        const fixture = await createHangingTcpServer();
        const monitor = new Monitor();
        Object.assign(monitor, {
            timeout: 0.1,
            databaseConnectionString: `mongodb://127.0.0.1:${fixture.port}/db?directConnection=true`,
        });
        try {
            await expectProviderStop(monitor, () => new MongodbMonitorType().check(monitor, {}), fixture);
        } finally {
            await fixture.close();
        }
    });

    test("MySQL stop enforces monitor timeout and destroys the active socket", async () => {
        const fixture = await createHangingTcpServer();
        const monitor = new Monitor();
        Object.assign(monitor, {
            timeout: 0.1,
            databaseConnectionString: `mysql://user:pass@127.0.0.1:${fixture.port}/db`,
            databaseQuery: "SELECT 1",
        });
        try {
            await expectProviderStop(monitor, () => new MysqlMonitorType().check(monitor, {}), fixture);
        } finally {
            await fixture.close();
        }
    });

    test("Redis stop enforces monitor timeout and destroys the active socket", async () => {
        const fixture = await createHangingTcpServer();
        const monitor = new Monitor();
        Object.assign(monitor, {
            timeout: 0.1,
            databaseConnectionString: `redis://127.0.0.1:${fixture.port}`,
            ignoreTls: false,
        });
        try {
            await expectProviderStop(monitor, () => new RedisMonitorType().check(monitor, {}), fixture);
        } finally {
            await fixture.close();
        }
    });

    test("SMTP stop enforces monitor timeout and closes the active socket", async () => {
        const fixture = await createHangingTcpServer();
        const monitor = new Monitor();
        Object.assign(monitor, {
            timeout: 0.1,
            hostname: "127.0.0.1",
            port: fixture.port,
            smtpSecurity: "nostarttls",
        });
        try {
            await expectProviderStop(monitor, () => new SMTPMonitorType().check(monitor, {}), fixture);
        } finally {
            await fixture.close();
        }
    });

    test("MQTT stop enforces monitor timeout and forcibly closes the active socket", async () => {
        const fixture = await createHangingTcpServer();
        const monitor = new Monitor();
        Object.assign(monitor, {
            timeout: 0.1,
            hostname: "127.0.0.1",
            port: fixture.port,
            mqttTopic: "health",
            mqttSuccessMessage: "ok",
        });
        try {
            await expectProviderStop(monitor, () => new MqttMonitorType().check(monitor, {}), fixture);
        } finally {
            await fixture.close();
        }
    });

    test("process monitor timeout kills a child that ignores SIGTERM", async () => {
        const started = performance.now();
        const result = await runCommand("sh", ["-c", "trap '' TERM; while :; do :; done"], { timeout: 50 });
        expect(performance.now() - started).toBeLessThan(500);
        expect(result.code).not.toBe(0);
    });
});
