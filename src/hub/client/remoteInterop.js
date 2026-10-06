/**
 * [hub] Remote stand-ins for the `SQLite` and `WebApi` interop globals.
 *
 * The point of this module is that **`src/services/sqlite.js` and
 * `src/services/webapi.js` need no changes at all**. Both already branch on the
 * compile-time `LINUX` flag and speak two different calling conventions:
 *
 *   SQLite.Execute(sql, argsObject)      -> any[][]            (CefSharp)
 *   SQLite.ExecuteJson(sql, argsMap)     -> JSON string        (Electron)
 *   SQLite.ExecuteInsert(sql, args)      -> rowid, 0 if none   (both)
 *   WebApi.Execute(optionsObject)        -> {Item1, Item2}     (CefSharp)
 *   WebApi.ExecuteJson(optionsJson)      -> JSON string        (Electron)
 *
 * So the proxies here implement *both* shapes and adapt a single canonical wire
 * result to whichever one the caller expects. The wire itself always carries
 * rows as an array-of-arrays and HTTP results as `{status, message}`.
 */

import { argsToWire } from '../shared/protocol.js';
import { consumeSignOutIntent } from './sessionGuard.js';

/**
 * Request shapes that must not run on the Hub.
 *
 * `WebApi`'s upload paths call `Program.AppApiInstance.ResizeImageToFitLimits`
 * and friends. The Hub never constructs an `AppApi` (doing so would require
 * `ProgramElectron.Init()`, which unconditionally starts an OpenVR polling
 * thread — fatal on a box with no `openvr_api` native library), so
 * `AppApiInstance` is null there and any upload would throw.
 *
 * They used to run locally with a copy of the Hub's cookies. That copy is
 * gone: VRChat revokes a session token that a second client uses, so a
 * mirror uploading with it signed the Hub out (and cost it its remembered
 * two-factor device). An upload to VRChat itself is therefore refused on a
 * mirror for now; the S3 `PUT` that follows a file upload is pre-signed, needs
 * no session, and still runs locally.
 */
const LOCAL_ONLY_REQUEST_FLAGS = ['uploadImage', 'uploadImageLegacy', 'uploadFilePUT', 'uploadImagePrint'];

/** What a refused upload answers, in the shape `services/request.js` reports. */
export const UPLOAD_UNAVAILABLE = Object.freeze({
    status: 403,
    message: JSON.stringify({
        error: {
            message: '"Uploading is not available on a Hub mirror: the VRChat session belongs to the Hub"',
            status_code: 403
        }
    })
});

/**
 * @param {any} options
 * @returns {boolean}
 */
export function mustRunLocally(options) {
    if (!options || typeof options !== 'object') {
        return false;
    }
    return LOCAL_ONLY_REQUEST_FLAGS.some((flag) => Boolean(options[flag]));
}

/**
 * Whether a request belongs on the Hub's HTTP stack.
 *
 * The Hub holds the VRChat session, so anything on `*.vrchat.cloud` -- the
 * API, the pipeline, and `files.vrchat.cloud`, whose images need the session
 * cookies -- goes there, as does whatever API endpoint the Hub is signed in
 * against (a custom one is possible). Everything else is a third party: the
 * VRCX update check, avatar-provider lookups, image previews of arbitrary
 * URLs, Sentry. Those carry no session, gain nothing from the round trip, and
 * would otherwise ship whole images over the sealed socket twice-encoded.
 *
 * An unparseable URL is sent to the Hub: that is where the failure will be
 * reported best, and `webApiService` callers already handle a non-200.
 *
 * @param {string | undefined} url
 * @param {string} [endpointDomain] - the Hub's API endpoint, e.g. `https://api.vrchat.cloud/api/1`
 * @returns {boolean}
 */
export function isHubBoundUrl(url, endpointDomain = '') {
    let host;
    try {
        host = new URL(String(url)).hostname.toLowerCase();
    } catch {
        return true;
    }
    if (host === 'vrchat.cloud' || host.endsWith('.vrchat.cloud')) {
        return true;
    }
    if (endpointDomain) {
        try {
            if (host === new URL(endpointDomain).hostname.toLowerCase()) {
                return true;
            }
        } catch {
            // A malformed endpoint cannot match anything.
        }
    }
    return false;
}

/**
 * @typedef {object} HubTransport
 * @property {(className: string, method: string, args: any[]) => Promise<any>} call
 */

/**
 * @param {HubTransport} transport
 * @returns {object} a stand-in for the `SQLite` global
 */
