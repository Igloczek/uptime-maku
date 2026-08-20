import { clearOldData } from "@/server/jobs/clear-old-data";
import { incrementalVacuum } from "@/server/jobs/incremental-vacuum";
import type { SQLiteStore } from "@/server/db-migrations";
import type { DatabaseMaintenanceCoordinator } from "@/server/database-maintenance";
import type { Settings } from "@/server/settings";

type JobCallback = () => unknown;

type CronJobLike = {
    stop: () => void;
};

type CronConstructor = new (
    interval: string,
    options: { name: string; timezone?: string },
    callback: JobCallback
) => CronJobLike;

function scheduleInProcessCron(interval: string, callback: JobCallback, timezone?: string): Bun.CronJob {
    if (!timezone) {
        return Bun.cron(interval, callback);
    }

    // @types/bun 1.3.x does not yet declare the 1.4 `{ tz }` overload.
    return (Bun.cron as (schedule: string, handler: JobCallback, options: { tz: string }) => Bun.CronJob)(
        interval,
        callback,
        { tz: timezone }
    );
}

class BunCron implements CronJobLike {
    #job: Bun.CronJob;

    constructor(interval: string, options: { name: string; timezone?: string }, callback: JobCallback) {
        this.#job = scheduleInProcessCron(interval, callback, options.timezone);
    }

    stop() {
        this.#job.stop();
    }
}

type BackgroundJob = {
    name: string;
    interval: string;
    jobFunc: (store: SQLiteStore, settings?: Settings, heartbeatData?: unknown) => unknown;
    exclusive?: boolean;
};

const jobDefinitions: BackgroundJob[] = [
    {
        name: "clear-old-data",
        interval: "14 03 * * *",
        jobFunc: clearOldData,
        exclusive: true,
    },
    {
        name: "incremental-vacuum",
        interval: "*/5 * * * *",
        jobFunc: incrementalVacuum,
        exclusive: false,
    },
];

function scheduleBackgroundJobs(
    store: SQLiteStore,
    coordinator: DatabaseMaintenanceCoordinator,
    timezone: string | undefined,
    CronClass: CronConstructor = BunCron,
    settings?: Settings,
    heartbeatData = null,
    scheduledJobs: CronJobLike[] = []
) {
    for (const job of jobDefinitions) {
        scheduledJobs.push(
            new CronClass(job.interval, { name: job.name, timezone }, () =>
                coordinator[job.exclusive ? "maintain" : "run"](() => job.jobFunc(store, settings, heartbeatData))
            )
        );
    }
    return scheduledJobs;
}

async function initBackgroundJobs(
    store: SQLiteStore,
    coordinator: DatabaseMaintenanceCoordinator,
    timezone: string | undefined,
    settings?: Settings,
    heartbeatData = null,
    scheduledJobs: CronJobLike[] = []
) {
    return scheduleBackgroundJobs(store, coordinator, timezone, BunCron, settings, heartbeatData, scheduledJobs);
}

function stopBackgroundJobs(scheduledJobs: CronJobLike[]) {
    for (const job of scheduledJobs.splice(0)) {
        job.stop();
    }
}

export { initBackgroundJobs, scheduleBackgroundJobs, stopBackgroundJobs };
