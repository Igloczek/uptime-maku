// @ts-nocheck

import { SQLiteModel } from "@/server/sqlite-model";
import { renderStatusPageDocument } from "@/server/status-page-document";
import config from "@/server/config";
import dayjs from "dayjs";
import {
    STATUS_PAGE_ALL_DOWN,
    STATUS_PAGE_ALL_UP,
    STATUS_PAGE_MAINTENANCE,
    STATUS_PAGE_PARTIAL_DOWN,
    UP,
    MAINTENANCE,
    DOWN,
    INCIDENT_PAGE_SIZE,
} from "@/constants";

class StatusPage extends SQLiteModel {
    get autoRefreshInterval() {
        return this.auto_refresh_interval;
    }

    set autoRefreshInterval(value) {
        this.auto_refresh_interval = value;
    }

    get analyticsId() {
        return this.analytics_id;
    }

    set analyticsId(value) {
        this.analytics_id = value;
    }

    get analyticsScriptUrl() {
        return this.analytics_script_url;
    }

    set analyticsScriptUrl(value) {
        this.analytics_script_url = value;
    }

    get analyticsType() {
        return this.analytics_type;
    }

    set analyticsType(value) {
        this.analytics_type = value;
    }

    get rssTitle() {
        return this.rss_title;
    }

    set rssTitle(value) {
        this.rss_title = value;
    }

    static normalizeSlug(slug) {
        slug = String(slug || "default").toLowerCase();
        // Handle url with trailing slash (http://localhost:3001/status/)
        // The old route parser produced "index.html" for an empty slug.
        if (slug === "index.html") {
            slug = "default";
        }

        return slug;
    }

    /**
     * Render a status page by slug.
     * @param {string} indexHTML HTML to render
     * @param {string} slug Status page slug
     * @returns {Promise<{ status: number, body: string }>} Response payload
     */
    static async renderHTMLBySlug(store, server, slug) {
        slug = StatusPage.normalizeSlug(slug);
        let statusPage = await store.findOne("status_page", " slug = ? ", [slug]);

        if (statusPage) {
            return {
                status: 200,
                body: await StatusPage.renderHTML(store, server, statusPage),
            };
        }

        return {
            status: 404,
            body: server.indexHTML,
        };
    }

    /**
     * Render a status page RSS feed by slug.
     * @param {string} slug Status page slug
     * @param {Request} request Request object
     * @returns {Promise<{ status: number, body: string, contentType: string }>} Response payload
     */
    static async renderRSSBySlug(store, server, settings, slug, request) {
        slug = StatusPage.normalizeSlug(slug);
        let statusPage = await store.findOne("status_page", " slug = ? ", [slug]);

        if (statusPage) {
            const feedUrl = await StatusPage.buildRSSUrl(settings, slug, request);
            return {
                status: 200,
                body: await StatusPage.renderRSS(store, server, statusPage, feedUrl),
                contentType: "application/rss+xml; charset=utf-8",
            };
        }

        return {
            status: 404,
            body: server.indexHTML,
            contentType: "text/html; charset=utf-8",
        };
    }

    /**
     * SSR for RSS feed
     * @param {StatusPage} statusPage Status page object
     * @param {string} feedUrl The URL for the RSS feed
     * @returns {Promise<string>} The rendered RSS XML
     */
    static async renderRSS(store, server, statusPage, feedUrl) {
        const { incidents, heartbeats, statusDescription } = await StatusPage.getRSSPageData(store, server, statusPage);
        const { Feed } = await import("feed");

        // Use custom RSS title if set, otherwise fall back to status page title
        let feedTitle = "Uptime Maku RSS Feed";
        if (statusPage.rss_title) {
            feedTitle = statusPage.rss_title;
        } else if (statusPage.title) {
            feedTitle = `${statusPage.title} RSS Feed`;
        }

        const feed = new Feed({
            title: feedTitle,
            description: `Current status: ${statusDescription}`,
            link: feedUrl,
            language: "en", // optional, used only in RSS 2.0, possible values: http://www.w3.org/TR/REC-html40/struct/dirlang.html#langcodes
            updated: new Date(), // optional, default = today
        });

        incidents.forEach((incident) => {
            let lastUpdatedDate = incident.lastUpdatedDate || incident.createdDate;
            feed.addItem({
                title: incident.title,
                description: incident.content,
                id: `i${incident.id}-${lastUpdatedDate}`,
                link: feedUrl,
                date: dayjs.utc(lastUpdatedDate).toDate(),
            });
        });

        heartbeats.forEach((heartbeat) => {
            feed.addItem({
                title: `${heartbeat.name} is down`,
                description: `${heartbeat.name} has been down since ${heartbeat.time} UTC`,
                id: `${heartbeat.monitorID}-${heartbeat.time}`,
                link: feedUrl,
                date: dayjs.utc(heartbeat.time).toDate(),
            });
        });

        return feed.rss2();
    }

