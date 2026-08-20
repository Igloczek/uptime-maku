// @ts-nocheck

/**
 * Calculates the uptime of a monitor.
 */
import dayjs from "dayjs";
import { UP, MAINTENANCE, DOWN, PENDING } from "@/constants";
import { LimitQueue } from "@/server/utils/limit-queue";
import { log } from "@/server/logger";

const emptyUptimeData = () => ({
    up: 0,
    down: 0,
    avgPing: 0,
    minPing: 0,
    maxPing: 0,
});

const commitUptimeData = (queue, key, data) => {
    if (key in queue) {
        queue[key] = data;
    } else {
        queue.push(key, data);
    }
};

function statExtras(data) {
    const extras = { ...data };
    for (const key of ["up", "down", "avgPing", "minPing", "maxPing", "timestamp"]) {
        delete extras[key];
    }
    return Object.keys(extras).length > 0 ? JSON.stringify(extras) : null;
}

async function storeStat(target, table, monitorID, timestamp, data) {
    await target.exec(
        `
        INSERT INTO ${table} (monitor_id, timestamp, ping, ping_min, ping_max, up, down, extras)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(monitor_id, timestamp) DO UPDATE SET
            ping = excluded.ping,
            ping_min = excluded.ping_min,
            ping_max = excluded.ping_max,
            up = excluded.up,
            down = excluded.down,
            extras = excluded.extras
        `,
        [monitorID, timestamp, data.avgPing, data.minPing, data.maxPing, data.up, data.down, statExtras(data)]
    );
}

class UptimeCalculator {
    /**
     * monitorID the id of the monitor
     * @type {number}
     */
    monitorID;

    /**
     * Recent 24-hour uptime, each item is a 1-minute interval
     * Key: {number} DivisionKey
     * @type {LimitQueue<number,string>}
     */
    minutelyUptimeDataList = new LimitQueue(24 * 60);

    /**
     * Recent 30-day uptime, each item is a 1-hour interval
     * Key: {number} DivisionKey
     * @type {LimitQueue<number,string>}
     */
    hourlyUptimeDataList = new LimitQueue(30 * 24);

    /**
     * Daily uptime data,
     * Key: {number} DailyKey
     */
    dailyUptimeDataList = new LimitQueue(365);

    lastUptimeData = null;
    lastHourlyUptimeData = null;
    lastDailyUptimeData = null;

    /**
     * For migration purposes.
     * @type {boolean}
     */
    migrationMode = false;

    statMinutelyKeepHour = 24;
    statHourlyKeepDay = 30;

    constructor(store = null, now = () => dayjs.utc()) {
        this.store = store;
        this.now = now;
    }

