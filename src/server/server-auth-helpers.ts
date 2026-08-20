// @ts-nocheck

import { genSecret } from "@/util/random";
import passwordHash from "@/server/password-hash";

/**
 * Init or reset JWT secret
 * @returns {Promise<Model>} JWT secret
 */
export const initJWTSecret = async (store) => {
    let jwtSecretModel = await store.findOne("setting", " `key` = ? ", ["jwtSecret"]);

    if (!jwtSecretModel) {
        jwtSecretModel = store.createModel("setting");
        jwtSecretModel.key = "jwtSecret";
    }

    jwtSecretModel.value = genSecret();
    await store.saveModel(jwtSecretModel);
    return jwtSecretModel;
};

/**
 * Decodes a jwt and returns the payload portion without verifying the jwt.
 * @param {string} jwt The input jwt as a string
 * @returns {object} Decoded jwt payload object
 */
export const decodeJwt = (jwt) => {
    return JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString());
};

/**
 * For logged-in users, double-check the password
 * @param {Socket} socket Socket.io instance
 * @param {string} currentPassword Password to validate
 * @returns {Promise<Model>} User
 * @throws The current password is not a string
 * @throws The provided password is not correct
 */
export const doubleCheckPassword = async (store, socket, currentPassword) => {
    if (typeof currentPassword !== "string") {
        throw new Error("Wrong data type?");
    }

    let user = await store.findOne("user", " id = ? AND active = 1 ", [socket.userID]);

    if (!user || !(await passwordHash.verify(currentPassword, user.password))) {
        throw new Error("Incorrect current password");
    }

    return user;
};
