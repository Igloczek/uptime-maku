// @ts-nocheck

import { expectedTableColumns } from "@/db/schema/expected-schema";

const monitorColumnTypes = {
    accepted_statuscodes_json: "TEXT NOT NULL DEFAULT '[\"200-299\"]'",
    auth_domain: "TEXT",
    auth_method: "TEXT",
    auth_workstation: "TEXT",
    bearer_token: "TEXT",
    body: "TEXT",
    cache_bust: "BOOLEAN NOT NULL DEFAULT 0",
    conditions: "TEXT NOT NULL DEFAULT '[]'",
    database_connection_string: "TEXT",
    database_query: "TEXT",
    description: "TEXT",
    dns_last_result: "TEXT",
    dns_resolve_server: "TEXT",
    dns_resolve_type: "TEXT",
    docker_container: "TEXT",
    docker_host: "INTEGER",
    domain_expiry_notification: "BOOLEAN DEFAULT 0",
    expected_tls_alert: "TEXT",
    expected_value: "TEXT",
    expiry_notification: "BOOLEAN DEFAULT 1",
    gamedig_given_port_only: "BOOLEAN NOT NULL DEFAULT 1",
    gamedig_token: "TEXT",
    game: "TEXT",
    grpc_body: "TEXT",
    grpc_enable_tls: "BOOLEAN NOT NULL DEFAULT 0",
    grpc_metadata: "TEXT",
    grpc_method: "TEXT",
    grpc_protobuf: "TEXT",
    grpc_service_name: "TEXT",
    grpc_url: "TEXT",
    headers: "TEXT",
    http_body_encoding: "TEXT",
    ignore_tls: "BOOLEAN NOT NULL DEFAULT 0",
    invert_keyword: "BOOLEAN NOT NULL DEFAULT 0",
    ip_family: "TEXT",
    json_path: "TEXT",
    json_path_operator: "TEXT",
    kafka_producer_allow_auto_topic_creation: "BOOLEAN NOT NULL DEFAULT 0",
    kafka_producer_brokers: "TEXT",
    kafka_producer_message: "TEXT",
    kafka_producer_sasl_options: "TEXT",
    kafka_producer_ssl: "BOOLEAN NOT NULL DEFAULT 0",
    kafka_producer_topic: "TEXT",
    location: "TEXT",
    manual_status: "INTEGER",
    maxredirects: "INTEGER NOT NULL DEFAULT 10",
    method: "TEXT NOT NULL DEFAULT 'GET'",
    mqtt_check_type: "TEXT NOT NULL DEFAULT 'keyword'",
    mqtt_password: "TEXT",
    mqtt_success_message: "TEXT",
    mqtt_topic: "TEXT",
    mqtt_username: "TEXT",
    mqtt_websocket_path: "TEXT",
    oauth_audience: "TEXT",
    oauth_auth_method: "TEXT",
    oauth_client_id: "TEXT",
    oauth_client_secret: "TEXT",
    oauth_scopes: "TEXT",
    oauth_token_url: "TEXT",
    packet_size: "INTEGER NOT NULL DEFAULT 56",
    parent: "INTEGER",
    ping_count: "INTEGER NOT NULL DEFAULT 1",
    ping_numeric: "BOOLEAN NOT NULL DEFAULT 1",
    ping_per_request_timeout: "INTEGER NOT NULL DEFAULT 2",
    protocol: "TEXT",
    proxy_id: "INTEGER",
    push_token: "TEXT",
    rabbitmq_nodes: "TEXT",
    rabbitmq_password: "TEXT",
    rabbitmq_username: "TEXT",
    radius_called_station_id: "TEXT",
    radius_calling_station_id: "TEXT",
    radius_password: "TEXT",
    radius_secret: "TEXT",
    radius_username: "TEXT",
    remote_browser: "INTEGER",
    response_max_length: "INTEGER NOT NULL DEFAULT 1024",
    retry_interval: "INTEGER NOT NULL DEFAULT 0",
    retry_only_on_status_code_failure: "BOOLEAN NOT NULL DEFAULT 0",
    save_error_response: "BOOLEAN NOT NULL DEFAULT 1",
    save_response: "BOOLEAN NOT NULL DEFAULT 0",
    screenshot_delay: "INTEGER NOT NULL DEFAULT 0",
    smtp_security: "TEXT",
    snmp_oid: "TEXT",
    snmp_v3_username: "TEXT",
    snmp_version: "TEXT DEFAULT '2c'",
    subtype: "TEXT",
    system_service_name: "TEXT",
    timeout: "REAL NOT NULL DEFAULT 0",
    tls_ca: "TEXT",
    tls_cert: "TEXT",
    tls_key: "TEXT",
    upside_down: "BOOLEAN NOT NULL DEFAULT 0",
    ws_ignore_sec_websocket_accept_header: "BOOLEAN NOT NULL DEFAULT 0",
    ws_subprotocol: "TEXT NOT NULL DEFAULT ''",
};