    /**
     * Initialize the uptime calculator for a monitor
     * @param {number} monitorID the id of the monitor
     * @returns {Promise<void>}
     */
    async init(monitorID) {
        this.monitorID = monitorID;

        if (!this.store) {
            return;
        }

        let now = this.getCurrentDate();

        // Load minutely data from database (recent 24 hours only)
        let minutelyStatModels = await this.store.find(
            "stat_minutely",
            " monitor_id = ? AND timestamp > ? ORDER BY timestamp",
            [monitorID, this.getMinutelyKey(now.subtract(24, "hour"), false)]
        );

        for (let model of minutelyStatModels) {
            let data = {
                up: model.up,
                down: model.down,
                avgPing: model.ping,
                minPing: model.pingMin ?? model.ping_min,
                maxPing: model.pingMax ?? model.ping_max,
            };

            if (model.extras !== null && model.extras !== undefined) {
                data = {
                    ...data,
                    ...JSON.parse(model.extras),
                };
            }

            let key = model.timestamp;
            this.minutelyUptimeDataList.push(key, data);
        }

        // Load hourly data from database (recent 30 days only)
        let hourlyStatModels = await this.store.find(
            "stat_hourly",
            " monitor_id = ? AND timestamp > ? ORDER BY timestamp",
            [monitorID, this.getHourlyKey(now.subtract(30, "day"), false)]
        );

        for (let model of hourlyStatModels) {
            let data = {
                up: model.up,
                down: model.down,
                avgPing: model.ping,
                minPing: model.pingMin ?? model.ping_min,
                maxPing: model.pingMax ?? model.ping_max,
            };

            if (model.extras !== null && model.extras !== undefined) {
                data = {
                    ...data,
                    ...JSON.parse(model.extras),
                };
            }

            this.hourlyUptimeDataList.push(model.timestamp, data);
        }

        // Load daily data from database (recent 365 days only)
        let dailyStatModels = await this.store.find(
            "stat_daily",
            " monitor_id = ? AND timestamp > ? ORDER BY timestamp",
            [monitorID, this.getDailyKey(now.subtract(365, "day"), false)]
        );

        for (let model of dailyStatModels) {
            let data = {
                up: model.up,
                down: model.down,
                avgPing: model.ping,
                minPing: model.pingMin ?? model.ping_min,
                maxPing: model.pingMax ?? model.ping_max,
            };

            if (model.extras !== null && model.extras !== undefined) {
                data = {
                    ...data,
                    ...JSON.parse(model.extras),
                };
            }

            this.dailyUptimeDataList.push(model.timestamp, data);
        }
    }

