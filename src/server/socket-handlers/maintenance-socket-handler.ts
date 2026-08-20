// @ts-nocheck

import { checkLogin } from "@/server/socket-auth";
import { log } from "@/server/logger";
import { clearResponseCache } from "@/server/bun-response";
import Maintenance from "@/server/model/maintenance";

function getOwnedMaintenance(server, maintenanceID, userID) {
    const maintenance = server.getMaintenance(maintenanceID);
    if (!maintenance || maintenance.user_id !== userID) {
        throw new Error("Maintenance not found");
    }
    return maintenance;
}

async function getUniqueRelationIDs(store, items, table, userID = null) {
    if (!Array.isArray(items)) {
        throw new Error("Invalid relation list");
    }
    const ids = [...new Set(items.map((item) => item?.id))];
    for (const id of ids) {
        if (!Number.isInteger(id)) {
            throw new Error("Invalid relation id");
        }
        const condition = userID === null ? " id = ? " : " id = ? AND user_id = ? ";
        const params = userID === null ? [id] : [id, userID];
        if (!(await store.findOne(table, condition, params))) {
            throw new Error("Relation not found");
        }
    }
    return ids;
}

async function writeRelations(store, maintenanceID, ids, table, foreignKey) {
    await store.exec(`DELETE FROM ${table} WHERE maintenance_id = ?`, [maintenanceID]);
    for (const id of ids) {
        const model = store.createModel(table);
        model.import({ maintenance_id: maintenanceID, [foreignKey]: id });
        await store.saveModel(model);
    }
}

async function replaceRelations(store, maintenanceID, ids, table, foreignKey) {
    const transaction = await store.begin();
    try {
        await writeRelations(transaction, maintenanceID, ids, table, foreignKey);
        await transaction.commit();
    } catch (error) {
        await transaction.rollback();
        throw error;
    }
}

async function validateRelations(store, relations, userID) {
    if (relations === null) {
        return null;
    }
    if (!relations || typeof relations !== "object") {
        throw new Error("Invalid maintenance relations");
    }
    return {
        monitorIDs: await getUniqueRelationIDs(store, relations.monitors, "monitor", userID),
        statusPageIDs: await getUniqueRelationIDs(store, relations.statusPages, "status_page"),
    };
}

async function publishMaintenanceList(server, socket) {
    try {
        await server.sendMaintenanceList(socket);
    } catch (error) {
        log.error("maintenance", `Could not publish maintenance list: ${error.message}`);
    }
}

