import dayjs from "dayjs";
import { intHash } from "@/util/int-hash";
import { isDev, isNode } from "@/server/runtime-flags";

const RESET = "\x1b[0m";
const COLORS = {
    cyan: "\x1b[36m",
    green: "\x1b[32m",
    lightGreen: "\x1b[38;5;119m",
    blue: "\x1b[34m",
    lightBlue: "\x1b[38;5;117m",
    magenta: "\x1b[35m",
    orange: "\x1b[38;5;208m",
    violet: "\x1b[38;5;141m",
    brown: "\x1b[38;5;130m",
    pink: "\x1b[38;5;219m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    gray: "\x1b[90m",
} as const;
const consoleModuleColors = [
    COLORS.cyan,
    COLORS.green,
    COLORS.lightGreen,
    COLORS.blue,
    COLORS.lightBlue,
    COLORS.magenta,
    COLORS.orange,
    COLORS.violet,
    COLORS.brown,
    COLORS.pink,
];
const consoleLevelColors = {
    info: COLORS.cyan,
    warn: COLORS.yellow,
    error: COLORS.red,
    debug: COLORS.gray,
} as const;
type LogLevel = keyof typeof consoleLevelColors;

export class Logger {
    hideLog: Record<string, string[]> = { info: [], warn: [], error: [], debug: [] };

    constructor() {
        if (typeof process !== "undefined" && process.env.IGLO_MONITOR_HIDE_LOG) {
            const list = process.env.IGLO_MONITOR_HIDE_LOG.split(",").map((value) => value.toLowerCase());

            for (const pair of list) {
                const values = pair.split(/_(.*)/s);
                if (values.length >= 2) {
                    this.hideLog[values[0]].push(values[1]);
                }
            }

            this.debug("server", "IGLO_MONITOR_HIDE_LOG is set");
            this.debug("server", this.hideLog);
        }
    }

    log(module: string, level: LogLevel, ...msg: unknown[]) {
        if (level === "debug" && !isDev) {
            return;
        }

        if (this.hideLog[level] && this.hideLog[level].includes(module.toLowerCase())) {
            return;
        }

        module = module.toUpperCase();
        const levelLabel = level.toUpperCase();
        const now = dayjs.tz ? dayjs.tz(new Date()).format() : dayjs().format();

        if (process.env.IGLO_MONITOR_LOG_FORMAT === "json") {
            const msgString = msg
                .map((value) => {
                    if (typeof value === "string") {
                        return value;
                    }
                    try {
                        return JSON.stringify(value);
                    } catch {
                        return String(value);
                    }
                })
                .join(" ");
            console.log(JSON.stringify({ time: now, module, level, msg: msgString }));
            return;
        }

        const levelColor = consoleLevelColors[level];
        const moduleColor = consoleModuleColors[intHash(module, consoleModuleColors.length)];
        const timePart = isNode ? (level === "debug" ? COLORS.gray : COLORS.cyan) + now + RESET : now;
        const modulePart = isNode ? `[${moduleColor}${module}${RESET}]` : `[${module}]`;
        const levelPart = isNode ? levelColor + `${levelLabel}:` + RESET : `${levelLabel}:`;

        switch (level) {
            case "error":
                console.error(timePart, modulePart, levelPart, ...msg);
                break;
            case "warn":
                console.warn(timePart, modulePart, levelPart, ...msg);
                break;
            case "info":
                console.info(timePart, modulePart, levelPart, ...msg);
                break;
            case "debug":
                if (isDev) {
                    console.debug(timePart, modulePart, levelPart, ...msg);
                }
                break;
        }
    }

    info(module: string, ...msg: unknown[]) {
        this.log(module, "info", ...msg);
    }

    warn(module: string, ...msg: unknown[]) {
        this.log(module, "warn", ...msg);
    }

    error(module: string, ...msg: unknown[]) {
        this.log(module, "error", ...msg);
    }

    debug(module: string, ...msg: unknown[]) {
        this.log(module, "debug", ...msg);
    }

    exception(module: string, exception: unknown, ...msg: unknown[]) {
        this.log(module, "error", ...msg, exception);
    }
}

export const log = new Logger();

export function debug(msg: unknown) {
    log.log("", "debug", msg);
}