export function createRemoteSQLite(transport) {
    return {
        async Init() {},
        async Exit() {},

        /**
         * @param {string} sql
         * @param {Map<string, any> | Record<string, any> | null} [args]
         * @returns {Promise<any[][]>}
         */
        async Execute(sql, args = null) {
            return transport.call('SQLite', 'Execute', [sql, argsToWire(args)]);
        },

        /**
         * @param {string} sql
         * @param {Map<string, any> | Record<string, any> | null} [args]
         * @returns {Promise<string>}
         */
        async ExecuteJson(sql, args = null) {
            const rows = await transport.call('SQLite', 'ExecuteJson', [sql, argsToWire(args)]);
            return JSON.stringify(rows);
        },

        /**
         * @param {string} sql
         * @param {Map<string, any> | Record<string, any> | null} [args]
         * @returns {Promise<number>}
         */
        async ExecuteNonQuery(sql, args = null) {
            return transport.call('SQLite', 'ExecuteNonQuery', [sql, argsToWire(args)]);
        },

        /**
         * @param {string} sql
         * @param {Map<string, any> | Record<string, any> | null} [args]
         * @returns {Promise<number>} the new row's rowid, or 0 if none was inserted
         */
        async ExecuteInsert(sql, args = null) {
            return Number(await transport.call('SQLite', 'ExecuteInsert', [sql, argsToWire(args)]));
        }
    };
}

/**
 * @param {HubTransport} transport
 * @param {object} localWebApi - the machine-local `WebApi` binding, used for uploads and third-party URLs
 * @param {{ endpointDomain?: () => string }} [options] - the Hub's API endpoint, read per request
 * @returns {object} a stand-in for the `WebApi` global
 */
export function createRemoteWebApi(transport, localWebApi, options = {}) {
    const { endpointDomain = () => '' } = options;

    /**
     * @param {any} requestOptions
     * @returns {Promise<{status: number, message: string}>}
     */
    async function execute(requestOptions) {
        const hubBound = isHubBoundUrl(requestOptions?.url, endpointDomain());
        if (mustRunLocally(requestOptions)) {
            return hubBound ? UPLOAD_UNAVAILABLE : executeLocally(requestOptions);
        }
        if (!hubBound) {
            return executeLocally(requestOptions);
        }
        return transport.call('WebApi', 'Execute', [requestOptions]);
    }

    /**
     * Runs an upload through the machine-local WebApi, normalising whichever
     * host shape it returns back to the canonical `{status, message}`.
     *
     * @param {any} options
     * @returns {Promise<{status: number, message: string}>}
     */
    async function executeLocally(options) {
        if (LINUX) {
            const json = await localWebApi.ExecuteJson(JSON.stringify(options));
            return JSON.parse(json);
        }
        const item = await localWebApi.Execute(options);
        return { status: item.Item1, message: item.Item2 };
    }

    return {
        async Init() {},
        async Exit() {},

        /**
         * CefSharp shape.
         * @param {any} options
         * @returns {Promise<{Item1: number, Item2: string}>}
         */
        async Execute(options) {
            const { status, message } = await execute(options);
            return { Item1: status, Item2: message };
        },

        /**
         * Electron shape.
         * @param {string} optionsJson
         * @returns {Promise<string>}
         */
        async ExecuteJson(optionsJson) {
            const result = await execute(JSON.parse(optionsJson));
            return JSON.stringify(result);
        },

        /** @returns {Promise<string>} */
        async GetCookies() {
            return transport.call('WebApi', 'GetCookies', []);
        },

        /**
         * @param {string} cookies
         * @returns {Promise<void>}
         */
        async SetCookies(_cookies) {
            // Upstream's relogin restores the cookies saved at the last
            // sign-in; on a mirror those are the Hub's, older than its jar,
            // and the Hub refuses them anyway. Nothing to send.
        },

        /**
         * Clearing cookies on a mirror client logs out the *Hub*, and therefore
         * every other client, and stops 24/7 collection -- when the person
         * asked for it. The call says whether they did; upstream also clears
         * on its own (a sign-out after a failed friend list, a retried 2FA),
         * and the Hub ignores those.
         *
         * @returns {Promise<void>}
         */
        async ClearCookies() {
            // Only the person's own "Log out" signs the Hub out; the Hub
            // ignores the automatic ones (see server/signInAuthority.js).
            return transport.call('WebApi', 'ClearCookies', [{ userInitiated: consumeSignOutIntent() }]);
        }
    };
}
