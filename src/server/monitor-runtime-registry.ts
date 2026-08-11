"use strict";

import { ConditionVariable } from "@/server/monitor-conditions/variables";
import { defaultStringOperators } from "@/server/monitor-conditions/operators";

type MonitorRuntimeServer = {
    store: object;
    settings: object;
    getUserAgent: () => string;
};

type LoadedMonitor = {
    check: (...args: unknown[]) => unknown;
};

type MonitorDefinition = {
    supportsConditions?: boolean;
    conditionVariables?: ConditionVariable[];
    allowCustomStatus?: boolean;
    load: (server: MonitorRuntimeServer) => unknown | Promise<unknown>;
};

type MonitorDefinitionMap = Record<string, MonitorDefinition>;

type MonitorTypeMetadata = {
    supportsConditions: boolean;
    conditionVariables: ConditionVariable[];
    allowCustomStatus: boolean;
};

type MonitorTypeList = Record<string, MonitorTypeMetadata>;

const CORE_MONITOR_TYPES = ["http", "keyword", "json-query", "ping", "push", "docker", "radius", "kafka-producer"];

const optionalMonitorDefinitions = {
    "real-browser": {
        load: async (server) =>
            new (await import("@/server/monitor-types/real-browser-monitor-type")).RealBrowserMonitorType(
                server.store,
                server.settings
            ),
    },
    "tailscale-ping": {
        load: async () => new (await import("@/server/monitor-types/tailscale-ping")).TailscalePing(),
    },
    "websocket-upgrade": {
        load: async () => new (await import("@/server/monitor-types/websocket-upgrade")).WebSocketMonitorType(),
    },
    dns: {
        supportsConditions: true,
        conditionVariables: [new ConditionVariable("record", defaultStringOperators)],
        load: async (server) => new (await import("@/server/monitor-types/dns")).DnsMonitorType(server.store),
    },
    postgres: {
        load: async () => new (await import("@/server/monitor-types/postgres")).PostgresMonitorType(),
    },
    mqtt: {
        supportsConditions: true,
        conditionVariables: [
            new ConditionVariable("message", defaultStringOperators),
            new ConditionVariable("topic", defaultStringOperators),
        ],
        load: async () => new (await import("@/server/monitor-types/mqtt")).MqttMonitorType(),
    },
    smtp: {
        load: async () => new (await import("@/server/monitor-types/smtp")).SMTPMonitorType(),
    },
    group: {
        allowCustomStatus: true,
        load: async () => new (await import("@/server/monitor-types/group")).GroupMonitorType(),
    },
    snmp: {
        load: async () => new (await import("@/server/monitor-types/snmp")).SNMPMonitorType(),
    },
    "grpc-keyword": {
        load: async () => new (await import("@/server/monitor-types/grpc")).GrpcKeywordMonitorType(),
    },
    mongodb: {
        load: async () => new (await import("@/server/monitor-types/mongodb")).MongodbMonitorType(),
    },
    rabbitmq: {
        load: async () => new (await import("@/server/monitor-types/rabbitmq")).RabbitMqMonitorType(),
    },
    "sip-options": {
        load: async () => new (await import("@/server/monitor-types/sip-options")).SIPMonitorType(),
    },
    gamedig: {
        load: async () => new (await import("@/server/monitor-types/gamedig")).GameDigMonitorType(),
    },
    steam: {
        load: async (server) =>
            new (await import("@/server/monitor-types/steam")).SteamMonitorType({ settings: server.settings }),
    },
    port: {
        load: async () => new (await import("@/server/monitor-types/tcp")).TCPMonitorType(),
    },
    manual: {
        allowCustomStatus: true,
        load: async () => new (await import("@/server/monitor-types/manual")).ManualMonitorType(),
    },
    globalping: {
        load: async (server) =>
            new (await import("@/server/monitor-types/globalping")).GlobalpingMonitorType(
                server.store,
                server.settings,
                server.getUserAgent()
            ),
    },
    redis: {
        load: async () => new (await import("@/server/monitor-types/redis")).RedisMonitorType(),
    },
    "system-service": {
        load: async () => new (await import("@/server/monitor-types/system-service")).SystemServiceMonitorType(),
    },
    sqlserver: {
        supportsConditions: true,
        conditionVariables: [new ConditionVariable("result", defaultStringOperators)],
        load: async () => new (await import("@/server/monitor-types/mssql")).MssqlMonitorType(),
    },
    mysql: {
        supportsConditions: true,
        conditionVariables: [new ConditionVariable("result", defaultStringOperators)],
        load: async () => new (await import("@/server/monitor-types/mysql")).MysqlMonitorType(),
    },
    oracledb: {
        supportsConditions: true,
        conditionVariables: [new ConditionVariable("result", defaultStringOperators)],
        load: async () => new (await import("@/server/monitor-types/oracledb")).OracleDbMonitorType(),
    },
} satisfies MonitorDefinitionMap;

const OPTIONAL_MONITOR_TYPES = Object.keys(optionalMonitorDefinitions);

function createMonitorTypeList(definitions: MonitorDefinitionMap = optionalMonitorDefinitions): MonitorTypeList {
    return Object.fromEntries(
        Object.entries(definitions).map(([name, definition]) => [
            name,
            {
                supportsConditions: Boolean(definition.supportsConditions),
                conditionVariables: definition.conditionVariables || [],
                allowCustomStatus: Boolean(definition.allowCustomStatus),
            },
        ])
    );
}

class MonitorRuntimeRegistry {
    server: MonitorRuntimeServer;
    definitions: MonitorDefinitionMap;
    monitorTypeList: MonitorTypeList;
    loaded: Map<string, LoadedMonitor>;
    loading: Map<string, Promise<LoadedMonitor>>;

    constructor(server: MonitorRuntimeServer, definitions: MonitorDefinitionMap = optionalMonitorDefinitions) {
        this.server = server;
        this.definitions = definitions;
        this.monitorTypeList = createMonitorTypeList(definitions);
        this.loaded = new Map();
        this.loading = new Map();
    }

    get(name: string): Promise<LoadedMonitor | null> {
        const definition = this.definitions[name];
        if (!definition) {
            return Promise.resolve(null);
        }

        if (this.loaded.has(name)) {
            return Promise.resolve(this.loaded.get(name)!);
        }

        if (!this.loading.has(name)) {
            const loading = Promise.resolve()
                .then(() => definition.load(this.server))
                .then((instance) => {
                    if (!isLoadedMonitor(instance)) {
                        throw new Error(`Invalid monitor type factory for "${name}": expected an object with check()`);
                    }
                    this.loaded.set(name, instance);
                    return instance;
                })
                .finally(() => this.loading.delete(name));
            this.loading.set(name, loading);
        }

        return this.loading.get(name)!;
    }

    getLoadedTypes(): string[] {
        return [...this.loaded.keys()];
    }

    getLoaded(name: string): LoadedMonitor | null {
        return this.loaded.get(name) || null;
    }
}

function isLoadedMonitor(value: unknown): value is LoadedMonitor {
    return typeof value === "object" && value !== null && "check" in value && typeof value.check === "function";
}

export { CORE_MONITOR_TYPES, MonitorRuntimeRegistry, OPTIONAL_MONITOR_TYPES, createMonitorTypeList };
