// @ts-nocheck

import { describe, test, expect, mock, spyOn } from "bun:test";
import { encodeBase64 } from "@/server/http-utils";
import { UP, PENDING } from "@/constants";
import { GlobalpingMonitorType } from "@/server/monitor-types/globalping";

function createMonitorType() {
    return new GlobalpingMonitorType({}, { get: async () => null }, "test-agent/1.0");
}

describe("GlobalpingMonitorType", () => {
    test("bounded polling aborts the active Globalping fetch at the monitor deadline", async () => {
        const monitorType = createMonitorType();
        let aborted = false;
        const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((request) => {
            return new Promise((_, reject) => {
                request.signal.addEventListener(
                    "abort",
                    () => {
                        aborted = true;
                        reject(request.signal.reason);
                    },
                    { once: true }
                );
            });
        });
        const started = performance.now();
        try {
            await expect(
                monitorType.awaitMeasurement({ userAgent: "test-agent/1.0" }, "measurement-id", 50)
            ).rejects.toThrow();
            expect(aborted).toBe(true);
            expect(performance.now() - started).toBeLessThan(500);
        } finally {
            fetchSpy.mockRestore();
        }
    });

    describe("ping", () => {
        test("should handle successful ping", async () => {
            const monitorType = createMonitorType();
            const mockClient = createGlobalpingClientMock();
            const createResponse = createMockResponse({
                id: "2g8T7V3OwXG3JV6Y10011zF2v",
            });
            const measurement = createPingMeasurement();
            const awaitResponse = createMockResponse(measurement);

            mockClient.createMeasurement.mockImplementation(() => createResponse);
            mockClient.awaitMeasurement.mockImplementation(() => awaitResponse);

            const monitor = {
                hostname: "example.com",
                location: "North America",
                ping_count: 3,
                protocol: "ICMP",
                ipFamily: "ipv4",
            };

            const heartbeat = {
                status: PENDING,
                msg: "",
                ping: 0,
            };

            await monitorType.ping(mockClient, monitor, heartbeat, true);

            expect(mockClient.createMeasurement.mock.calls.length).toBe(1);
            expect(mockClient.createMeasurement.mock.calls[0][0]).toEqual({
                type: "ping",
                target: "example.com",
                inProgressUpdates: false,
                limit: 1,
                locations: [{ magic: "North America" }],
                measurementOptions: {
                    packets: 3,
                    protocol: "ICMP",
                    ipVersion: 4,
                },
            });

            expect(heartbeat).toEqual({
                status: UP,
                msg: "Ashburn (VA), US, NA, Amazon.com (AS14618), (aws-us-east-1) : OK",
                ping: 2.169,
            });
        });

        test("should handle failed ping with status failed", async () => {
            const monitorType = createMonitorType();
            const mockClient = createGlobalpingClientMock();
            const createResponse = createMockResponse({
                id: "2g8T7V3OwXG3JV6Y10011zF2v",
            });
            const measurement = createPingMeasurement();
            measurement.results[0].result.status = "failed";
            measurement.results[0].result.rawOutput = "Host unreachable";
            const awaitResponse = createMockResponse(measurement);

            mockClient.createMeasurement.mockImplementation(() => createResponse);
            mockClient.awaitMeasurement.mockImplementation(() => awaitResponse);

            const monitor = {
                hostname: "unreachable.example.com",
                location: "Europe",
                ping_count: 3,
                protocol: "ICMP",
            };

            const heartbeat = {
                status: PENDING,
                msg: "",
            };

            await expect(monitorType.ping(mockClient, monitor, heartbeat, true)).rejects.toEqual(
                new Error("Ashburn (VA), US, NA, Amazon.com (AS14618), (aws-us-east-1) : Failed: Host unreachable")
            );
        });

        test("should handle API error on create measurement", async () => {
            const monitorType = createMonitorType();
            const mockClient = createGlobalpingClientMock();
            const createResponse = createMockResponse({
                error: {
                    type: "validation_error",
                    message: "Invalid target",
                    params: { target: "example.com" },
                },
            });
            createResponse.ok = false;
            createResponse.response.status = 400;

            mockClient.createMeasurement.mockImplementation(() => createResponse);

            const monitor = {
                hostname: "example.com",
                location: "North America",
                ping_count: 3,
                protocol: "ICMP",
            };

            const heartbeat = {
                status: PENDING,
                msg: "",
            };

            await expect(monitorType.ping(mockClient, monitor, heartbeat, true)).rejects.toEqual(
                new Error("Failed to create measurement: validation_error Invalid target.\ntarget: example.com")
            );
        });

        test("should handle API error on await measurement", async () => {
            const monitorType = createMonitorType();
            const mockClient = createGlobalpingClientMock();
            const createResponse = createMockResponse({
                id: "2g8T7V3OwXG3JV6Y10011zF2v",
            });
            const awaitResponse = createMockResponse({
                error: {
                    type: "internal_error",
                    message: "Server error",
                },
            });
            awaitResponse.ok = false;
            awaitResponse.response.status = 400;

            mockClient.createMeasurement.mockImplementation(() => createResponse);
            mockClient.awaitMeasurement.mockImplementation(() => awaitResponse);

            const monitor = {
                hostname: "example.com",
                location: "North America",
                ping_count: 3,
                protocol: "ICMP",
            };

            const heartbeat = {
                status: PENDING,
                msg: "",
            };

            await expect(monitorType.ping(mockClient, monitor, heartbeat, true)).rejects.toEqual(
                new Error("Failed to fetch measurement (2g8T7V3OwXG3JV6Y10011zF2v): internal_error Server error.")
            );
        });

        test("should retry create measurement on status 500", async () => {
            const monitorType = createMonitorType();
            const mockClient = createGlobalpingClientMock();
            const createResponse = createMockResponse({
                id: "2g8T7V3OwXG3JV6Y10011zF2v",
            });
            const measurement = createPingMeasurement();
            const awaitResponse = createMockResponse(measurement);

            mockClient.createMeasurement.mockImplementationOnce(() => ({
                ok: false,
                response: {
                    status: 500,
                },
            }));
            mockClient.createMeasurement.mockImplementation(() => createResponse);
            mockClient.awaitMeasurement.mockImplementation(() => awaitResponse);

            const monitor = {
                hostname: "example.com",
                location: "North America",
                ping_count: 3,
                protocol: "ICMP",
                ipFamily: "ipv4",
            };

            const heartbeat = {
                status: PENDING,
                msg: "",
                ping: 0,
            };

            await monitorType.ping(mockClient, monitor, heartbeat, true);

            const expectedCreateMeasurement = {
                type: "ping",
                target: "example.com",
                inProgressUpdates: false,
                limit: 1,
                locations: [{ magic: "North America" }],
                measurementOptions: {
                    packets: 3,
                    protocol: "ICMP",
                    ipVersion: 4,
                },
            };
            expect(mockClient.createMeasurement.mock.calls.length).toBe(2);
            expect(mockClient.createMeasurement.mock.calls[0][0]).toEqual(expectedCreateMeasurement);
            expect(mockClient.createMeasurement.mock.calls[1][0]).toEqual(expectedCreateMeasurement);

            expect(heartbeat).toEqual({
                status: UP,
                msg: "Ashburn (VA), US, NA, Amazon.com (AS14618), (aws-us-east-1) : OK",
                ping: 2.169,
            });
        });
    });

    describe("http", () => {
        test("should handle successful HTTP request", async () => {
            const monitorType = createMonitorType();
            const mockClient = createGlobalpingClientMock();
            const createResponse = createMockResponse({
                id: "2g8T7V3OwXG3JV6Y10011zF2v",
            });
            const measurement = createHttpMeasurement();
            const awaitResponse = createMockResponse(measurement);

            mockClient.createMeasurement.mockImplementation(() => createResponse);
            mockClient.awaitMeasurement.mockImplementation(() => awaitResponse);

            const monitor = {
                url: "https://example.com:444/api/test?test=1",
                location: "North America",
                method: "GET",
                accepted_statuscodes_json: JSON.stringify(["200-299", "300-399"]),
                headers: '{"Test-Header": "Test-Value"}',
                ipFamily: "ipv4",
                dns_resolve_server: "8.8.8.8",
                auth_method: "basic",
                basic_auth_user: "username",
                basic_auth_pass: "password",
            };

            const heartbeat = {
                status: PENDING,
                msg: "",
                ping: 0,
            };

            await monitorType.http(mockClient, monitor, heartbeat, true);

            expect(mockClient.createMeasurement.mock.calls.length).toBe(1);
            const expectedToken = encodeBase64(monitor.basic_auth_user, monitor.basic_auth_pass);
            expect(mockClient.createMeasurement.mock.calls[0][0]).toEqual({
                type: "http",
                target: "example.com",
                inProgressUpdates: false,
                limit: 1,
                locations: [{ magic: "North America" }],
                measurementOptions: {
                    request: {
                        host: "example.com",
                        path: "/api/test",
                        query: "test=1",
                        method: "GET",
                        headers: {
                            "Test-Header": "Test-Value",
                            Authorization: `Basic ${expectedToken}`,
                        },
                    },
                    port: 444,
                    protocol: "HTTPS",
                    ipVersion: 4,
                    resolver: "8.8.8.8",
                },
            });

            expect(heartbeat).toEqual({
                status: UP,
                msg: "New York (NY), US, NA, MASSIVEGRID (AS49683) : OK",
                ping: 1440,
            });
        });

        test("should handle failed HTTP request", async () => {
            const monitorType = createMonitorType();
            const mockClient = createGlobalpingClientMock();
            const createResponse = createMockResponse({
                id: "2g8T7V3OwXG3JV6Y10011zF2v",
            });
            const measurement = createHttpMeasurement();
            measurement.results[0].result.status = "failed";
            measurement.results[0].result.rawOutput = "Host unreachable";
            const awaitResponse = createMockResponse(measurement);

            mockClient.createMeasurement.mockImplementation(() => createResponse);
            mockClient.awaitMeasurement.mockImplementation(() => awaitResponse);

            const monitor = {
                url: "https://example.com",
                location: "North America",
                method: "GET",
                accepted_statuscodes_json: JSON.stringify(["200-299", "300-399"]),
                headers: null,
            };

            const heartbeat = {
                status: PENDING,
                msg: "",
            };

            await expect(monitorType.http(mockClient, monitor, heartbeat, true)).rejects.toEqual(
                new Error("New York (NY), US, NA, MASSIVEGRID (AS49683) : Failed: Host unreachable")
            );
        });

        test("should handle API error on create measurement", async () => {
            const monitorType = createMonitorType();
            const mockClient = createGlobalpingClientMock();
            const createResponse = createMockResponse({
                error: {
                    type: "validation_error",
                    message: "Invalid target",
                    params: { target: "example.com" },
                },
            });
            createResponse.ok = false;
            createResponse.response.status = 400;

            mockClient.createMeasurement.mockImplementation(() => createResponse);

            const monitor = {
                url: "https://example.com",
                location: "North America",
                method: "GET",
                accepted_statuscodes_json: JSON.stringify(["200-299", "300-399"]),
                headers: null,
            };

            const heartbeat = {
                status: PENDING,
                msg: "",
            };

            await expect(monitorType.http(mockClient, monitor, heartbeat, true)).rejects.toEqual(
                new Error("Failed to create measurement: validation_error Invalid target.\ntarget: example.com")
            );
        });

        test("should handle API error on await measurement", async () => {
            const monitorType = createMonitorType();
            const mockClient = createGlobalpingClientMock();
            const createResponse = createMockResponse({
                id: "2g8T7V3OwXG3JV6Y10011zF2v",
            });
            const awaitResponse = createMockResponse({
                error: {
                    type: "internal_error",
                    message: "Server error",
                },
            });
            awaitResponse.ok = false;
            awaitResponse.response.status = 400;

            mockClient.createMeasurement.mockImplementation(() => createResponse);
            mockClient.awaitMeasurement.mockImplementation(() => awaitResponse);

            const monitor = {
                url: "https://example.com",
                location: "North America",
                method: "GET",
                accepted_statuscodes_json: JSON.stringify(["200-299", "300-399"]),
                headers: null,
            };

            const heartbeat = {
                status: PENDING,
                msg: "",
            };

            await expect(monitorType.http(mockClient, monitor, heartbeat, true)).rejects.toEqual(
                new Error("Failed to fetch measurement (2g8T7V3OwXG3JV6Y10011zF2v): internal_error Server error.")
            );
        });

        test("should handle invalid status code", async () => {
            const monitorType = createMonitorType();
            const mockClient = createGlobalpingClientMock();
            const createResponse = createMockResponse({
                id: "2g8T7V3OwXG3JV6Y10011zF2v",
            });
            const measurement = createHttpMeasurement();
            measurement.results[0].result.rawOutput = "RAW OUTPUT";
            const awaitResponse = createMockResponse(measurement);

            mockClient.createMeasurement.mockImplementation(() => createResponse);
            mockClient.awaitMeasurement.mockImplementation(() => awaitResponse);

            const monitor = {
                url: "https://example.com/api/test",
                location: "North America",
                method: "GET",
                accepted_statuscodes_json: JSON.stringify(["200-299"]),
                headers: null,
            };

            const heartbeat = {
                status: PENDING,
                msg: "",
                ping: 0,
            };

            await expect(monitorType.http(mockClient, monitor, heartbeat, true)).rejects.toEqual(
                new Error(
                    "New York (NY), US, NA, MASSIVEGRID (AS49683) : Status code 301 not accepted. Output: RAW OUTPUT"
                )
            );

            // heartbeat.ping should still be set before the error is thrown
            expect(heartbeat.ping).toBe(1440);
        });

        test("should handle keyword check (keyword present)", async () => {
            const monitorType = createMonitorType();
            const mockClient = createGlobalpingClientMock();
            const createResponse = createMockResponse({
                id: "2g8T7V3OwXG3JV6Y10011zF2v",
            });
            const measurement = createHttpMeasurement();
            measurement.results[0].result.rawOutput = "Response body with KEYWORD word";
            const awaitResponse = createMockResponse(measurement);

            mockClient.createMeasurement.mockImplementation(() => createResponse);
            mockClient.awaitMeasurement.mockImplementation(() => awaitResponse);

            const monitor = {
                url: "https://example.com",
                location: "North America",
                protocol: "HTTPS",
                accepted_statuscodes_json: JSON.stringify(["300-399"]),
                keyword: "KEYWORD",
                invertKeyword: false,
            };

            const heartbeat = {
                status: PENDING,
                msg: "",
            };

            await monitorType.http(mockClient, monitor, heartbeat, true);

            expect(heartbeat).toEqual({
                status: UP,
                msg: "New York (NY), US, NA, MASSIVEGRID (AS49683) : 301 - Moved Permanently, keyword is found",
                ping: 1440,
            });
        });

        test("should handle keyword check (keyword not present)", async () => {
            const monitorType = createMonitorType();
            const mockClient = createGlobalpingClientMock();
            const createResponse = createMockResponse({
                id: "2g8T7V3OwXG3JV6Y10011zF2v",
            });
            const measurement = createHttpMeasurement();
            measurement.results[0].result.rawOutput = "Response body with KEYWORD word";
            const awaitResponse = createMockResponse(measurement);

            mockClient.createMeasurement.mockImplementation(() => createResponse);
            mockClient.awaitMeasurement.mockImplementation(() => awaitResponse);

            const monitor = {
                url: "https://example.com",
                location: "North America",
                protocol: "HTTPS",
                accepted_statuscodes_json: JSON.stringify(["300-399"]),
                keyword: "MISSING_KEYWORD",
                invertKeyword: false,
            };

            const heartbeat = {
                status: PENDING,
                msg: "",
            };

            await expect(monitorType.http(mockClient, monitor, heartbeat, true)).rejects.toEqual(
                new Error(
                    "New York (NY), US, NA, MASSIVEGRID (AS49683) : 301 - Moved Permanently, but keyword is not in [Response body with KEYWORD word]"
                )
            );
        });

        test("should handle inverted keyword check", async () => {
            const monitorType = createMonitorType();
            const mockClient = createGlobalpingClientMock();
            const createResponse = createMockResponse({
                id: "2g8T7V3OwXG3JV6Y10011zF2v",
            });
            const measurement = createHttpMeasurement();
            measurement.results[0].result.rawOutput = "Response body with KEYWORD word";
            const awaitResponse = createMockResponse(measurement);

            mockClient.createMeasurement.mockImplementation(() => createResponse);
            mockClient.awaitMeasurement.mockImplementation(() => awaitResponse);

            const monitor = {
                url: "https://example.com",
                location: "North America",
                protocol: "HTTPS",
                accepted_statuscodes_json: JSON.stringify(["300-399"]),
                keyword: "ERROR",
                invertKeyword: true,
            };

            const heartbeat = {
                status: PENDING,
                msg: "",
            };

            await monitorType.http(mockClient, monitor, heartbeat, true);

            expect(heartbeat).toEqual({
                status: UP,
                msg: "New York (NY), US, NA, MASSIVEGRID (AS49683) : 301 - Moved Permanently, keyword not found",
                ping: 1440,
            });
        });

        test("should handle JSON query check (valid)", async () => {
            const monitorType = createMonitorType();
            const mockClient = createGlobalpingClientMock();
            const createResponse = createMockResponse({
                id: "2g8T7V3OwXG3JV6Y10011zF2v",
            });
            const measurement = createHttpMeasurement();
            measurement.results[0].result.rawOutput = JSON.stringify({
                status: "success",
                value: 42,
            });
            const awaitResponse = createMockResponse(measurement);

            mockClient.createMeasurement.mockImplementation(() => createResponse);
            mockClient.awaitMeasurement.mockImplementation(() => awaitResponse);

            const monitor = {
                url: "https://api.example.com/status",
                location: "North America",
                protocol: "HTTPS",
                accepted_statuscodes_json: JSON.stringify(["300-399"]),
                jsonPath: "$.status",
                jsonPathOperator: "==",
                expectedValue: "success",
            };

            const heartbeat = {
                status: PENDING,
                msg: "",
            };

            await monitorType.http(mockClient, monitor, heartbeat, true);

            expect(heartbeat).toEqual({
                status: UP,
                msg: "New York (NY), US, NA, MASSIVEGRID (AS49683) : JSON query passes (comparing success == success)",
                ping: 1440,
            });
        });

        test("should handle JSON query check (invalid)", async () => {
            const monitorType = createMonitorType();
            const mockClient = createGlobalpingClientMock();
            const createResponse = createMockResponse({
                id: "2g8T7V3OwXG3JV6Y10011zF2v",
            });
            const measurement = createHttpMeasurement();
            measurement.results[0].result.rawOutput = JSON.stringify({
                status: "failed",
                value: 42,
            });
            const awaitResponse = createMockResponse(measurement);

            mockClient.createMeasurement.mockImplementation(() => createResponse);
            mockClient.awaitMeasurement.mockImplementation(() => awaitResponse);

            const monitor = {
                url: "https://api.example.com/status",
                location: "North America",
                protocol: "HTTPS",
                accepted_statuscodes_json: JSON.stringify(["300-399"]),
                jsonPath: "$.status",
                jsonPathOperator: "==",
                expectedValue: "success",
            };

            const heartbeat = {
                status: PENDING,
                msg: "",
            };

            await expect(monitorType.http(mockClient, monitor, heartbeat, true)).rejects.toEqual(
                new Error(
                    "New York (NY), US, NA, MASSIVEGRID (AS49683) : JSON query does not pass (comparing failed == success)"
                )
            );
        });

        test("should retry create measurement on status 500", async () => {
            const monitorType = createMonitorType();
            const mockClient = createGlobalpingClientMock();
            const createResponse = createMockResponse({
                id: "2g8T7V3OwXG3JV6Y10011zF2v",
            });
            const measurement = createHttpMeasurement();
            const awaitResponse = createMockResponse(measurement);

            mockClient.createMeasurement.mockImplementationOnce(() => ({
                ok: false,
                response: {
                    status: 500,
                },
            }));
            mockClient.createMeasurement.mockImplementation(() => createResponse);
            mockClient.awaitMeasurement.mockImplementation(() => awaitResponse);

            const monitor = {
                url: "https://example.com:444/api/test?test=1",
                location: "North America",
                method: "GET",
                accepted_statuscodes_json: JSON.stringify(["200-299", "300-399"]),
                headers: '{"Test-Header": "Test-Value"}',
                ipFamily: "ipv4",
                dns_resolve_server: "8.8.8.8",
                auth_method: "basic",
                basic_auth_user: "username",
                basic_auth_pass: "password",
            };

            const heartbeat = {
                status: PENDING,
                msg: "",
                ping: 0,
            };

            await monitorType.http(mockClient, monitor, heartbeat, true);

            const expectedToken = encodeBase64(monitor.basic_auth_user, monitor.basic_auth_pass);
            const expectedCreateMeasurement = {
                type: "http",
                target: "example.com",
                inProgressUpdates: false,
                limit: 1,
                locations: [{ magic: "North America" }],
                measurementOptions: {
                    request: {
                        host: "example.com",
                        path: "/api/test",
                        query: "test=1",
                        method: "GET",
                        headers: {
                            "Test-Header": "Test-Value",
                            Authorization: `Basic ${expectedToken}`,
                        },
                    },
                    port: 444,
                    protocol: "HTTPS",
                    ipVersion: 4,
                    resolver: "8.8.8.8",
                },
            };
            expect(mockClient.createMeasurement.mock.calls.length).toBe(2);
            expect(mockClient.createMeasurement.mock.calls[0][0]).toEqual(expectedCreateMeasurement);
            expect(mockClient.createMeasurement.mock.calls[1][0]).toEqual(expectedCreateMeasurement);

            expect(heartbeat).toEqual({
                status: UP,
                msg: "New York (NY), US, NA, MASSIVEGRID (AS49683) : OK",
                ping: 1440,
            });
        });
    });

    describe("dns", () => {
        test("should handle successful dns", async () => {
            const monitorType = createMonitorType();
            const mockClient = createGlobalpingClientMock();
            const createResponse = createMockResponse({
                id: "2g8T7V3OwXG3JV6Y10011zF2v",
            });
            const measurement = createDnsMeasurement();
            const awaitResponse = createMockResponse(measurement);

            mockClient.createMeasurement.mockImplementation(() => createMockResponse(createResponse));
            mockClient.awaitMeasurement.mockImplementation(() => awaitResponse);

            const storeMock = createStoreMock();
            storeMock.exec.mockImplementation(() => Promise.resolve());

            const monitor = {
                id: "1",
                hostname: "example.com",
                location: "us-east-1",
                dns_resolve_type: "A",
                port: 53,
                protocol: "udp",
            };

            const heartbeat = {
                status: PENDING,
                msg: "",
                ping: null,
            };

            await monitorType.dns(mockClient, monitor, heartbeat, false, storeMock);

            expect(mockClient.createMeasurement.mock.calls.length).toBe(1);
            expect(mockClient.createMeasurement.mock.calls[0][0]).toEqual({
                type: "dns",
                target: "example.com",
                inProgressUpdates: false,
                limit: 1,
                locations: [{ magic: "us-east-1" }],
                measurementOptions: {
                    query: { type: "A" },
                    port: 53,
                    protocol: "udp",
                },
            });

            expect(heartbeat).toEqual({
                status: UP,
                msg: "New York (NY), US, NA, MASSIVEGRID (AS49683) : 93.184.216.34",
                ping: 25,
            });

            expect(storeMock.exec.mock.calls.length).toBe(1);
            expect(storeMock.exec.mock.calls[0]).toEqual([
                "UPDATE `monitor` SET dns_last_result = ? WHERE id = ? ",
                ["93.184.216.34", "1"],
            ]);
        });

        test("should handle failed dns with status failed", async () => {
            const monitorType = createMonitorType();
            const mockClient = createGlobalpingClientMock();
            const createResponse = createMockResponse({
                id: "2g8T7V3OwXG3JV6Y10011zF2v",
            });
            const measurement = createDnsMeasurement();
            measurement.results[0].result.status = "failed";
            measurement.results[0].result.rawOutput = "NXDOMAIN";
            const awaitResponse = createMockResponse(measurement);

            mockClient.createMeasurement.mockImplementation(() => createMockResponse(createResponse));
            mockClient.awaitMeasurement.mockImplementation(() => awaitResponse);

            const monitor = {
                hostname: "nonexistent.example.com",
                location: "us-east-1",
                dns_resolve_type: "A",
                port: 53,
            };

            const heartbeat = {
                status: PENDING,
                msg: "",
            };

            await expect(monitorType.dns(mockClient, monitor, heartbeat, false)).rejects.toThrow(
                "New York (NY), US, NA, MASSIVEGRID (AS49683) : Failed: NXDOMAIN"
            );
        });

        test("should handle API error on create measurement", async () => {
            const monitorType = createMonitorType();
            const mockClient = createGlobalpingClientMock();
            const createResponse = createMockResponse({
                error: {
                    type: "validation_error",
                    message: "Invalid target",
                    params: { target: "example.com" },
                },
            });
            createResponse.ok = false;
            createResponse.response.status = 400;

            mockClient.createMeasurement.mockImplementation(() => createResponse);

            const monitor = {
                hostname: "example.com",
                location: "us-east-1",
                dns_resolve_type: "A",
                port: 53,
            };

            const heartbeat = {
                status: PENDING,
                msg: "",
            };

            await expect(monitorType.dns(mockClient, monitor, heartbeat, false)).rejects.toEqual(
                new Error("Failed to create measurement: validation_error Invalid target.\ntarget: example.com")
            );
        });

        test("should handle API error on await measurement", async () => {
            const monitorType = createMonitorType();
            const mockClient = createGlobalpingClientMock();
            const createResponse = createMockResponse({
                id: "2g8T7V3OwXG3JV6Y10011zF2v",
            });
            const awaitResponse = createMockResponse({
                error: {
                    type: "internal_error",
                    message: "Server error",
                },
            });
            awaitResponse.ok = false;
            awaitResponse.response.status = 400;

            mockClient.createMeasurement.mockImplementation(() => createResponse);
            mockClient.awaitMeasurement.mockImplementation(() => awaitResponse);

            const monitor = {
                hostname: "example.com",
                location: "us-east-1",
                dns_resolve_type: "A",
                port: 53,
            };

            const heartbeat = {
                status: PENDING,
                msg: "",
            };

            await expect(monitorType.dns(mockClient, monitor, heartbeat, false)).rejects.toEqual(
                new Error("Failed to fetch measurement (2g8T7V3OwXG3JV6Y10011zF2v): internal_error Server error.")
            );
        });

        test("should handle regex matched", async () => {
            const monitorType = createMonitorType();
            const mockClient = createGlobalpingClientMock();
            const createResponse = {
                id: "2g8T7V3OwXG3JV6Y10011zF2v",
            };
            const measurement = createDnsMeasurement();
            const awaitResponse = createMockResponse(measurement);

            mockClient.createMeasurement.mockImplementation(() => createMockResponse(createResponse));
            mockClient.awaitMeasurement.mockImplementation(() => awaitResponse);

            const storeMock = createStoreMock();
            storeMock.exec.mockImplementation(() => Promise.resolve());

            const monitor = {
                id: "1",
                hostname: "example.com",
                location: "us-east-1",
                dns_resolve_type: "A",
                port: 53,
                protocol: "udp",
                keyword: "93\\.184\\.216\\.34",
            };

            const heartbeat = {
                status: PENDING,
                msg: "",
                ping: null,
            };

            await monitorType.dns(mockClient, monitor, heartbeat, false, storeMock);

            expect(heartbeat).toEqual({
                status: UP,
                msg: "New York (NY), US, NA, MASSIVEGRID (AS49683) : 93.184.216.34",
                ping: 25,
            });

            expect(storeMock.exec.mock.calls[0]).toEqual([
                "UPDATE `monitor` SET dns_last_result = ? WHERE id = ? ",
                ["93.184.216.34", "1"],
            ]);
        });

        test("should handle regex not matched", async () => {
            const monitorType = createMonitorType();
            const mockClient = createGlobalpingClientMock();
            const createResponse = {
                id: "2g8T7V3OwXG3JV6Y10011zF2v",
            };
            const measurement = createDnsMeasurement();
            const awaitResponse = createMockResponse(measurement);

            mockClient.createMeasurement.mockImplementation(() => createMockResponse(createResponse));
            mockClient.awaitMeasurement.mockImplementation(() => awaitResponse);

            const storeMock = createStoreMock();
            storeMock.exec.mockImplementation(() => Promise.resolve());

            const monitor = {
                id: "1",
                hostname: "example.com",
                location: "us-east-1",
                dns_resolve_type: "A",
                port: 53,
                protocol: "udp",
                keyword: "192\\.168\\.1\\.1",
            };

            const heartbeat = {
                status: PENDING,
                msg: "",
            };

            await expect(monitorType.dns(mockClient, monitor, heartbeat, false, storeMock)).rejects.toEqual(
                new Error("New York (NY), US, NA, MASSIVEGRID (AS49683) : No record matched. 93.184.216.34")
            );

            expect(storeMock.exec.mock.calls[0]).toEqual([
                "UPDATE `monitor` SET dns_last_result = ? WHERE id = ? ",
                ["93.184.216.34", "1"],
            ]);
        });

        test("should retry create measurement on status 500", async () => {
            const monitorType = createMonitorType();
            const mockClient = createGlobalpingClientMock();
            const createResponse = createMockResponse({
                id: "2g8T7V3OwXG3JV6Y10011zF2v",
            });
            const measurement = createDnsMeasurement();
            const awaitResponse = createMockResponse(measurement);

            mockClient.createMeasurement.mockImplementationOnce(() => ({
                ok: false,
                response: {
                    status: 500,
                },
            }));
            mockClient.createMeasurement.mockImplementation(() => createMockResponse(createResponse));
            mockClient.awaitMeasurement.mockImplementation(() => awaitResponse);

            const storeMock = createStoreMock();
            storeMock.exec.mockImplementation(() => Promise.resolve());

            const monitor = {
                id: "1",
                hostname: "example.com",
                location: "us-east-1",
                dns_resolve_type: "A",
                port: 53,
                protocol: "udp",
            };

            const heartbeat = {
                status: PENDING,
                msg: "",
                ping: null,
            };

            await monitorType.dns(mockClient, monitor, heartbeat, false, storeMock);

            const expectedCreateMeasurement = {
                type: "dns",
                target: "example.com",
                inProgressUpdates: false,
                limit: 1,
                locations: [{ magic: "us-east-1" }],
                measurementOptions: {
                    query: { type: "A" },
                    port: 53,
                    protocol: "udp",
                },
            };
            expect(mockClient.createMeasurement.mock.calls.length).toBe(2);
            expect(mockClient.createMeasurement.mock.calls[0][0]).toEqual(expectedCreateMeasurement);
            expect(mockClient.createMeasurement.mock.calls[1][0]).toEqual(expectedCreateMeasurement);

            expect(heartbeat).toEqual({
                status: UP,
                msg: "New York (NY), US, NA, MASSIVEGRID (AS49683) : 93.184.216.34",
                ping: 25,
            });

            expect(storeMock.exec.mock.calls.length).toBe(1);
            expect(storeMock.exec.mock.calls[0]).toEqual([
                "UPDATE `monitor` SET dns_last_result = ? WHERE id = ? ",
                ["93.184.216.34", "1"],
            ]);
        });
    });

    describe("helper methods", () => {
        test("formatProbeLocation should format location correctly", () => {
            const monitorType = createMonitorType();

            const probe = {
                city: "New York",
                state: "NY",
                country: "US",
                continent: "NA",
                network: "Amazon.com",
                asn: 14618,
                tags: ["aws-us-east-1", "datacenter"],
            };

            const result = monitorType.formatProbeLocation(probe);

            expect(result).toBe("New York (NY), US, NA, Amazon.com (AS14618), (aws-us-east-1)");
        });

        test("formatProbeLocation should handle missing state", () => {
            const monitorType = createMonitorType();

            const probe = {
                city: "London",
                state: null,
                country: "GB",
                continent: "EU",
                network: "Example Network",
                asn: 12345,
                tags: [],
            };

            const result = monitorType.formatProbeLocation(probe);

            expect(result).toBe("London, GB, EU, Example Network (AS12345)");
        });

        test("formatResponse should combine location and text", () => {
            const monitorType = createMonitorType();

            const probe = {
                city: "Tokyo",
                state: null,
                country: "JP",
                continent: "AS",
                network: "Example ISP",
                asn: 54321,
                tags: [],
            };

            const result = monitorType.formatResponse(probe, "Test message");

            expect(result).toBe("Tokyo, JP, AS, Example ISP (AS54321) : Test message");
        });

        test("formatApiError should format error with params", () => {
            const monitorType = createMonitorType();

            const error = {
                type: "validation_error",
                message: "Invalid request",
                params: {
                    field: "target",
                    value: "invalid",
                },
            };

            const result = monitorType.formatApiError(error);

            expect(result).toBe("validation_error Invalid request.\nfield: target\nvalue: invalid");
        });

        test("formatApiError should format error without params", () => {
            const monitorType = createMonitorType();

            const error = {
                type: "internal_error",
                message: "Server error",
            };

            const result = monitorType.formatApiError(error);

            expect(result).toBe("internal_error Server error.");
        });

        test("formatTooManyRequestsError with API token", () => {
            const monitorType = createMonitorType();

            const result = monitorType.formatTooManyRequestsError(true);

            expect(result).toBe(
                "You have run out of credits. Get higher limits by sponsoring us or hosting probes. Learn more at https://dash.globalping.io?view=add-credits."
            );
        });

        test("formatTooManyRequestsError without API token", () => {
            const monitorType = createMonitorType();

            const result = monitorType.formatTooManyRequestsError(false);

            expect(result).toBe(
                "You have run out of credits. Get higher limits by creating an account. Sign up at https://dash.globalping.io?view=add-credits."
            );
        });

        test("getBasicAuthHeader should return empty for non-basic auth", () => {
            const monitorType = createMonitorType();

            const monitor = {
                auth_method: "none",
            };

            const result = monitorType.getBasicAuthHeader(monitor);

            expect(result).toEqual({});
        });

        test("getBasicAuthHeader should return Authorization header", () => {
            const monitorType = createMonitorType();

            const monitor = {
                auth_method: "basic",
                basic_auth_user: "testuser",
                basic_auth_pass: "testpass",
            };

            const result = monitorType.getBasicAuthHeader(monitor);

            const expectedToken = encodeBase64(monitor.basic_auth_user, monitor.basic_auth_pass);

            expect(result.Authorization).toBe(`Basic ${expectedToken}`);
        });
    });
});