    /**
     * @param {number} status status
     * @param {number} ping Ping
     * @param {dayjs.Dayjs} date Date (Only for migration)
     * @returns {Promise<dayjs.Dayjs>} date
     * @throws {Error} Invalid status
     */
    async stageUpdate(status, ping = 0, date) {
        if (!date) {
            date = this.getCurrentDate();
        }

        let flatStatus = this.flatStatus(status);

        if (flatStatus === DOWN && ping > 0) {
            log.debug("uptime_calc", "The ping is not effective when the status is DOWN");
        }

        let divisionKey = this.getMinutelyKey(date, false);
        let hourlyKey = this.getHourlyKey(date, false);
        let dailyKey = this.getDailyKey(date, false);

        let minutelyData = { ...(this.minutelyUptimeDataList[divisionKey] || emptyUptimeData()) };
        let hourlyData = { ...(this.hourlyUptimeDataList[hourlyKey] || emptyUptimeData()) };
        let dailyData = { ...(this.dailyUptimeDataList[dailyKey] || emptyUptimeData()) };

        if (status === MAINTENANCE) {
            minutelyData.maintenance = minutelyData.maintenance ? minutelyData.maintenance + 1 : 1;
            hourlyData.maintenance = hourlyData.maintenance ? hourlyData.maintenance + 1 : 1;
            dailyData.maintenance = dailyData.maintenance ? dailyData.maintenance + 1 : 1;
        } else if (flatStatus === UP) {
            minutelyData.up += 1;
            hourlyData.up += 1;
            dailyData.up += 1;

            // Only UP status can update the ping
            if (!isNaN(ping)) {
                // Add avg ping
                // The first beat of the minute, the ping is the current ping
                if (minutelyData.up === 1) {
                    minutelyData.avgPing = ping;
                    minutelyData.minPing = ping;
                    minutelyData.maxPing = ping;
                } else {
                    minutelyData.avgPing = (minutelyData.avgPing * (minutelyData.up - 1) + ping) / minutelyData.up;
                    minutelyData.minPing = Math.min(minutelyData.minPing, ping);
                    minutelyData.maxPing = Math.max(minutelyData.maxPing, ping);
                }

                // Add avg ping
                // The first beat of the hour, the ping is the current ping
                if (hourlyData.up === 1) {
                    hourlyData.avgPing = ping;
                    hourlyData.minPing = ping;
                    hourlyData.maxPing = ping;
                } else {
                    hourlyData.avgPing = (hourlyData.avgPing * (hourlyData.up - 1) + ping) / hourlyData.up;
                    hourlyData.minPing = Math.min(hourlyData.minPing, ping);
                    hourlyData.maxPing = Math.max(hourlyData.maxPing, ping);
                }

                // Add avg ping (daily)
                // The first beat of the day, the ping is the current ping
                if (dailyData.up === 1) {
                    dailyData.avgPing = ping;
                    dailyData.minPing = ping;
                    dailyData.maxPing = ping;
                } else {
                    dailyData.avgPing = (dailyData.avgPing * (dailyData.up - 1) + ping) / dailyData.up;
                    dailyData.minPing = Math.min(dailyData.minPing, ping);
                    dailyData.maxPing = Math.max(dailyData.maxPing, ping);
                }
            }
        } else if (flatStatus === DOWN) {
            minutelyData.down += 1;
            hourlyData.down += 1;
            dailyData.down += 1;
        }

        let currentDate = this.getCurrentDate();
        const commit = () => {
            commitUptimeData(this.minutelyUptimeDataList, divisionKey, minutelyData);
            commitUptimeData(this.hourlyUptimeDataList, hourlyKey, hourlyData);
            commitUptimeData(this.dailyUptimeDataList, dailyKey, dailyData);
            this.lastUptimeData = minutelyData;
            this.lastHourlyUptimeData = hourlyData;
            this.lastDailyUptimeData = dailyData;
        };

        return {
            date,
            commit,
            persist: async (target) => {
                await storeStat(target, "stat_daily", this.monitorID, dailyKey, dailyData);

                if (!this.migrationMode || date.isAfter(currentDate.subtract(this.statHourlyKeepDay, "day"))) {
                    await storeStat(target, "stat_hourly", this.monitorID, hourlyKey, hourlyData);
                }

                if (!this.migrationMode || date.isAfter(currentDate.subtract(this.statMinutelyKeepHour, "hour"))) {
                    await storeStat(target, "stat_minutely", this.monitorID, divisionKey, minutelyData);
                }

                if (!this.migrationMode) {
                    await target.exec("DELETE FROM stat_minutely WHERE monitor_id = ? AND timestamp < ?", [
                        this.monitorID,
                        this.getMinutelyKey(currentDate.subtract(this.statMinutelyKeepHour, "hour"), false),
                    ]);
                    await target.exec("DELETE FROM stat_hourly WHERE monitor_id = ? AND timestamp < ?", [
                        this.monitorID,
                        this.getHourlyKey(currentDate.subtract(this.statHourlyKeepDay, "day"), false),
                    ]);
                }
            },
        };
    }

    async update(status, ping = 0, date) {
        const staged = await this.stageUpdate(status, ping, date);
        if (!this.store) {
            staged.commit();
            return staged.date;
        }

        const transaction = await this.store.begin();
        try {
            await staged.persist(transaction);
            await transaction.commit();
            staged.commit();
            return staged.date;
        } catch (error) {
            await transaction.rollback();
            throw error;
        }
    }

    /**
     * Convert timestamp to minutely key
     * @param {dayjs.Dayjs} date The heartbeat date
     * @param {boolean} createIfMissing Whether to create a missing bucket, defaults to true
     * @returns {number} Timestamp
     */
    getMinutelyKey(date, createIfMissing = true) {
        // Truncate value to minutes (e.g. 2021-01-01 12:34:56 -> 2021-01-01 12:34:00)
        date = date.startOf("minute");

        // Convert to timestamp in second
        let divisionKey = date.unix();

        if (createIfMissing && !(divisionKey in this.minutelyUptimeDataList)) {
            this.minutelyUptimeDataList.push(divisionKey, {
                up: 0,
                down: 0,
                avgPing: 0,
                minPing: 0,
                maxPing: 0,
            });
        }

        return divisionKey;
    }

