/**
 * [hub] One log line for everything that changes the Hub's VRChat session.
 *
 * The Hub's session is shared by everything attached to it, and in October
 * 2026 it kept dying: signed in, then "Missing Credentials" a minute later,
 * then a two-factor prompt on a mirror. The log said a request had failed but
 * not who had touched the session, when, or what VRChat answered. This records
 * exactly that, whoever does it -- the Hub's own data core or a client over the
 * link:
 *
 *   - a password sign-in (`auth/user` with an Authorization header), and
 *     whether VRChat answered with a user or asked for a second factor;
 *   - a two-factor verification;
 *   - the cookie jar being cleared or replaced.
 *
 * Nothing secret is logged: no header, cookie or body, only the outcome.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who is calling, while a client's interop call is running. `runHub.js` sets it
 * around each call; the Hub's own requests run outside it.
 */
export const sessionCaller = new AsyncLocalStorage();

/** @returns {string} */
function caller() {
    return sessionCaller.getStore() ?? 'the Hub';
}

/**
 * @param {any} options - a WebApi request
 * @returns {'sign-in' | 'two-factor verification' | null}
 */
export function classifySessionRequest(options) {
    let path = '';
    try {
        path = new URL(String(options?.url)).pathname;
    } catch {
        return null;
    }
    const headers = options?.headers ?? {};
    const hasAuthorization = Object.keys(headers).some((name) => name.toLowerCase() === 'authorization');
    if (path.endsWith('/auth/user') && hasAuthorization) {
        return 'sign-in';
    }
    if (/\/auth\/twofactorauth\/[^/]+\/verify$/.test(path)) {
        return 'two-factor verification';
    }
    return null;
}

/**
 * @param {number} status
 * @param {string} message - the response body
 * @returns {string}
 */
function describeOutcome(status, message) {
    if (status !== 200) {
        return `${status}`;
    }
    try {
        const json = JSON.parse(message);
        if (Array.isArray(json?.requiresTwoFactorAuth) && json.requiresTwoFactorAuth.length > 0) {
            return `200, but VRChat wants a second factor (${json.requiresTwoFactorAuth.join(', ')})`;
        }
        if (json?.verified === false) {
            return '200, not verified';
        }
    } catch {
        // Not JSON; the status says enough.
    }
    return '200';
}

/**
 * Wrap the WebApi binding. Same shape as `webApiLog.js`: a Proxy over an
 * empty target, because the node-api-dotnet members are read-only.
 *
 * @param {object} WebApi
 * @param {{ log: (message: string) => void }} options
 * @returns {object}
 */
export function auditSessionChanges(WebApi, options) {
    const { log } = options;

    const executeJson = async function ExecuteJson(requestJson) {
        let kind = null;
        try {
            kind = classifySessionRequest(JSON.parse(requestJson));
        } catch {
            // Not ours to parse.
        }
        const who = caller();
        const json = await WebApi.ExecuteJson(requestJson);
        if (kind) {
            try {
                const { status, message } = JSON.parse(json);
                log(`VRChat ${kind} by ${who}: ${describeOutcome(status, String(message ?? ''))}`);
            } catch {
                log(`VRChat ${kind} by ${who}: unreadable response`);
            }
        }
        return json;
    };

    const wrapped = {
        ExecuteJson: executeJson,
        ClearCookies(...args) {
            log(`VRChat cookies cleared by ${caller()}`);
            return WebApi.ClearCookies(...args);
        },
        SetCookies(...args) {
            log(`VRChat cookies replaced by ${caller()}`);
            return WebApi.SetCookies(...args);
        }
    };

    return new Proxy(
        {},
        {
            get(_, prop) {
                if (Object.hasOwn(wrapped, prop)) {
                    return wrapped[prop];
                }
                const value = WebApi[prop];
                return typeof value === 'function' ? value.bind(WebApi) : value;
            },
            has(_, prop) {
                return Object.hasOwn(wrapped, prop) || prop in WebApi;
            }
        }
    );
}
