// @ts-nocheck

import { describe, test, expect } from "bun:test";
import { pingAsync } from "@/server/ping";

describe("Server Utilities: pingAsync", () => {
    test("should convert IDN domains to Punycode before pinging", async () => {
        const idnDomain = "münchen.de";
        const punycodeDomain = "xn--mnchen-3ya.de";

        try {
            await pingAsync(idnDomain, false, 1, "", true, 56, 1, 1);
            expect.unreachable();
        } catch (err) {
            if (err.message.includes("Parameter string not correctly encoded")) {
                throw new Error("Ping failed with encoding error: IDN was not converted");
            }
            expect(err.message.includes(punycodeDomain)).toBe(true);
        }
    });

    test("should strip brackets from IPv6 addresses before pinging", async () => {
        const ipv6WithBrackets = "[2606:4700:4700::1111]";
        const ipv6Raw = "2606:4700:4700::1111";

        try {
            await pingAsync(ipv6WithBrackets, true, 1, "", true, 56, 1, 1);
            expect.unreachable();
        } catch (err) {
            expect(err.message.includes(ipv6WithBrackets)).toBe(false);
            const containsIP = err.message.includes(ipv6Raw);
            const isUnreachable =
                err.message.includes("Network is unreachable") || err.message.includes("Network unreachable");
            const isMacOSError = err.message.includes("nodename nor servname provided");
            expect(containsIP || isUnreachable || isMacOSError).toBe(true);
        }
    });

    test("should handle standard ASCII domains correctly", async () => {
        const domain = "iglo-monitor-unresolvable.invalid";

        try {
            await pingAsync(domain, false, 1, "", true, 56, 1, 1);
            expect.unreachable();
        } catch (err) {
            expect(err.message.includes("Parameter string not correctly encoded")).toBe(false);
            expect(err.message.includes(domain)).toBe(true);
        }
    });
});
