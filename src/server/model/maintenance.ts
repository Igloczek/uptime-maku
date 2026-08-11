// @ts-nocheck

import { SQLiteModel } from "@/server/sqlite-model";
import { parseTimeObject, parseTimeFromTimeObject } from "@/util/time";
import { log } from "@/server/logger";
import { SQL_DATETIME_FORMAT } from "@/constants";
import dayjs from "dayjs";
import Cron from "croner";
import { clearResponseCache } from "@/server/bun-response";

class Maintenance extends SQLiteModel {
    constructor() {
        super();
        Object.defineProperty(this, "modelMeta", { value: {}, writable: true, enumerable: false });
    }

    /**
     * Return an object that ready to parse to JSON for public
     * Only show necessary data to public
     * @returns {Promise<object>} Object ready to parse
     */
    async toPublicJSON(server) {
        let dateRange = [];
        if (this.start_date) {
            dateRange.push(this.start_date);
        } else {
            dateRange.push(null);
        }

        if (this.end_date) {
            dateRange.push(this.end_date);
        }

        let timeRange = [];
        let startTime = parseTimeObject(this.start_time);
        timeRange.push(startTime);
        let endTime = parseTimeObject(this.end_time);
        timeRange.push(endTime);

        let obj = {
            id: this.id,
            title: this.title,
            description: this.description,
            strategy: this.strategy,
            intervalDay: this.interval_day,
            active: !!this.active,
            dateRange: dateRange,
            timeRange: timeRange,
            weekdays: this.parseList(this.weekdays),
            daysOfMonth: this.parseList(this.days_of_month),
            timeslotList: [],
            cron: this.cron,
            duration: this.duration,
            durationMinutes: parseInt(this.duration / 60),
            timezone: await this.getTimezone(server), // Only valid timezone
            timezoneOption: this.timezone, // Mainly for dropdown menu, because there is a option "SAME_AS_SERVER"
            timezoneOffset: await this.getTimezoneOffset(server),
            status: await this.getStatus(server),
        };

        if (this.strategy === "manual") {
            // Do nothing, no timeslots
        } else if (this.strategy === "single") {
            obj.timeslotList.push({
                startDate: this.start_date,
                endDate: this.end_date,
            });
        } else {
            // Should be cron or recurring here
            if (this.modelMeta.job) {
                const runningTimeslot = await this.getRunningTimeslot(server);

                if (runningTimeslot) {
                    obj.timeslotList.push(runningTimeslot);
                }

                let nextRunDate = this.modelMeta.job.nextRun();
                if (nextRunDate) {
                    if (this.strategy.startsWith("recurring-")) {
                        obj.timeslotList.push(await this.getTimeslot(server, nextRunDate));
                    } else {
                        const startDate = dayjs(nextRunDate);
                        obj.timeslotList.push({
                            startDate: startDate.toISOString(),
                            endDate: startDate.add(this.duration, "second").toISOString(),
                        });
                    }
                }
            }
        }

        if (!Array.isArray(obj.weekdays)) {
            obj.weekdays = [];
        }

        if (!Array.isArray(obj.daysOfMonth)) {
            obj.daysOfMonth = [];
        }

        return obj;
    }

    /**
     * Return an object that ready to parse to JSON
     * @param {string} timezone If not specified, the timeRange will be in UTC
     * @returns {Promise<object>} Object ready to parse
     */
    async toJSON(server) {
        return this.toPublicJSON(server);
    }

    /**
     * Get a list of weekdays that the maintenance is active for
     * Monday=1, Tuesday=2 etc.
     * @returns {number[]} Array of active weekdays
     */
    getDayOfWeekList() {
        log.debug("timeslot", "List: " + this.weekdays);
        return this.parseList(this.weekdays).sort(function (a, b) {
            return a - b;
        });
    }

    /**
     * Get a list of days in month that maintenance is active for
     * @returns {number[]|string[]} Array of active days in month
     */
    getDayOfMonthList() {
        return this.parseList(this.days_of_month).sort(function (a, b) {
            return a - b;
        });
    }