/**
 * Reusable mock factory for Globalping client
 * @returns {object} Mocked Globalping client
 */
function createGlobalpingClientMock() {
    return {
        createMeasurement: mock(() => undefined),
        awaitMeasurement: mock(() => undefined),
    };
}

/**
 * Reusable mock factory for the SQLite store
 * @returns {object} Mocked SQLite store
 */
function createStoreMock() {
    return {
        exec: mock(() => undefined),
    };
}

/**
 * Reusable mock factory for Globalping response
 * @param {object} data Response data
 * @returns {object} Mocked Globalping response
 */
function createMockResponse(data) {
    return {
        ok: true,
        response: {
            status: 200,
        },
        data,
    };
}

/**
 * Creates a successful ping measurement response
 * @returns {object} Mock measurement response
 */
function createPingMeasurement() {
    return {
        id: "2g8T7V3OwXG3JV6Y10011zF2v",
        type: "ping",
        status: "finished",
        createdAt: "2025-11-05T08:25:33.173Z",
        updatedAt: "2025-11-05T08:25:34.750Z",
        target: "google.com",
        probesCount: 1,
        locations: [{ magic: "us-east-1" }],
        results: [
            {
                probe: {
                    continent: "NA",
                    region: "Northern America",
                    country: "US",
                    state: "VA",
                    city: "Ashburn",
                    asn: 14618,
                    longitude: -77.49,
                    latitude: 39.04,
                    network: "Amazon.com",
                    tags: [
                        "aws-us-east-1",
                        "aws",
                        "datacenter-network",
                        "u-cloudlookingglass:aws-us-east-1-use1-az6",
                        "u-cloudlookingglass:aws-us-east-1-use1-az6-net",
                    ],
                    resolvers: ["private"],
                },
                result: {
                    status: "finished",
                    rawOutput:
                        "PING  (142.251.16.100) 56(84) bytes of data.\n64 bytes from bl-in-f100.1e100.net (142.251.16.100): icmp_seq=1 ttl=106 time=2.07 ms\n64 bytes from bl-in-f100.1e100.net (142.251.16.100): icmp_seq=2 ttl=106 time=2.08 ms\n64 bytes from bl-in-f100.1e100.net (142.251.16.100): icmp_seq=3 ttl=106 time=2.35 ms\n\n---  ping statistics ---\n3 packets transmitted, 3 received, 0% packet loss, time 1002ms\nrtt min/avg/max/mdev = 2.073/2.169/2.351/0.128 ms",
                    resolvedAddress: "142.251.16.100",
                    resolvedHostname: "bl-in-f100.1e100.net",
                    timings: [
                        { ttl: 106, rtt: 2.07 },
                        { ttl: 106, rtt: 2.08 },
                        { ttl: 106, rtt: 2.35 },
                    ],
                    stats: {
                        min: 2.073,
                        max: 2.351,
                        avg: 2.169,
                        total: 3,
                        loss: 0,
                        rcv: 3,
                        drop: 0,
                    },
                },
            },
        ],
    };
}