// Columns that stay snake_case end-to-end (API + model); skip camelCase aliases.
const monitorSnakeOnlyColumns = new Set([
    "accepted_statuscodes_json",
    "dns_last_result",
    "docker_container",
    "docker_host",
]);

function snakeToCamelColumn(column) {
    return column.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function buildMonitorPropertyColumns() {
    const result = {};
    for (const column of Object.keys(monitorColumnTypes)) {
        if (!column.includes("_") || monitorSnakeOnlyColumns.has(column)) {
            continue;
        }
        result[snakeToCamelColumn(column)] = column;
    }
    return result;
}

const monitorPropertyColumns = buildMonitorPropertyColumns();

const monitorBooleanColumns = new Set(
    Object.entries(monitorColumnTypes)
        .filter(([, type]) => /\bBOOLEAN\b/i.test(type))
        .map(([column]) => column)
);

const monitorSnakePrecedenceColumns = new Set([
    "response_max_length",
    "retry_only_on_status_code_failure",
    "save_error_response",
    "save_response",
]);

export function normalizeBoolean(value) {
    if (value === true || value === 1 || value === "1") {
        return true;
    }
    if (value === false || value === 0 || value === "0" || value === "" || value === null || value === undefined) {
        return false;
    }
    return Boolean(value);
}

export function normalizeMonitorColumnValue(column, value) {
    if (monitorBooleanColumns.has(column)) {
        return normalizeBoolean(value);
    }
    return value;
}

const tableColumnTypes = {
    monitor: monitorColumnTypes,
    status_page: {
        analytics_id: "TEXT",
        analytics_script_url: "TEXT",
        analytics_type: "TEXT",
        auto_refresh_interval: "INTEGER DEFAULT 300",
        rss_title: "TEXT",
        show_certificate_expiry: "BOOLEAN NOT NULL DEFAULT 0",
        show_only_last_heartbeat: "BOOLEAN NOT NULL DEFAULT 0",
    },
    user: {
        twofa_secret: "TEXT",
        twofa_status: "INTEGER NOT NULL DEFAULT 0",
        twofa_last_token: "TEXT",
    },
    incident: {
        pin: "BOOLEAN NOT NULL DEFAULT 1",
        active: "BOOLEAN NOT NULL DEFAULT 1",
    },
    heartbeat: {
        end_time: "DATETIME",
        retries: "INTEGER NOT NULL DEFAULT 0",
        response: "TEXT",
        ping: "BIGINT",
    },
};

export function validateColumnTypeFragment(type) {
    if (typeof type !== "string" || type.trim() === "") {
        throw new Error("Column type must be a non-empty string");
    }

    if (/[;]|--|\/\*/.test(type)) {
        throw new Error("Column type contains disallowed SQL fragments");
    }

    if (!/^[A-Za-z0-9_()'"[\],\s.-]+$/.test(type)) {
        throw new Error("Column type contains disallowed characters");
    }
}

export function getKnownColumnType(table, column) {
    return tableColumnTypes[table]?.[column] ?? null;
}

export function isAllowedStoreColumn(table, column) {
    const allowed = expectedTableColumns[table];
    return Array.isArray(allowed) && allowed.includes(column);
}

export function resolveColumnType(table: string, column: string, explicitType?: string) {
    if (explicitType !== undefined) {
        validateColumnTypeFragment(explicitType);
        return explicitType;
    }

    const knownType = getKnownColumnType(table, column);
    if (knownType) {
        validateColumnTypeFragment(knownType);
        return knownType;
    }

    throw new Error(`Unknown column type for ${table}.${column}; refusing to ALTER TABLE`);
}

export { monitorPropertyColumns, monitorBooleanColumns, monitorSnakePrecedenceColumns };

export function filterStoreRow(table, row) {
    const allowed = expectedTableColumns[table];
    if (!allowed) {
        return row;
    }

    const filtered = {};
    for (const [key, value] of Object.entries(row)) {
        if (!allowed.includes(key)) {
            throw new Error(`Refusing to store unknown column ${table}.${key}`);
        }
        filtered[key] = value;
    }
    return filtered;
}
