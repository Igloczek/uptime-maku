/* eslint-disable camelcase */
/*!
// Shared constants for frontend and backend
*/

export const appName = "iglo.monitor";
export const DOWN = 0;
export const UP = 1;
export const PENDING = 2;
export const MAINTENANCE = 3;

export const STATUS_PAGE_ALL_DOWN = 0;
export const STATUS_PAGE_ALL_UP = 1;
export const STATUS_PAGE_PARTIAL_DOWN = 2;
export const STATUS_PAGE_MAINTENANCE = 3;

export const SQL_DATE_FORMAT = "YYYY-MM-DD";
export const SQL_DATETIME_FORMAT = "YYYY-MM-DD HH:mm:ss";
export const SQL_DATETIME_FORMAT_WITHOUT_SECOND = "YYYY-MM-DD HH:mm";

export const MAX_INTERVAL_SECOND = 2073600; // 24 days
export const MIN_INTERVAL_SECOND = 1; // 1 second
export const MIN_PROVIDER_TIMEOUT_SECOND = 0.1;
export const MAX_MONITOR_RETRIES = 100;
export const MAX_MONITOR_REDIRECTS = 100;

export const INCIDENT_PAGE_SIZE = 10;

// Packet Size limits
export const PING_PACKET_SIZE_MIN = 1;
export const PING_PACKET_SIZE_MAX = 65500;
export const PING_PACKET_SIZE_DEFAULT = 56;

// Global timeout (aka deadline) limits in seconds
export const PING_GLOBAL_TIMEOUT_MIN = 1;
export const PING_GLOBAL_TIMEOUT_MAX = 300;
export const PING_GLOBAL_TIMEOUT_DEFAULT = 10;

// Ping count limits
export const PING_COUNT_MIN = 1;
export const PING_COUNT_MAX = 100;
export const PING_COUNT_DEFAULT = 1;

// per-request timeout (aka timeout) limits in seconds
export const PING_PER_REQUEST_TIMEOUT_MIN = 1;
export const PING_PER_REQUEST_TIMEOUT_MAX = 60;
export const PING_PER_REQUEST_TIMEOUT_DEFAULT = 2;

/**
 * Response body length cutoff used by default (10kb)
 * (measured in bytes)
 */
export const RESPONSE_BODY_LENGTH_DEFAULT = 1024;
/**
 * Maximum allowed response body length to store (1mb)
 * (measured in bytes)
 */
export const RESPONSE_BODY_LENGTH_MAX = 1024 * 1024;

export const badgeConstants = {
    naColor: "#999",
    defaultUpColor: "#66c20a",
    defaultWarnColor: "#eed202",
    defaultDownColor: "#c2290a",
    defaultPendingColor: "#f8a306",
    defaultMaintenanceColor: "#1747f5",
    defaultPingColor: "blue", // Shields.io-compatible color name
    defaultStyle: "flat",
    defaultPingValueSuffix: "ms",
    defaultPingLabelSuffix: "h",
    defaultUptimeValueSuffix: "%",
    defaultUptimeLabelSuffix: "h",
    defaultCertExpValueSuffix: " days",
    defaultCertExpLabelSuffix: "h",
    // Values Come From Default Notification Times
    defaultCertExpireWarnDays: "14",
    defaultCertExpireDownDays: "7",
};

// these types will have domain expiry support via the specified field
export const TYPES_WITH_DOMAIN_EXPIRY_SUPPORT_VIA_FIELD = {
    http: "url",
    keyword: "url",
    "json-query": "url",
    "real-browser": "url",
    "websocket-upgrade": "url",
    port: "hostname",
    ping: "hostname",
    "grpc-keyword": "grpcUrl",
    dns: "hostname",
    smtp: "hostname",
    snmp: "hostname",
    gamedig: "hostname",
    steam: "hostname",
    mqtt: "hostname",
    radius: "hostname",
    "tailscale-ping": "hostname",
    "sip-options": "hostname",
} as const;