    /**
     * Get the duration of maintenance in seconds
     * @returns {number} Duration of maintenance
     */
    calcDuration() {
        const [startHour, startMinute] = this.start_time.split(":").map(Number);
        const [endHour, endMinute] = this.end_time.split(":").map(Number);
        let duration = (endHour * 60 + endMinute - startHour * 60 - startMinute) * 60;
        // Add 24hours if it is across day
        if (duration < 0) {
            duration += 24 * 3600;
        }
        return duration;
    }

    /**
     * Resolve one recurring window against the timezone offset of that occurrence.
     * @param {Date|string} startDate Concrete start instant
     * @returns {Promise<{startDate: string, endDate: string}>} Concrete UTC timeslot
     */
    async getTimeslot(server, startDate) {
        const timezone = await this.getTimezone(server);
        const start = dayjs(startDate);
        const [hour, minute] = this.end_time.split(":").map(Number);
        const endJob = new Cron(`${minute} ${hour} * * *`, { timezone, paused: true });
        let end = dayjs(endJob.nextRun(start.toDate()));
        endJob.stop();

        const [startHour, startMinute] = this.start_time.split(":").map(Number);
        const localStart = start.tz(timezone);
        const nominalStartMinute = startHour * 60 + startMinute;
        const nominalEndMinute = hour * 60 + minute;
        const shiftedStart = localStart.hour() !== startHour || localStart.minute() !== startMinute;
        if (
            shiftedStart &&
            nominalEndMinute >= nominalStartMinute &&
            localStart.hour() * 60 + localStart.minute() >= nominalEndMinute
        ) {
            end = start.add(this.calcDuration(), "second");
        }

        return {
            startDate: start.toISOString(),
            endDate: end.toISOString(),
        };
    }

    /**
     * Legacy malformed relation lists are displayed as empty and never run a job.
     * @param {string|null} value JSON list from SQLite
     * @returns {Array} Parsed list
     */
    parseList(value) {
        try {
            const list = value ? JSON.parse(value) : [];
            return Array.isArray(list) ? list : [];
        } catch {
            return [];
        }
    }

