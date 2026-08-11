// @ts-nocheck

import { UptimeCalculators } from "@/server/uptime-calculator";

class HeartbeatDataPlane {
    constructor(store, { now, maxCalculators } = {}) {
        this.store = store;
        this.uptime = new UptimeCalculators(store, { now, maxSize: maxCalculators });
        this.operationQueues = new Map();
    }

    runOperation(monitorID, operation) {
        const key = String(monitorID);
        this.uptime.pin(key);
        const previous = this.operationQueues.get(key);
        const pending = previous ? previous.then(operation) : Promise.resolve().then(operation);
        const settled = pending.catch(() => {});
        this.operationQueues.set(key, settled);
        return pending.finally(() => {
            this.uptime.release(key);
            if (this.operationQueues.get(key) === settled) {
                this.operationQueues.delete(key);
            }
        });
    }

    write(model) {
        return this.runOperation(model.monitor_id, () => this.commitWrite(model));
    }

    async commitWrite(model) {
        const calculator = await this.uptime.get(model.monitor_id);
        const staged = await calculator.stageUpdate(model.status, Number.parseFloat(model.ping));
        const transaction = await this.store.begin();
        const previousID = model.id;

        try {
            model.end_time = this.store.isoDateTimeMillis(staged.date);
            await transaction.saveModel(model);
            await staged.persist(transaction);
            await transaction.commit();
            staged.commit();
            return calculator;
        } catch (error) {
            await transaction.rollback();
            if (previousID === undefined) {
                delete model.id;
            } else {
                model.id = previousID;
            }
            throw error;
        }
    }

    async latest(monitorID) {
        return this.store.findOne("heartbeat", " monitor_id = ? ORDER BY time DESC, id DESC", [monitorID]);
    }

    async list(monitorID, limit = 100) {
        const rows = await this.store.getAll(
            "SELECT * FROM heartbeat WHERE monitor_id = ? ORDER BY time DESC, id DESC LIMIT ?",
            [monitorID, limit]
        );
        return this.store.hydrateModels("heartbeat", rows.reverse());
    }

    async recentForOwner(userID, monitorID, period) {
        return this.store.getAll(
            `SELECT heartbeat.* FROM heartbeat JOIN monitor ON monitor.id = heartbeat.monitor_id
             WHERE heartbeat.monitor_id = ? AND monitor.user_id = ?
               AND heartbeat.time > DATETIME('now', ? || ' hours')
             ORDER BY heartbeat.time ASC, heartbeat.id ASC`,
            [monitorID, userID, -period]
        );
    }

    async publicList(monitorID, limit = 100) {
        return (await this.list(monitorID, limit)).map((heartbeat) => heartbeat.toPublicJSON());
    }

    async stats(monitorID) {
        const calculator = await this.uptime.get(monitorID);
        return {
            day: calculator.get24Hour(),
            week: calculator.get7Day(),
            month: calculator.get30Day(),
            year: calculator.get1Year(),
        };
    }

    async importantCount(userID, monitorID = null) {
        const params = [userID];
        let monitorFilter = "";
        if (monitorID !== null && monitorID !== undefined) {
            monitorFilter = " AND heartbeat.monitor_id = ?";
            params.push(monitorID);
        }
        return Number(
            await this.store.getCell(
                `SELECT COUNT(*) FROM heartbeat JOIN monitor ON monitor.id = heartbeat.monitor_id
                 WHERE heartbeat.important = 1 AND monitor.user_id = ?${monitorFilter}`,
                params
            )
        );
    }

    async importantPage(userID, monitorID, offset, count) {
        const params = [userID];
        let monitorFilter = "";
        if (monitorID !== null && monitorID !== undefined) {
            monitorFilter = " AND heartbeat.monitor_id = ?";
            params.push(monitorID);
        }
        params.push(count, offset);
        const rows = await this.store.getAll(
            `SELECT heartbeat.* FROM heartbeat JOIN monitor ON monitor.id = heartbeat.monitor_id
             WHERE heartbeat.important = 1 AND monitor.user_id = ?${monitorFilter}
             ORDER BY heartbeat.time DESC LIMIT ? OFFSET ?`,
            params
        );
        return this.store.hydrateModels("heartbeat", rows);
    }

    async clearEvents(userID, monitorID) {
        await this.store.exec(
            `UPDATE heartbeat SET msg = ?, important = ?
             WHERE monitor_id = ? AND EXISTS (
                 SELECT 1 FROM monitor WHERE monitor.id = heartbeat.monitor_id AND monitor.user_id = ?
             )`,
            ["", 0, monitorID, userID]
        );
    }

    async clearMonitor(userID, monitorID) {
        const owned = await this.store.getCell("SELECT 1 FROM monitor WHERE id = ? AND user_id = ?", [
            monitorID,
            userID,
        ]);
        if (!owned) {
            throw new Error("You do not own this monitor.");
        }

        const transaction = await this.store.begin();
        try {
            for (const table of ["heartbeat", "stat_minutely", "stat_hourly", "stat_daily"]) {
                await transaction.exec(`DELETE FROM ${table} WHERE monitor_id = ?`, [monitorID]);
            }
            await transaction.commit();
            this.uptime.remove(monitorID);
        } catch (error) {
            await transaction.rollback();
            throw error;
        }
    }

    async clearAll(userID) {
        const monitorIDs = await this.store.getCol("SELECT id FROM monitor WHERE user_id = ?", [userID]);
        const transaction = await this.store.begin();
        try {
            for (const table of ["heartbeat", "stat_minutely", "stat_hourly", "stat_daily"]) {
                await transaction.exec(
                    `DELETE FROM ${table} WHERE monitor_id IN (SELECT id FROM monitor WHERE user_id = ?)`,
                    [userID]
                );
            }
            await transaction.commit();
            for (const monitorID of monitorIDs) {
                this.uptime.remove(monitorID);
            }
        } catch (error) {
            await transaction.rollback();
            throw error;
        }
    }

    reset() {
        this.uptime.removeAll();
        this.operationQueues.clear();
    }
}

export { HeartbeatDataPlane };
