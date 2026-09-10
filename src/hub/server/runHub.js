/**
 * [hub] Brings up the whole Hub: data core, transport, status page.
 *
 * Import order matters. `bootstrap/dom.js` must have been evaluated before
 * anything under `src/` is touched, which is why `hub/main.js` imports this
 * module dynamically rather than statically.
 */

import { watch } from 'vue';

import { createHubServer } from './wsServer.js';
import { createAdminHandler } from './adminHandler.js';
import { createConfigSync } from './configSync.js';
import { createGameStateRegistry } from './gameStateRegistry.js';
import { createInteropHandler } from './interopHandler.js';
import { createNativeBridge, shutdownNativeBridge } from './nativeBridge.js';
import { createSqliteGate } from './sqliteGate.js';
import { createStatusServer } from './statusServer.js';
import { logWebApiFailures } from './webApiLog.js';
import { diagnoseVrchatReachability } from './networkCheck.js';
import { EventType } from '../shared/protocol.js';
import { HubMode, setHubMode } from '../shared/mode.js';
import { HUB_USAGE, loadHubConfig, RESTART_EXIT_CODE } from './config.js';
import { applyPendingImport } from './pendingImport.js';
import { EXPECTED_DATABASE_VERSION } from '../shared/schema.js';
import { isEchoedIpc } from '../shared/ipcRouting.js';
import { resolveDatabasePath } from '../migrate/dataDir.js';
import { installNativeStubs } from '../bootstrap/nativeStubs.js';
import { setPipelineObserver } from '../shared/pipelineRelay.js';
import { startHubCore, startHubRuntime } from '../bootstrap/core.js';
import { UplinkKind } from '../client/uplink.js';
import { withRequestCoalescing } from './requestCoalescer.js';
import { addGameLogEntry, tryLoadPlayerList } from '../../coordinators/gameLogCoordinator';
import { AppDebug } from '../../services/appConfig';
import { wsState } from '../../services/websocket.js';

import configRepository from '../../services/config';

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
 * Replays a client's start-up backlog the way `gameLogCoordinator.js#updateGameLog`
 * does: the location each entry belongs to is tracked from the backlog's own
 * `location` entries, regardless of the game state at the time.
 *
 * @param {object[]} entries - parsed entries, as `gameLogService.getAll()` returns them
 */
function replayGameLogBacklog(entries) {
    let location = '';
    for (const gameLog of entries) {
        if (gameLog?.type === 'location') {
            location = gameLog.location;
        }
        addGameLogEntry(gameLog, location);
    }
}

/**
 * @param {{ argv?: string[], rootDir?: string, startRuntime?: boolean,
 *           installSignalHandlers?: boolean,
 *           onRestartRequest?: ((reason: string) => void) | null }} [options]
 * @returns {Promise<object>} a handle with `stop()`
 */
