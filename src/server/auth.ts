// @ts-nocheck

/**
 * Login to web app
 * @param {string} username Username to login with
 * @param {string} password Password to login with
 * @returns {Promise<(Bean|null)>} User or null if login failed
 */
import passwordHash from "@/server/password-hash";
import { log } from "@/server/logger";
import { loginRateLimiter, apiRateLimiter } from "@/server/rate-limiter";
import dayjs from "dayjs";
import { textResponse } from "@/server/bun-response";

const API_KEY_PATTERN = /^uk([1-9]\d*)_([A-Za-z0-9]{40})$/;

export function parseAPIKey(key) {
    if (typeof key !== "string") {
        return null;
    }

    const parsed = API_KEY_PATTERN.exec(key);
    if (!parsed || !Number.isSafeInteger(Number(parsed[1]))) {
        return null;
    }

    return {
        id: parsed[1],
        secret: parsed[2],
    };
}

export async function login(store, username, password) {
    if (typeof username !== "string" || typeof password !== "string") {
        return null;
    }

    let user = await store.findOne("user", "TRIM(username) = ? AND active = 1 ", [username.trim()]);

    if (user && (await passwordHash.verify(password, user.password))) {
        // Upgrade legacy or non-native password hashes after successful login.
        if (passwordHash.needRehash(user.password)) {
            await store.exec("UPDATE `user` SET password = ? WHERE id = ? ", [
                await passwordHash.generate(password),
                user.id,
            ]);
        }
        return user;
    }

    return null;
}

/**
 * Validate a provided API key
 * @param {string} key API key to verify
 * @returns {Promise<Bean|null>} Matching API key or null
 */
async function verifyAPIKey(store, key) {
    const parsed = parseAPIKey(key);
    if (!parsed) {
        return null;
    }

    let hash = await store.findOne("api_key", " id=? ", [parsed.id]);

    if (hash === null) {
        return null;
    }

    if ((hash.expires && !dayjs(hash.expires).isAfter(dayjs())) || !hash.active) {
        return null;
    }

    return (await passwordHash.verify(parsed.secret, hash.key)) ? hash : null;
}

/**
 * Validate username and password credentials for HTTP Basic auth.
 * @param {string} username Username to login with
 * @param {string} password Password to login with
 * @returns {Promise<number|null>} User ID when authorized
 */
async function authorizeUser(store, username, password, source) {
    const rateLimitKey = typeof username === "string" ? username.trim().toLowerCase() : "invalid";
    // Login Rate Limit
    const pass = await loginRateLimiter.pass(null, 1, rateLimitKey, source);
    if (!pass) {
        log.warn("basic-auth", "Failed basic auth attempt: rate limit exceeded");
        return null;
    }

    const user = await login(store, username, password);
    if (user !== null) {
        loginRateLimiter.reset(rateLimitKey);
        return user.id;
    }

    log.warn("basic-auth", "Failed basic auth attempt: invalid username/password");
    return null;
}

/**
 * Validate an API key passed as the HTTP Basic auth password.
 * @param {string} password API key from the password field
 * @returns {Promise<number|null>} API key owner ID when authorized
 */
async function authorizeAPIKey(store, password, source) {
    const parsed = parseAPIKey(password);
    const rateLimitKey = parsed ? `api-key:${parsed.id}` : "invalid";
    const pass = await apiRateLimiter.pass(null, 1, rateLimitKey, source);
    if (!pass) {
        log.warn("api-auth", "Failed API auth attempt: rate limit exceeded");
        return null;
    }

    const key = await verifyAPIKey(store, password);
    if (!key) {
        log.warn("api-auth", "Failed API auth attempt: invalid API Key");
    } else {
        apiRateLimiter.reset(rateLimitKey);
    }
    // Only allow a set number of api requests per minute (currently set to 60).
    return key?.user_id ?? null;
}

function parseBasicAuthRequest(request) {
    const authorization = request.headers.get("authorization");
    if (!authorization || !authorization.toLowerCase().startsWith("basic ")) {
        return null;
    }

    let decoded;
    try {
        decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    } catch {
        return null;
    }

    const separator = decoded.indexOf(":");
    if (separator === -1) {
        return null;
    }

    return {
        username: decoded.slice(0, separator),
        password: decoded.slice(separator + 1),
    };
}

function unauthorizedResponse(disableFrameSameOrigin) {
    return textResponse("Unauthorized", {
        status: 401,
        disableFrameSameOrigin,
        headers: {
            "WWW-Authenticate": 'Basic realm="iglo.monitor"',
        },
    });
}

/**
 * Check a Bun Request with HTTP Basic auth.
 * @param {Request} request Bun request
 * @param {object} options Auth options
 * @param {boolean} options.apiKeys Use API key auth when enabled
 * @param {boolean} options.disableFrameSameOrigin Disable SAMEORIGIN frame header
 * @returns {Promise<Response|null>} null when authorized, otherwise an auth response
 */
export async function checkBasicAuthRequest(store, settings, request, options = {}) {
    const auth = await authenticateBasicAuthRequest(store, settings, request, options);
    return auth.response || null;
}

/**
 * Authenticate a Bun Request and preserve the authenticated user identity.
 * @param {Request} request Bun request
 * @param {object} options Auth options
 * @returns {Promise<{userID: number|null, response?: Response}>} Auth result
 */
export async function authenticateBasicAuthRequest(store, settings, request, options = {}) {
    const disabledAuth = await settings.get("disableAuth");
    if (disabledAuth) {
        return { userID: null };
    }

    const credentials = parseBasicAuthRequest(request);
    if (!credentials) {
        return { userID: null, response: unauthorizedResponse(options.disableFrameSameOrigin) };
    }

    let userID;
    if (options.apiKeys && (await settings.get("apiKeysEnabled"))) {
        userID = await authorizeAPIKey(store, credentials.password, options.source);
    } else {
        userID = await authorizeUser(store, credentials.username, credentials.password, options.source);
    }

    return userID === null
        ? { userID: null, response: unauthorizedResponse(options.disableFrameSameOrigin) }
        : { userID };
}

/**
 * Check HTTP API auth, using API keys when they are enabled.
 * @param {Request} request Bun request
 * @param {object} options Auth options
 * @returns {Promise<Response|null>} null when authorized, otherwise an auth response
 */
export async function checkAPIAuthRequest(store, settings, request, options = {}) {
    return checkBasicAuthRequest(store, settings, request, {
        ...options,
        apiKeys: true,
    });
}

/**
 * Authenticate HTTP API access and return its user identity.
 * @param {Request} request Bun request
 * @param {object} options Auth options
 * @returns {Promise<{userID: number|null, response?: Response}>} Auth result
 */
export async function authenticateAPIRequest(store, settings, request, options = {}) {
    return authenticateBasicAuthRequest(store, settings, request, {
        ...options,
        apiKeys: true,
    });
}