    /**
     * Build RSS feed URL, handling proxy headers
     * @param {string} slug Status page slug
     * @param {Request} request Request object
     * @returns {Promise<string>} The full URL for the RSS feed
     */
    static async buildRSSUrl(settings, slug, request) {
        if (request) {
            const trustProxy = await settings.get("trustProxy");
            const url = new URL(request.url);
            const headers = request.headers;

            // Determine protocol (check X-Forwarded-Proto if behind proxy)
            let proto = url.protocol.replace(/:$/, "");
            const forwardedProto = headers.get("x-forwarded-proto");
            if (trustProxy && forwardedProto) {
                proto = forwardedProto.split(",")[0].trim();
            }

            // Determine host (check X-Forwarded-Host if behind proxy)
            let host = headers.get("host") || url.host;
            const forwardedHost = headers.get("x-forwarded-host");
            if (trustProxy && forwardedHost) {
                host = forwardedHost;
            }

            return `${proto}://${host}/status/${slug}`;
        }

        // Fallback to config values
        const proto = config.isSSL ? "https" : "http";
        const host = config.hostname || "localhost";
        const port = config.port;
        return `${proto}://${host}:${port}/status/${slug}`;
    }

    /**
     * SSR for status pages
     * @param {StatusPage} statusPage Status page populate HTML with
     * @returns {Promise<string>} the rendered html
     */
    static async renderHTML(store, server, statusPage) {
        return renderStatusPageDocument({
            statusPage,
            preloadData: await StatusPage.getStatusPageData(store, server, statusPage),
        });
    }

    /**
     * @param {heartbeats} heartbeats from getRSSPageData
     * @returns {number} status_page constant from util.ts
     */
    static overallStatus(heartbeats) {
        if (heartbeats.length === 0) {
            return -1;
        }

        let status = STATUS_PAGE_ALL_UP;
        let hasUp = false;

        for (let beat of heartbeats) {
            if (beat.status === MAINTENANCE) {
                return STATUS_PAGE_MAINTENANCE;
            } else if (beat.status === UP) {
                hasUp = true;
            } else {
                status = STATUS_PAGE_PARTIAL_DOWN;
            }
        }

        if (!hasUp) {
            status = STATUS_PAGE_ALL_DOWN;
        }

        return status;
    }

    /**
     * @param {number} status from overallStatus
     * @returns {string} description
     */
    static getStatusDescription(status) {
        if (status === -1) {
            return "No Services";
        }

        if (status === STATUS_PAGE_ALL_UP) {
            return "All Systems Operational";
        }

        if (status === STATUS_PAGE_PARTIAL_DOWN) {
            return "Partially Degraded Service";
        }

        if (status === STATUS_PAGE_ALL_DOWN) {
            return "Degraded Service";
        }

        // TODO: show the real maintenance information: title, description, time
        if (status === MAINTENANCE) {
            return "Under maintenance";
        }

        return "?";
    }

    /**
     * Get all data required for RSS
     * @param {StatusPage} statusPage Status page to get data for
     * @returns {object} Status page data
     */
    static async getRSSPageData(store, server, statusPage) {
        const { incidents, publicGroupList } = await StatusPage.getStatusPageData(store, server, statusPage);

        let heartbeats = [];

        for (let monitorGroup of publicGroupList) {
            for (const monitor of monitorGroup.monitorList) {
                const heartbeat = await store.findOne("heartbeat", "monitor_id = ? ORDER BY time DESC", [monitor.id]);
                if (heartbeat) {
                    heartbeats.push({
                        ...monitor,
                        status: heartbeat.status,
                        time: heartbeat.time,
                    });
                }
            }
        }

        // keep only DOWN heartbeats in the RSS feed
        heartbeats = heartbeats.filter((heartbeat) => heartbeat.status === DOWN);

        // calculate RSS feed description
        let status = StatusPage.overallStatus(heartbeats);
        let statusDescription = StatusPage.getStatusDescription(status);

        return {
            incidents,
            heartbeats,
            statusDescription,
        };
    }