/**
 * Creates a successful HTTP measurement response
 * @returns {object} Mock measurement response
 */
function createHttpMeasurement() {
    return {
        id: "2m6DeD067jeT6licX0011zF2x",
        type: "http",
        status: "finished",
        createdAt: "2025-11-05T08:27:29.034Z",
        updatedAt: "2025-11-05T08:27:30.718Z",
        target: "google.com",
        probesCount: 1,
        locations: [{ magic: "New York" }],
        results: [
            {
                probe: {
                    continent: "NA",
                    region: "Northern America",
                    country: "US",
                    state: "NY",
                    city: "New York",
                    asn: 49683,
                    longitude: -74.01,
                    latitude: 40.71,
                    network: "MASSIVEGRID",
                    tags: ["datacenter-network", "u-gbzret4d"],
                    resolvers: ["private"],
                },
                result: {
                    status: "finished",
                    resolvedAddress: "209.85.201.101",
                    headers: {
                        location: "https://www.google.com/",
                        "content-type": "text/html; charset=UTF-8",
                        "content-security-policy-report-only":
                            "object-src 'none';base-uri 'self';script-src 'nonce-Eft2LKpM01f69RvQoV6QJA' 'strict-dynamic' 'report-sample' 'unsafe-eval' 'unsafe-inline' https: http:;report-uri https://csp.withgoogle.com/csp/gws/other-hp",
                        date: "Wed, 05 Nov 2025 08:27:30 GMT",
                        expires: "Fri, 05 Dec 2025 08:27:30 GMT",
                        "cache-control": "public, max-age=2592000",
                        server: "gws",
                        "content-length": "220",
                        "x-xss-protection": "0",
                        "x-frame-options": "SAMEORIGIN",
                        "alt-svc": 'h3=":443"; ma=2592000,h3-29=":443"; ma=2592000',
                        connection: "close",
                    },
                    rawHeaders:
                        "Location: https://www.google.com/\nContent-Type: text/html; charset=UTF-8\nContent-Security-Policy-Report-Only: object-src 'none';base-uri 'self';script-src 'nonce-Eft2LKpM01f69RvQoV6QJA' 'strict-dynamic' 'report-sample' 'unsafe-eval' 'unsafe-inline' https: http:;report-uri https://csp.withgoogle.com/csp/gws/other-hp\nDate: Wed, 05 Nov 2025 08:27:30 GMT\nExpires: Fri, 05 Dec 2025 08:27:30 GMT\nCache-Control: public, max-age=2592000\nServer: gws\nContent-Length: 220\nX-XSS-Protection: 0\nX-Frame-Options: SAMEORIGIN\nAlt-Svc: h3=\":443\"; ma=2592000,h3-29=\":443\"; ma=2592000\nConnection: close",
                    rawBody: null,
                    rawOutput:
                        "HTTP/1.1 301\nLocation: https://www.google.com/\nContent-Type: text/html; charset=UTF-8\nContent-Security-Policy-Report-Only: object-src 'none';base-uri 'self';script-src 'nonce-Eft2LKpM01f69RvQoV6QJA' 'strict-dynamic' 'report-sample' 'unsafe-eval' 'unsafe-inline' https: http:;report-uri https://csp.withgoogle.com/csp/gws/other-hp\nDate: Wed, 05 Nov 2025 08:27:30 GMT\nExpires: Fri, 05 Dec 2025 08:27:30 GMT\nCache-Control: public, max-age=2592000\nServer: gws\nContent-Length: 220\nX-XSS-Protection: 0\nX-Frame-Options: SAMEORIGIN\nAlt-Svc: h3=\":443\"; ma=2592000,h3-29=\":443\"; ma=2592000\nConnection: close",
                    truncated: false,
                    statusCode: 301,
                    statusCodeName: "Moved Permanently",
                    timings: {
                        total: 1440,
                        download: 1,
                        firstByte: 1391,
                        dns: 9,
                        tls: 22,
                        tcp: 16,
                    },
                },
            },
        ],
    };
}