    /**
     * Convert timestamp to hourly key
     * @param {dayjs.Dayjs} date The heartbeat date
     * @param {boolean} createIfMissing Whether to create a missing bucket, defaults to true
     * @returns {number} Timestamp
     */
    getHourlyKey(date, createIfMissing = true) {
        // Truncate value to hours (e.g. 2021-01-01 12:34:56 -> 2021-01-01 12:00:00)
        date = date.startOf("hour");

        // Convert to timestamp in second
        let divisionKey = date.unix();

        if (createIfMissing && !(divisionKey in this.hourlyUptimeDataList)) {
            this.hourlyUptimeDataList.push(divisionKey, {
                up: 0,
                down: 0,
                avgPing: 0,
                minPing: 0,
                maxPing: 0,
            });
        }

        return divisionKey;
    }

    /**
     * Convert timestamp to daily key
     * @param {dayjs.Dayjs} date The heartbeat date
     * @param {boolean} createIfMissing Whether to create a missing bucket, defaults to true
     * @returns {number} Timestamp
     */
    getDailyKey(date, createIfMissing = true) {
        // Truncate value to start of day (e.g. 2021-01-01 12:34:56 -> 2021-01-01 00:00:00)
        // Considering if the user keep changing could affect the calculation, so use UTC time to avoid this problem.
        date = date.utc().startOf("day");
        let dailyKey = date.unix();

        if (createIfMissing && !this.dailyUptimeDataList[dailyKey]) {
            this.dailyUptimeDataList.push(dailyKey, {
                up: 0,
                down: 0,
                avgPing: 0,
                minPing: 0,
                maxPing: 0,
            });
        }

        return dailyKey;
    }

    /**
     * Convert timestamp to key
     * @param {dayjs.Dayjs} datetime Datetime
     * @param {"day" | "hour" | "minute"} type the type of data which is expected to be returned
     * @returns {number} Timestamp
     * @throws {Error} If the type is invalid
     */
    getKey(datetime, type, createIfMissing = false) {
        switch (type) {
            case "day":
                return this.getDailyKey(datetime, createIfMissing);
            case "hour":
                return this.getHourlyKey(datetime, createIfMissing);
            case "minute":
                return this.getMinutelyKey(datetime, createIfMissing);
            default:
                throw new Error("Invalid type");
        }
    }

    /**
     * Flat status to UP or DOWN
     * @param {number} status the status which should be turned into a flat status
     * @returns {UP|DOWN|PENDING} The flat status
     * @throws {Error} Invalid status
     */
    flatStatus(status) {
        switch (status) {
            case UP:
            case MAINTENANCE:
                return UP;
            case DOWN:
            case PENDING:
                return DOWN;
        }
        throw new Error("Invalid status");
    }

