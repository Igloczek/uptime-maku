// @ts-nocheck
import { test } from "@playwright/test";
import { login, screenshot, takeSqliteSnapshot } from "../util-test";

test.describe("iglo.monitor Setup", () => {
    test.afterEach(async ({ page }, testInfo) => {
        await screenshot(testInfo, page);
    });

    /*
     * Setup
     */

    test("setup sqlite", async ({ page }, testInfo) => {
        await page.goto("./");
        const sqliteOption = page.getByText("SQLite");
        if (await sqliteOption.isVisible({ timeout: 2000 }).catch(() => false)) {
            await sqliteOption.click();
            await page.getByRole("button", { name: "Next" }).click();
        }
        await screenshot(testInfo, page);
        await page.waitForURL("/setup"); // ensures the server is ready to continue to the next test
    });

    test("setup admin", async ({ page }) => {
        await page.goto("./");
        await page.getByPlaceholder("Username").click();
        await page.getByPlaceholder("Username").fill("admin");
        await page.getByPlaceholder("Username").press("Tab");
        await page.getByPlaceholder("Password", { exact: true }).fill("admin123");
        await page.getByPlaceholder("Password", { exact: true }).press("Tab");
        await page.getByPlaceholder("Repeat Password").fill("admin123");
        await page.getByRole("button", { name: "Create" }).click();
    });

    /*
     * All other tests should be run after setup
     */

    test("login", async ({ page }) => {
        await page.goto("./dashboard");
        await login(page);
    });

    test("logout", async ({ page }) => {
        await page.goto("./dashboard");
        await login(page);
        await page.getByText("A", { exact: true }).click();
        await page.getByRole("button", { name: "Log out" }).click();
    });

    test("take sqlite snapshot", async ({ page }) => {
        await takeSqliteSnapshot(page);
    });
});
