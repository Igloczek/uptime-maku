// @ts-nocheck

import { SQLiteModel } from "@/server/sqlite-model";
import passwordHash from "@/server/password-hash";
import jwt from "@/server/jwt";
import { shake256, SHAKE256_LENGTH } from "@/server/hash";

class User extends SQLiteModel {
    /**
     * Reset user password
     * Fix #1510, as in the context reset-password.ts, there is no auto model mapping. Call this static function instead.
     * @param {number} userID ID of user to update
     * @param {string} newPassword Users new password
     * @returns {Promise<void>}
     */
    static async resetPassword(store, userID, newPassword) {
        await store.exec("UPDATE `user` SET password = ? WHERE id = ? ", [
            await passwordHash.generate(newPassword),
            userID,
        ]);
    }

    /**
     * Reset this users password
     * @param {string} newPassword Users new password
     * @returns {Promise<void>}
     */
    async resetPassword(store, newPassword) {
        const hashedPassword = await passwordHash.generate(newPassword);

        await store.exec("UPDATE `user` SET password = ? WHERE id = ? ", [hashedPassword, this.id]);

        this.password = hashedPassword;
    }

    /**
     * Create a new JWT for a user
     * @param {User} user The User to create a JsonWebToken for
     * @param {string} jwtSecret The key used to sign the JsonWebToken
     * @param {string} sessionID Persistent session identifier
     * @returns {string} the JsonWebToken as a string
     */
    static createJWT(user, jwtSecret, sessionID) {
        return jwt.sign(
            {
                username: user.username,
                h: shake256(user.password, SHAKE256_LENGTH),
                sid: sessionID,
            },
            jwtSecret
        );
    }

    /**
     * Create a persistent session and its JWT.
     * @param {User} user Authenticated user
     * @param {string} jwtSecret JWT signing secret
     * @returns {Promise<{id: string, token: string}>} Session ID and signed token
     */
    static async createSession(store, user, jwtSecret) {
        const id = crypto.randomUUID();
        await store.exec("INSERT INTO setting (`key`, `value`) VALUES (?, ?)", [`session:${id}`, String(user.id)]);
        return { id, token: User.createJWT(user, jwtSecret, id) };
    }

    /**
     * Check that a JWT session is still active for the user.
     * @param {string} sessionID Session identifier
     * @param {number} userID User identifier
     * @returns {Promise<boolean>} Whether the session is active
     */
    static async hasSession(store, sessionID, userID) {
        if (typeof sessionID !== "string") {
            return false;
        }
        return (
            (await store.getCell("SELECT 1 FROM setting WHERE `key` = ? AND `value` = ?", [
                `session:${sessionID}`,
                String(userID),
            ])) === 1
        );
    }

    /**
     * Revoke one persistent session.
     * @param {string} sessionID Session identifier
     * @param {number} userID User identifier
     * @returns {Promise<void>}
     */
    static async revokeSession(store, sessionID, userID) {
        if (typeof sessionID === "string") {
            await store.exec("DELETE FROM setting WHERE `key` = ? AND `value` = ?", [
                `session:${sessionID}`,
                String(userID),
            ]);
        }
    }

    /**
     * Revoke every persistent session for a user.
     * @param {number} userID User identifier
     * @returns {Promise<void>}
     */
    static async revokeAllSessions(store, userID) {
        await store.exec("DELETE FROM setting WHERE `key` LIKE 'session:%' AND `value` = ?", [String(userID)]);
    }
}

export default User;
