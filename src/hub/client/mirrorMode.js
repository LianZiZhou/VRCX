/**
 * [hub] Turns a normal VRCX client into a mirror of a Hub.
 *
 * Called from `plugins/interopApi.js` after the local native bindings are in
 * place and *before* `configRepository.init()`. That order matters: the
 * `configs` table is read through `SQLite`, so if the rebind happened later the
 * client's settings would come from its own local database instead of the
 * Hub's.
 *
 * What gets rebound, and what deliberately does not:
 *
 *   SQLite, WebApi          -> the Hub. The database and the VRChat session
 *                              live there; that is the whole point.
 *   VRCXStorage             -> stays local. It backs VRCX.json, which holds
 *                              per-machine settings (window geometry, GPU
 *                              flags, database path, proxy) and the Hub
 *                              connection settings themselves.
 *   AppApi, LogWatcher,
 *   Discord, AssetBundle    -> stay local. They describe this machine.
 *
 * If anything goes wrong — no settings, Hub unreachable, wrong token, schema
 * mismatch — this returns null and the client carries on as an ordinary
 * standalone VRCX against its own local database.
 */

import { createRemoteSQLite, createRemoteWebApi } from './remoteInterop.js';
import { ConnectionState, createHubConnection } from './connection.js';
import { EventType } from '../shared/protocol.js';
import { HubMode, setHubMode } from '../shared/mode.js';
import { injectPipelineMessage } from '../shared/pipelineRelay.js';
import { setUplinkSender } from './uplink.js';

/** How long to wait for a Hub before falling back to standalone. */
const CONNECT_TIMEOUT_MS = 3000;

/**
 * Keys live in VRCXStorage (VRCX.json) rather than the `configs` table,
 * because they must be readable before any remote binding exists.
 */
export const HubSettingKey = {
    ENABLED: 'VRCX_HubEnabled',
    URL: 'VRCX_HubUrl',
    TOKEN: 'VRCX_HubToken'
};

/** Observable state for the UI and for tests. */
export const hubClientState = {
    active: false,
    connectionState: ConnectionState.IDLE,
    hub: null,
    lastError: null
};

/** @type {ReturnType<typeof createHubConnection> | null} */
let connection = null;

/**
 * @param {object} storage - the local VRCXStorage binding
 * @returns {Promise<{enabled: boolean, url: string, token: string}>}
 */
export async function readHubSettings(storage) {
    const [enabled, url, token] = await Promise.all([
        storage.Get(HubSettingKey.ENABLED),
        storage.Get(HubSettingKey.URL),
        storage.Get(HubSettingKey.TOKEN)
    ]);
    return {
        enabled: String(enabled) === 'true',
        url: String(url ?? ''),
        token: String(token ?? '')
    };
}

/**
 * @param {object} storage
 * @param {{enabled?: boolean, url?: string, token?: string}} settings
 * @returns {Promise<void>}
 */
export async function writeHubSettings(storage, settings) {
    if (settings.enabled !== undefined) {
        await storage.Set(HubSettingKey.ENABLED, settings.enabled ? 'true' : 'false');
    }
    if (settings.url !== undefined) {
        await storage.Set(HubSettingKey.URL, settings.url);
    }
    if (settings.token !== undefined) {
        await storage.Set(HubSettingKey.TOKEN, settings.token);
    }
    await storage.Save?.();
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Hub connection timed out')), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (err) => {
                clearTimeout(timer);
                reject(err);
            }
        );
    });
}

export class HubSchemaMismatchError extends Error {
    /**
     * @param {number} hubVersion
     * @param {number} clientVersion
     */
    constructor(hubVersion, clientVersion) {
        super(
            hubVersion < clientVersion
                ? `The Hub's database schema (v${hubVersion}) is older than this client expects (v${clientVersion}). Update the Hub.`
                : `The Hub's database schema (v${hubVersion}) is newer than this client supports (v${clientVersion}). Update this client.`
        );
        this.name = 'HubSchemaMismatchError';
        this.hubVersion = hubVersion;
        this.clientVersion = clientVersion;
    }
}

/**
 * @typedef {object} MirrorModeOptions
 * @property {object} storage - local VRCXStorage binding
 * @property {object} localWebApi - local WebApi binding, used for uploads and cookie mirroring
 * @property {number} clientDatabaseVersion - the schema this client expects
 * @property {string} [clientName]
 * @property {(event: string, data: any) => void} [onHubEvent]
 * @property {(state: string, detail: any) => void} [onStateChange]
 */

