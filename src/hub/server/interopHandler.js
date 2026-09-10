/**
 * [hub] Executes `call` frames against the Hub's local interop bindings.
 *
 * Returns the canonical wire shapes described in `client/remoteInterop.js`:
 * SQL rows as an array-of-arrays, HTTP results as `{status, message}`. The
 * client adapts those to whichever calling convention its host expects.
 */

import { argsFromWire, isCallAllowed } from '../shared/protocol.js';

export class HubInteropError extends Error {
    /**
     * @param {string} message
     * @param {string} [code]
     */
    constructor(message, code = 'interop-error') {
        super(message);
        this.name = 'HubInteropError';
        this.code = code;
    }
}

/**
 * @param {object} natives - `{ SQLite, WebApi }` bindings
 * @param {{ sqliteForClient?: (client: object | undefined) => object }} [options] -
 *   a per-client view of the SQLite binding (the transaction gate in
 *   `server/sqliteGate.js` hands out one per owner); defaults to `natives.SQLite`
 * @returns {(className: string, method: string, args: any[], client?: object) => Promise<any>}
 */
export function createInteropHandler(natives, options = {}) {
    const { WebApi } = natives;
    const { sqliteForClient = () => natives.SQLite } = options;

    /**
     * @param {object} sqlite
     * @param {string} sql
     * @param {Record<string, any> | null} wireArgs
     * @returns {Promise<any[][]>}
     */
    async function query(sqlite, sql, wireArgs) {
        const json = await sqlite.ExecuteJson(sql, argsFromWire(wireArgs));
        if (!json) {
            return [];
        }
        return JSON.parse(json);
    }

    /**
     * @param {any} options
     * @returns {Promise<{status: number, message: string}>}
     */
    async function httpExecute(options) {
        const json = await WebApi.ExecuteJson(JSON.stringify(options));
        const data = JSON.parse(json);
        return { status: data.status, message: data.message };
    }

    return async function handleCall(className, method, args = [], client = undefined) {
        if (!isCallAllowed(className, method)) {
            throw new HubInteropError(`Call not allowed: ${className}.${method}`, 'not-allowed');
        }

        switch (`${className}.${method}`) {
            case 'SQLite.Execute':
            case 'SQLite.ExecuteJson':
                return query(sqliteForClient(client), args[0], args[1] ?? null);

            case 'SQLite.ExecuteNonQuery':
                return sqliteForClient(client).ExecuteNonQuery(args[0], argsFromWire(args[1] ?? null));

            case 'WebApi.Execute':
                return httpExecute(args[0]);

            case 'WebApi.ExecuteJson':
                return httpExecute(typeof args[0] === 'string' ? JSON.parse(args[0]) : args[0]);

            case 'WebApi.GetCookies':
                return WebApi.GetCookies();

            case 'WebApi.SetCookies':
                return WebApi.SetCookies(args[0]);

            case 'WebApi.ClearCookies':
                return WebApi.ClearCookies();

            default:
                throw new HubInteropError(`Unhandled call: ${className}.${method}`, 'unhandled');
        }
    };
}