/**
 * Handlers for Maintenance
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
export const maintenanceSocketHandler = (socket, store, server, responseCache) => {
    // Add a new maintenance
    socket.on("addMaintenance", async (maintenance, relations, callback) => {
        if (typeof relations === "function") {
            callback = relations;
            relations = null;
        }
        let model;
        let transaction;
        let maintenanceID;
        try {
            checkLogin(socket);

            log.debug("maintenance", maintenance);

            const relationIDs = await validateRelations(store, relations, socket.userID);
            model = await Maintenance.jsonToModel(store.createModel("maintenance"), maintenance);
            model.user_id = socket.userID;
            transaction = await store.begin();
            maintenanceID = await transaction.saveModel(model);
            if (relationIDs) {
                await writeRelations(
                    transaction,
                    maintenanceID,
                    relationIDs.monitorIDs,
                    "monitor_maintenance",
                    "monitor_id"
                );
                await writeRelations(
                    transaction,
                    maintenanceID,
                    relationIDs.statusPageIDs,
                    "maintenance_status_page",
                    "status_page_id"
                );
            }
            await model.run(store, server, true, true, responseCache);
            await transaction.commit();
            transaction = null;
        } catch (e) {
            model?.stop();
            await transaction?.rollback();
            callback({
                ok: false,
                msg: e.message,
            });
            return;
        }
        server.maintenanceList[maintenanceID] = model;
        clearResponseCache(responseCache);
        callback({
            ok: true,
            msg: "successAdded",
            msgi18n: true,
            maintenanceID,
        });
        await publishMaintenanceList(server, socket);
    });

    // Edit a maintenance
    socket.on("editMaintenance", async (maintenance, relations, callback) => {
        if (typeof relations === "function") {
            callback = relations;
            relations = null;
        }
        let model;
        let draft;
        try {
            checkLogin(socket);

            model = getOwnedMaintenance(server, maintenance?.id, socket.userID);
            const relationIDs = await validateRelations(store, relations, socket.userID);
            draft = await Maintenance.jsonToModel(store.createModel("maintenance").import(model.export()), maintenance);
            const transaction = await store.begin();
            try {
                model.stop();
                await transaction.saveModel(draft);
                if (relationIDs) {
                    await writeRelations(
                        transaction,
                        draft.id,
                        relationIDs.monitorIDs,
                        "monitor_maintenance",
                        "monitor_id"
                    );
                    await writeRelations(
                        transaction,
                        draft.id,
                        relationIDs.statusPageIDs,
                        "maintenance_status_page",
                        "status_page_id"
                    );
                }
                await draft.run(store, server, true, true, responseCache);
                await transaction.commit();
            } catch (error) {
                draft.stop();
                await transaction.rollback();
                await model.run(store, server, true, true, responseCache);
                throw error;
            }
        } catch (e) {
            log.error("maintenance", e);
            callback({
                ok: false,
                msg: e.message,
            });
            return;
        }
        server.maintenanceList[model.id] = draft;
        clearResponseCache(responseCache);
        callback({
            ok: true,
            msg: "Saved.",
            msgi18n: true,
            maintenanceID: model.id,
        });
        await publishMaintenanceList(server, socket);
    });

    // Add a new monitor_maintenance
    socket.on("addMonitorMaintenance", async (maintenanceID, monitors, callback) => {
        try {
            checkLogin(socket);

            getOwnedMaintenance(server, maintenanceID, socket.userID);
            const monitorIDs = await getUniqueRelationIDs(store, monitors, "monitor", socket.userID);

            await replaceRelations(store, maintenanceID, monitorIDs, "monitor_maintenance", "monitor_id");

            clearResponseCache(responseCache);

            callback({
                ok: true,
                msg: "successAdded",
                msgi18n: true,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    // Add a new monitor_maintenance
    socket.on("addMaintenanceStatusPage", async (maintenanceID, statusPages, callback) => {
        try {
            checkLogin(socket);

            getOwnedMaintenance(server, maintenanceID, socket.userID);
            // Status pages have no user_id in this SQLite schema, so their ownership is global.
            const statusPageIDs = await getUniqueRelationIDs(store, statusPages, "status_page");

            await replaceRelations(store, maintenanceID, statusPageIDs, "maintenance_status_page", "status_page_id");

            clearResponseCache(responseCache);

            callback({
                ok: true,
                msg: "successAdded",
                msgi18n: true,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("getMaintenance", async (maintenanceID, callback) => {
        try {
            checkLogin(socket);

            log.debug("maintenance", `Get Maintenance: ${maintenanceID} User ID: ${socket.userID}`);

            let model = getOwnedMaintenance(server, maintenanceID, socket.userID);

            callback({
                ok: true,
                maintenance: await model.toJSON(server),
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("getMaintenanceList", async (callback) => {
        try {
            checkLogin(socket);

            await server.sendMaintenanceList(socket);
            callback({
                ok: true,
            });
        } catch (e) {
            log.error("maintenance", e);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("getMonitorMaintenance", async (maintenanceID, callback) => {
        try {
            checkLogin(socket);

            getOwnedMaintenance(server, maintenanceID, socket.userID);

            log.debug("maintenance", `Get Monitors for Maintenance: ${maintenanceID} User ID: ${socket.userID}`);

            let monitors = await store.getAll(
                "SELECT monitor.id FROM monitor_maintenance mm JOIN monitor ON mm.monitor_id = monitor.id WHERE mm.maintenance_id = ? ",
                [maintenanceID]
            );

            callback({
                ok: true,
                monitors,
            });
        } catch (e) {
            log.error("maintenance", e);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("getMaintenanceStatusPage", async (maintenanceID, callback) => {
        try {
            checkLogin(socket);

            getOwnedMaintenance(server, maintenanceID, socket.userID);

            log.debug("maintenance", `Get Status Pages for Maintenance: ${maintenanceID} User ID: ${socket.userID}`);

            let statusPages = await store.getAll(
                "SELECT status_page.id, status_page.title FROM maintenance_status_page msp JOIN status_page ON msp.status_page_id = status_page.id WHERE msp.maintenance_id = ? ",
                [maintenanceID]
            );

            callback({
                ok: true,
                statusPages,
            });
        } catch (e) {
            log.error("maintenance", e);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("deleteMaintenance", async (maintenanceID, callback) => {
        try {
            checkLogin(socket);

            log.debug("maintenance", `Delete Maintenance: ${maintenanceID} User ID: ${socket.userID}`);

            const maintenance = getOwnedMaintenance(server, maintenanceID, socket.userID);
            await store.exec("DELETE FROM maintenance WHERE id = ? AND user_id = ? ", [maintenanceID, socket.userID]);
            maintenance.active = false;
            maintenance.stop();
            delete server.maintenanceList[maintenanceID];

            clearResponseCache(responseCache);

            callback({
                ok: true,
                msg: "successDeleted",
                msgi18n: true,
            });

            await publishMaintenanceList(server, socket);
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("pauseMaintenance", async (maintenanceID, callback) => {
        try {
            checkLogin(socket);

            log.debug("maintenance", `Pause Maintenance: ${maintenanceID} User ID: ${socket.userID}`);

            let maintenance = getOwnedMaintenance(server, maintenanceID, socket.userID);

            const active = maintenance.active;
            maintenance.active = false;
            try {
                await store.saveModel(maintenance);
            } catch (error) {
                maintenance.active = active;
                throw error;
            }
            maintenance.stop();

            clearResponseCache(responseCache);

            callback({
                ok: true,
                msg: "successPaused",
                msgi18n: true,
            });

            await publishMaintenanceList(server, socket);
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("resumeMaintenance", async (maintenanceID, callback) => {
        try {
            checkLogin(socket);

            log.debug("maintenance", `Resume Maintenance: ${maintenanceID} User ID: ${socket.userID}`);

            let maintenance = getOwnedMaintenance(server, maintenanceID, socket.userID);

            const active = maintenance.active;
            maintenance.active = true;
            try {
                await store.saveModel(maintenance);
                await maintenance.run(store, server, true, true, responseCache);
            } catch (error) {
                maintenance.stop();
                maintenance.active = active;
                await store.saveModel(maintenance);
                throw error;
            }

            clearResponseCache(responseCache);

            callback({
                ok: true,
                msg: "successResumed",
                msgi18n: true,
            });

            await publishMaintenanceList(server, socket);
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });
};