/**
 * @param {MirrorModeOptions} options
 * @returns {Promise<object | null>} the connection, or null to stay standalone
 */
export async function initMirrorMode(options) {
    const {
        storage,
        localWebApi,
        clientDatabaseVersion,
        clientName = 'vrcx-client',
        onHubEvent = () => {},
        onStateChange = () => {}
    } = options;

    const settings = await readHubSettings(storage);
    if (!settings.enabled || !settings.url || !settings.token) {
        return null;
    }

    connection = createHubConnection({
        url: settings.url,
        token: settings.token,
        clientName,
        onEvent: (event, data) => {
            handleHubEvent(event, data, localWebApi);
            onHubEvent(event, data);
        },
        onStateChange: (state, detail) => {
            hubClientState.connectionState = state;
            onStateChange(state, detail);
        }
    });

    let welcome;
    try {
        welcome = await withTimeout(connection.connect(), CONNECT_TIMEOUT_MS);
    } catch (err) {
        hubClientState.lastError = err;
        console.warn('[hub] Could not reach the Hub, staying standalone:', err.message);
        connection.close();
        connection = null;
        return null;
    }

    // A client writing against a schema it does not expect corrupts data
    // quietly, so a mismatch is a hard failure rather than a warning.
    if (welcome.databaseVersion !== clientDatabaseVersion) {
        const err = new HubSchemaMismatchError(welcome.databaseVersion, clientDatabaseVersion);
        hubClientState.lastError = err;
        console.error(`[hub] ${err.message}`);
        connection.close();
        connection = null;
        return null;
    }

    const transport = { call: (c, m, a) => connection.call(c, m, a) };
    globalThis.SQLite = createRemoteSQLite(transport);
    globalThis.WebApi = createRemoteWebApi(transport, localWebApi);
    if (typeof globalThis.window !== 'undefined') {
        globalThis.window.SQLite = globalThis.SQLite;
        globalThis.window.WebApi = globalThis.WebApi;
    }

    setUplinkSender((kind, data) => connection.uplink(kind, data));
    setHubMode(HubMode.MIRROR);

    hubClientState.active = true;
    hubClientState.hub = welcome;
    console.log(`[hub] Mirroring ${settings.url} (${welcome.hub ?? 'unknown build'})`);
    return connection;
}

/**
 * @param {string} event
 * @param {any} data
 * @param {object} localWebApi
 */
function handleHubEvent(event, data, localWebApi) {
    switch (event) {
        case EventType.PIPELINE:
            injectPipelineMessage(data);
            break;

        case EventType.GAMELOG:
            // Re-processed locally so this client's in-memory stores update.
            // The rows are already written; derived writes are suppressed here.
            for (const line of data ?? []) {
                globalThis.$pinia?.gameLog?.addGameLogEvent?.(line);
            }
            break;

        case EventType.IPC:
            globalThis.$pinia?.vrcx?.ipcEvent?.(data);
            break;

        case EventType.GAME_STATE:
            globalThis.$pinia?.game?.updateIsGameRunning?.(data?.isGameRunning, data?.isSteamVRRunning);
            break;

        case EventType.SESSION:
            // Cookie mirroring. Keeping a local copy of the Hub's session is
            // what lets an offline fallback carry on without a fresh login and
            // a 2FA prompt.
            if (data?.cookies) {
                localWebApi.SetCookies(data.cookies);
            }
            break;

        default:
            break;
    }
}

/** @returns {object | null} */
export function getHubConnection() {
    return connection;
}

/**
 * Drop the Hub link and return this client to standalone.
 *
 * The reload is deliberate. The remote and local databases hold different
 * content and different per-user table prefixes, and swapping them underneath a
 * running app is a whole class of half-migrated-state bugs. Re-entering the app
 * is cheap and unambiguous.
 *
 * @param {{ reload?: boolean }} [options]
 */
export function leaveMirrorMode(options = {}) {
    connection?.close();
    connection = null;
    hubClientState.active = false;
    setHubMode(HubMode.STANDALONE);
    setUplinkSender(null);
    if (options.reload !== false && typeof globalThis.location?.reload === 'function') {
        globalThis.location.reload();
    }
}