    /**
     * Convert data from socket to model
     * @param {Model} model Model to fill in
     * @param {object} obj Data to fill model with
     * @returns {Promise<Model>} Filled model
     */
    static async jsonToModel(model, obj) {
        if (!obj || typeof obj !== "object") {
            throw new Error("Invalid maintenance");
        }

        const strategies = new Set([
            "manual",
            "single",
            "cron",
            "recurring-interval",
            "recurring-weekday",
            "recurring-day-of-month",
        ]);
        if (typeof obj.title !== "string" || !obj.title.trim() || obj.title.length > 150) {
            throw new Error("Invalid title");
        }
        if (typeof obj.description !== "string" || !strategies.has(obj.strategy) || !Array.isArray(obj.dateRange)) {
            throw new Error("Invalid maintenance");
        }
        if (![true, false, 0, 1].includes(obj.active)) {
            throw new Error("Invalid active state");
        }
        if (obj.timezoneOption && obj.timezoneOption !== "SAME_AS_SERVER") {
            try {
                Intl.DateTimeFormat(undefined, { timeZone: obj.timezoneOption });
            } catch {
                throw new Error("Invalid timezone");
            }
        }

        const parseDate = (value, name, required = false) => {
            if (value === null || value === undefined || value === "") {
                if (required) {
                    throw new Error(`Invalid ${name} date`);
                }
                return null;
            }
            if (typeof value !== "string") {
                throw new Error(`Invalid ${name} date`);
            }
            const date = new Date(value);
            if (isNaN(date.getTime()) || date.getFullYear() > 9999) {
                throw new Error(`Invalid ${name} date`);
            }
            return date;
        };
        const startDate = parseDate(obj.dateRange[0], "start", obj.strategy === "single");
        const endDate = parseDate(obj.dateRange[1], "end", obj.strategy === "single");
        if (startDate && endDate && endDate <= startDate) {
            throw new Error("End date must be after start date");
        }

        const validateTime = (time) =>
            time &&
            Number.isInteger(time.hours) &&
            Number.isInteger(time.minutes) &&
            time.hours >= 0 &&
            time.hours < 24 &&
            time.minutes >= 0 &&
            time.minutes < 60;
        if (
            obj.strategy.startsWith("recurring-") &&
            (!Array.isArray(obj.timeRange) || !validateTime(obj.timeRange[0]) || !validateTime(obj.timeRange[1]))
        ) {
            throw new Error("Invalid maintenance time");
        }
        if (
            obj.strategy === "recurring-interval" &&
            (!Number.isInteger(Number(obj.intervalDay)) ||
                Number(obj.intervalDay) < 1 ||
                Number(obj.intervalDay) > 3650)
        ) {
            throw new Error("Invalid interval");
        }
        if (
            obj.strategy === "recurring-weekday" &&
            (!Array.isArray(obj.weekdays) ||
                obj.weekdays.length === 0 ||
                obj.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6))
        ) {
            throw new Error("Invalid weekdays");
        }
        if (
            obj.strategy === "recurring-day-of-month" &&
            (!Array.isArray(obj.daysOfMonth) ||
                obj.daysOfMonth.length === 0 ||
                obj.daysOfMonth.some(
                    (day) => !((Number.isInteger(day) && day >= 1 && day <= 31) || day === "lastDay1")
                ))
        ) {
            throw new Error("Invalid days of month");
        }
        if (obj.strategy === "cron") {
            if (
                !Number.isInteger(Number(obj.durationMinutes)) ||
                Number(obj.durationMinutes) < 1 ||
                Number(obj.durationMinutes) > 24 * 60
            ) {
                throw new Error("Invalid duration");
            }
            if (typeof obj.cron !== "string") {
                throw new Error("Invalid cron");
            }
        }
        if (obj.id) {
            model.id = obj.id;
        }

        model.title = obj.title;
        model.description = obj.description;
        model.strategy = obj.strategy;
        model.interval_day = obj.intervalDay;
        model.timezone = obj.timezoneOption;
        model.active = obj.active;

        if (startDate) {
            model.start_date = obj.dateRange[0];
        } else {
            model.start_date = null;
        }

        if (endDate) {
            model.end_date = obj.dateRange[1];
        } else {
            model.end_date = null;
        }

        if (model.strategy === "cron") {
            model.duration = obj.durationMinutes * 60;
            model.cron = obj.cron;
            this.validateCron(model.cron);
        }

