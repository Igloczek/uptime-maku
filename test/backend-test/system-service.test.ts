// @ts-nocheck

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { SystemServiceMonitorType } from "@/server/monitor-types/system-service";
import * as processHelper from "@/server/process-helper";
import { DOWN, UP } from "@/constants";
import process from "process";

describe("SystemServiceMonitorType", () => {
    let monitorType;
    let heartbeat;
    let originalPlatform;
    let runCommandSpy;

    beforeEach(() => {
        monitorType = new SystemServiceMonitorType();
        heartbeat = {
            status: DOWN,
            msg: "",
        };
        originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
        Object.defineProperty(process, "platform", { value: "linux", configurable: true });
        runCommandSpy = spyOn(processHelper, "runCommand");
    });

    afterEach(() => {
        if (originalPlatform) {
            Object.defineProperty(process, "platform", originalPlatform);
        }
        runCommandSpy.mockRestore();
    });

    test("check() returns UP for a running service", async () => {
        runCommandSpy.mockResolvedValue({ code: 0, stdout: "active\n", stderr: "" });

        const monitor = {
            system_service_name: "iglo-monitor.service",
            timeout: 2,
        };

        await monitorType.check(monitor, heartbeat);

        expect(heartbeat.status).toBe(UP);
        expect(heartbeat.msg.includes("is running")).toBeTruthy();
        expect(runCommandSpy).toHaveBeenCalledWith("systemctl", ["is-active", "iglo-monitor.service"], {
            timeout: 2000,
        });
    });

    test("check() returns DOWN for a stopped service", async () => {
        const monitor = {
            system_service_name: "non-existent-service-12345",
        };
        runCommandSpy.mockResolvedValue({ code: 3, stdout: "inactive\n", stderr: "" });

        // Query a non-existent service to force an error/down state.
        // Pass the promise directly to expect().rejects without an unnecessary async wrapper.
        await expect(monitorType.check(monitor, heartbeat)).rejects.toThrow();

        expect(heartbeat.status).toBe(DOWN);
    });

    test("check() fails gracefully with invalid characters", async () => {
        const monitor = {
            system_service_name: "invalid&service;name",
        };

        // Expected validation error
        await expect(monitorType.check(monitor, heartbeat)).rejects.toThrow();

        expect(heartbeat.status).toBe(DOWN);
        expect(runCommandSpy).not.toHaveBeenCalled();
    });

    test("check() throws on unsupported platforms", async () => {
        // This test mocks the platform, so it can run anywhere.
        Object.defineProperty(process, "platform", {
            value: "darwin",
            configurable: true,
        });

        const monitor = {
            system_service_name: "test-service",
        };

        await expect(monitorType.check(monitor, heartbeat)).rejects.toThrow(/not supported/);
    });
});
