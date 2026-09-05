// @ts-nocheck
"use strict";

import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import { log } from "@/server/logger";
import type { DatabaseMaintenanceCoordinator } from "@/server/database-maintenance";

const WS_PATH = "/ws";

function headersToObject(headers) {
    const result = {};
    for (const [key, value] of headers.entries()) {
        result[key.toLowerCase()] = value;
    }
    return result;
}

function toMessage(type, fields) {
    return JSON.stringify({
        type,
        ...fields,
    });
}

class BunRealtimeSocket extends EventEmitter {
    constructor(adapter, ws) {
        super();
        this.adapter = adapter;
        this.ws = ws;
        this.id = randomUUID();
        this.userID = null;
        this.rooms = new Set([this.id]);
        this.client = {
            conn: {
                remoteAddress: ws.data.remoteAddress || "",
                request: {
                    headers: ws.data.headers,
                },
            },
        };
    }

    emit(event, ...args) {
        if (event === "disconnect") {
            return super.emit(event, ...args);
        }

        this.sendEvent(event, args);
        return true;
    }

    sendEvent(event, args) {
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(toMessage("event", { event, args }));
        }
    }

    sendReply(id, args) {
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(toMessage("reply", { id, args }));
        }
    }

    sendError(id, error) {
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(
                toMessage("error", {
                    id,
                    message: error && error.message ? error.message : String(error),
                })
            );
        }
    }

    join(room) {
        this.adapter.join(this, room);
    }

    leave(room) {
        this.adapter.leave(this, room);
    }

    disconnect() {
        this.ws.close();
    }

    async dispatch(message) {
        if (!message || message.type !== "event" || typeof message.event !== "string") {
            this.sendError(message && message.id, new Error("Invalid WebSocket message envelope"));
            return;
        }

        const args = Array.isArray(message.args) ? message.args : [];
        if (message.id) {
            args.push((...replyArgs) => this.sendReply(message.id, replyArgs));
        }

        try {
            const listeners = this.listeners(message.event);
            await Promise.all(listeners.map((listener) => listener(...args)));
        } catch (error) {
            this.sendError(message.id, error);
            log.error("socket", error);
        }
    }
}

class BunRealtimeAdapter {
    databaseMaintenance: DatabaseMaintenanceCoordinator | null = null;
    maintenanceEvents = new Set();
    connectionInitializer = null;

    constructor(server, settings) {
        this.server = server;
        this.settings = settings;
        this.rooms = new Map();
        this.sockets = {
            sockets: new Map(),
            adapter: {
                rooms: this.rooms,
            },
        };
    }

    setDatabaseMaintenanceCoordinator(coordinator: DatabaseMaintenanceCoordinator) {
        this.databaseMaintenance = coordinator;
    }

    setMaintenanceEvents(events) {
        this.maintenanceEvents = new Set(events);
    }

    setConnectionInitializer(initializer) {
        this.connectionInitializer = initializer;
    }

    async canUpgrade(request, bunServer) {
        const url = new URL(request.url);
        if (url.pathname !== WS_PATH) {
            return false;
        }

        const headers = headersToObject(request.headers);
        const clientIP = await this.server.getClientIPwithProxy(bunServer.requestIP(request)?.address || "", headers);
        log.info("socket", `New websocket connection, IP = ${clientIP}`);

        const bypass = process.env.IGLO_MONITOR_WS_ORIGIN_CHECK === "bypass";
        const origin = request.headers.get("origin");
        if (!bypass && origin) {
            try {
                const originURL = new URL(origin);
                const host = request.headers.get("host");
                let xForwardedFor;
                if (await this.settings.get("trustProxy")) {
                    xForwardedFor = request.headers.get("x-forwarded-for");
                }

                if (host !== originURL.host && xForwardedFor !== originURL.host) {
                    log.error("auth", `Origin (${origin}) does not match host (${host}), IP: ${clientIP}`);
                    return false;
                }
            } catch (_) {
                log.error("auth", `Invalid origin url (${origin}), IP: ${clientIP}`);
                return false;
            }
        }

        return bunServer.upgrade(request, {
            data: {
                headers,
                remoteAddress: clientIP,
            },
        });
    }

    to(room) {
        return {
            emit: (event, ...args) => {
                const sockets = this.rooms.get(room);
                if (!sockets) {
                    return;
                }

                for (const socket of sockets) {
                    socket.sendEvent(event, args);
                }
            },
        };
    }

    join(socket, room) {
        socket.rooms.add(room);
        if (!this.rooms.has(room)) {
            this.rooms.set(room, new Set());
        }
        this.rooms.get(room).add(socket);
    }

    leave(socket, room) {
        socket.rooms.delete(room);
        const sockets = this.rooms.get(room);
        if (sockets) {
            sockets.delete(socket);
            if (sockets.size === 0) {
                this.rooms.delete(room);
            }
        }
    }

    async open(ws) {
        const socket = new BunRealtimeSocket(this, ws);
        ws.data.socket = socket;
        this.sockets.sockets.set(socket.id, socket);
        this.join(socket, socket.id);

        const initialize = () => this.connectionInitializer?.(socket);
        if (this.databaseMaintenance) {
            await this.databaseMaintenance.run(initialize);
        } else {
            await initialize();
        }
    }

    async message(ws, rawMessage) {
        let message;
        try {
            message = JSON.parse(String(rawMessage));
        } catch (error) {
            ws.send(toMessage("error", { message: "Invalid JSON WebSocket message" }));
            return;
        }

        const dispatch = () => ws.data.socket.dispatch(message);
        if (this.databaseMaintenance) {
            const coordinate = this.maintenanceEvents.has(message.event)
                ? this.databaseMaintenance.maintain.bind(this.databaseMaintenance)
                : this.databaseMaintenance.run.bind(this.databaseMaintenance);
            await coordinate(dispatch);
        } else {
            await dispatch();
        }
    }

    close(ws) {
        const socket = ws.data.socket;
        if (!socket) {
            return;
        }

        for (const room of Array.from(socket.rooms)) {
            this.leave(socket, room);
        }
        this.sockets.sockets.delete(socket.id);
        socket.emit("disconnect");
    }
}

export { BunRealtimeAdapter, WS_PATH };
