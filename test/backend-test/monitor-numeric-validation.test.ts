// @ts-nocheck

import { beforeAll, describe, expect, test } from "bun:test";
import {
    MAX_INTERVAL_SECOND,
    PING_COUNT_MAX,
    PING_PACKET_SIZE_MAX,
    PING_PER_REQUEST_TIMEOUT_MAX,
    RESPONSE_BODY_LENGTH_MAX,
} from "@/constants";

let Monitor;

beforeAll(async () => {
    await import("@/server/sqlite-store");
    Monitor = (await import("@/server/model/monitor")).default;
});

const TIMEOUT_ERROR = `Timeout must be 0 or a finite number between 0.1 and ${MAX_INTERVAL_SECOND} seconds`;
const MAX_MONITOR_RETRIES = 100;
const MAX_MONITOR_REDIRECTS = 100;

function monitor(overrides = {}) {
    const model = new Monitor();
    Object.assign(model, {
        type: "http",
        interval: 60,
        retryInterval: 20,
        resendInterval: 0,
        maxretries: 0,
        timeout: 1,
        maxredirects: 10,
        response_max_length: 1024,
        port: null,
        ...overrides,
    });
    return model;
}

function expectInvalid(field, values, message) {
    for (const value of values) {
        const model = monitor({ [field]: value });
        expect(() => model.validate(), `${field}=${String(value)}`).toThrow(message);
    }
}

