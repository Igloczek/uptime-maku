// @ts-nocheck

import {
    monitorPropertyColumns,
    monitorSnakePrecedenceColumns,
    normalizeBoolean,
    normalizeMonitorColumnValue,
} from "@/db/schema/column-metadata";
import { expectedTableColumns } from "@/db/schema/expected-schema";

const monitorMappedProperties = new Set(Object.keys(monitorPropertyColumns));

// Generic camelCase -> snake_case aliases for tables that use BeanModel fields in camelCase.
const tablePropertyColumns = {
    monitor: monitorPropertyColumns,
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

function resolveMonitorField(row, property, column, { forStore = false } = {}) {
    const hasColumn = forStore ? row[column] !== undefined : row[column] !== undefined && row[column] !== null;
    const hasProperty = forStore ? row[property] !== undefined : row[property] !== undefined && row[property] !== null;

    if (!hasColumn && !hasProperty) {
        return undefined;
    }

    let raw;
    if (forStore) {
        const preferColumn = monitorSnakePrecedenceColumns.has(column);
        raw = preferColumn && hasColumn ? row[column] : hasProperty ? row[property] : row[column];
    } else {
        raw = hasColumn ? row[column] : row[property];
    }

    return normalizeMonitorColumnValue(column, raw);
}

function normalizeMonitorRow(row) {
    const result = { ...row };
    for (const [property, column] of Object.entries(monitorPropertyColumns)) {
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

function camelToSnake(key) {
    return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function normalizeRowForStore(table, row) {
    // Drop internal bean fields used only for serialization helpers.
    const cleaned = Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("_")));

    if (table === "monitor") {
        const result = Object.fromEntries(Object.entries(cleaned).filter(([key]) => !monitorMappedProperties.has(key)));
        for (const [property, column] of Object.entries(monitorPropertyColumns)) {
            const value = resolveMonitorField(cleaned, property, column, { forStore: true });
            if (value !== undefined) {
                result[column] = value;
            }
        }
        return result;
    }

    const propertyColumns = tablePropertyColumns[table] || {};
    const allowed = expectedTableColumns[table];
    const result = {};
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

export function beanForTable(Model, table, row = {}) {
    const bean = new Model();
    Object.assign(bean, table === "monitor" ? normalizeMonitorRow(row) : row);
    if (table === "heartbeat") {
        if (row.down_count !== undefined) {
            bean.downCount = row.down_count;
        }
        bean._monitorId = row.monitor_id;
        bean._status = row.status;
        bean._time = row.time;
        bean._msg = row.msg;
        bean._ping = row.ping;
        bean._important = row.important;
        bean._duration = row.duration;
        bean._retries = row.retries;
        bean._response = row.response;
    }
    return bean;
}
