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
 *
 * Timing is the other half of this module. The link is up long before the
 * app is: before Pinia exists, and then before the friends list is loaded.
 * Upstream never receives a pipeline message in either state -- it opens its
 * socket only once `watchState.isFriendsLoaded` -- and the stores are not
 * built to be poked before then, so relayed pipeline messages are dropped
 * until that point (the REST snapshot taken at login is the authoritative
 * state anyway, and replaying older events over it would move things
 * backwards). The Hub's echoes of machine-local data have no such snapshot,
 * so those are buffered until the stores exist and then replayed in order.
 */

import { reactive } from 'vue';

import { createRemoteSQLite, createRemoteWebApi } from './remoteInterop.js';
import { ConnectionState, createHubConnection } from './connection.js';
import { EventType } from '../shared/protocol.js';
import { handleHubConnectionState } from './fallback.js';
import { HubMode, setHubMode } from '../shared/mode.js';
import { injectPipelineMessage } from '../shared/pipelineRelay.js';
import { suppressionStats } from './databaseGuard.js';
import { notifyUplinkReady, replayFromHub, setUplinkSender, uplinkQueueDepth, uplinkStats } from './uplink.js';
import { recordSocketMessage, SocketChannel } from './socketInspector.js';
import { watchState } from '../../services/watchState.js';

/** How long to wait for a Hub before falling back to standalone. */
const CONNECT_TIMEOUT_MS = 3000;

/** Echoes held while the stores do not exist yet; oldest dropped beyond this. */
const BOOT_BUFFER_LIMIT = 5000;
/** How often to look for the stores while something is waiting for them. */
const STORES_POLL_MS = 50;

/**
 * Keys live in VRCXStorage (VRCX.json) rather than the `configs` table,
 * because they must be readable before any remote binding exists.
 */
export const HubSettingKey = {
    ENABLED: 'VRCX_HubEnabled',
    URL: 'VRCX_HubUrl',
    TOKEN: 'VRCX_HubToken'
};

/**
 * Observable state for the UI and for tests. Reactive so a status bar can
 * bind to it.
 */
export const hubClientState = reactive({
    active: false,
    connectionState: ConnectionState.IDLE,
    /** the `welcome` payload */
    hub: null,
    lastError: null,
    /** the Hub's aggregate game state; informational, never applied locally */
    hubGameState: null,
    /** whether the Hub's own VRChat pipeline socket is up */
    pipelineConnected: false,
    clientCount: 0,
    reconnects: 0,
    resyncs: 0,
    stats: {
        /** relayed pipeline messages handled, by type */
        pipelineByType: {},
        /** relayed pipeline messages dropped because friends were not loaded yet */
        pipelineDroppedBeforeFriends: 0,
        /** echoes held until the stores existed */
        bootBuffered: 0,
        bootDropped: 0,
        /** echoes replayed, by event */
        echoesByEvent: {},
        lastGameStateReceived: null,
        lastEventAt: 0
    }
});

/**
 * When relayed pipeline messages may be handed to the stores. Upstream's
 * rule, behind a seam: `watchState` is shared with the Hub's own data core
 * when both run in one test process, and flipping it there wakes the Hub.
 */
export const relayGate = {
    /** @returns {boolean} */
    isFriendsLoaded: () => watchState.isFriendsLoaded
};

/** @type {ReturnType<typeof createHubConnection> | null} */
let connection = null;

/** @type {Array<{ event: string, data: any }>} */
let bootBuffer = [];
let storesPollTimer = null;

/** @type {{ connected: boolean, messageCount: number, bytesReceived: number } | null} */
let wsState = null;

/** @type {((entries: object[]) => void) | null} */
let replayBacklog = null;

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
 * The upstream modules that the echo handlers need, loaded lazily: this
 * module is imported during boot, before Pinia exists, and must not drag the
 * store graph in ahead of `app.js`.
 */
async function loadUpstreamHooks() {
    const [websocket, coordinator] = await Promise.all([
        import('../../services/websocket.js'),
        import('../../coordinators/gameLogCoordinator.js')
    ]);
    wsState = websocket.wsState;
    replayBacklog = (entries) => {
        let location = '';
        for (const gameLog of entries) {
            if (gameLog?.type === 'location') {
                location = gameLog.location;
            }
            coordinator.addGameLogEntry(gameLog, location);
        }
    };
    if (wsState) {
        wsState.connected = hubClientState.pipelineConnected;
    }
}