/**
 * Creates a successful DNS measurement response
 * @returns {object} Mock measurement response
 */
function createDnsMeasurement() {
    return {
        id: "2g8T7V3OwXG3JV6Y10011zF2v",
        type: "dns",
        status: "finished",
        createdAt: "2025-11-05T08:30:00.000Z",
        updatedAt: "2025-11-05T08:30:01.000Z",
        target: "example.com",
        probesCount: 1,
        locations: [{ magic: "us-east-1" }],
        results: [
            {
                probe: {
                    continent: "NA",
                    region: "Northern America",
                    country: "US",
                    state: "NY",
                    city: "New York",
                    asn: 49683,
                    longitude: -74.01,
                    latitude: 40.71,
                    network: "MASSIVEGRID",
                    tags: ["datacenter-network", "u-gbzret4d"],
                    resolvers: ["private"],
                },
                result: {
                    status: "finished",
                    rawOutput: ";; ANSWER SECTION:\nexample.com.\t\t86400\tIN\tA\t93.184.216.34",
                    answers: [
                        {
                            name: "example.com.",
                            type: "A",
                            ttl: 86400,
                            class: "IN",
                            value: "93.184.216.34",
                        },
                    ],
                    timings: {
                        total: 25,
                    },
                },
            },
        ],
    };
}
