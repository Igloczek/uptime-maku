// @ts-nocheck

import { describe, test, expect, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import StatusPage from "@/server/model/status_page";
import { BunSQLiteRedbean } from "@/server/sqlite-core";
import { statusPageSocketHandler } from "@/server/socket-handlers/status-page-socket-handler";
import { createResponseCache } from "@/server/bun-response";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import {
    STATUS_PAGE_ALL_UP,
    STATUS_PAGE_ALL_DOWN,
    STATUS_PAGE_PARTIAL_DOWN,
    STATUS_PAGE_MAINTENANCE,
} from "@/constants";
import { hasEmbeddedAsset } from "@/server/embedded-assets.js";
import { getFrontendEntryAssets } from "@/server/frontend-entry-assets.js";
import { markdownToPlainText, renderStatusPageDocument } from "@/server/status-page-document";
import { handleStatusPageRequest } from "@/server/routers/status-page-router";
import "@/server/model-registry";

dayjs.extend(utc);

const frontendEntryAssets = getFrontendEntryAssets();

describe("StatusPage", () => {
    describe("status page document", () => {
        test("renders an owned document with escaped metadata, preload data, and Vite assets", async () => {
            const html = await renderStatusPageDocument({
                statusPage: {
                    slug: "example",
                    title: 'A <status> & "quotes"',
                    description: "**Healthy** <em>now</em>",
                    icon: "https://example.test/icon.svg?theme=light&size=32",
                    analyticsType: "google",
                    analyticsId: "G-TEST123",
                },
                preloadData: {
                    unsafe: "</script><script>globalThis.pwned = true</script>",
                    quotes: "\"'&<>",
                    lineSeparators: "\u2028\u2029",
                },
            });

            expect(html).toContain("<!DOCTYPE html>");
            expect(html).toContain('<div id="app"></div>');
            expect(html).toContain("<title>A &lt;status&gt; &amp; &quot;quotes&quot;</title>");
            expect(html).toContain('name="description" content="Healthy now"');
            expect(html).toContain('property="og:title" content="A &lt;status&gt; &amp; &quot;quotes&quot;"');
            expect(html).toContain('href="https://example.test/icon.svg?theme=light&amp;size=32"');
            expect(html).not.toContain("apple-touch-icon");
            expect(html).toContain('href="/api/status-page/example/manifest.json"');
            expect(html).toContain("https://www.googletagmanager.com/gtag/js?id=G-TEST123");
            expect(html).toContain("window.preloadData =");
            expect(html).toContain("<\\/script><script>globalThis.pwned");
            expect(html).not.toContain("</script><script>globalThis.pwned");
            expect(html).toContain("\\u2028\\u2029");
            expect(html).toContain(`src="/${frontendEntryAssets.mainScript}"`);
            expect(html.indexOf("window.preloadData =")).toBeLessThan(
                html.indexOf(`src="/${frontendEntryAssets.mainScript}"`)
            );
            for (const style of frontendEntryAssets.styles) {
                expect(html).toContain(`href="/${style}"`);
            }
            for (const preload of frontendEntryAssets.modulePreloads) {
                expect(html).toContain(`href="/${preload}"`);
            }
        });

        test("keeps default icons and a complete SPA shell without analytics", async () => {
            const html = await renderStatusPageDocument({
                statusPage: {
                    slug: "default",
                    title: "Default",
                    description: "",
                    icon: "",
                },
                preloadData: {},
            });

            expect(html).toContain('rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"');
            expect(html).toContain('rel="icon" type="image/svg+xml" href="/icon.svg"');
            expect(html).toContain('id="preload-data" data-json="{}"');
            expect(html).toContain('type="module" crossorigin');
            expect(html).not.toContain("googletagmanager");
        });

        test("keeps every generated entry asset in the embedded asset map", () => {
            for (const asset of [
                frontendEntryAssets.mainScript,
                ...frontendEntryAssets.styles,
                ...frontendEntryAssets.modulePreloads,
            ]) {
                expect(hasEmbeddedAsset(asset)).toBe(true);
            }
        });

        test("converts editor markdown to the bounded metadata plain text contract", () => {
            expect(
                markdownToPlainText(
                    "# **Status**\n![Logo](https://example.test/logo.png) [Docs](https://example.test) `ready` <em>now</em> &amp;&nbsp;&#169;"
                )
            ).toBe("Status Logo Docs ready now & ©");
            expect(markdownToPlainText("x".repeat(200))).toHaveLength(155);
        });

        test("preserves literal inline syntax while removing Markdown presentation", () => {
            expect(markdownToPlainText("`a_b *c*`")).toBe("a_b *c*");
            expect(markdownToPlainText("<https://example.com>")).toBe("https://example.com");
            expect(markdownToPlainText("Title\n===")).toBe("Title");
            expect(markdownToPlainText("Before\n---\nAfter")).toBe("Before After");
            expect(markdownToPlainText("\\*literal\\*")).toBe("*literal*");
            expect(markdownToPlainText("[Nested URL](https://example.com/a_(b))")).toBe("Nested URL");
        });

        test("encodes a status slug as a manifest URL segment", async () => {
            const html = await renderStatusPageDocument({
                statusPage: { slug: "one/two?three", title: "Encoded", description: "", icon: "" },
                preloadData: undefined,
            });

            expect(html).toContain('href="/api/status-page/one%2Ftwo%3Fthree/manifest.json"');
            expect(html).toContain("window.preloadData = null;");
        });

        test("keeps default route normalization and 404 fallback behavior", async () => {
            expect(StatusPage.normalizeSlug("")).toBe("default");
            expect(StatusPage.normalizeSlug("DEFAULT")).toBe("default");
            expect(StatusPage.normalizeSlug("index.html")).toBe("default");

            const fallback = "<html>fallback</html>";
            const result = await StatusPage.renderHTMLBySlug(
                { findOne: async () => null },
                { indexHTML: fallback },
                "missing"
            );
            expect(result).toEqual({ status: 404, body: fallback });
        });

        test("serves the component document through status routes and keeps the five-minute response cache", async () => {
            const responseCache = createResponseCache();
            const statusPage = {
                slug: "default",
                title: "Default status",
                description: "Online",
                icon: "",
            };
            const getStatusPageDataSpy = spyOn(StatusPage, "getStatusPageData").mockResolvedValue({
                config: { customCSS: "body { color: teal; }" },
                incidents: [],
                publicGroupList: [],
                maintenanceList: [],
            });
            const store = {
                async findOne(_table, _condition, [slug]) {
                    return slug === "default" ? statusPage : null;
                },
            };

            try {
                const first = await handleStatusPageRequest(new Request("http://localhost/status"), {
                    store,
                    server: { indexHTML: "<html>fallback</html>" },
                    heartbeatData: {},
                    settings: {},
                    responseCache,
                    disableFrameSameOrigin: false,
                });
                expect(first.status).toBe(200);
                expect(await first.text()).toContain("window.preloadData");

                statusPage.title = "Changed after cache";
                const cached = await handleStatusPageRequest(new Request("http://localhost/status"), {
                    store,
                    server: { indexHTML: "<html>fallback</html>" },
                    heartbeatData: {},
                    settings: {},
                    responseCache,
                    disableFrameSameOrigin: false,
                });
                expect(await cached.text()).toContain("<title>Default status</title>");

                const legacyDefault = await handleStatusPageRequest(new Request("http://localhost/status-page"), {
                    store,
                    server: { indexHTML: "<html>fallback</html>" },
                    heartbeatData: {},
                    settings: {},
                    responseCache,
                    disableFrameSameOrigin: false,
                });
                expect(legacyDefault.status).toBe(200);

                const missing = await handleStatusPageRequest(new Request("http://localhost/status/missing"), {
                    store,
                    server: { indexHTML: "<html>fallback</html>" },
                    heartbeatData: {},
                    settings: {},
                    responseCache,
                    disableFrameSameOrigin: false,
                });
                expect(missing.status).toBe(404);
                expect(await missing.text()).toBe("<html>fallback</html>");
            } finally {
                getStatusPageDataSpy.mockRestore();
            }
        });
    });

    test("keeps slug and domain mappings isolated between explicit stores", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uptime-maku-status-page-stores-"));
        const first = new BunSQLiteRedbean();
        const second = new BunSQLiteRedbean();
        try {
            await Promise.all([
                first.connect({
                    sqlitePath: path.join(dir, "first.db"),
                    templatePath: path.join(process.cwd(), "out/kuma.db"),
                    testMode: true,
                }),
                second.connect({
                    sqlitePath: path.join(dir, "second.db"),
                    templatePath: path.join(process.cwd(), "out/kuma.db"),
                    testMode: true,
                }),
            ]);
            await first.exec(
                "INSERT INTO status_page (id, slug, title, icon, theme) VALUES (1, 'first', 'First', '', 'auto')"
            );
            await second.exec(
                "INSERT INTO status_page (id, slug, title, icon, theme) VALUES (1, 'second', 'Second', '', 'auto')"
            );
            await first.exec("INSERT INTO status_page_cname (status_page_id, domain) VALUES (1, 'first.example.com')");
            await second.exec(
                "INSERT INTO status_page_cname (status_page_id, domain) VALUES (1, 'second.example.com')"
            );

            const firstDomains = {};
            const secondDomains = {};
            await Promise.all([
                StatusPage.loadDomainMappingList(first, firstDomains),
                StatusPage.loadDomainMappingList(second, secondDomains),
            ]);

            expect(firstDomains).toEqual({ "first.example.com": "first" });
            expect(secondDomains).toEqual({ "second.example.com": "second" });
            expect(await StatusPage.slugToID(first, "second")).toBeNull();
            expect(await StatusPage.slugToID(second, "first")).toBeNull();
        } finally {
            await Promise.all([first.close(), second.close()]);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test("rolls back when the first domain-mapping statement fails", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uptime-maku-status-page-transaction-"));
        const store = new BunSQLiteRedbean();
        await store.connect({
            sqlitePath: path.join(dir, "kuma.db"),
            templatePath: path.join(process.cwd(), "out/kuma.db"),
            testMode: true,
        });
        await store.exec(
            "INSERT INTO status_page (id, slug, title, icon, theme) VALUES (1, 'test', 'Test', '', 'auto')"
        );
        await store.exec("INSERT INTO status_page_cname (status_page_id, domain) VALUES (1, 'old.example.com')");
        await store.exec(`
            CREATE TRIGGER reject_first_domain_delete
            BEFORE DELETE ON status_page_cname
            BEGIN
                SELECT RAISE(ABORT, 'forced first statement failure');
            END
        `);
        try {
            const page = Object.assign(new StatusPage(), { id: 1 });
            await expect(page.updateDomainNameList(store, ["status.example.com"])).rejects.toThrow(
                "forced first statement failure"
            );
            await expect(
                Promise.race([
                    store.getCell("SELECT 1"),
                    Bun.sleep(100).then(() => {
                        throw new Error("subsequent operation stayed blocked");
                    }),
                ])
            ).resolves.toBe(1);
        } finally {
            await store.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test("keeps status page config and cache unchanged when CNAME replacement rolls back", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "uptime-maku-status-page-save-"));
        const store = new BunSQLiteRedbean();
        const handlers = new Map();
        const domains = {};
        const server = { entryPage: "dashboard", statusPageDomainMappingList: domains };
        const cacheOwner = server.statusPageDomainMappingList;
        try {
            await store.connect({
                sqlitePath: path.join(directory, "kuma.db"),
                templatePath: path.join(process.cwd(), "out/kuma.db"),
                testMode: true,
            });
            await store.exec(
                "INSERT INTO status_page (id, slug, title, icon, theme) VALUES (1, 'old', 'Old', '', 'auto')"
            );
            await store.exec("INSERT INTO status_page_cname (status_page_id, domain) VALUES (1, 'old.example.com')");
            await StatusPage.loadDomainMappingList(store, domains);
            await store.exec(`
                CREATE TRIGGER reject_cname_replacement
                BEFORE DELETE ON status_page_cname
                BEGIN
                    SELECT RAISE(ABORT, 'forced CNAME failure');
                END
            `);
            statusPageSocketHandler(
                {
                    userID: 1,
                    on(event, handler) {
                        handlers.set(event, handler);
                    },
                },
                store,
                server,
                { async set() {} },
                createResponseCache()
            );

            const callbacks = [];
            await handlers.get("saveStatusPage")(
                "old",
                {
                    slug: "new",
                    title: "New",
                    description: "Changed",
                    logo: "",
                    autoRefreshInterval: 300,
                    theme: "auto",
                    showTags: false,
                    footerText: "",
                    customCSS: "",
                    showPoweredBy: true,
                    rssTitle: "",
                    showOnlyLastHeartbeat: false,
                    showCertificateExpiry: false,
                    analyticsId: "",
                    analyticsScriptUrl: "",
                    analyticsType: null,
                    domainNameList: ["new.example.com"],
                },
                "",
                [],
                (result) => callbacks.push(result)
            );

            expect(callbacks[0]).toMatchObject({ ok: false, msg: "forced CNAME failure" });
            expect(await store.getAll("SELECT slug, title FROM status_page WHERE id = 1")).toEqual([
                { slug: "old", title: "Old" },
            ]);
            expect(await store.getCol("SELECT domain FROM status_page_cname WHERE status_page_id = 1")).toEqual([
                "old.example.com",
            ]);
            expect(domains).toEqual({ "old.example.com": "old" });
            expect(server.statusPageDomainMappingList).toBe(cacheOwner);

            await store.exec("DROP TRIGGER reject_cname_replacement");
            await handlers.get("saveStatusPage")(
                "old",
                {
                    slug: "new",
                    title: "New",
                    description: "Changed",
                    logo: "",
                    autoRefreshInterval: 300,
                    theme: "auto",
                    showTags: false,
                    footerText: "",
                    customCSS: "",
                    showPoweredBy: true,
                    rssTitle: "",
                    showOnlyLastHeartbeat: false,
                    showCertificateExpiry: false,
                    analyticsId: "",
                    analyticsScriptUrl: "",
                    analyticsType: null,
                    domainNameList: ["new.example.com"],
                },
                "",
                [],
                (result) => callbacks.push(result)
            );
            expect(callbacks[1]).toMatchObject({ ok: true });
            expect(domains).toEqual({ "new.example.com": "new" });
            expect(server.statusPageDomainMappingList).toBe(cacheOwner);
        } finally {
            await store.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test("reloads the owned domain cache immediately after deleting a status page", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "uptime-maku-status-page-delete-"));
        const store = new BunSQLiteRedbean();
        const handlers = new Map();
        const domains = {};
        const server = { entryPage: "dashboard", statusPageDomainMappingList: domains };
        try {
            await store.connect({
                sqlitePath: path.join(directory, "kuma.db"),
                templatePath: path.join(process.cwd(), "out/kuma.db"),
                testMode: true,
            });
            await store.exec(
                "INSERT INTO status_page (id, slug, title, icon, theme) VALUES (1, 'gone', 'Gone', '', 'auto')"
            );
            await store.exec("INSERT INTO status_page_cname (status_page_id, domain) VALUES (1, 'gone.example.com')");
            await StatusPage.loadDomainMappingList(store, domains);
            statusPageSocketHandler(
                {
                    userID: 1,
                    on(event, handler) {
                        handlers.set(event, handler);
                    },
                },
                store,
                server,
                { async set() {} },
                createResponseCache()
            );

            const callbacks = [];
            await handlers.get("deleteStatusPage")("gone", (result) => callbacks.push(result));

            expect(callbacks).toEqual([{ ok: true }]);
            expect(await store.findOne("status_page", " id = ? ", [1])).toBeNull();
            expect(await store.getCol("SELECT domain FROM status_page_cname")).toEqual([]);
            expect(domains).toEqual({});
        } finally {
            await store.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test("uses injected trustProxy settings for entry-page host resolution", async () => {
        const { handleApiRequest } = await import("@/server/routers/api-router");
        const request = new Request("http://app.example/api/entry-page", {
            headers: { host: "app.example", "x-forwarded-host": "status.example.com" },
        });
        const server = {
            entryPage: "dashboard",
            statusPageDomainMappingList: { "status.example.com": "status" },
        };
        const untrusted = await handleApiRequest(request, {
            server,
            settings: {
                async get() {
                    return false;
                },
            },
            disableFrameSameOrigin: false,
        });
        expect(await untrusted.json()).toEqual({ type: "entryPage", entryPage: "dashboard" });

        const trusted = await handleApiRequest(request, {
            server,
            settings: {
                async get() {
                    return true;
                },
            },
            disableFrameSameOrigin: false,
        });
        expect(await trusted.json()).toEqual({ type: "statusPageMatchedDomain", statusPageSlug: "status" });
    });

    describe("getStatusDescription()", () => {
        test("returns 'No Services' when status is -1", () => {
            const description = StatusPage.getStatusDescription(-1);
            expect(description).toBe("No Services");
        });

        test("returns 'All Systems Operational' when all services are up", () => {
            const description = StatusPage.getStatusDescription(STATUS_PAGE_ALL_UP);
            expect(description).toBe("All Systems Operational");
        });

        test("returns 'Partially Degraded Service' when some services are down", () => {
            const description = StatusPage.getStatusDescription(STATUS_PAGE_PARTIAL_DOWN);
            expect(description).toBe("Partially Degraded Service");
        });

        test("returns 'Degraded Service' when all services are down", () => {
            const description = StatusPage.getStatusDescription(STATUS_PAGE_ALL_DOWN);
            expect(description).toBe("Degraded Service");
        });

        test("returns 'Under maintenance' when status page is in maintenance", () => {
            const description = StatusPage.getStatusDescription(STATUS_PAGE_MAINTENANCE);
            expect(description).toBe("Under maintenance");
        });

        test("returns '?' for unknown status values", () => {
            const description = StatusPage.getStatusDescription(999);
            expect(description).toBe("?");
        });
    });

    describe("renderRSS()", () => {
        const MOCK_FEED_URL = "http://localhost:3001/status/test";

        test("pubDate uses UTC timezone for heartbeat.time without timezone info", async () => {
            const mockStatusPage = {
                title: "Test Status Page",
            };

            const mockIncidents = [
                {
                    title: "Test Monitor",
                    content: "Test content",
                    id: 1,
                    createdDate: "2026-05-21 15:07:35.600",
                },
            ];

            const mockHeartbeats = [
                {
                    name: "Test Monitor",
                    monitorID: 1,
                    time: "2026-01-24 13:16:25.400",
                },
            ];

            const getRSSPageDataSpy = spyOn(StatusPage, "getRSSPageData").mockImplementation(async () => ({
                incidents: mockIncidents,
                heartbeats: mockHeartbeats,
                statusDescription: "All Systems Operational",
            }));

            try {
                const rss = await StatusPage.renderRSS({}, {}, mockStatusPage, MOCK_FEED_URL);

                expect(rss.includes("<pubDate>Sat, 24 Jan 2026 13:16:25 GMT</pubDate>")).toBeTruthy();
            } finally {
                getRSSPageDataSpy.mockRestore();
            }
        });
    });
});
