import type { SchemaMigration } from "@/server/db-migrations";

export async function upgrade004RemoveMonitorResendStateSchema(migration: SchemaMigration) {
    if (!migration.hasTable("monitor")) {
        return;
    }

    for (const column of ["resend_interval", "last_notification_at", "last_notification_attempt_at"]) {
        if (migration.hasColumn("monitor", column)) {
            migration.exec(`ALTER TABLE "monitor" DROP COLUMN "${column}"`);
        }
    }
}
