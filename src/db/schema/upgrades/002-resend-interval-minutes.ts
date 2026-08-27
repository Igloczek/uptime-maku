import type { SchemaMigration, SQLiteTransaction } from "@/server/db-migrations";

const RESEND_INTERVAL_MIGRATION_KEY = "resend_interval_unit";
const RESEND_INTERVAL_MIGRATION_VALUE = "minutes";
const DEFAULT_LEGACY_INTERVAL_SECONDS = 60;

export async function upgrade002ResendIntervalMinutesSchema(migration: SchemaMigration) {
    if (!migration.hasTable("monitor")) {
        return;
    }

    migration.addColumnIfMissing("monitor", "last_notification_at", "DATETIME");
    migration.addColumnIfMissing("monitor", "last_notification_attempt_at", "DATETIME");
}

async function migrateLegacyResendIntervals(store: SQLiteTransaction) {
    const monitors = await store.getAll(
        "SELECT id, interval, resend_interval FROM monitor WHERE resend_interval IS NOT NULL AND resend_interval > 0"
    );

    for (const monitor of monitors) {
        const row = monitor as { id: number; interval: number; resend_interval: number };
        const legacyChecks = Number(row.resend_interval);
        if (!Number.isFinite(legacyChecks) || legacyChecks <= 0) {
            continue;
        }

        const intervalSeconds = Number(row.interval);
        const effectiveIntervalSeconds =
            Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds : DEFAULT_LEGACY_INTERVAL_SECONDS;

        const convertedMinutes = Math.ceil((legacyChecks * effectiveIntervalSeconds) / 60);
        const resendIntervalMinutes = Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, convertedMinutes));

        await store.exec("UPDATE monitor SET resend_interval = ? WHERE id = ?", [resendIntervalMinutes, row.id]);
    }
}

async function seedLastNotificationTimes(store: SQLiteTransaction) {
    if (!(await store.hasTable("heartbeat"))) {
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
        if (row.last_notification_at) {
            await store.exec(
                `UPDATE monitor
                 SET last_notification_at = ?, last_notification_attempt_at = ?
                 WHERE id = ? AND last_notification_at IS NULL AND last_notification_attempt_at IS NULL`,
                [row.last_notification_at, row.last_notification_at, row.monitor_id]
            );
        }
    }
}

export async function upgrade002ResendIntervalMinutesData(store: SQLiteTransaction) {
    if (!(await store.hasTable("monitor")) || !(await store.hasTable("setting"))) {
        return;
    }

    const migrationValue = await store.getCell('SELECT value FROM setting WHERE "key" = ?', [
        RESEND_INTERVAL_MIGRATION_KEY,
    ]);
    if (migrationValue === RESEND_INTERVAL_MIGRATION_VALUE) {
        return;
    }

    // v1 stored this field as a number of failed checks. Convert it once to minutes.
    // The marker makes the data phase safe to retry after a transaction failure.
    await migrateLegacyResendIntervals(store);
    await seedLastNotificationTimes(store);
    await store.exec(
        `INSERT INTO setting ("key", value) VALUES (?, ?)
         ON CONFLICT ("key") DO UPDATE SET value = excluded.value`,
        [RESEND_INTERVAL_MIGRATION_KEY, RESEND_INTERVAL_MIGRATION_VALUE]
    );
}
