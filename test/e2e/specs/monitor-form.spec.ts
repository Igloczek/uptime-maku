// @ts-nocheck
import { expect, test } from "@playwright/test";
import dns2 from "dns2";
import { login, restoreSqliteSnapshot, screenshot, serverUrl } from "../util-test";

async function startDnsFixture() {
    const server = dns2.createServer({
        udp: true,
        handle(request, send) {
            const response = dns2.Packet.createResponseFromRequest(request);
            const [{ name }] = request.questions;
            for (const ns of ["ns1.fixture.test", "ns2.fixture.test"]) {
                response.answers.push({
                    name,
                    type: dns2.Packet.TYPE.NS,
                    class: dns2.Packet.CLASS.IN,
                    ttl: 60,
                    ns,
                });
            }
            send(response);
        },
    });

    await new Promise((resolve) => {
        server.once("listening", resolve);
        server.listen({ udp: { port: 0, address: "127.0.0.1", type: "udp4" } });
    });

    return server;
}

/**
 * Selects the monitor type from the dropdown.
 * @param {import('@playwright/test').Page} page - The Playwright page instance.
 * @param {string} monitorType - The monitor type to select (default is "dns").
 * @returns {Promise<void>} - A promise that resolves when the monitor type is selected.
 */
async function selectMonitorType(page, monitorType = "dns") {
    const monitorTypeSelect = page.getByTestId("monitor-type-select");
    await expect(monitorTypeSelect).toBeVisible();
    await monitorTypeSelect.selectOption(monitorType);

    const selectedValue = await monitorTypeSelect.evaluate((select) => select.value);
    expect(selectedValue).toBe(monitorType);
}

function collectSentSocketEvents(page) {
    const events = [];
    page.on("websocket", (socket) => {
        socket.on("framesent", ({ payload }) => {
            try {
                const message = JSON.parse(String(payload));
                if (message.type === "event") {
                    events.push(message.event);
                }
            } catch {}
        });
    });
    return events;
}

async function expectBootstrapModalCleanup(page) {
    await expect(page.locator(".modal.show")).toHaveCount(0);
    await expect(page.locator(".modal-backdrop")).toHaveCount(0);
    await expect(page.locator("body")).not.toHaveClass(/modal-open/);
}

