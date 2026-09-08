/**
 * [hub] Brings up the whole Hub: data core, transport, status page.
 *
 * Import order matters. `bootstrap/dom.js` must have been evaluated before
 * anything under `src/` is touched, which is why `hub/main.js` imports this
 * module dynamically rather than statically.
 */

import { createHubServer } from './wsServer.js';
import { createInteropHandler } from './interopHandler.js';
import { createNativeBridge, shutdownNativeBridge } from './nativeBridge.js';
import { createStatusServer } from './statusServer.js';
import { EventType } from '../shared/protocol.js';
import { HubMode, setHubMode } from '../shared/mode.js';
import { HUB_USAGE, loadHubConfig } from './config.js';
import { installNativeStubs } from '../bootstrap/nativeStubs.js';
import { setPipelineObserver } from '../shared/pipelineRelay.js';
import { startHubCore, startHubRuntime } from '../bootstrap/core.js';
import { UplinkKind } from '../client/uplink.js';
import { withRequestCoalescing } from './requestCoalescer.js';
import { wsState } from '../../services/websocket.js';

// `VERSION` is injected as a build-time define (see vite.hub.config.js).
const HUB_VERSION = typeof VERSION === 'undefined' ? 'VRCX-Hub' : VERSION;

/**
 * The Hub binds the three data-core primitives to real .NET objects and stubs
 * the rest.
 *
 * AppApi, LogWatcher, Discord and AssetBundleManager all describe a desktop
 * machine running VRChat, which a Hub box is not. Stubbing them rather than
 * guarding every call site keeps the upstream diff small: the data core calls
 * them freely and simply gets no-ops.
 *
 * @param {object} natives
 */
function bindNatives(natives) {
    installNativeStubs();
    globalThis.SQLite = natives.SQLite;
    globalThis.WebApi = natives.WebApi;
    globalThis.VRCXStorage = natives.VRCXStorage;
    if (typeof globalThis.window !== 'undefined') {
        globalThis.window.SQLite = natives.SQLite;
        globalThis.window.WebApi = natives.WebApi;
        globalThis.window.VRCXStorage = natives.VRCXStorage;
    }
}

/**
 * @param {{ argv?: string[], rootDir?: string, startRuntime?: boolean,
 *           installSignalHandlers?: boolean }} [options]
 * @returns {Promise<object>} a handle with `stop()`
 */