export async function runHub(options = {}) {
    const {
        argv = process.argv.slice(2),
        rootDir = process.cwd(),
        // Tests embed the Hub and drive it directly, so they opt out of signing
        // in and of taking over the process signals.
        startRuntime = true,
        installSignalHandlers = true,
        // What a restart request does. The default exits with RESTART_EXIT_CODE
        // for the supervisor to act on; an embedded Hub gets a no-op instead of
        // having its test runner killed.
        onRestartRequest = installSignalHandlers ? null : () => {}
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
    log(`Node ${process.versions.node} on ${process.platform}-${process.arch}`);
    log(`Data directory: ${config.configDir}`);

    // --- staged import ----------------------------------------------------
    if (installSignalHandlers) {
        // Node terminates the process on an unhandled rejection by default
        // (v15+). The data core fires plenty of un-awaited API calls from
        // background paths -- a pipeline event triggering a user lookup, say --
        // so a transient VRChat error would otherwise take the Hub down. A
        // 24/7 daemon should log it and keep collecting.
        //
        // Installed here, before the data core boots, and not at the end of
        // start-up as it once was: the start-up sign-in itself forks its
        // request promise (services/request.js merges concurrent GETs), and
        // when that failed the second branch's rejection arrived before the
        // handler existed and killed the process.
        process.on('unhandledRejection', (reason) => {
            log('Unhandled rejection (continuing)', reason);
        });
        // The desktop app runs in a browser, where a throw from a timer or an
        // event callback is logged and life goes on. Give the same code the
        // same treatment here.
        process.on('uncaughtException', (err) => {
            log('Uncaught exception (continuing)', err);
        });
    }

    // Before the .NET side opens the database: an upload from the migration
    // tool waiting in import-pending/ is moved into place here, and the
    // previous file into backups/. See server/pendingImport.js.
    const databasePath = resolveDatabasePath(config.configDir);
    if (!config.dryRun) {
        await applyPendingImport({ configDir: config.configDir, databasePath, log });
    }

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
            version: HUB_VERSION,
            log
        });
        // The one place the .NET side's HTTP failure reason can still be read
        // before upstream code reduces it to `{}`.
        natives.WebApi = logWebApiFailures(natives.WebApi, { log });
    }

    // One connection, many writers: the Hub's own statements and every
    // client's go through the transaction gate, each as its own owner, so a
    // `BEGIN ... COMMIT` from one cannot interleave with another's.
    const sqliteGate = createSqliteGate(natives.SQLite, { log });
    const nativeSQLite = natives.SQLite;
    natives = { ...natives, SQLite: sqliteGate.forOwner('hub') };
    bindNatives(natives);
    if (!config.dryRun) {
        const where = natives.runtime.bundled ? 'bundled' : 'system';
        log(`.NET bridge ready (SQLite, WebApi, VRCXStorage) on ${natives.runtime.description} [${where}]`);
    }

    // --- data core --------------------------------------------------------
    setHubMode(HubMode.HUB);
    const { app, stores } = await startHubCore();
    log(`Data core up: ${Object.keys(stores).length} stores`);

    // --- transport --------------------------------------------------------
    /** @type {Map<string, object>} clientId -> that client's view of SQLite */
    const clientSqliteViews = new Map();
    const sqliteForClient = (client) => {
        const owner = client?.clientId ?? 'anonymous';
        let view = clientSqliteViews.get(owner);
        if (!view) {
            view = sqliteGate.forOwner(owner);
            clientSqliteViews.set(owner, view);
        }
        return view;
    };

    let signInWake = () => {};
    const configSync = createConfigSync({
        stores,
        configRepository,
        log,
        verbose: config.verbose,
        onSignInHint: () => signInWake()
    });

    const interop = createInteropHandler({ SQLite: nativeSQLite, WebApi: natives.WebApi }, { sqliteForClient });
    const coalesced = withRequestCoalescing(interop, { ttlMs: 0 });
    const handleCall = async (className, method, args, client) => {
        if (config.verbose) {
            log(`call ${className}.${method} from ${client?.clientName ?? '?'}`);
        }
        if (className === 'SQLite' && method === 'ExecuteNonQuery') {
            configSync.observe(args?.[0], args?.[1] ?? null);
        }
        return coalesced(className, method, args, client);
    };

    /**
     * Ask the supervisor for a fresh process. `stop` is defined further down;
     * by the time anything can call this it exists.
     *
     * @param {string} reason
     */
    function requestRestart(reason) {
        log(`Restarting: ${reason}`);
        stop()
            .catch((err) => log('Shutdown before restart failed', err))
            .then(() => {
                if (onRestartRequest) {
                    onRestartRequest(reason);
                } else {
                    process.exit(RESTART_EXIT_CODE);
                }
            });
    }

    const handleAdmin = createAdminHandler({
        configDir: config.configDir,
        databasePath,
        hubVersion: HUB_VERSION,
        expectedSchemaVersion: EXPECTED_DATABASE_VERSION,
        getStatus: () => ({
            loggedIn: Boolean(stores.user.currentUser?.id),
            userId: stores.user.currentUser?.id ?? null,
            displayName: stores.user.currentUser?.displayName ?? null,
            clientCount: server.clientCount
        }),
        requestRestart,
        log
    });

    // --- game state -------------------------------------------------------
    // Per client, keyed by the stable clientId; the Hub's own game state is
    // the OR over them. See server/gameStateRegistry.js for why.
    const registry = createGameStateRegistry();

    /** What every client and the status page get told about the Hub. */
    function hubState() {
        return {
            pipelineConnected: wsState.connected,
            clientCount: server.clientCount,
            gameState: registry.aggregate(),
            clients: registry.snapshot()
        };
    }

    function broadcastHubState() {
        server.broadcast(EventType.HUB_STATE, hubState()).catch(() => {});
    }

    registry.onChange((state) => {
        log(`Game state: ${state.isGameRunning ? 'running' : 'stopped'} (SteamVR ${state.isSteamVRRunning})`);
        applyAggregateGameState(state).catch((err) => log('Failed to apply game state', err));
    });

    /**
     * The Hub runs the same game-state flow a desktop does: it is what opens
     * and closes the session the activity views are built on, and what gates
     * the game log handlers (`location` writes a visit only while the game is
     * running). Then everyone is told what the Hub now believes.
     *
     * @param {{ isGameRunning: boolean, isSteamVRRunning: boolean }} state
     */
    async function applyAggregateGameState(state) {
        await stores.game.updateIsGameRunning(state.isGameRunning, state.isSteamVRRunning);
        if (state.isGameRunning && stores.game.isGameRunning && !stores.location.lastLocation.location) {
            // A Hub restarted mid-session has no idea where the player is.
            // Upstream's own hot-reload recovery rebuilds it from the rows
            // already in the database.
            try {
                await tryLoadPlayerList();
            } catch (err) {
                log('Could not restore the player list from the game log', err);
            }
        }
        await server.broadcast(EventType.GAME_STATE, state);
        broadcastHubState();
    }

    // --- session mirroring ------------------------------------------------
    // Clients keep a local copy of the Hub's VRChat cookies so that when the
    // Hub goes away they can fall back to standalone without a fresh login and
    // a 2FA prompt. Sent to each client as it attaches, and broadcast on
    // change: the cookie jar only moves on login, logout and token refresh.
    let lastSessionFingerprint = null;

    /** @returns {Promise<{ fingerprint: string, session: object }>} */
    async function currentSession() {
        const cookies = await natives.WebApi.GetCookies();
        const userId = stores.user.currentUser?.id ?? null;
        return {
            fingerprint: `${userId}:${cookies?.length ?? 0}:${cookies ?? ''}`,
            session: {
                loggedIn: Boolean(userId),
                userId,
                displayName: stores.user.currentUser?.displayName ?? null,
                cookies
            }
        };
    }

    async function broadcastSessionIfChanged() {
        if (!server.clientCount) {
            return;
        }
        try {
            const { fingerprint, session } = await currentSession();
            if (fingerprint === lastSessionFingerprint) {
                return;
            }
            lastSessionFingerprint = fingerprint;
            await server.broadcast(EventType.SESSION, session);
        } catch (err) {
            log('Failed to broadcast session state', err);
        }
    }

    /**
     * @param {object} client
     */
    async function sendSessionTo(client) {
        try {
            const { fingerprint, session } = await currentSession();
            lastSessionFingerprint = fingerprint;
            await server.sendTo(client, EventType.SESSION, session);
        } catch (err) {
            log('Failed to send session state to a client', err);
        }
    }

    const server = createHubServer({
        port: config.port,
        host: config.host,
        token: config.token,
        tls: config.tls,
        log,
        handleCall,
        describe: () => ({
            hub: HUB_VERSION,
            // Advertises the `admin` frame; the migration tool checks for it.
            admin: true,
            databaseVersion: stores.vrcx.state.databaseVersion ?? 0,
            loggedIn: Boolean(stores.user.currentUser?.id),
            userId: stores.user.currentUser?.id ?? null,
            displayName: stores.user.currentUser?.displayName ?? null,
            // Which HTTP goes through the Hub: `client/remoteInterop.js`.
            endpointDomain: AppDebug.endpointDomain,
            gameState: registry.aggregate(),
            pipelineConnected: wsState.connected
        }),
        onConnect: (client) => {
            registry.attach(client.clientId, client.clientName);
            client.uplinkStats = { gamelog: 0, backlog: 0, ipc: 0, gameState: 0, lastAt: 0 };
            if (stores.user.currentUser?.id) {
                sendSessionTo(client);
            }
            broadcastHubState();
        },
        onUplink: (kind, data, client) => handleUplink(kind, data, client),
        onDisconnect: (client) => {
            registry.detach(client.clientId);
            clientSqliteViews.delete(client.clientId);
            broadcastHubState();
        },
        onAdmin: handleAdmin
    });

    /**
     * Local-machine data from a client. The Hub processes it exactly once,
     * which writes the rows, then echoes it to every client (including the
     * sender) so their in-memory stores update. Clients have derived writes
     * suppressed, so the echo costs nothing in the database.
     *
     * @param {string} kind
     * @param {any} data
     * @param {object} client - the socket it came from
     */
    function handleUplink(kind, data, client) {
        const stats = client.uplinkStats;
        if (stats) {
            stats.lastAt = Date.now();
        }
        try {
            switch (kind) {
                case UplinkKind.GAME_LOG:
                    if (stats) {
                        stats.gamelog += data?.length ?? 0;
                    }
                    for (const line of data ?? []) {
                        stores.gameLog.addGameLogEvent(line);
                    }
                    server.broadcast(EventType.GAMELOG, data);
                    break;

                case UplinkKind.GAME_LOG_BACKLOG:
                    if (stats) {
                        stats.backlog += data?.length ?? 0;
                    }
                    replayGameLogBacklog(Array.isArray(data) ? data : []);
                    server.broadcast(EventType.GAMELOG_BACKLOG, data);
                    break;

                case UplinkKind.IPC:
                    if (stats) {
                        stats.ipc += 1;
                    }
                    stores.vrcx.ipcEvent(data);
                    // `Ping`, `MsgPing` and `Event7List` are processed on the
                    // sender as well as here; echoing them would double that.
                    if (isEchoedIpc(data)) {
                        server.broadcast(EventType.IPC, data);
                    }
                    break;

                case UplinkKind.GAME_STATE:
                    if (stats) {
                        stats.gameState += 1;
                    }
                    registry.report(client.clientId, data, client.clientName);
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

    // The status bar on a mirror shows the *Hub's* pipeline, since the mirror
    // has none of its own.
    const stopPipelineWatch = watch(
        () => wsState.connected,
        (connected) => {
            log(`VRChat pipeline ${connected ? 'connected' : 'disconnected'}`);
            broadcastHubState();
        }
    );

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
            uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
            gameState: registry.aggregate(),
            location: stores.location.lastLocation.location || null,
            clients: server.clientList.map((client) => ({
                clientId: client.clientId,
                name: client.clientName,
                remote: client.remoteLabel,
                connectedAt: client.connectedAt ?? null,
                gameState: registry.snapshot().find((entry) => entry.clientId === client.clientId) ?? null,
                uplink: client.uplinkStats ?? null
            })),
            detached: registry.snapshot().filter((entry) => !entry.attached),
            effectiveSettings: {
                gameLogDisabled: stores.advancedSettings?.gameLogDisabled ?? null,
                autoStateChangeEnabled: stores.generalSettings?.autoStateChangeEnabled ?? null,
                relaunchVRChatAfterCrash: stores.advancedSettings?.relaunchVRChatAfterCrash ?? null,
                logEmptyAvatars: stores.generalSettings?.logEmptyAvatars ?? null
            },
            stats: {
                requests: coalesced.stats,
                transactions: sqliteGate.stats,
                settings: configSync.stats
            }
        })
    });
    await status.start();
    if (config.statusPort) {
        log(`Status page on http://${config.host}:${config.statusPort}/`);
    }

    // --- start collecting -------------------------------------------------
    // Last, so that a client connecting during sign-in already has a socket to
    // connect to and sees the session events as they happen.
    const shutdown = new AbortController();
    if (startRuntime) {
        const databaseReady = await startHubRuntime(stores, {
            log,
            signal: shutdown.signal,
            onRetryControls: (controls) => {
                signInWake = controls.wake;
            },
            // A sign-in that fails with no HTTP status never left the .NET
            // side. Say whether the box can reach VRChat at all, since on a
            // headless machine that is the whole question.
            onSignInFailure: async (err) => {
                if (err?.status && err.status > 0) {
                    return;
                }
                const report = await diagnoseVrchatReachability({ configDir: config.configDir });
                log(report.detail);
                for (const line of report.advice) {
                    log(`  ${line}`);
                }
            }
        });
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
        shutdown.abort();
        clearInterval(sessionTimer);
        stopPipelineWatch();
        setPipelineObserver(null);
        registry.dispose();
        await server.stop();
        await status.stop();
        app.unmount();
        if (!config.dryRun) {
            shutdownNativeBridge({ ...natives, SQLite: nativeSQLite });
        }
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

    return { stop, server, status, stores, config, requestRestart, registry, sqliteGate, configSync };
}
