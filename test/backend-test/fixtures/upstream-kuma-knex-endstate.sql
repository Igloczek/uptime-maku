-- Simulates a fully migrated upstream Uptime Kuma 2.x SQLite database:
-- Knex end-state schema (marker columns present) but no rewrite schema-version setting.
-- Data rows exercise iglo.monitor-specific migrations in 001-upstream-baseline.

PRAGMA foreign_keys = OFF;

CREATE TABLE user (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password TEXT,
    active BOOLEAN NOT NULL DEFAULT 1,
    timezone TEXT,
    twofa_secret TEXT,
    twofa_status INTEGER NOT NULL DEFAULT 0,
    twofa_last_token TEXT
);

CREATE TABLE monitor (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    active BOOLEAN NOT NULL DEFAULT 1,
    user_id INTEGER,
    interval INTEGER NOT NULL DEFAULT 20,
    url TEXT,
    type TEXT,
    hostname TEXT,
    grpc_url TEXT,
    game TEXT,
    json_path_operator TEXT,
    domain_expiry_notification BOOLEAN DEFAULT 1,
    accepted_statuscodes_json TEXT NOT NULL DEFAULT '["200-299"]',
    retry_interval INTEGER NOT NULL DEFAULT 0,
    bearer_token TEXT,
    gamedig_token TEXT
);

CREATE TABLE status_page (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    icon TEXT NOT NULL,
    theme TEXT NOT NULL,
    published BOOLEAN NOT NULL DEFAULT 1,
    search_engine_index BOOLEAN NOT NULL DEFAULT 1,
    show_tags BOOLEAN NOT NULL DEFAULT 0,
    created_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    modified_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    analytics_id TEXT,
    analytics_script_url TEXT,
    analytics_type TEXT,
    auto_refresh_interval INTEGER DEFAULT 300,
    rss_title TEXT,
    show_certificate_expiry BOOLEAN NOT NULL DEFAULT 0,
    show_only_last_heartbeat BOOLEAN NOT NULL DEFAULT 0
);

CREATE TABLE notification (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    active BOOLEAN NOT NULL DEFAULT 1,
    user_id INTEGER,
    is_default BOOLEAN NOT NULL DEFAULT 0,
    config TEXT
);

CREATE TABLE monitor_notification (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id INTEGER NOT NULL,
    notification_id INTEGER NOT NULL
);

CREATE TABLE setting (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    value TEXT,
    type TEXT
);

INSERT INTO user (username, password, active) VALUES ('admin', 'hash', 1);

INSERT INTO monitor (name, type, game, json_path_operator, domain_expiry_notification, hostname, accepted_statuscodes_json, user_id, bearer_token, gamedig_token)
VALUES ('GameDig TF2', 'gamedig', 'tf2', NULL, 1, 'games.example.invalid', '["200-299"]', 1, NULL, NULL);

INSERT INTO monitor (name, type, json_path_operator, accepted_statuscodes_json, user_id)
VALUES ('SNMP monitor', 'snmp', NULL, '["200-299"]', 1);

INSERT INTO status_page (slug, title, icon, theme, analytics_id, auto_refresh_interval, rss_title)
VALUES ('default', 'Status', '', 'light', 'G-KNEX', 300, 'RSS');

INSERT INTO notification (name, active, config)
VALUES ('LINE Notify', 1, '{"type":"line-notify","lineNotifyAccessToken":"token"}');

INSERT INTO monitor_notification (monitor_id, notification_id) VALUES (1, 1);

PRAGMA foreign_keys = ON;
