// @ts-nocheck

/**
 * Validates incident data
 * @param {object} incident - The incident object
 * @returns {void}
 * @throws {Error} If validation fails
 */
import { checkLogin } from "@/server/socket-auth";
import dayjs from "dayjs";
import { log } from "@/server/logger";
import ImageDataURI from "@/server/image-data-uri";
import Database from "@/server/database";
import { clearResponseCache } from "@/server/bun-response";
import StatusPage from "@/server/model/status_page";

function validateIncident(incident) {
    if (!incident.title || incident.title.trim() === "") {
        throw new Error("Please input title");
    }
    if (!incident.content || incident.content.trim() === "") {
        throw new Error("Please input content");
    }
}

/**
 * Socket handlers for status page
 * @param {Socket} socket Socket.io instance to add listeners on
 * @returns {void}
 */
export const statusPageSocketHandler = (socket, store, server, settings, responseCache) => {
    // Post or edit incident
    socket.on("postIncident", async (slug, incident, callback) => {
        try {
            checkLogin(socket);

            let statusPageID = await StatusPage.slugToID(store, slug);

            if (!statusPageID) {
                throw new Error("slug is not found");
            }

            let incidentModel;

            if (incident.id) {
                incidentModel = await store.findOne("incident", " id = ? AND status_page_id = ? ", [
                    incident.id,
                    statusPageID,
                ]);
            }

            if (incidentModel == null) {
                incidentModel = store.createModel("incident");
            }

            incidentModel.title = incident.title;
            incidentModel.content = incident.content;
            incidentModel.style = incident.style;
            incidentModel.pin = true;
            incidentModel.active = true;
            incidentModel.status_page_id = statusPageID;

            if (incident.id) {
                incidentModel.last_updated_date = store.isoDateTime(dayjs.utc());
            } else {
                incidentModel.created_date = store.isoDateTime(dayjs.utc());
            }

            await store.saveModel(incidentModel);

            callback({
                ok: true,
                incident: incidentModel.toPublicJSON(),
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });

    socket.on("unpinIncident", async (slug, callback) => {
        try {
            checkLogin(socket);

            let statusPageID = await StatusPage.slugToID(store, slug);

            await store.exec("UPDATE incident SET pin = 0 WHERE pin = 1 AND status_page_id = ? ", [statusPageID]);

            callback({
                ok: true,
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });

    socket.on("getIncidentHistory", async (slug, cursor, callback) => {
        try {
            let statusPageID = await StatusPage.slugToID(store, slug);
            if (!statusPageID) {
                throw new Error("slug is not found");
            }

            const isPublic = !socket.userID;
            const result = await StatusPage.getIncidentHistory(store, statusPageID, cursor, isPublic);
            callback({
                ok: true,
                ...result,
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });

    socket.on("editIncident", async (slug, incidentID, incident, callback) => {
        try {
            checkLogin(socket);

            let statusPageID = await StatusPage.slugToID(store, slug);
            if (!statusPageID) {
                callback({
                    ok: false,
                    msg: "slug is not found",
                    msgi18n: true,
                });
                return;
            }

            let model = await store.findOne("incident", " id = ? AND status_page_id = ? ", [incidentID, statusPageID]);
            if (!model) {
                callback({
                    ok: false,
                    msg: "Incident not found or access denied",
                    msgi18n: true,
                });
                return;
            }

            try {
                validateIncident(incident);
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                    msgi18n: true,
                });
                return;
            }

            const validStyles = ["info", "warning", "danger", "primary", "light", "dark"];
            if (!validStyles.includes(incident.style)) {
                incident.style = "warning";
            }

            model.title = incident.title;
            model.content = incident.content;
            model.style = incident.style;
            model.pin = incident.pin !== false;
            model.lastUpdatedDate = store.isoDateTime(dayjs.utc());

            await store.saveModel(model);

            callback({
                ok: true,
                msg: "Saved.",
                msgi18n: true,
                incident: model.toPublicJSON(),
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
                msgi18n: true,
            });
        }
    });

    socket.on("deleteIncident", async (slug, incidentID, callback) => {
        try {
            checkLogin(socket);

            let statusPageID = await StatusPage.slugToID(store, slug);
            if (!statusPageID) {
                callback({
                    ok: false,
                    msg: "slug is not found",
                    msgi18n: true,
                });
                return;
            }

            let model = await store.findOne("incident", " id = ? AND status_page_id = ? ", [incidentID, statusPageID]);
            if (!model) {
                callback({
                    ok: false,
                    msg: "Incident not found or access denied",
                    msgi18n: true,
                });
                return;
            }

            await store.deleteModel(model);

            callback({
                ok: true,
                msg: "successDeleted",
                msgi18n: true,
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
                msgi18n: true,
            });
        }
    });

    socket.on("resolveIncident", async (slug, incidentID, callback) => {
        try {
            checkLogin(socket);

            let statusPageID = await StatusPage.slugToID(store, slug);
            if (!statusPageID) {
                callback({
                    ok: false,
                    msg: "slug is not found",
                    msgi18n: true,
                });
                return;
            }

            let model = await store.findOne("incident", " id = ? AND status_page_id = ? ", [incidentID, statusPageID]);
            if (!model) {
                callback({
                    ok: false,
                    msg: "Incident not found or access denied",
                    msgi18n: true,
                });
                return;
            }

            await model.resolve(store);

            callback({
                ok: true,
                msg: "Resolved",
                msgi18n: true,
                incident: model.toPublicJSON(),
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
                msgi18n: true,
            });
        }
    });

    socket.on("getStatusPage", async (slug, callback) => {
        try {
            checkLogin(socket);

            let statusPage = await store.findOne("status_page", " slug = ? ", [slug]);

            if (!statusPage) {
                throw new Error("No slug?");
            }

            callback({
                ok: true,
                config: await statusPage.toJSON(server.statusPageDomainMappingList),
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });

    // Save Status Page
    // imgDataUrl Only Accept PNG!
    socket.on("saveStatusPage", async (slug, config, imgDataUrl, publicGroupList, callback) => {
        try {
            checkLogin(socket);

            // Save Config
            let statusPage = await store.findOne("status_page", " slug = ? ", [slug]);

            if (!statusPage) {
                throw new Error("No slug?");
            }

            checkSlug(config.slug);

            const header = "data:image/png;base64,";

            // Check logo format
            // If is image data url, convert to png file
            // Else assume it is a url, nothing to do
            if (imgDataUrl.startsWith("data:")) {
                if (!imgDataUrl.startsWith(header)) {
                    throw new Error("Only allowed PNG logo.");
                }

                const filename = `logo${statusPage.id}.png`;

                // Convert to file
                await ImageDataURI.outputFile(imgDataUrl, Database.uploadDir + filename);
                config.logo = `/upload/${filename}?t=` + Date.now();
            } else {
                config.logo = imgDataUrl;
            }

            statusPage.slug = config.slug;
            statusPage.title = config.title;
            statusPage.description = config.description;
            statusPage.icon = config.logo;
            ((statusPage.autoRefreshInterval = config.autoRefreshInterval), (statusPage.theme = config.theme));
            //statusPage.published = ;
            //statusPage.search_engine_index = ;
            statusPage.show_tags = config.showTags;
            //statusPage.password = null;
            statusPage.footer_text = config.footerText;
            statusPage.custom_css = config.customCSS;
            statusPage.show_powered_by = config.showPoweredBy;
            statusPage.rss_title = config.rssTitle;
            statusPage.show_only_last_heartbeat = config.showOnlyLastHeartbeat;
            statusPage.show_certificate_expiry = config.showCertificateExpiry;
            statusPage.modified_date = store.isoDateTime();
            statusPage.analytics_id = config.analyticsId;
            statusPage.analytics_script_url = config.analyticsScriptUrl;
            const validAnalyticsTypes = ["google", "umami", "plausible", "matomo", "rybbit"];
            if (config.analyticsType !== null && !validAnalyticsTypes.includes(config.analyticsType)) {
                throw new Error("Invalid analytics type");
            }
            statusPage.analytics_type = config.analyticsType;

            const transaction = await store.begin();
            try {
                await transaction.saveModel(statusPage);
                await statusPage.replaceDomainNameList(transaction, config.domainNameList);
                await transaction.commit();
            } catch (error) {
                await transaction.rollback();
                throw error;
            }
            await StatusPage.loadDomainMappingList(store, server.statusPageDomainMappingList);

            // Save Public Group List
            const groupIDList = [];
            let groupOrder = 1;

            for (let group of publicGroupList) {
                let groupModel;
                if (group.id) {
                    groupModel = await store.findOne("group", " id = ? AND public = 1 AND status_page_id = ? ", [
                        group.id,
                        statusPage.id,
                    ]);
                } else {
                    groupModel = store.createModel("group");
                }

                groupModel.status_page_id = statusPage.id;
                groupModel.name = group.name;
                groupModel.public = true;
                groupModel.weight = groupOrder++;

                await store.saveModel(groupModel);

                await store.exec("DELETE FROM monitor_group WHERE group_id = ? ", [groupModel.id]);

                let monitorOrder = 1;

                for (let monitor of group.monitorList) {
                    let relationModel = store.createModel("monitor_group");
                    relationModel.weight = monitorOrder++;
                    relationModel.group_id = groupModel.id;
                    relationModel.monitor_id = monitor.id;

                    if (monitor.sendUrl !== undefined) {
                        relationModel.send_url = monitor.sendUrl;
                    }

                    if (monitor.url !== undefined) {
                        relationModel.custom_url = monitor.url;
                    }

                    await store.saveModel(relationModel);
                }

                groupIDList.push(groupModel.id);
                group.id = groupModel.id;
            }

            // Delete groups that are not in the list
            log.debug("socket", "Delete groups that are not in the list");
            if (groupIDList.length === 0) {
                await store.exec("DELETE FROM `group` WHERE status_page_id = ?", [statusPage.id]);
            } else {
                const slots = groupIDList.map(() => "?").join(",");

                const data = [...groupIDList, statusPage.id];
                await store.exec(`DELETE FROM \`group\` WHERE id NOT IN (${slots}) AND status_page_id = ?`, data);
            }

            // Also change entry page to new slug if it is the default one, and slug is changed.
            if (server.entryPage === "statusPage-" + slug && statusPage.slug !== slug) {
                server.entryPage = "statusPage-" + statusPage.slug;
                await settings.set("entryPage", server.entryPage, "general");
            }

            clearResponseCache(responseCache);

            callback({
                ok: true,
                publicGroupList,
            });
        } catch (error) {
            log.error("socket", error);

            callback({
                ok: false,
                msg: error.message,
            });
        }
    });

    // Add a new status page
    socket.on("addStatusPage", async (title, slug, callback) => {
        try {
            checkLogin(socket);

            title = title?.trim();
            slug = slug?.trim();

            // Check empty
            if (!title || !slug) {
                throw new Error("Please input all fields");
            }

            // Make sure slug is string
            if (typeof slug !== "string") {
                throw new Error("Slug -Accept string only");
            }

            // lower case only
            slug = slug.toLowerCase();

            checkSlug(slug);

            let statusPage = store.createModel("status_page");
            statusPage.slug = slug;
            statusPage.title = title;
            statusPage.theme = "auto";
            statusPage.icon = "";
            statusPage.autoRefreshInterval = 300;
            await store.saveModel(statusPage);

            callback({
                ok: true,
                msg: "successAdded",
                msgi18n: true,
                slug: slug,
            });
        } catch (error) {
            log.error("socket", error);
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });

    // Delete a status page
    socket.on("deleteStatusPage", async (slug, callback) => {
        try {
            checkLogin(socket);

            let statusPageID = await StatusPage.slugToID(store, slug);

            if (statusPageID) {
                // No need to delete records from `status_page_cname`, because it has cascade foreign key.
                // But for incident & group, it is hard to add cascade foreign key during migration, so they have to be deleted manually.

                const transaction = await store.begin();
                try {
                    await transaction.exec("DELETE FROM incident WHERE status_page_id = ? ", [statusPageID]);
                    await transaction.exec("DELETE FROM `group` WHERE status_page_id = ? ", [statusPageID]);
                    await transaction.exec("DELETE FROM status_page WHERE id = ? ", [statusPageID]);
                    await transaction.commit();
                } catch (error) {
                    await transaction.rollback();
                    throw error;
                }

                if (server.entryPage === "statusPage-" + slug) {
                    server.entryPage = "dashboard";
                    await settings.set("entryPage", server.entryPage, "general");
                }

                await StatusPage.loadDomainMappingList(store, server.statusPageDomainMappingList);

                clearResponseCache(responseCache);
            } else {
                throw new Error("Status Page is not found");
            }

            callback({
                ok: true,
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });
};

/**
 * Check slug a-z, 0-9, - only
 * Regex from: https://stackoverflow.com/questions/22454258/js-regex-string-validation-for-slug
 * @param {string} slug Slug to test
 * @returns {void}
 * @throws Slug is not valid
 */
function checkSlug(slug) {
    if (typeof slug !== "string") {
        throw new Error("Slug must be string");
    }

    slug = slug.trim();

    if (!slug) {
        throw new Error("Slug cannot be empty");
    }

    if (!slug.match(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/)) {
        throw new Error("Invalid Slug");
    }
}
