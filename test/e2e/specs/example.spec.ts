// @ts-nocheck
import { expect, test } from "@playwright/test";
import { login, restoreSqliteSnapshot, screenshot, serverUrl } from "../util-test";

test.describe("Example Spec", () => {
    test.beforeEach(async ({ page }) => {
        await restoreSqliteSnapshot(page);
    });

    test("dashboard", async ({ page }, testInfo) => {
        await page.goto("./dashboard");
        await login(page);
        await screenshot(testInfo, page);
    });

    test("set up monitor", async ({ page }, testInfo) => {
        await page.goto("./add");
        await login(page);

        await expect(page.getByTestId("monitor-type-select")).toBeVisible();
        await page.getByTestId("monitor-type-select").selectOption("http");
        await page.getByTestId("friendly-name-input").fill("Local iglo.monitor");
        await page.getByTestId("url-input").fill(serverUrl);
        await page.getByTestId("save-button").click();
        await page.waitForURL("/dashboard/*"); // wait for the monitor to be created

        await expect(page.getByTestId("monitor-list")).toContainText("Local iglo.monitor");
        await screenshot(testInfo, page);
    });

    test("database is reset after previous test", async ({ page }, testInfo) => {
        await page.goto("./dashboard");
        await login(page);

        await expect(page.getByTestId("monitor-list")).not.toContainText("Local iglo.monitor");
        await screenshot(testInfo, page);
    });
});