    /**
     * Get all status page data in one call
     * @param {StatusPage} statusPage Status page to get data for
     * @returns {object} Status page data
     */
    static async getStatusPageData(store, server, statusPage) {
        const config = await statusPage.toPublicJSON();

        // All active incidents
        let incidents = await store.find(
            "incident",
            "pin = 1 AND active = 1 AND status_page_id = ? ORDER BY created_date DESC",
            [statusPage.id]
        );
        incidents = incidents.map((i) => i.toPublicJSON());

        let maintenanceList = await StatusPage.getMaintenanceList(store, server, statusPage.id);

        // Public Group List
        const publicGroupList = [];
        const showTags = !!statusPage.show_tags;

        const list = await store.find("group", "public = 1 AND status_page_id = ? ORDER BY weight", [statusPage.id]);

        for (let groupModel of list) {
            let monitorGroup = await groupModel.toPublicJSON(store, showTags, config?.showCertificateExpiry);
            publicGroupList.push(monitorGroup);
        }

        // Response
        return {
            config,
            incidents,
            publicGroupList,
            maintenanceList,
        };
    }

    /**
     * Loads domain mapping from DB
     * Return object like this: { "status.example.com": "default" }
     * @returns {Promise<void>}
     */
    static async loadDomainMappingList(store, domainMappingList) {
        const mappings = await store.getAssoc(`
            SELECT domain, slug
            FROM status_page, status_page_cname
            WHERE status_page.id = status_page_cname.status_page_id
        `);
        for (const domain in domainMappingList) {
            delete domainMappingList[domain];
        }
        Object.assign(domainMappingList, mappings);
    }

    /**
     * Send status page list to client
     * @param {Server} io io Socket server instance
     * @param {Socket} socket Socket.io instance
     * @returns {Promise<Model[]>} Status page list
     */
    static async sendStatusPageList(store, io, socket, domainMappingList) {
        let result = {};

        let list = await store.findAll("status_page", " ORDER BY title ");

        for (let item of list) {
            result[item.id] = await item.toJSON(domainMappingList);
        }

        io.to(socket.userID).emit("statusPageList", result);
        return list;
    }

    /**
     * Update list of domain names
     * @param {string[]} domainNameList List of status page domains
     * @returns {Promise<void>}
     */
    async updateDomainNameList(store, domainNameList) {
        const trx = await store.begin();
        try {
            await this.replaceDomainNameList(trx, domainNameList);
            await trx.commit();
        } catch (error) {
            await trx.rollback();
            throw error;
        }
    }

    async replaceDomainNameList(store, domainNameList) {
        if (!Array.isArray(domainNameList)) {
            throw new Error("Invalid array");
        }

        await store.exec("DELETE FROM status_page_cname WHERE status_page_id = ?", [this.id]);
        for (let domain of domainNameList) {
            if (typeof domain !== "string") {
                throw new Error("Invalid domain");
            }

            if (domain.trim() === "") {
                continue;
            }

            // If the domain name is used in another status page, delete it
            await store.exec("DELETE FROM status_page_cname WHERE domain = ?", [domain]);

            let mapping = store.createModel("status_page_cname");
            mapping.status_page_id = this.id;
            mapping.domain = domain;
            await store.saveModel(mapping);
        }
    }

    /**
     * Get list of domain names
     * @returns {object[]} List of status page domains
     */
    getDomainNameList(domainMappingList) {
        let domainList = [];
        for (let domain in domainMappingList) {
            let s = domainMappingList[domain];

            if (this.slug === s) {
                domainList.push(domain);
            }
        }
        return domainList;
    }