test.describe("Monitor Form", () => {
    let dnsFixture;

    test.beforeEach(async ({ page }) => {
        await restoreSqliteSnapshot(page);
        dnsFixture = await startDnsFixture();
    });

    test.afterEach(async () => {
        await new Promise((resolve) => {
            dnsFixture.once("close", resolve);
            dnsFixture.close();
        });
    });

    test("condition ui", async ({ page }, testInfo) => {
        await page.goto("./add");
        await login(page);
        await screenshot(testInfo, page);
        await selectMonitorType(page);

        await page.getByTestId("add-condition-button").click();
        expect(await page.getByTestId("condition").count()).toEqual(1); // 1 explicitly added

        await page.getByTestId("add-group-button").click();
        expect(await page.getByTestId("condition-group").count()).toEqual(1);
        expect(await page.getByTestId("condition").count()).toEqual(2); // 1 solo conditions + 1 condition in group

        await screenshot(testInfo, page);

        await page.getByTestId("remove-condition").first().click();
        expect(await page.getByTestId("condition").count()).toEqual(1); // 0 solo condition + 1 condition in group

        await page.getByTestId("remove-condition-group").first().click();
        expect(await page.getByTestId("condition-group").count()).toEqual(0);

        await screenshot(testInfo, page);
    });

    test("exposes retry, redirect, and timeout bounds to the browser", async ({ page }) => {
        await page.goto("./add");
        await login(page);
        await selectMonitorType(page, "http");

        const retries = page.locator("#maxRetries");
        await expect(retries).toHaveAttribute("min", "0");
        await expect(retries).toHaveAttribute("max", "100");
        await retries.fill("101");
        expect(await retries.evaluate((input) => input.checkValidity())).toBe(false);
        await retries.fill("100");
        expect(await retries.evaluate((input) => input.checkValidity())).toBe(true);

        const redirects = page.locator("#maxRedirects");
        await expect(redirects).toHaveAttribute("min", "0");
        await expect(redirects).toHaveAttribute("max", "100");
        await redirects.fill("101");
        expect(await redirects.evaluate((input) => input.checkValidity())).toBe(false);
        await redirects.fill("100");
        expect(await redirects.evaluate((input) => input.checkValidity())).toBe(true);

        const timeout = page.locator("#timeout");
        await expect(timeout).toHaveAttribute("min", "0");
        await expect(timeout).toHaveAttribute("step", "0.1");
        await timeout.fill("0.01");
        expect(await timeout.evaluate((input) => input.checkValidity())).toBe(false);
        await timeout.fill("0.1");
        expect(await timeout.evaluate((input) => input.checkValidity())).toBe(true);

    });

    test("successful condition", async ({ page }, testInfo) => {
        await page.goto("./add");
        await login(page);
        await screenshot(testInfo, page);
        await selectMonitorType(page);

        const friendlyName = "Example DNS NS";
        await page.getByTestId("friendly-name-input").fill(friendlyName);
        await page.getByTestId("hostname-input").fill("fixture.test");
        await page.locator("#dns_resolve_server").fill("127.0.0.1");
        await page.locator("#port").fill(String(dnsFixture.addresses().udp.port));

        const resolveTypeSelect = page.getByTestId("resolve-type-select");
        await resolveTypeSelect.click();
        await resolveTypeSelect.getByRole("option", { name: "NS" }).click();

        await page.getByTestId("add-condition-button").click();
        expect(await page.getByTestId("condition").count()).toEqual(1); // 1 explicitly added

        await page.getByTestId("add-condition-button").click();
        expect(await page.getByTestId("condition").count()).toEqual(2); // 2 explicitly added

        await page.getByTestId("condition-value").nth(0).fill("ns1.fixture.test");
        await page.getByTestId("condition-and-or").nth(0).selectOption("or");
        await page.getByTestId("condition-value").nth(1).fill("ns2.fixture.test");

        await screenshot(testInfo, page);
        await page.getByTestId("save-button").click();
        await page.waitForURL("/dashboard/*");

        await expect(page.getByTestId("monitor-status")).toHaveText("up", { ignoreCase: true, timeout: 15000 });

        await screenshot(testInfo, page);
    });

    test("failing condition", async ({ page }, testInfo) => {
        await page.goto("./add");
        await login(page);
        await screenshot(testInfo, page);
        await selectMonitorType(page);

        const friendlyName = "Example DNS NS";
        await page.getByTestId("friendly-name-input").fill(friendlyName);
        await page.getByTestId("hostname-input").fill("fixture.test");
        await page.locator("#dns_resolve_server").fill("127.0.0.1");
        await page.locator("#port").fill(String(dnsFixture.addresses().udp.port));

        const resolveTypeSelect = page.getByTestId("resolve-type-select");
        await resolveTypeSelect.click();
        await resolveTypeSelect.getByRole("option", { name: "NS" }).click();

        await page.getByTestId("add-condition-button").click();
        expect(await page.getByTestId("condition").count()).toEqual(1); // 1 explicitly added

        await page.getByTestId("condition-value").nth(0).fill("definitely-not.net");

        await screenshot(testInfo, page);
        await page.getByTestId("save-button").click();
        await page.waitForURL("/dashboard/*");

        await expect(page.getByTestId("monitor-status")).toHaveText("down", { ignoreCase: true, timeout: 15000 });

        await screenshot(testInfo, page);
    });

    test("save response settings persist", async ({ page }, testInfo) => {
        await page.goto("./add");
        await login(page);
        await selectMonitorType(page, "http");

        const friendlyName = "Example HTTP Save Response";
        await page.getByTestId("friendly-name-input").fill(friendlyName);
        await page.getByTestId("url-input").fill(serverUrl);

        // Expect error response save enabled by default
        await expect(page.getByLabel("Save HTTP Error Response for Notifications")).toBeChecked();

        await page.getByLabel("Save HTTP Success Response for Notifications").check();
        await page.getByLabel("Save HTTP Error Response for Notifications").uncheck();
        await page.getByLabel("Response Max Length (bytes)").fill("2048");

        await screenshot(testInfo, page);
        await page.getByTestId("save-button").click();
        await page.waitForURL("/dashboard/*");

        await page.getByRole("link", { name: "Edit" }).click();
        await page.waitForURL("/edit/*");

        await expect(page.getByLabel("Save HTTP Success Response for Notifications")).toBeHidden();
        await expect(page.getByLabel("Save HTTP Error Response for Notifications")).not.toBeChecked();
        await expect(page.getByLabel("Response Max Length (bytes)")).toHaveValue("2048");

        await screenshot(testInfo, page);
    });

    test("blocks HTTPS proxy with Ignore TLS on create and edit before WebSocket persistence", async ({ page }) => {
        const sentEvents = collectSentSocketEvents(page);
        const message =
            "Ignore TLS cannot be combined with an HTTPS proxy because Bun cannot limit disabled certificate validation to the target.";

        await page.goto("./settings/proxies");
        await login(page);
        await expect(page.getByText("Add New Monitor")).toBeVisible();
        await page.goto("./settings/proxies");
        await page.getByRole("button", { name: "Set Up Proxy" }).click();

        const proxyModal = page.locator(".modal").filter({ has: page.locator("#proxy-protocol") });
        await proxyModal.locator("#proxy-protocol").selectOption("https");
        await proxyModal.locator("#proxy-host").fill("127.0.0.1");
        await proxyModal.locator('input[type="number"]').fill("443");
        await proxyModal.locator("#mark-active").check();
        await proxyModal.getByRole("button", { name: "Save" }).click();
        await expect(proxyModal).toBeHidden();
        await expectBootstrapModalCleanup(page);

        await page.goto("./add");
        await selectMonitorType(page, "http");
        await page.getByTestId("friendly-name-input").fill("Blocked proxy combination");
        await page.getByTestId("url-input").fill(serverUrl);
        await page.locator('input[name="proxy"]:not(#proxy-disable)').check();
        await page.getByLabel("Ignore TLS/SSL errors for HTTPS websites").check();

        const errorToasts = page.locator(".Vue-Toastification__toast--error").filter({ hasText: message });
        await expect(errorToasts).toHaveCount(0);
        const eventsBeforeCreate = sentEvents.length;
        await page.getByTestId("save-button").click();
        await expect(errorToasts).toHaveCount(1);
        await expect(errorToasts.locator(".Vue-Toastification__toast-body")).toHaveText(message);
        expect(sentEvents.slice(eventsBeforeCreate)).not.toContain("add");
        await expect(page).toHaveURL(/\/add$/);

        await errorToasts.locator(".Vue-Toastification__close-button").click();
        await page.getByLabel("Ignore TLS/SSL errors for HTTPS websites").uncheck();
        await page.locator("#proxy-disable").check();
        const eventsBeforeAllowedCreate = sentEvents.length;
        await page.getByTestId("save-button").click();
        await expect.poll(() => sentEvents.slice(eventsBeforeAllowedCreate)).toContain("add");
        await page.waitForURL("**/dashboard/*");
        const monitorID = page.url().split("/").at(-1);

        await page.goto(`./edit/${monitorID}`);
        await expect(page.getByTestId("friendly-name-input")).toHaveValue("Blocked proxy combination");
        await page.locator('input[name="proxy"]:not(#proxy-disable)').check();
        await page.getByLabel("Ignore TLS/SSL errors for HTTPS websites").check();

        await expect(errorToasts).toHaveCount(0);
        const eventsBeforeEdit = sentEvents.length;
        await page.getByTestId("save-button").click();
        await expect(errorToasts).toHaveCount(1);
        await expect(errorToasts.locator(".Vue-Toastification__toast-body")).toHaveText(message);
        expect(sentEvents.slice(eventsBeforeEdit)).not.toContain("editMonitor");

        await page.reload();
        await expect(page.getByTestId("friendly-name-input")).toHaveValue("Blocked proxy combination");
        await expect(page.getByLabel("Ignore TLS/SSL errors for HTTPS websites")).not.toBeChecked();
        await expect(page.locator("#proxy-disable")).toBeChecked();

        await page.getByTestId("friendly-name-input").fill("Allowed proxy edit");
        const eventsBeforeAllowedEdit = sentEvents.length;
        await page.getByTestId("save-button").click();
        await expect.poll(() => sentEvents.slice(eventsBeforeAllowedEdit)).toContain("editMonitor");
        await page.reload();
        await expect(page.getByTestId("friendly-name-input")).toHaveValue("Allowed proxy edit");
    });
});
