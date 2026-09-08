/**
 * [hub] Remote stand-ins for the `SQLite` and `WebApi` interop globals.
 *
 * The point of this module is that **`src/services/sqlite.js` and
 * `src/services/webapi.js` need no changes at all**. Both already branch on the
 * compile-time `LINUX` flag and speak two different calling conventions:
 *
 *   SQLite.Execute(sql, argsObject)      -> any[][]            (CefSharp)
 *   SQLite.ExecuteJson(sql, argsMap)     -> JSON string        (Electron)
 *   WebApi.Execute(optionsObject)        -> {Item1, Item2}     (CefSharp)
 *   WebApi.ExecuteJson(optionsJson)      -> JSON string        (Electron)
 *
 * So the proxies here implement *both* shapes and adapt a single canonical wire
 * result to whichever one the caller expects. The wire itself always carries
 * rows as an array-of-arrays and HTTP results as `{status, message}`.
 */

import { argsToWire } from '../shared/protocol.js';

/**
 * Request shapes that must not run on the Hub.
 *
 * `WebApi`'s upload paths call `Program.AppApiInstance.ResizeImageToFitLimits`
 * and friends. The Hub never constructs an `AppApi` (doing so would require
 * `ProgramElectron.Init()`, which unconditionally starts an OpenVR polling
 * thread — fatal on a box with no `openvr_api` native library), so
 * `AppApiInstance` is null there and any upload would throw.
 *
 * Uploads are low-frequency, user-initiated, and the client already holds a
 * mirrored copy of the Hub's cookies, so they run locally instead. This is what
 * buys us a zero-line diff in the C# tree.
 */
const LOCAL_ONLY_REQUEST_FLAGS = ['uploadImage', 'uploadImageLegacy', 'uploadFilePUT', 'uploadImagePrint'];

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
        }
    };
}

/**
 * @param {HubTransport} transport
 * @param {object} localWebApi - the machine-local `WebApi` binding, used for uploads
 * @returns {object} a stand-in for the `WebApi` global
 */
export function createRemoteWebApi(transport, localWebApi) {
    /**
     * @param {any} options
     * @returns {Promise<{status: number, message: string}>}
     */
    async function execute(options) {
        if (mustRunLocally(options)) {
            return executeLocally(options);
        }
        return transport.call('WebApi', 'Execute', [options]);
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
        async SetCookies(cookies) {
            return transport.call('WebApi', 'SetCookies', [cookies]);
        },

        /**
         * Clearing cookies on a mirror client logs out the *Hub*, and therefore
         * every other client, and stops 24/7 collection. The confirmation for
         * that lives in the UI layer; this call is the point of no return.
         *
         * @returns {Promise<void>}
         */
        async ClearCookies() {
            return transport.call('WebApi', 'ClearCookies', []);
        }
    };
}