export async function runHub(options = {}) {
    const {
        argv = process.argv.slice(2),
        rootDir = process.cwd(),
        // Tests embed the Hub and drive it directly, so they opt out of signing
        // in and of taking over the process signals.
        startRuntime = true,
        installSignalHandlers = true
    } = options;

    if (argv.includes('--help') || argv.includes('-h')) {
        console.log(HUB_USAGE);
        return { stop: async () => {} };
    }

    const config = loadHubConfig(argv);
    const startedAt = Date.now();

    const log = (message, detail) => {
        if (detail === undefined) {
            console.log(`[hub] ${message}`);
        } else {
            console.log(`[hub] ${message}`, detail);
        }
    };

    log(`Starting ${HUB_VERSION}`);
    log(`Data directory: ${config.configDir}`);

    // --- native layer -----------------------------------------------------
    let natives = null;
    if (config.dryRun) {
        log('Dry run: using in-memory stubs, no real database or VRChat session');
        installNativeStubs();
        natives = {
            SQLite: globalThis.SQLite,
            WebApi: globalThis.WebApi,
            VRCXStorage: globalThis.VRCXStorage
        };
    } else {
        natives = await createNativeBridge({
            rootDir,
            configDir: config.configDir,
            version: HUB_VERSION
        });
        bindNatives(natives);
        log('.NET bridge ready (SQLite, WebApi, VRCXStorage)');
    }

    // --- data core --------------------------------------------------------
    setHubMode(HubMode.HUB);
    const { app, stores } = await startHubCore();
    log(`Data core up: ${Object.keys(stores).length} stores`);

    // --- transport --------------------------------------------------------
    const handleCall = withRequestCoalescing(createInteropHandler({ SQLite: natives.SQLite, WebApi: natives.WebApi }), {
        ttlMs: 0
    });

    const server = createHubServer({
        port: config.port,
        host: config.host,
        token: config.token,
        tls: config.tls,
        log,
        handleCall: config.verbose
            ? async (c, m, a) => {
                  log(`call ${c}.${m}`);
                  return handleCall(c, m, a);
              }
            : handleCall,
        describe: () => ({
            hub: HUB_VERSION,
            databaseVersion: stores.vrcx.state.databaseVersion ?? 0,
            loggedIn: Boolean(stores.user.currentUser?.id),
            userId: stores.user.currentUser?.id ?? null,
            displayName: stores.user.currentUser?.displayName ?? null
        }),
        onUplink: (kind, data) => handleUplink(kind, data)
    });

    /**
     * Local-machine data from a client. The Hub processes it exactly once,
     * which writes the rows, then echoes it to every client (including the
     * sender) so their in-memory stores update. Clients have derived writes
     * suppressed, so the echo costs nothing in the database.
     *
     * @param {string} kind
     * @param {any} data
     */
    function handleUplink(kind, data) {
        try {
            switch (kind) {
                case UplinkKind.GAME_LOG:
                    for (const line of data ?? []) {
                        stores.gameLog.addGameLogEvent(line);
                    }
                    server.broadcast(EventType.GAMELOG, data);
                    break;

                case UplinkKind.IPC:
                    stores.vrcx.ipcEvent(data);
                    server.broadcast(EventType.IPC, data);
                    break;

                case UplinkKind.GAME_STATE:
                    server.broadcast(EventType.GAME_STATE, data);
                    break;

                default:
                    log(`Ignoring unknown uplink kind: ${kind}`);
            }
        } catch (err) {
            log(`Failed to handle uplink "${kind}"`, err);
        }
    }

    // Relay every VRChat pipeline message to the connected clients.
    setPipelineObserver((raw) => {
        server.broadcast(EventType.PIPELINE, raw);
    });

    // --- session mirroring ------------------------------------------------
    // Clients keep a local copy of the Hub's VRChat cookies so that when the
    // Hub goes away they can fall back to standalone without a fresh login and
    // a 2FA prompt. Broadcast on change rather than on a timer: the cookie jar
    // only moves on login, logout and token refresh.
    let lastSessionFingerprint = null;
    async function broadcastSessionIfChanged() {
        if (!server.clientCount) {
            return;
        }
        try {
            const cookies = await natives.WebApi.GetCookies();
            const userId = stores.user.currentUser?.id ?? null;
            const fingerprint = `${userId}:${cookies?.length ?? 0}:${cookies ?? ''}`;
            if (fingerprint === lastSessionFingerprint) {
                return;
            }
            lastSessionFingerprint = fingerprint;
            await server.broadcast(EventType.SESSION, {
                loggedIn: Boolean(userId),
                userId,
                displayName: stores.user.currentUser?.displayName ?? null,
                cookies
            });
        } catch (err) {
            log('Failed to broadcast session state', err);
        }
    }

    const sessionTimer = setInterval(() => {
        broadcastSessionIfChanged().catch(() => {});
    }, 15000);
    sessionTimer.unref?.();

    await server.start();
    log(`Listening on ${config.host}:${config.port}`);
    log(`Token: ${config.configDir}/hub-token`);

    // --- status page ------------------------------------------------------
    const status = createStatusServer({
        port: config.statusPort,
        host: config.host,
        getStatus: () => ({
            version: HUB_VERSION,
            loggedIn: Boolean(stores.user.currentUser?.id),
            displayName: stores.user.currentUser?.displayName ?? null,
            pipelineConnected: wsState.connected,
            clientCount: server.clientCount,
            databaseVersion: stores.vrcx.state.databaseVersion ?? 0,
            uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000)
        })
    });
    await status.start();
    if (config.statusPort) {
        log(`Status page on http://${config.host}:${config.statusPort}/`);
    }

    // --- start collecting -------------------------------------------------
    // Last, so that a client connecting during sign-in already has a socket to
    // connect to and sees the session events as they happen.
    if (startRuntime) {
        const databaseReady = await startHubRuntime(stores);
        if (!databaseReady) {
            log('Database did not initialise; the Hub is up but will not collect.');
        }
    }

    let stopping = false;
    /**
     * @returns {Promise<void>}
     */
    async function stop() {
        if (stopping) {
            return;
        }
        stopping = true;
        log('Shutting down');
        clearInterval(sessionTimer);
        setPipelineObserver(null);
        await server.stop();
        await status.stop();
        app.unmount();
        if (!config.dryRun) {
            shutdownNativeBridge(natives);
        }
    }

    if (installSignalHandlers) {
        // Node terminates the process on an unhandled rejection by default
        // (v15+). The data core fires plenty of un-awaited API calls from
        // background paths -- a pipeline event triggering a user lookup, say --
        // so a transient VRChat error would otherwise take the Hub down. A
        // 24/7 daemon should log it and keep collecting.
        process.on('unhandledRejection', (reason) => {
            log('Unhandled rejection (continuing)', reason);
        });
    }

    for (const signal of installSignalHandlers ? ['SIGINT', 'SIGTERM'] : []) {
        process.on(signal, () => {
            stop()
                .then(() => process.exit(0))
                .catch((err) => {
                    console.error('[hub] Shutdown failed:', err);
                    process.exit(1);
                });
        });
    }

    return { stop, server, status, stores, config };
}