    /**
     * Return an object that ready to parse to JSON
     * @returns {object} Object ready to parse
     */
    async toJSON(domainMappingList = {}) {
        return {
            id: this.id,
            slug: this.slug,
            title: this.title,
            description: this.description,
            icon: this.getIcon(),
            theme: this.theme,
            autoRefreshInterval: this.autoRefreshInterval,
            published: !!this.published,
            showTags: !!this.show_tags,
            domainNameList: this.getDomainNameList(domainMappingList),
            customCSS: this.custom_css,
            footerText: this.footer_text,
            showPoweredBy: !!this.show_powered_by,
            analyticsId: this.analytics_id,
            analyticsScriptUrl: this.analytics_script_url,
            analyticsType: this.analytics_type,
            showCertificateExpiry: !!this.show_certificate_expiry,
            showOnlyLastHeartbeat: !!this.show_only_last_heartbeat,
            rssTitle: this.rss_title,
        };
    }

    /**
     * Return an object that ready to parse to JSON for public
     * Only show necessary data to public
     * @returns {object} Object ready to parse
     */
    async toPublicJSON() {
        return {
            slug: this.slug,
            title: this.title,
            description: this.description,
            icon: this.getIcon(),
            autoRefreshInterval: this.autoRefreshInterval,
            theme: this.theme,
            published: !!this.published,
            showTags: !!this.show_tags,
            customCSS: this.custom_css,
            footerText: this.footer_text,
            showPoweredBy: !!this.show_powered_by,
            analyticsId: this.analytics_id,
            analyticsScriptUrl: this.analytics_script_url,
            analyticsType: this.analytics_type,
            showCertificateExpiry: !!this.show_certificate_expiry,
            showOnlyLastHeartbeat: !!this.show_only_last_heartbeat,
            rssTitle: this.rss_title,
        };
    }

    /**
     * Convert slug to status page ID
     * @param {string} slug Status page slug
     * @returns {Promise<number>} ID of status page
     */
    static async slugToID(store, slug) {
        return await store.getCell("SELECT id FROM status_page WHERE slug = ? ", [slug]);
    }

    /**
     * Get path to the icon for the page
     * @returns {string} Path
     */
    getIcon() {
        if (!this.icon) {
            return "/icon.svg";
        } else {
            return this.icon;
        }
    }

    /**
     * Get paginated incident history for a status page using cursor-based pagination
     * @param {number} statusPageId ID of the status page
     * @param {string|null} cursor ISO date string cursor (created_date of last item from previous page)
     * @param {boolean} isPublic Whether to return public or admin data
     * @returns {Promise<object>} Paginated incident data with cursor
     */
    static async getIncidentHistory(store, statusPageId, cursor = null, isPublic = true) {
        let incidents;

        if (cursor) {
            incidents = await store.find(
                "incident",
                " status_page_id = ? AND created_date < ? ORDER BY created_date DESC LIMIT ? ",
                [statusPageId, cursor, INCIDENT_PAGE_SIZE]
            );
        } else {
            incidents = await store.find("incident", " status_page_id = ? ORDER BY created_date DESC LIMIT ? ", [
                statusPageId,
                INCIDENT_PAGE_SIZE,
            ]);
        }

        const total = await store.count("incident", " status_page_id = ? ", [statusPageId]);

        const lastIncident = incidents[incidents.length - 1];
        let nextCursor = null;
        let hasMore = false;

        if (lastIncident) {
            const moreCount = await store.count("incident", " status_page_id = ? AND created_date < ? ", [
                statusPageId,
                lastIncident.created_date,
            ]);
            hasMore = moreCount > 0;
            if (hasMore) {
                nextCursor = lastIncident.created_date;
            }
        }

        return {
            incidents: incidents.map((i) => i.toPublicJSON()),
            total,
            nextCursor,
            hasMore,
        };
    }

    /**
     * Get list of maintenances
     * @param {number} statusPageId ID of status page to get maintenance for
     * @returns {object} Object representing maintenances sanitized for public
     */
    static async getMaintenanceList(store, server, statusPageId) {
        try {
            const publicMaintenanceList = [];

            let maintenanceIDList = await store.getCol(
                `
                SELECT DISTINCT maintenance_id
                FROM maintenance_status_page
                WHERE status_page_id = ?
            `,
                [statusPageId]
            );

            for (const maintenanceID of maintenanceIDList) {
                let maintenance = server.getMaintenance(maintenanceID);
                if (maintenance && (await maintenance.isUnderMaintenance(server))) {
                    publicMaintenanceList.push(await maintenance.toPublicJSON(server));
                }
            }

            return publicMaintenanceList;
        } catch (error) {
            return [];
        }
    }
}

export default StatusPage;
