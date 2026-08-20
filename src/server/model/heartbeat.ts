// @ts-nocheck

import { SQLiteModel } from "@/server/sqlite-model";
import zlib from "node:zlib";
import { promisify } from "node:util";

const brotliDecompress = promisify(zlib.brotliDecompress);

/**
 * status:
 *      0 = DOWN
 *      1 = UP
 *      2 = PENDING
 *      3 = MAINTENANCE
 */
class Heartbeat extends SQLiteModel {
    /**
     * Return an object that ready to parse to JSON for public
     * Only show necessary data to public
     * @returns {object} Object ready to parse
     */
    toPublicJSON() {
        return {
            status: this.status,
            time: this.time,
            msg: "", // Hide for public
            ping: this.ping,
        };
    }

    /**
     * Return an object that ready to parse to JSON
     * @returns {object} Object ready to parse
     */
    toJSON() {
        return {
            monitorID: this._monitorId ?? this.monitor_id,
            status: this._status ?? this.status,
            time: this._time ?? this.time,
            msg: this._msg ?? this.msg,
            ping: this._ping ?? this.ping,
            important: this._important ?? this.important,
            duration: this._duration ?? this.duration,
            retries: this._retries ?? this.retries,
            response: this._response ?? this.response,
        };
    }

    /**
     * Return an object that ready to parse to JSON
     * @param {{ decodeResponse?: boolean }} opts Options for JSON serialization
     * @returns {Promise<object>} Object ready to parse
     */
    async toJSONAsync(opts) {
        return {
            monitorID: this._monitorId ?? this.monitor_id,
            status: this._status ?? this.status,
            time: this._time ?? this.time,
            msg: this._msg ?? this.msg,
            ping: this._ping ?? this.ping,
            important: this._important ?? this.important,
            duration: this._duration ?? this.duration,
            retries: this._retries ?? this.retries,
            response: opts?.decodeResponse
                ? await Heartbeat.decodeResponseValue(this._response ?? this.response)
                : undefined,
        };
    }

    /**
     * Decode compressed response payload stored in database.
     * @param {string|null} response Encoded response payload.
     * @returns {string|null} Decoded response payload.
     */
    static async decodeResponseValue(response) {
        if (!response) {
            return response;
        }

        try {
            // Offload brotli decode from main event loop to libuv thread pool
            return (await brotliDecompress(Buffer.from(response, "base64"))).toString("utf8");
        } catch (error) {
            return response;
        }
    }
}

export default Heartbeat;
