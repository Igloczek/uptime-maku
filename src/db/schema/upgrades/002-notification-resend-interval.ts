import type { SchemaMigration, SQLiteTransaction } from "@/server/db-migrations";

const DEFAULT_LEGACY_INTERVAL_SECONDS = 60;

function legacyInterval(value: unknown) {
    const interval = Number(value);
    return Number.isSafeInteger(interval) && interval >= 0 ? interval : 0;
}

function parseConfig(value: unknown): Record<string, unknown> {
    if (typeof value !== "string") {
        return {};
    }

    try {
        const config = JSON.parse(value);
        return config && typeof config === "object" && !Array.isArray(config) ? config : {};
    } catch {
        return {};
    }
}

function legacyResendIntervalMinutes(resendInterval: unknown, monitorInterval: unknown) {
    const legacyChecks = legacyInterval(resendInterval);
    if (legacyChecks === 0) {
        return 0;
    }

    const intervalSeconds = Number(monitorInterval);
    const effectiveIntervalSeconds =
        Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds : DEFAULT_LEGACY_INTERVAL_SECONDS;
    const convertedMinutes = Math.ceil((legacyChecks * effectiveIntervalSeconds) / 60);
    return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, convertedMinutes));
}

async function hasColumn(store: SQLiteTransaction, table: string, column: string) {
    const columns = await store.getAll(`PRAGMA table_info("${table}")`);
    return columns.some((row) => (row as { name?: unknown }).name === column);
}

export async function upgrade002NotificationResendIntervalSchema(migration: SchemaMigration) {
    if (!migration.hasTable("monitor_notification")) {
        return;
    }

    migration.addColumnIfMissing("monitor_notification", "last_notification_at", "DATETIME");
    migration.addColumnIfMissing("monitor_notification", "last_notification_attempt_at", "DATETIME");
}

async function migrateNotificationResendIntervals(store: SQLiteTransaction) {
    if (
        !(await store.hasTable("monitor")) ||
        !(await store.hasTable("monitor_notification")) ||
        !(await store.hasTable("notification")) ||
        !(await hasColumn(store, "monitor", "resend_interval"))
    ) {
        return;
    }

    const legacyIntervals = new Map<number, number>();
    const disabledNotificationIDs = new Set<number>();
    const relations = await store.getAll(
        `SELECT monitor_notification.notification_id, monitor.interval, monitor.resend_interval
         FROM monitor_notification
         JOIN monitor ON monitor.id = monitor_notification.monitor_id`
    );

    for (const relation of relations) {
        const row = relation as { notification_id: number; interval: number; resend_interval: number };
        const interval = legacyResendIntervalMinutes(row.resend_interval, row.interval);
        if (interval === 0) {
            disabledNotificationIDs.add(row.notification_id);
            continue;
        }

        if (disabledNotificationIDs.has(row.notification_id)) {
            continue;
        }

        if (interval > (legacyIntervals.get(row.notification_id) ?? 0)) {
            legacyIntervals.set(row.notification_id, interval);
        }
    }

    const notifications = await store.getAll("SELECT id, config FROM notification");
    for (const notification of notifications) {
        const row = notification as { id: number; config: string | null };
        const interval = disabledNotificationIDs.has(row.id) ? 0 : (legacyIntervals.get(row.id) ?? 0);
        if (interval === 0) {
            continue;
        }

        const config = parseConfig(row.config);
        if (config.resendInterval !== undefined || config.resend_interval !== undefined) {
            continue;
        }

        config.resendInterval = interval;
        await store.exec("UPDATE notification SET config = ? WHERE id = ?", [JSON.stringify(config), row.id]);
    }
}

async function migrateNotificationResendState(store: SQLiteTransaction) {
    if (!(await store.hasTable("heartbeat")) || !(await store.hasTable("monitor_notification"))) {
        return;
    }

    const heartbeats = await store.getAll(
        `SELECT monitor_id, MAX(time) AS last_notification_at
         FROM heartbeat
         WHERE (important = 1 AND status IN (0, 1))
            OR (status = 0 AND down_count = 0)
         GROUP BY monitor_id`
    );

    for (const heartbeat of heartbeats) {
        const row = heartbeat as { monitor_id: number; last_notification_at: string };
        if (!row.last_notification_at) {
            continue;
        }

        await store.exec(
            `UPDATE monitor_notification
             SET last_notification_at = COALESCE(last_notification_at, ?),
                 last_notification_attempt_at = COALESCE(last_notification_attempt_at, ?)
             WHERE monitor_id = ?`,
            [row.last_notification_at, row.last_notification_at, row.monitor_id]
        );
    }
}

async function removeLegacyMonitorResendState(store: SQLiteTransaction) {
    if (!(await store.hasTable("monitor"))) {
        return;
    }

    for (const column of ["resend_interval", "last_notification_at", "last_notification_attempt_at"]) {
        if (await hasColumn(store, "monitor", column)) {
            await store.exec(`ALTER TABLE "monitor" DROP COLUMN "${column}"`);
        }
    }
}

export async function upgrade002NotificationResendIntervalData(store: SQLiteTransaction) {
    await migrateNotificationResendIntervals(store);
    await migrateNotificationResendState(store);
    await removeLegacyMonitorResendState(store);
}