describe("monitor numeric validation", () => {
    test("validate() normalizes numeric WebSocket strings before persistence", () => {
        const model = monitor({
            interval: "60",
            retryInterval: "20",
            resendInterval: "3",
            maxretries: "2",
            timeout: "0.25",
            maxredirects: "10",
            response_max_length: "1024",
            port: "5432",
        });

        model.validate();

        expect({
            interval: model.interval,
            retryInterval: model.retryInterval,
            resendInterval: model.resendInterval,
            maxretries: model.maxretries,
            timeout: model.timeout,
            maxredirects: model.maxredirects,
            response_max_length: model.response_max_length,
            port: model.port,
        }).toEqual({
            interval: 60,
            retryInterval: 20,
            resendInterval: 3,
            maxretries: 2,
            timeout: 0.25,
            maxredirects: 10,
            response_max_length: 1024,
            port: 5432,
        });
    });

    test("validate() preserves zero and UI-representable provider timeout values", () => {
        for (const value of [0, "0", "0.0", 0.1, "0.25", MAX_INTERVAL_SECOND]) {
            const model = monitor({ timeout: value });
            model.validate();
            expect(model.timeout).toBe(Number(value));
        }
    });

    test("validate() respects Oracle's one-second connection timeout granularity", () => {
        const error = `Oracle timeout must be 0 or a finite number between 1 and ${MAX_INTERVAL_SECOND} seconds`;
        for (const value of [0.1, 0.999]) {
            expect(() => monitor({ type: "oracledb", timeout: value }).validate()).toThrow(error);
            expect(monitor({ type: "oracledb", interval: 60, timeout: value }).getEffectiveTimeout()).toBe(48);
        }
        expect(monitor({ type: "oracledb", interval: 1, timeout: 0.1 }).getEffectiveTimeout()).toBe(1);
        for (const value of [0, 1, "1", MAX_INTERVAL_SECOND]) {
            const model = monitor({ type: "oracledb", timeout: value });
            model.validate();
            expect(model.timeout).toBe(Number(value));
        }
    });

    test("validate() rejects malformed, non-finite, negative, missing, and overflowing timeouts", () => {
        expectInvalid(
            "timeout",
            [
                "",
                "   ",
                "bogus",
                NaN,
                Infinity,
                -Infinity,
                Number.MIN_VALUE,
                0.001,
                0.099,
                0.000999,
                -0.001,
                MAX_INTERVAL_SECOND + 1,
                null,
                undefined,
                true,
                false,
                {},
                [],
            ],
            TIMEOUT_ERROR
        );
    });

    test("validate() bounds integral scheduling and retry fields", () => {
        const cases = [
            [
                "interval",
                ["", "bogus", NaN, Infinity, -Infinity, 0, -1, 1.5, MAX_INTERVAL_SECOND + 1, null, undefined],
                `Interval must be an integer between 1 and ${MAX_INTERVAL_SECOND} seconds`,
            ],
            [
                "retryInterval",
                ["", "bogus", NaN, Infinity, -Infinity, 0, -1, 1.5, MAX_INTERVAL_SECOND + 1, null, undefined],
                `Retry interval must be an integer between 1 and ${MAX_INTERVAL_SECOND} seconds`,
            ],
            [
                "maxretries",
                [
                    "",
                    "bogus",
                    NaN,
                    Infinity,
                    -Infinity,
                    -1,
                    0.5,
                    MAX_MONITOR_RETRIES + 1,
                    1000,
                    Number.MAX_SAFE_INTEGER,
                    null,
                    undefined,
                ],
                `Retries must be an integer between 0 and ${MAX_MONITOR_RETRIES}`,
            ],
            [
                "resendInterval",
                ["", "bogus", NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, undefined],
                "Resend interval must be a non-negative safe integer",
            ],
        ];

        for (const [field, values, message] of cases) {
            expectInvalid(field, values, message);
        }
    });

    test("validate() bounds HTTP counts and persisted response length", () => {
        expectInvalid(
            "maxredirects",
            [
                "",
                "bogus",
                NaN,
                Infinity,
                -Infinity,
                -1,
                0.5,
                MAX_MONITOR_REDIRECTS + 1,
                1000,
                Number.MAX_SAFE_INTEGER,
                null,
                undefined,
            ],
            `Max redirects must be an integer between 0 and ${MAX_MONITOR_REDIRECTS}`
        );
        expectInvalid(
            "response_max_length",
            ["", "bogus", NaN, Infinity, -Infinity, -1, 0.5, RESPONSE_BODY_LENGTH_MAX + 1, null, undefined],
            `Response max length must be an integer between 0 and ${RESPONSE_BODY_LENGTH_MAX} bytes`
        );
    });

    test("validate() accepts retry and redirect boundary values", () => {
        for (const value of [0, "0", MAX_MONITOR_RETRIES, String(MAX_MONITOR_RETRIES)]) {
            const model = monitor({ maxretries: value });
            model.validate();
            expect(model.maxretries).toBe(Number(value));
        }
        for (const value of [0, "0", MAX_MONITOR_REDIRECTS, String(MAX_MONITOR_REDIRECTS)]) {
            const model = monitor({ maxredirects: value });
            model.validate();
            expect(model.maxredirects).toBe(Number(value));
        }
    });

    test("validate() normalizes optional ports and rejects invalid endpoints", () => {
        for (const value of ["", "   ", null, undefined]) {
            const model = monitor({ port: value });
            model.validate();
            expect(model.port).toBeNull();
        }
        for (const value of ["0", 0, "65535", 65535]) {
            const model = monitor({ port: value });
            model.validate();
            expect(model.port).toBe(Number(value));
        }
        expectInvalid(
            "port",
            ["bogus", "80garbage", NaN, Infinity, -Infinity, -1, 1.5, 65536],
            "Port must be an integer between 0 and 65535"
        );
    });

    test("validate() normalizes and bounds ping scheduling fields", () => {
        const model = monitor({
            type: "ping",
            timeout: "10.4",
            packetSize: "56",
            ping_count: "3",
            ping_per_request_timeout: "2",
        });
        model.validate();
        expect(model.timeout).toBe(10);
        expect(model.packetSize).toBe(56);
        expect(model.ping_count).toBe(3);
        expect(model.ping_per_request_timeout).toBe(2);

        const fields = [
            [
                "packetSize",
                ["", "bogus", NaN, Infinity, -Infinity, 0, -1, 1.5, PING_PACKET_SIZE_MAX + 1, null, undefined],
                `Packet size must be an integer between 1 and ${PING_PACKET_SIZE_MAX}`,
            ],
            [
                "ping_count",
                ["", "bogus", NaN, Infinity, -Infinity, 0, -1, 1.5, PING_COUNT_MAX + 1, null, undefined],
                `Echo requests count must be an integer between 1 and ${PING_COUNT_MAX}`,
            ],
            [
                "ping_per_request_timeout",
                ["", "bogus", NaN, Infinity, -Infinity, 0, -1, 1.5, PING_PER_REQUEST_TIMEOUT_MAX + 1, null, undefined],
                `Per-ping timeout must be an integer between 1 and ${PING_PER_REQUEST_TIMEOUT_MAX} seconds`,
            ],
        ];
        for (const [field, values, message] of fields) {
            for (const value of values) {
                const invalid = monitor({
                    type: "ping",
                    timeout: 10,
                    packetSize: 56,
                    ping_count: 3,
                    ping_per_request_timeout: 2,
                    [field]: value,
                });
                expect(() => invalid.validate(), `${field}=${String(value)}`).toThrow(message);
            }
        }
    });

    test("validate() persists real-browser delay as a finite integer", () => {
        const model = monitor({ type: "real-browser", screenshot_delay: "250" });
        model.validate();
        expect(model.screenshot_delay).toBe(250);

        for (const value of ["", "bogus", NaN, Infinity, -Infinity, -1, 0.5, null, undefined]) {
            const invalid = monitor({ type: "real-browser", screenshot_delay: value });
            expect(() => invalid.validate(), `screenshot_delay=${String(value)}`).toThrow(
                "Screenshot delay must be a non-negative safe integer"
            );
        }
    });

    test("normalizeRuntimeConfig() gives malformed legacy rows finite safe defaults without a database write", () => {
        const model = monitor({
            type: "ping",
            interval: "bogus",
            retryInterval: 0,
            resendInterval: Infinity,
            maxretries: Number.MAX_SAFE_INTEGER,
            timeout: 0.001,
            maxredirects: Number.MAX_SAFE_INTEGER,
            response_max_length: "bogus",
            port: "80garbage",
            packetSize: "bogus",
            ping_count: Infinity,
            ping_per_request_timeout: 0,
        });

        model.normalizeRuntimeConfig();

        expect({
            interval: model.interval,
            retryInterval: model.retryInterval,
            resendInterval: model.resendInterval,
            maxretries: model.maxretries,
            timeout: model.timeout,
            maxredirects: model.maxredirects,
            response_max_length: model.response_max_length,
            port: model.port,
            packetSize: model.packetSize,
            ping_count: model.ping_count,
            ping_per_request_timeout: model.ping_per_request_timeout,
        }).toEqual({
            interval: 1,
            retryInterval: 1,
            resendInterval: 0,
            maxretries: 0,
            timeout: 0.8,
            maxredirects: 10,
            response_max_length: 1024,
            port: null,
            packetSize: 56,
            ping_count: 1,
            ping_per_request_timeout: 2,
        });
    });

    test("getEffectiveTimeout() preserves finite values and replaces zero, missing, malformed, and overflow values", () => {
        for (const [value, expected] of [
            ["0.25", 0.25],
            [0, 48],
            ["0", 48],
            ["", 48],
            ["bogus", 48],
            [NaN, 48],
            [Infinity, 48],
            [-1, 48],
            [MAX_INTERVAL_SECOND + 1, 48],
            [null, 48],
            [undefined, 48],
            [Number.MIN_VALUE, 48],
            [0.001, 48],
            [0.099, 48],
            [0.000999, 48],
        ]) {
            expect(monitor({ interval: 60, timeout: value }).getEffectiveTimeout(), String(value)).toBe(expected);
        }
    });
});