/** @returns {boolean} whether the store graph exists and the echo entry points with it */
function storesReady() {
    const stores = globalThis.$pinia;
    return Boolean(stores?.gameLog && stores?.vrcx && stores?.game) && replayBacklog !== null;
}

/**
 * @param {{ gameState?: object, pipelineConnected?: boolean, clientCount?: number }} info
 */
function applyHubInfo(info) {
    if (!info) {
        return;
    }
    if (info.gameState) {
        hubClientState.hubGameState = info.gameState;
        hubClientState.stats.lastGameStateReceived = `${info.gameState.isGameRunning}:${info.gameState.isSteamVRRunning}`;
    }
    if (typeof info.pipelineConnected === 'boolean') {
        hubClientState.pipelineConnected = info.pipelineConnected;
        if (wsState) {
            wsState.connected = info.pipelineConnected;
        }
    }
    if (typeof info.clientCount === 'number') {
        hubClientState.clientCount = info.clientCount;
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
            if (hubClientState.active) {
                if (state === ConnectionState.READY) {
                    onReconnected(detail);
                }
                // Only once attached: a failure during the initial attempt is
                // a silent fall back to standalone, not something to
                // interrupt over.
                handleHubConnectionState(state, detail);
            }
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
    globalThis.WebApi = createRemoteWebApi(transport, localWebApi, {
        endpointDomain: () => hubClientState.hub?.endpointDomain ?? ''
    });
    if (typeof globalThis.window !== 'undefined') {
        globalThis.window.SQLite = globalThis.SQLite;
        globalThis.window.WebApi = globalThis.WebApi;
    }

    setUplinkSender((kind, data) => {
        const sent = connection.uplink(kind, data);
        if (sent) {
            recordSocketMessage(SocketChannel.UPLINK, 'out', data, { type: kind });
        }
        return sent;
    });
    setHubMode(HubMode.MIRROR);

    hubClientState.active = true;
    hubClientState.hub = welcome;
    applyHubInfo(welcome);
    globalThis.__vrcxHub = { hubClientState, uplinkStats, suppressionStats, uplinkQueueDepth };
    console.log(`[hub] Mirroring ${settings.url} (${welcome.hub ?? 'unknown build'})`);

    loadUpstreamHooks().catch((err) => console.error('[hub] Could not load the echo entry points:', err));
    // Nothing to flush yet, but a fresh process tells the Hub its game state
    // as soon as the store knows it; see notifyUplinkReady().
    notifyUplinkReady();
    return connection;
}

/**
 * The link came back. The Hub may be a fresh process that knows nothing
 * about this machine, and this machine missed every pipeline message while
 * the link was down. Upstream heals both after an unclean socket close by
 * refreshing notifications and friends (`services/websocket.js#onopen`);
 * that code never runs on a mirror, so it is done here.
 *
 * @param {object} welcome
 */
function onReconnected(welcome) {
    hubClientState.reconnects++;
    hubClientState.hub = welcome ?? hubClientState.hub;
    applyHubInfo(welcome);
    const flushed = notifyUplinkReady();
    console.info('[hub] Reconnected; re-announced game state and flushed', flushed);

    const stores = globalThis.$pinia;
    // Friends loaded implies logged in; before that point the login flow's
    // own REST snapshot is still ahead.
    if (!stores || !relayGate.isFriendsLoaded()) {
        return;
    }
    hubClientState.resyncs++;
    console.info('[hub] Resyncing notifications and friends after the reconnect');
    try {
        stores.notification?.refreshNotifications?.();
    } catch (err) {
        console.error('[hub] Notification resync failed:', err);
    }
    try {
        if (!stores.friend?.isRefreshFriendsLoading) {
            stores.friend?.refreshFriends?.();
        }
    } catch (err) {
        console.error('[hub] Friend resync failed:', err);
    }
}

/**
 * @param {string} event
 * @param {any} data
 */
function bufferUntilStoresReady(event, data) {
    bootBuffer.push({ event, data });
    hubClientState.stats.bootBuffered++;
    if (bootBuffer.length > BOOT_BUFFER_LIMIT) {
        bootBuffer.shift();
        hubClientState.stats.bootDropped++;
    }
    if (!storesPollTimer) {
        storesPollTimer = setInterval(() => {
            if (!storesReady()) {
                return;
            }
            clearInterval(storesPollTimer);
            storesPollTimer = null;
            drainBootBuffer();
        }, STORES_POLL_MS);
    }
}

function drainBootBuffer() {
    const held = bootBuffer;
    bootBuffer = [];
    if (held.length) {
        console.info(`[hub] Stores are up; replaying ${held.length} buffered Hub events`);
    }
    for (const { event, data } of held) {
        replayEcho(event, data);
    }
}

/**
 * The next three re-enter the same entry points the local sources use,
 * inside replayFromHub() so the uplink guards there let them through instead
 * of sending them up again. Rows are already written on the Hub; derived
 * writes are suppressed here.
 *
 * @param {string} event
 * @param {any} data
 */
function replayEcho(event, data) {
    const stores = globalThis.$pinia;
    const stats = hubClientState.stats.echoesByEvent;
    stats[event] = (stats[event] ?? 0) + 1;
    try {
        switch (event) {
            case EventType.GAMELOG:
                replayFromHub(() => {
                    for (const line of data ?? []) {
                        stores.gameLog.addGameLogEvent(line);
                    }
                });
                break;

            case EventType.GAMELOG_BACKLOG:
                replayFromHub(() => replayBacklog?.(Array.isArray(data) ? data : []));
                break;

            case EventType.IPC:
                replayFromHub(() => stores.vrcx.ipcEvent(data));
                break;

            default:
                break;
        }
    } catch (err) {
        console.error(`[hub] Failed to replay a ${event} event from the Hub:`, err);
    }
}

/**
 * @param {string} event
 * @param {any} data
 * @param {object} localWebApi
 */
function handleHubEvent(event, data, localWebApi) {
    hubClientState.stats.lastEventAt = Date.now();
    if (event !== EventType.PIPELINE) {
        // The relayed pipeline is recorded where it is injected, as `vrchat`.
        recordSocketMessage(SocketChannel.HUB, 'in', event === EventType.SESSION ? { ...data, cookies: '…' } : data, {
            type: event
        });
    }
    switch (event) {
        case EventType.PIPELINE: {
            if (!relayGate.isFriendsLoaded()) {
                hubClientState.stats.pipelineDroppedBeforeFriends++;
                break;
            }
            let type = '?';
            try {
                type = JSON.parse(data)?.type ?? '?';
            } catch {
                // Counted under '?'; the injector reports the parse failure.
            }
            const byType = hubClientState.stats.pipelineByType;
            byType[type] = (byType[type] ?? 0) + 1;
            if (wsState) {
                wsState.messageCount++;
                wsState.bytesReceived += typeof data === 'string' ? data.length : 0;
            }
            injectPipelineMessage(data);
            break;
        }

        case EventType.GAMELOG:
        case EventType.GAMELOG_BACKLOG:
        case EventType.IPC:
            if (bootBuffer.length || !storesReady()) {
                bufferUntilStoresReady(event, data);
            } else {
                replayEcho(event, data);
            }
            break;

        case EventType.GAME_STATE:
            // The Hub's aggregate over every client. This machine's own game
            // state is a fact about this machine and is never overwritten by
            // it; an earlier version did, and a second client reporting
            // "not running" closed the session on the machine that was.
            applyHubInfo({ gameState: data });
            break;

        case EventType.HUB_STATE:
            applyHubInfo(data);
            break;

        case EventType.SESSION:
            // Cookie mirroring. Keeping a local copy of the Hub's session is
            // what lets an offline fallback carry on without a fresh login and
            // a 2FA prompt.
            if (data?.cookies) {
                localWebApi.SetCookies(data.cookies);
            }
            // The Hub re-established its session (a 401 on this side is left
            // to the Hub to fix). Re-fetch the user soon rather than in five
            // minutes.
            if (watchState.isLoggedIn) {
                globalThis.$pinia?.updateLoop?.setNextCurrentUserRefresh?.(5);
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
    hubClientState.hub = null;
    hubClientState.hubGameState = null;
    hubClientState.pipelineConnected = false;
    setHubMode(HubMode.STANDALONE);
    setUplinkSender(null);
    bootBuffer = [];
    if (storesPollTimer) {
        clearInterval(storesPollTimer);
        storesPollTimer = null;
    }
    if (options.reload !== false && typeof globalThis.location?.reload === 'function') {
        globalThis.location.reload();
    }
}
