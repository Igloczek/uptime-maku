import type { SchemaMigration, SQLiteTransaction } from "@/server/db-migrations";

const RESEND_INTERVAL_SCOPE_KEY = "resend_interval_scope";
const RESEND_INTERVAL_SCOPE_VALUE = "notification";

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

export async function upgrade003NotificationResendIntervalSchema(migration: SchemaMigration) {
    if (!migration.hasTable("monitor_notification")) {
        return;
    }

    migration.addColumnIfMissing("monitor_notification", "last_notification_at", "DATETIME");
    migration.addColumnIfMissing("monitor_notification", "last_notification_attempt_at", "DATETIME");
}

async function migrateNotificationResendIntervals(store: SQLiteTransaction) {
    if (!(await store.hasTable("monitor")) || !(await store.hasTable("notification"))) {
        return;
    }

    const legacyIntervals = new Map<number, number>();
    const disabledNotificationIDs = new Set<number>();
    const relations = await store.getAll(
        `SELECT monitor_notification.notification_id, monitor.resend_interval
         FROM monitor_notification
         JOIN monitor ON monitor.id = monitor_notification.monitor_id`
    );

    for (const relation of relations) {
        const row = relation as { notification_id: number; resend_interval: number };
        const interval = legacyInterval(row.resend_interval);
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
    if (!(await store.hasTable("monitor")) || !(await store.hasTable("monitor_notification"))) {
        return;
    }

    await store.exec(
        `UPDATE monitor_notification
         SET last_notification_at = COALESCE(
                 last_notification_at,
                 (SELECT last_notification_at FROM monitor WHERE monitor.id = monitor_notification.monitor_id)
             ),
             last_notification_attempt_at = COALESCE(
                 last_notification_attempt_at,
                 (SELECT last_notification_attempt_at FROM monitor WHERE monitor.id = monitor_notification.monitor_id)
             )`
    );
}

export async function upgrade003NotificationResendIntervalData(store: SQLiteTransaction) {
    if (!(await store.hasTable("setting"))) {
        return;
    }

    const scope = await store.getCell('SELECT value FROM setting WHERE "key" = ?', [RESEND_INTERVAL_SCOPE_KEY]);
    if (scope === RESEND_INTERVAL_SCOPE_VALUE) {
        return;
    }

    // A notification can be attached to several monitors. Keep repeats disabled when any linked monitor had
    // them disabled; otherwise keep the largest legacy cadence so migration never increases its frequency.
    await migrateNotificationResendIntervals(store);
    await migrateNotificationResendState(store);
    await store.exec(
        `INSERT INTO setting ("key", value) VALUES (?, ?)
         ON CONFLICT ("key") DO UPDATE SET value = excluded.value`,
        [RESEND_INTERVAL_SCOPE_KEY, RESEND_INTERVAL_SCOPE_VALUE]
    );
}