    /**
     * @param {number} num the number of data points which are expected to be returned
     * @param {"day" | "hour" | "minute"} type the type of data which is expected to be returned
     * @returns {UptimeDataResult} UptimeDataResult
     * @throws {Error} The maximum number of minutes greater than 1440
     */
    getData(num, type = "day") {
        if (type === "hour" && num > 24 * 30) {
            throw new Error("The maximum number of hours is 720");
        }
        if (type === "minute" && num > 24 * 60) {
            throw new Error("The maximum number of minutes is 1440");
        }
        if (type === "day" && num > 365) {
            throw new Error("The maximum number of days is 365");
        }
        // Get the current time period key based on the type
        let key = this.getKey(this.getCurrentDate(), type, false);

        let total = {
            up: 0,
            down: 0,
        };

        let totalPing = 0;
        let endTimestamp;

        // Get the earliest timestamp of the required period based on the type
        switch (type) {
            case "day":
                endTimestamp = key - 86400 * (num - 1);
                break;
            case "hour":
                endTimestamp = key - 3600 * (num - 1);
                break;
            case "minute":
                endTimestamp = key - 60 * (num - 1);
                break;
            default:
                throw new Error("Invalid type");
        }

        // Sum up all data in the specified time range
        while (key >= endTimestamp) {
            let data;

            switch (type) {
                case "day":
                    data = this.dailyUptimeDataList[key];
                    break;
                case "hour":
                    data = this.hourlyUptimeDataList[key];
                    break;
                case "minute":
                    data = this.minutelyUptimeDataList[key];
                    break;
                default:
                    throw new Error("Invalid type");
            }

            if (data) {
                total.up += data.up;
                total.down += data.down;
                totalPing += data.avgPing * data.up;
            }

            // Set key to the previous time period
            switch (type) {
                case "day":
                    key -= 86400;
                    break;
                case "hour":
                    key -= 3600;
                    break;
                case "minute":
                    key -= 60;
                    break;
                default:
                    throw new Error("Invalid type");
            }
        }

        let uptimeData = new UptimeDataResult();

        // If there is no data in the previous time ranges, use the last data?
        if (total.up === 0 && total.down === 0) {
            switch (type) {
                case "day":
                    if (this.lastDailyUptimeData) {
                        total = this.lastDailyUptimeData;
                        totalPing = total.avgPing * total.up;
                    } else {
                        return uptimeData;
                    }
                    break;
                case "hour":
                    if (this.lastHourlyUptimeData) {
                        total = this.lastHourlyUptimeData;
                        totalPing = total.avgPing * total.up;
                    } else {
                        return uptimeData;
                    }
                    break;
                case "minute":
                    if (this.lastUptimeData) {
                        total = this.lastUptimeData;
                        totalPing = total.avgPing * total.up;
                    } else {
                        return uptimeData;
                    }
                    break;
                default:
                    throw new Error("Invalid type");
            }
        }

        let avgPing;

        if (total.up === 0) {
            avgPing = null;
        } else {
            avgPing = totalPing / total.up;
        }

        if (total.up + total.down === 0) {
            uptimeData.uptime = 0;
        } else {
            uptimeData.uptime = total.up / (total.up + total.down);
        }
        uptimeData.avgPing = avgPing;
        return uptimeData;
    }

    /**
     * Get data in form of an array
     * @param {number} num the number of data points which are expected to be returned
     * @param {"day" | "hour" | "minute"} type the type of data which is expected to be returned
     * @returns {Array<object>} uptime data
     * @throws {Error} The maximum number of minutes greater than 1440
     */
    getDataArray(num, type = "day") {
        if (type === "hour" && num > 24 * 30) {
            throw new Error("The maximum number of hours is 720");
        }
        if (type === "minute" && num > 24 * 60) {
            throw new Error("The maximum number of minutes is 1440");
        }

        // Get the current time period key based on the type
        let key = this.getKey(this.getCurrentDate(), type, false);

        let result = [];

        let endTimestamp;

        // Get the earliest timestamp of the required period based on the type
        switch (type) {
            case "day":
                endTimestamp = key - 86400 * (num - 1);
                break;
            case "hour":
                endTimestamp = key - 3600 * (num - 1);
                break;
            case "minute":
                endTimestamp = key - 60 * (num - 1);
                break;
            default:
                throw new Error("Invalid type");
        }

        // Get datapoints in the specified time range
        while (key >= endTimestamp) {
            let data;

            switch (type) {
                case "day":
                    data = this.dailyUptimeDataList[key];
                    break;
                case "hour":
                    data = this.hourlyUptimeDataList[key];
                    break;
                case "minute":
                    data = this.minutelyUptimeDataList[key];
                    break;
                default:
                    throw new Error("Invalid type");
            }

            if (data) {
                data.timestamp = key;
                result.push(data);
            }

            // Set key to the previous time period
            switch (type) {
                case "day":
                    key -= 86400;
                    break;
                case "hour":
                    key -= 3600;
                    break;
                case "minute":
                    key -= 60;
                    break;
                default:
                    throw new Error("Invalid type");
            }
        }

        return result;
    }