        if (model.strategy.startsWith("recurring-")) {
            model.start_time = parseTimeFromTimeObject(obj.timeRange[0]);
            model.end_time = parseTimeFromTimeObject(obj.timeRange[1]);
            model.weekdays = JSON.stringify(obj.weekdays);
            model.days_of_month = JSON.stringify(obj.daysOfMonth);
            await model.generateCron();
            if (model.duration <= 0 || model.duration > 24 * 60 * 60) {
                throw new Error("Invalid duration");
            }
            this.validateCron(model.cron);
        }
        return model;
    }

    /**
     * Throw error if cron is invalid
     * @param {string|Date} cron Pattern or date
     * @returns {void}
     */
    static validateCron(cron) {
        let job = new Cron(cron, () => {});
        job.stop();
    }

    /**
     * Run the cron
     * @param {boolean} throwError Should an error be thrown on failure
     * @param {boolean} recovery Restore an already-running timeslot without persistence or publication
     * @returns {Promise<void>}
     */
    async run(store, server, throwError = false, recovery = false, responseCache) {
        this.stop();
        if (!this.active) {
            return;
        }
        const generation = this.modelMeta.generation;

        if (this.end_date && dayjs().isAfter(dayjs.tz(this.end_date, await this.getTimezone(server)))) {
            return;
        }

        log.debug("maintenance", "Run maintenance id: " + this.id);

        // 1.21.2 migration
        if (!this.cron) {
            await this.generateCron();
            if (!this.timezone) {
                this.timezone = "UTC";
            }
            if (this.cron && !recovery) {
                await store.saveModel(this);
            }
        }

        if (this.strategy === "manual") {
            // Do nothing, because it is controlled by the user
        } else if (this.strategy === "single") {
            const timezone = await this.getTimezone(server);
            const now = dayjs();
            const start = dayjs.tz(this.start_date, timezone);
            const notify = async () => {
                if (!this.active || this.modelMeta.generation !== generation) {
                    return;
                }
                clearResponseCache(responseCache);
                await server.sendMaintenanceListByUserID(this.user_id);
            };

            if (now.isBefore(start)) {
                this.modelMeta.job = new Cron(this.start_date, { timezone }, async () => {
                    if (!this.active || this.modelMeta.generation !== generation) {
                        return;
                    }
                    delete this.modelMeta.job;
                    log.info("maintenance", "Maintenance id: " + this.id + " is under maintenance now");
                    await notify();
                });
            }
            this.modelMeta.endJob = new Cron(this.end_date, { timezone }, async () => {
                if (!this.active || this.modelMeta.generation !== generation) {
                    return;
                }
                delete this.modelMeta.endJob;
                log.info("maintenance", "Maintenance id: " + this.id + " has ended");
                await notify();
            });
        } else if (this.cron != null) {
            // Here should be cron or recurring
            try {
                this.modelMeta.status = "scheduled";

                let startEvent = async (customDuration = 0, notify = true, persist = true) => {
                    const timezone = await this.getTimezone(server);
                    if (
                        !this.active ||
                        this.modelMeta.generation !== generation ||
                        (this.start_date && dayjs().isBefore(dayjs.tz(this.start_date, timezone))) ||
                        (this.end_date && dayjs().isAfter(dayjs.tz(this.end_date, timezone)))
                    ) {
                        return;
                    }

                    log.info("maintenance", "Maintenance id: " + this.id + " is under maintenance now");

                    this.modelMeta.status = "under-maintenance";
                    clearTimeout(this.modelMeta.durationTimeout);

                    let duration = await this.inferDuration(server, customDuration);
                    if (!this.active || this.modelMeta.generation !== generation) {
                        return;
                    }

                    if (notify) {
                        clearResponseCache(responseCache);
                        server.sendMaintenanceListByUserID(this.user_id);
                    }

                    this.modelMeta.durationTimeout = setTimeout(() => {
                        if (!this.active || this.modelMeta.generation !== generation) {
                            return;
                        }
                        // End of maintenance for this timeslot
                        this.modelMeta.status = "scheduled";
                        delete this.modelMeta.durationTimeout;
                        clearResponseCache(responseCache);
                        server.sendMaintenanceListByUserID(this.user_id);
                    }, duration);

                    if (persist) {
                        this.last_start_date = dayjs().utc().format(SQL_DATETIME_FORMAT);
                        await store.saveModel(this);
                    }
                };

                // Create Cron
                if (this.strategy === "recurring-interval") {
                    // For recurring-interval, Croner needs to have interval and startAt
                    const startDate = dayjs(this.start_date);
                    const [hour, minute] = this.start_time.split(":");
                    const startDateTime = startDate.hour(hour).minute(minute);

                    // Fix #6118, since the startDateTime is optional, it will throw error if the date is null when using toISOString()
                    let startAt = undefined;
                    try {
                        startAt = startDateTime.toISOString();
                    } catch (_) {}

                    this.modelMeta.job = new Cron(
                        this.cron,
                        {
                            timezone: await this.getTimezone(server),
                            startAt,
                        },
                        () => {
                            if (!this.last_start_date || this.interval_day === 1) {
                                return startEvent();
                            }

                            // If last start date is set, it means the maintenance has been started before
                            let lastStartDate = dayjs(this.last_start_date).subtract(1.1, "hour"); // Subtract 1.1 hour to avoid issues with timezone differences

                            // Check if the interval is enough
                            if (dayjs().diff(lastStartDate, "day") < this.interval_day) {
                                log.debug(
                                    "maintenance",
                                    "Maintenance id: " + this.id + " is still in the window, skipping start event"
                                );
                                return;
                            }

                            log.debug(
                                "maintenance",
                                "Maintenance id: " + this.id + " is not in the window, starting event"
                            );
                            return startEvent();
                        }
                    );
                } else {
                    this.modelMeta.job = new Cron(
                        this.cron,
                        {
                            timezone: await this.getTimezone(server),
                        },
                        startEvent
                    );
                }

                // Continue if the maintenance is still in the window
                let runningTimeslot = await this.getRunningTimeslot(server);

                if (runningTimeslot) {
                    let duration = dayjs(runningTimeslot.endDate).diff(dayjs(), "second") * 1000;
                    log.debug("maintenance", "Maintenance id: " + this.id + " Remaining duration: " + duration + "ms");
                    await startEvent(duration, !recovery, !recovery);
                }
            } catch (e) {
                this.stop();
                log.error("maintenance", "Error in maintenance id: " + this.id);
                log.error("maintenance", "Cron: " + this.cron);
                log.error("maintenance", e);

                if (throwError) {
                    throw e;
                }
            }
        } else {
            log.error("maintenance", "Maintenance id: " + this.id + " has no cron");
        }
    }

    /**
     * Get timeslots where maintenance is running
     * @returns {object|null} Maintenance time slot
     */
    async getRunningTimeslot(server) {
        const current = dayjs();
        let start;
        let end;

        if (this.strategy.startsWith("recurring-")) {
            const previousRun = this.modelMeta.job.nextRun(current.subtract(25, "hour").toDate());
            if (!previousRun) {
                return null;
            }
            start = dayjs(previousRun);
            let timeslot = await this.getTimeslot(server, start.toDate());
            end = dayjs(timeslot.endDate);
            if (!end.isAfter(current)) {
                const nextRun = this.modelMeta.job.nextRun(start.add(1, "millisecond").toDate());
                if (!nextRun) {
                    return null;
                }
                start = dayjs(nextRun);
                timeslot = await this.getTimeslot(server, start.toDate());
                end = dayjs(timeslot.endDate);
            }
        } else {
            start = dayjs(this.modelMeta.job.nextRun(current.add(-this.duration, "second").toDate()));
            end = start.add(this.duration, "second");
        }

        if (current.isAfter(start) && current.isBefore(end)) {
            return {
                startDate: start.toISOString(),
                endDate: end.toISOString(),
            };
        } else {
            return null;
        }
    }

    /**
     * Calculate the maintenance duration
     * @param {number} customDuration - The custom duration in milliseconds.
     * @returns {number} The inferred duration in milliseconds.
     */
    async inferDuration(server, customDuration) {
        // Check if duration is still in the window. If not, use the duration from the current time to the end of the window
        const now = dayjs();
        let duration;
        if (customDuration > 0) {
            duration = customDuration;
        } else if (this.strategy.startsWith("recurring-")) {
            const timeslot = await this.getTimeslot(server, now.toDate());
            duration = dayjs(timeslot.endDate).diff(now);
        } else {
            duration = this.duration * 1000;
        }
        if (this.end_date) {
            duration = Math.min(duration, dayjs.tz(this.end_date, await this.getTimezone(server)).diff(now));
        }
        return Math.max(0, duration);
    }

    /**
     * Stop the maintenance
     * @returns {void}
     */
    stop() {
        this.modelMeta.generation = (this.modelMeta.generation || 0) + 1;
        if (this.modelMeta.job) {
            this.modelMeta.job.stop();
            delete this.modelMeta.job;
        }
        if (this.modelMeta.endJob) {
            this.modelMeta.endJob.stop();
            delete this.modelMeta.endJob;
        }
        if (this.modelMeta.durationTimeout) {
            clearTimeout(this.modelMeta.durationTimeout);
            delete this.modelMeta.durationTimeout;
        }
        delete this.modelMeta.status;
    }

    /**
     * Is this maintenance currently active
     * @returns {Promise<boolean>} The maintenance is active?
     */
    async isUnderMaintenance(server) {
        return (await this.getStatus(server)) === "under-maintenance";
    }

    /**
     * Get the timezone of the maintenance
     * @returns {Promise<string>} timezone
     */
    async getTimezone(server) {
        if (!this.timezone || this.timezone === "SAME_AS_SERVER") {
            return await server.getTimezone();
        }
        try {
            Intl.DateTimeFormat(undefined, { timeZone: this.timezone });
            return this.timezone;
        } catch {
            log.warn("maintenance", `Invalid legacy timezone ${this.timezone}; using server timezone`);
            return await server.getTimezone();
        }
    }

    /**
     * Get offset for timezone
     * @returns {Promise<string>} offset
     */
    async getTimezoneOffset(server) {
        return dayjs.tz(dayjs(), await this.getTimezone(server)).format("Z");
    }

    /**
     * Get the current status of the maintenance
     * @returns {Promise<string>} Current status
     */
    async getStatus(server) {
        if (!this.active) {
            return "inactive";
        }

        if (this.strategy === "manual") {
            return "under-maintenance";
        }

        // Check if the maintenance is started
        if (this.start_date && dayjs().isBefore(dayjs.tz(this.start_date, await this.getTimezone(server)))) {
            return "scheduled";
        }

        // Check if the maintenance is ended
        if (this.end_date && dayjs().isAfter(dayjs.tz(this.end_date, await this.getTimezone(server)))) {
            return "ended";
        }

        if (this.strategy === "single") {
            return "under-maintenance";
        }

        if (!this.modelMeta.status) {
            return "unknown";
        }

        return this.modelMeta.status;
    }

    /**
     * Generate Cron for recurring maintenance
     * @returns {Promise<void>}
     */
    async generateCron() {
        log.info("maintenance", "Generate cron for maintenance id: " + this.id);

        if (this.strategy === "cron") {
            // Do nothing for cron
        } else if (!this.strategy.startsWith("recurring-")) {
            this.cron = "";
        } else if (this.strategy === "recurring-interval") {
            // For intervals, the pattern is used to check if the execution should be started
            let array = this.start_time.split(":");
            let hour = parseInt(array[0]);
            let minute = parseInt(array[1]);
            this.cron = `${minute} ${hour}  * * *`;
            this.duration = this.calcDuration();
            log.debug("maintenance", "Cron: " + this.cron);
            log.debug("maintenance", "Duration: " + this.duration);
        } else if (this.strategy === "recurring-weekday") {
            let list = this.getDayOfWeekList();
            let array = this.start_time.split(":");
            let hour = parseInt(array[0]);
            let minute = parseInt(array[1]);
            this.cron = minute + " " + hour + " * * " + list.join(",");
            this.duration = this.calcDuration();
        } else if (this.strategy === "recurring-day-of-month") {
            let list = this.getDayOfMonthList();
            let array = this.start_time.split(":");
            let hour = parseInt(array[0]);
            let minute = parseInt(array[1]);

            let dayList = [];

            for (let day of list) {
                if (typeof day === "string" && day.startsWith("lastDay")) {
                    if (day === "lastDay1") {
                        dayList.push("L");
                    }
                    // Unfortunately, lastDay2-4 is not supported by cron
                } else {
                    dayList.push(day);
                }
            }

            // Remove duplicate
            dayList = [...new Set(dayList)];

            this.cron = minute + " " + hour + " " + dayList.join(",") + " * *";
            this.duration = this.calcDuration();
        }
    }
}

export default Maintenance;
