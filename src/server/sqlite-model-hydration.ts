import {
    monitorPropertyColumns,
    monitorSnakePrecedenceColumns,
    normalizeBoolean,
    normalizeMonitorColumnValue,
} from "@/db/schema/column-metadata";
import { expectedTableColumns } from "@/db/schema/expected-schema";

type ModelRow = Record<string, unknown>;
type ModelInstance = ModelRow;
type ModelConstructor = new () => ModelInstance;
type TablePropertyColumns = Record<string, string>;
type ExpectedColumns = Record<string, readonly string[]>;

const monitorColumns: TablePropertyColumns = monitorPropertyColumns;
const monitorMappedProperties = new Set(Object.keys(monitorColumns));

// Generic camelCase -> snake_case aliases for tables whose model fields use camelCase.
const tablePropertyColumns: Record<string, TablePropertyColumns> = {
    monitor: monitorColumns,
    stat_daily: {
        pingMin: "ping_min",
        pingMax: "ping_max",
        monitorId: "monitor_id",
    },
    stat_hourly: {
        pingMin: "ping_min",
        pingMax: "ping_max",
        monitorId: "monitor_id",
    },
    stat_minutely: {
        pingMin: "ping_min",
        pingMax: "ping_max",
        monitorId: "monitor_id",
    },
    status_page: {
        analyticsId: "analytics_id",
        analyticsScriptUrl: "analytics_script_url",
        analyticsType: "analytics_type",
        autoRefreshInterval: "auto_refresh_interval",
        rssTitle: "rss_title",
        showCertificateExpiry: "show_certificate_expiry",
        showOnlyLastHeartbeat: "show_only_last_heartbeat",
        searchEngineIndex: "search_engine_index",
        showTags: "show_tags",
        footerText: "footer_text",
        customCss: "custom_css",
        showPoweredBy: "show_powered_by",
        createdDate: "created_date",
        modifiedDate: "modified_date",
    },
};
const expectedColumns = expectedTableColumns as ExpectedColumns;

function resolveMonitorField(
    row: ModelRow,
    property: string,
    column: string,
    { forStore = false }: { forStore?: boolean } = {}
): unknown {
    const hasColumn = forStore ? row[column] !== undefined : row[column] !== undefined && row[column] !== null;
    const hasProperty = forStore ? row[property] !== undefined : row[property] !== undefined && row[property] !== null;

    if (!hasColumn && !hasProperty) {
        return undefined;
    }

    let raw: unknown;
    if (forStore) {
        const preferColumn = monitorSnakePrecedenceColumns.has(column);
        raw = preferColumn && hasColumn ? row[column] : hasProperty ? row[property] : row[column];
    } else {
        raw = hasColumn ? row[column] : row[property];
    }

    return normalizeMonitorColumnValue(column, raw);
}

function normalizeMonitorRow(row: ModelRow): ModelRow {
    const result: ModelRow = { ...row };
    for (const [property, column] of Object.entries(monitorColumns)) {
        const value = resolveMonitorField(result, property, column);
        if (value !== undefined) {
            result[column] = value;
            result[property] = value;
        }
    }

    if (result.send_url !== undefined && result.send_url !== null) {
        result.sendUrl = normalizeBoolean(result.send_url);
    }
    if (result.custom_url !== undefined && result.custom_url !== null) {
        result.customUrl = result.custom_url;
    }
    return result;
}

function camelToSnake(key: string): string {
    return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function normalizeRowForStore(table: string, row: ModelRow): ModelRow {
    // Drop internal model fields used only for serialization helpers.
    const cleaned: ModelRow = Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("_")));

    if (table === "monitor") {
        const result: ModelRow = Object.fromEntries(
            Object.entries(cleaned).filter(([key]) => !monitorMappedProperties.has(key))
        );
        for (const [property, column] of Object.entries(monitorColumns)) {
            const value = resolveMonitorField(cleaned, property, column, { forStore: true });
            if (value !== undefined) {
                result[column] = value;
            }
        }
        return result;
    }

    const propertyColumns = tablePropertyColumns[table] ?? {};
    const allowed = expectedColumns[table];
    const result: ModelRow = {};
    for (const [key, value] of Object.entries(cleaned)) {
        if (propertyColumns[key]) {
            const column = propertyColumns[key];
            if (result[column] === undefined) {
                result[column] = value;
            }
        } else if (!allowed || allowed.includes(key)) {
            result[key] = value;
        } else {
            const snake = camelToSnake(key);
            if (allowed.includes(snake)) {
                if (result[snake] === undefined) {
                    result[snake] = value;
                }
            } else {
                // Keep unknown keys so filterStoreRow can fail loudly.
                result[key] = value;
            }
        }
    }
    return result;
}

export function hydrateModelFromRow(Model: ModelConstructor, table: string, row: ModelRow = {}): ModelInstance {
    const model = new Model();
    Object.assign(model, table === "monitor" ? normalizeMonitorRow(row) : row);
    if (table === "heartbeat") {
        if (row.down_count !== undefined) {
            model.downCount = row.down_count;
        }
        model._monitorId = row.monitor_id;
        model._status = row.status;
        model._time = row.time;
        model._msg = row.msg;
        model._ping = row.ping;
        model._important = row.important;
        model._duration = row.duration;
        model._retries = row.retries;
        model._response = row.response;
    }
    return model;
}