    /**
     * Get the uptime data for given duration.
     * @param {string} duration  A string with a number and a unit (m,h,d,w,M,y), such as 24h, 30d, 1y.
     * @returns {UptimeDataResult} UptimeDataResult
     * @throws {Error} Invalid duration / Unsupported unit
     */
    getDataByDuration(duration) {
        const durationNumStr = duration.slice(0, -1);

        if (!/^[0-9]+$/.test(durationNumStr)) {
            throw new Error(`Invalid duration: ${duration}`);
        }
        const num = Number(durationNumStr);
        const unit = duration.slice(-1);

        switch (unit) {
            case "m":
                return this.getData(num, "minute");
            case "h":
                return this.getData(num, "hour");
            case "d":
                return this.getData(num, "day");
            case "w":
                return this.getData(7 * num, "day");
            case "M":
                return this.getData(30 * num, "day");
            case "y":
                return this.getData(365 * num, "day");
            default:
                throw new Error(`Unsupported unit (${unit}) for badge duration ${duration}`);
        }
    }

    /**
     * 1440 = 24 * 60mins
     * @returns {UptimeDataResult} UptimeDataResult
     */
    get24Hour() {
        return this.getData(1440, "minute");
    }

    /**
     * @returns {UptimeDataResult} UptimeDataResult
     */
    get7Day() {
        return this.getData(168, "hour");
    }

    /**
     * @returns {UptimeDataResult} UptimeDataResult
     */
    get30Day() {
        return this.getData(30);
    }

    /**
     * @returns {UptimeDataResult} UptimeDataResult
     */
    get1Year() {
        return this.getData(365);
    }

    /**
     * @returns {dayjs.Dayjs} Current datetime in UTC
     */
    getCurrentDate() {
        return this.now();
    }

    /**
     * For migration purposes.
     * @param {boolean} value Migration mode on/off
     * @returns {void}
     */
    setMigrationMode(value) {
        this.migrationMode = value;
    }
}

class UptimeCalculators {
    constructor(store, { now = () => dayjs.utc(), maxSize = 10000 } = {}) {
        this.store = store;
        this.now = now;
        this.maxSize = maxSize;
        this.list = new Map();
        this.pins = new Map();
    }

    pin(monitorID) {
        const key = String(monitorID);
        this.pins.set(key, (this.pins.get(key) || 0) + 1);
    }

    release(monitorID) {
        const key = String(monitorID);
        const count = this.pins.get(key) || 0;
        if (count <= 1) {
            this.pins.delete(key);
        } else {
            this.pins.set(key, count - 1);
        }
        this.evict();
    }

    evict() {
        for (const key of this.list.keys()) {
            if (this.list.size <= this.maxSize) {
                break;
            }
            if (!this.pins.has(key)) {
                this.list.delete(key);
            }
        }
    }

    async get(monitorID) {
        if (!monitorID) {
            throw new Error("Monitor ID is required");
        }

        const key = String(monitorID);
        let pending;
        if (!this.list.has(key)) {
            const calculator = new UptimeCalculator(this.store, this.now);
            pending = calculator.init(monitorID).then(() => calculator);
            this.list.set(key, pending);
            pending.catch(() => {
                if (this.list.get(key) === pending) {
                    this.list.delete(key);
                }
            });
        } else {
            pending = this.list.get(key);
            this.list.delete(key);
            this.list.set(key, pending);
        }
        this.evict();
        return pending;
    }

    remove(monitorID) {
        this.list.delete(String(monitorID));
    }

    removeAll() {
        this.list.clear();
        this.pins.clear();
    }
}

class UptimeDataResult {
    /**
     * @type {number} Uptime
     */
    uptime = 0;

    /**
     * @type {number} Average ping
     */
    avgPing = null;
}

export { UptimeCalculator, UptimeCalculators, UptimeDataResult };
