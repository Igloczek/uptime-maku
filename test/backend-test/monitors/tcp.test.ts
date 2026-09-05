// @ts-nocheck

import { describe, test, expect } from "bun:test";
import { TCPMonitorType } from "@/server/monitor-types/tcp";
import { UP, PENDING } from "@/constants";
import net from "net";
import { parseTlsAlertNumber, getTlsAlertName } from "@/server/monitor-types/tcp";

const isPublicNetworkTestsEnabled = (value) => value === "1";
const publicNetworkTest = isPublicNetworkTestsEnabled(process.env.IGLO_MONITOR_PUBLIC_NETWORK_TESTS) ? test : test.skip;

describe("TCP Monitor", () => {
    /**
     * Retries a test function with exponential backoff for external service reliability
     * @param {Function} testFn - Async function to retry
     * @param {object} heartbeat - Heartbeat object to reset between attempts
     * @param {number} maxAttempts - Maximum number of retry attempts (default: 5)
     * @returns {Promise<void>}
     */
    async function retryExternalService(testFn, heartbeat, maxAttempts = 5) {
        let lastError;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                await testFn();
                return; // Success, exit retry loop
            } catch (error) {
                lastError = error;
                // Reset heartbeat for next attempt
                heartbeat.msg = "";
                heartbeat.status = PENDING;
                // Wait a bit before retrying with exponential backoff
                if (attempt < maxAttempts) {
                    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
                }
            }
        }
        // If all retries failed, throw the last error
        throw lastError;
    }
    /**
     * Creates a TCP server on an ephemeral loopback port
     * @returns {Promise<net.Server>} A promise that resolves with the created server
     */
    async function createTCPServer() {
        return new Promise((resolve, reject) => {
            const server = net.createServer();

            server.listen({ host: "127.0.0.1", port: 0 }, () => {
                resolve(server);
            });

            server.on("error", (err) => {
                reject(err);
            });
        });
    }

    test("public network gate enables only the exact value 1", () => {
        expect([undefined, "0", "false", "1"].map(isPublicNetworkTestsEnabled)).toEqual([false, false, false, true]);
    });

    test("check() sets status to UP when TCP server is reachable", async () => {
        const server = await createTCPServer();
        const port = server.address().port;

        try {
            const tcpMonitor = new TCPMonitorType();

            const monitor = {
                hostname: "127.0.0.1",
                port: port,
                isEnabledExpiryNotification: () => false,
            };

            const heartbeat = {
                msg: "",
                status: PENDING,
            };

            await tcpMonitor.check(monitor, heartbeat, {});

            expect(heartbeat.status).toBe(UP);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    test("check() rejects with connection failed when TCP server is not running", async () => {
        const tcpMonitor = new TCPMonitorType();

        const monitor = {
            hostname: "127.0.0.1",
            port: 0,
            isEnabledExpiryNotification: () => false,
        };

        const heartbeat = {
            msg: "",
            status: PENDING,
        };

        await expect(tcpMonitor.check(monitor, heartbeat, {})).rejects.toEqual(new Error("Connection failed"));
    });

    // Opt-in until Chat 4 replaces these public endpoints with local TLS fixtures.
    publicNetworkTest("check() rejects when TLS certificate is expired or invalid", async () => {
        const tcpMonitor = new TCPMonitorType();

        const monitor = {
            hostname: "expired.badssl.com",
            port: 443,
            smtpSecurity: "secure",
            isEnabledExpiryNotification: () => true,
            handleTlsInfo: async (tlsInfo) => {
                return tlsInfo;
            },
        };

        const heartbeat = {
            msg: "",
            status: PENDING,
        };

        // Regex: contains with "TLS Connection failed:" or "Certificate is invalid"
        const regex = /TLS Connection failed:|Certificate is invalid/;

        await expect(tcpMonitor.check(monitor, heartbeat, {})).rejects.toThrow(regex);
    });

    publicNetworkTest("check() sets status to UP when TLS certificate is valid (SSL)", async () => {
        const tcpMonitor = new TCPMonitorType();

        const monitor = {
            hostname: "smtp.gmail.com",
            port: 465,
            smtpSecurity: "secure",
            isEnabledExpiryNotification: () => true,
            handleTlsInfo: async (tlsInfo) => {
                return tlsInfo;
            },
        };

        const heartbeat = {
            msg: "",
            status: PENDING,
        };

        await retryExternalService(async () => {
            await tcpMonitor.check(monitor, heartbeat, {});
        }, heartbeat);
        expect(heartbeat.status).toBe(UP);
    });

    publicNetworkTest("check() sets status to UP when TLS certificate is valid (STARTTLS)", async () => {
        const tcpMonitor = new TCPMonitorType();

        const monitor = {
            hostname: "smtp.gmail.com",
            port: 587,
            smtpSecurity: "starttls",
            isEnabledExpiryNotification: () => true,
            handleTlsInfo: async (tlsInfo) => {
                return tlsInfo;
            },
        };

        const heartbeat = {
            msg: "",
            status: PENDING,
        };

        await retryExternalService(async () => {
            await tcpMonitor.check(monitor, heartbeat, {});
        }, heartbeat);
        expect(heartbeat.status).toBe(UP);
    });

    publicNetworkTest("check() rejects when TLS certificate hostname does not match (STARTTLS)", async () => {
        const tcpMonitor = new TCPMonitorType();

        const monitor = {
            hostname: "wr-in-f108.1e100.net",
            port: 587,
            smtpSecurity: "starttls",
            isEnabledExpiryNotification: () => true,
            handleTlsInfo: async (tlsInfo) => {
                return tlsInfo;
            },
        };

        const heartbeat = {
            msg: "",
            status: PENDING,
        };

        const regex = /does not match certificate/;

        await expect(tcpMonitor.check(monitor, heartbeat, {})).rejects.toThrow(regex);
    });
    publicNetworkTest("check() sets status to UP for XMPP server with valid certificate (STARTTLS)", async () => {
        const tcpMonitor = new TCPMonitorType();

        const monitor = {
            hostname: "xmpp.earth",
            port: 5222,
            smtpSecurity: "starttls",
            isEnabledExpiryNotification: () => true,
            handleTlsInfo: async (tlsInfo) => {
                return tlsInfo;
            },
        };

        const heartbeat = {
            msg: "",
            status: PENDING,
        };

        await retryExternalService(async () => {
            await tcpMonitor.check(monitor, heartbeat, {});
        }, heartbeat);
        expect(heartbeat.status).toBe(UP);
    });

    // TLS Alert checking tests
    publicNetworkTest("check() rejects when expecting TLS alert but connection succeeds", async () => {
        const tcpMonitor = new TCPMonitorType();

        const monitor = {
            hostname: "google.com",
            port: 443,
            expected_tls_alert: "certificate_required",
            timeout: 10,
            isEnabledExpiryNotification: () => false,
            getIgnoreTls: () => false,
        };

        const heartbeat = {
            msg: "",
            status: PENDING,
        };

        // Retry with backoff for external service reliability, expecting rejection
        await retryExternalService(async () => {
            await expect(tcpMonitor.check(monitor, heartbeat, {})).rejects.toThrow(
                /Expected TLS alert 'certificate_required' but connection succeeded/
            );
        }, heartbeat);
    });

    test("parseTlsAlertNumber() extracts alert number from error message", async () => {
        // Test various error message formats
        expect(parseTlsAlertNumber("alert number 116")).toBe(116);
        expect(parseTlsAlertNumber("SSL alert number 42")).toBe(42);
        expect(parseTlsAlertNumber("TLS alert number 48")).toBe(48);
        expect(parseTlsAlertNumber("no alert here")).toBe(null);
        expect(parseTlsAlertNumber("")).toBe(null);
    });

    test("getTlsAlertName() returns correct alert name for known codes", async () => {
        expect(getTlsAlertName(116)).toBe("certificate_required");
        expect(getTlsAlertName(42)).toBe("bad_certificate");
        expect(getTlsAlertName(48)).toBe("unknown_ca");
        expect(getTlsAlertName(40)).toBe("handshake_failure");
        expect(getTlsAlertName(999)).toBe("unknown_alert_999");
    });
});
