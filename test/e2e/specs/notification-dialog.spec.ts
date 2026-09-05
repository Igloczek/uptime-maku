// @ts-nocheck
import { expect, test } from "@playwright/test";
import { createServer } from "node:net";

import { login, restoreSqliteSnapshot } from "../util-test";

async function openNotificationSettings(page) {
    await page.goto("./settings/notifications");

    if (await page.getByPlaceholder("Username").isVisible()) {
        await login(page);
        await expect(page.getByText("Add New Monitor")).toBeVisible();
        await page.goto("./settings/notifications");
    }

    await expect(page.getByRole("button", { name: "Set Up Notification" })).toBeVisible();
}

async function waitForModalToClose(page, modal) {
    await expect(modal).toBeHidden();
    await expect(page.locator(".modal-backdrop")).toHaveCount(0);
}

async function startSmtpSink() {
    const messages = [];
    const protocolErrors = [];
    const sockets = new Set();
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.setEncoding("utf8");
        socket.write("220 iglo-monitor-e2e ESMTP\r\n");

        let buffer = "";
        let receivingData = false;
        let state = "ehlo";
        let mailFrom;
        const rcptTo = [];

        function rejectCommand(command) {
            protocolErrors.push(`Unexpected SMTP command in ${state}: ${command}`);
            socket.write("503 Bad sequence of commands\r\n");
        }

        socket.on("data", (chunk) => {
            buffer += chunk;

            while (buffer) {
                if (receivingData) {
                    const end = buffer.indexOf("\r\n.\r\n");
                    if (end === -1) {
                        return;
                    }

                    const data = buffer.slice(0, end);
                    buffer = buffer.slice(end + 5);
                    receivingData = false;
                    if (!data.trim()) {
                        protocolErrors.push("Empty SMTP DATA");
                        socket.write("554 Empty message rejected\r\n");
                    } else {
                        messages.push({ mailFrom, rcptTo: [...rcptTo], data });
                        state = "quit";
                        socket.write("250 Message accepted\r\n");
                    }
                    continue;
                }

                const lineEnd = buffer.indexOf("\r\n");
                if (lineEnd === -1) {
                    return;
                }

                const command = buffer.slice(0, lineEnd);
                buffer = buffer.slice(lineEnd + 2);

                const mail = command.match(/^MAIL FROM:<([^>]+)>$/i);
                const recipient = command.match(/^RCPT TO:<([^>]+)>$/i);

                if (state === "ehlo" && /^EHLO\b/i.test(command)) {
                    state = "mail";
                    socket.write("250 iglo-monitor-e2e\r\n");
                } else if (state === "mail" && mail) {
                    mailFrom = mail[1];
                    state = "rcpt";
                    socket.write("250 Sender accepted\r\n");
                } else if ((state === "rcpt" || state === "data") && recipient) {
                    rcptTo.push(recipient[1]);
                    state = "data";
                    socket.write("250 Recipient accepted\r\n");
                } else if (state === "data" && /^DATA$/i.test(command)) {
                    receivingData = true;
                    socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
                } else if (state === "quit" && /^QUIT$/i.test(command)) {
                    state = "closed";
                    socket.end("221 Bye\r\n");
                } else {
                    rejectCommand(command);
                }
            }
        });
        socket.on("error", (error) => protocolErrors.push(error.message));
        socket.on("close", () => sockets.delete(socket));
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });

    return {
        port: server.address().port,
        messages: () => messages,
        protocolErrors: () => protocolErrors,
        close: () =>
            new Promise((resolve) => {
                for (const socket of sockets) {
                    socket.destroy();
                }
                server.close(resolve);
            }),
    };
}

test.describe("Notification dialog", () => {
    test.beforeEach(async ({ page }) => {
        await restoreSqliteSnapshot(page);
        await openNotificationSettings(page);
    });

    test("renders legacy and generic provider fields without page errors", async ({ page }) => {
        const pageErrors = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));

        await page.getByRole("button", { name: "Set Up Notification" }).click();
        const notificationType = page.getByLabel("Notification Type");

        const providerFields = [
            ["telegram", ["#telegram-bot-token", "#telegram-chat-id"]],
            ["smtp", ["#hostname", "#port", "#from-email", "#to-email"]],
            ["pumble", ["#pumble-webhook-url"]],
            ["squadcast", ["#squadcast-webhook-url"]],
            ["Resend", ["#resend-api-key", "#resend-from-email", "#resend-to-email"]],
            ["SendGrid", ["#sendgrid-api-key", "#sendgrid-from-email", "#sendgrid-to-email"]],
            ["discord", ["#discord-webhook-url", "#discord-message-type"]],
            ["webhook", ["#webhook-url", "#webhook-http-method"]],
        ];

        for (const [provider, selectors] of providerFields) {
            await notificationType.selectOption(provider);
            for (const selector of selectors) {
                await expect
                    .soft(page.locator(selector), `${provider} should render ${selector}`)
                    .toBeVisible({ timeout: 1_000 });
            }
        }

        expect(pageErrors).toEqual([]);
    });

    test("manages initial focus, Close, Escape, and focus return", async ({ page }) => {
        const setupButton = page.getByRole("button", { name: "Set Up Notification" });
        const modal = page.locator(".modal").filter({ has: page.locator("#notification-type") });

        await setupButton.click();
        await expect(modal).toBeVisible();
        await expect(page.getByLabel("Notification Type")).toBeFocused();
        await modal.getByRole("button", { name: "Close" }).click();
        await waitForModalToClose(page, modal);
        await expect(setupButton).toBeFocused();

        await setupButton.click();
        await expect(modal).toBeVisible();
        await expect(page.getByLabel("Notification Type")).toBeFocused();
        await page.keyboard.press("Escape");
        await waitForModalToClose(page, modal);
        await expect(setupButton).toBeFocused();
    });

    test("tests, saves, edits, cancels, and deletes SMTP through a local sink", async ({ page }) => {
        const smtpSink = await startSmtpSink();

        try {
            await page.getByRole("button", { name: "Set Up Notification" }).click();
            await expect(page.getByLabel("Notification Type")).toBeFocused();
            await page.getByLabel("Notification Type").selectOption("smtp");

            const modal = page.locator(".modal").filter({ has: page.locator("#notification-type") });
            const hostname = page.locator("#hostname");
            const port = page.locator("#port");
            const from = page.locator("#from-email");
            const to = page.locator("#to-email");
            const name = "Local SMTP E2E";
            const savedRecipient = "saved@example.invalid";

            await expect(hostname).toHaveAttribute("required", "");
            await expect(port).toHaveAttribute("required", "");
            await expect(from).toHaveAttribute("required", "");
            await modal.getByRole("button", { name: "Save" }).click();
            await expect(hostname).toBeFocused();
            await expect(modal).toBeVisible();

            await page.getByLabel("Friendly Name").fill(name);
            await hostname.fill("127.0.0.1");
            await port.fill(String(smtpSink.port));
            await page.locator("#ignore-starttls").check();
            await from.fill("sender@example.invalid");
            await to.fill("recipient@example.invalid");

            await modal.getByRole("button", { name: "Test" }).click();
            await expect(page.getByText("Sent Successfully.", { exact: true }).last()).toBeVisible();
            await expect.poll(() => smtpSink.messages().length).toBe(1);
            expect(smtpSink.protocolErrors()).toEqual([]);
            expect(smtpSink.messages()[0]).toMatchObject({
                mailFrom: "sender@example.invalid",
                rcptTo: ["recipient@example.invalid"],
            });
            expect(smtpSink.messages()[0].data).toContain("Subject: Local SMTP E2E Testing");
            expect(smtpSink.messages()[0].data).toMatch(/\r\n\r\nLocal SMTP E2E Testing$/);

            await modal.getByRole("button", { name: "Save" }).click();
            await waitForModalToClose(page, modal);

            const notificationRow = page.locator(".notification-list li").filter({ hasText: name });
            await expect(notificationRow).toBeVisible();
            await notificationRow.getByText("Edit", { exact: true }).click();
            await expect(modal).toBeVisible();
            await expect(page.getByLabel("Notification Type")).toBeFocused();
            await expect(hostname).toHaveValue("127.0.0.1");
            await expect(port).toHaveValue(String(smtpSink.port));
            await expect(from).toHaveValue("sender@example.invalid");
            await expect(to).toHaveValue("recipient@example.invalid");

            await to.fill(savedRecipient);
            await modal.getByRole("button", { name: "Save" }).click();
            await waitForModalToClose(page, modal);

            await notificationRow.getByText("Edit", { exact: true }).click();
            await expect(modal).toBeVisible();
            await expect(page.getByLabel("Notification Type")).toBeFocused();
            await expect(to).toHaveValue(savedRecipient);
            await to.fill("cancelled@example.invalid");
            await modal.getByRole("button", { name: "Close" }).click();
            await waitForModalToClose(page, modal);

            await notificationRow.getByText("Edit", { exact: true }).click();
            await expect(modal).toBeVisible();
            await expect(page.getByLabel("Notification Type")).toBeFocused();
            await expect(to).toHaveValue(savedRecipient);
            await modal.getByRole("button", { name: "Delete" }).click();

            const confirmModal = page.locator(".modal.show").filter({
                hasText: "Are you sure want to delete this notification for all monitors?",
            });
            await expect(confirmModal).toHaveCount(1);
            await confirmModal.getByRole("button", { name: "Yes" }).click();
            await expect(page.getByText("Deleted Successfully.", { exact: true }).last()).toBeVisible();
            await expect(notificationRow).toHaveCount(0);
        } finally {
            await smtpSink.close();
        }
    });
});
