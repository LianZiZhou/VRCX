/**
 * [hub] Mirror-mode client behaviour against a real Hub.
 *
 * Runs the Hub with `--dry-run` and then puts a client through the same
 * `initMirrorMode` entry point that `plugins/interopApi.js` calls, so the
 * rebinding, the schema gate and the fallback are exercised for real rather
 * than described.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
    getHubConnection,
    hubClientState,
    HubSettingKey,
    initMirrorMode,
    leaveMirrorMode,
    readHubSettings,
    relayGate,
    writeHubSettings
} from '../client/mirrorMode.js';
import { getHubMode, HubMode, setHubMode } from '../shared/mode.js';
import { emitPipelineMessage, setPipelineInjector } from '../shared/pipelineRelay.js';
import { EXPECTED_DATABASE_VERSION } from '../shared/schema.js';
import { guardDatabase } from '../client/databaseGuard.js';
import { runHub } from '../server/runHub.js';
import { lastReportedGameState, uplinkQueueDepth, uplinkStats } from '../client/uplink.js';

/**
 * The Hub's own data core runs in this process too and watches the real
 * `watchState`, so "friends loaded" is faked through the seam rather than
 * by flipping the flag the Hub would react to.
 */
let friendsLoaded = false;

/**
 * A stand-in for the local VRCXStorage binding (VRCX.json).
 */
function createFakeStorage(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
        map,
        async Get(key) {
            return map.get(key) ?? '';
        },
        async Set(key, value) {
            map.set(key, value);
        },
        async Save() {}
    };
}

function createFakeLocalWebApi() {
    const calls = [];
    return {
        calls,
        async SetCookies(value) {
            calls.push(['SetCookies', value]);
        },
        async ExecuteJson() {
            return JSON.stringify({ status: 200, message: '{}' });
        }
    };
}

describe('mirror mode', () => {
    let dataDir;
    let hub;
    let url;
    let token;
    const savedGlobals = {};

    beforeAll(async () => {
        dataDir = mkdtempSync(join(tmpdir(), 'vrcx-mirror-test-'));
        hub = await runHub({
            argv: [`--config=${dataDir}`, '--dry-run', '--port=0', '--status-port=0'],
            startRuntime: false,
            installSignalHandlers: false
        });
        url = `ws://127.0.0.1:${hub.server.address.port}`;
        token = hub.config.token;
        savedGlobals.SQLite = globalThis.SQLite;
        savedGlobals.WebApi = globalThis.WebApi;
        relayGate.isFriendsLoaded = () => friendsLoaded;
    }, 60000);

    afterEach(() => {
        leaveMirrorMode({ reload: false });
        setHubMode(HubMode.HUB);
        globalThis.SQLite = savedGlobals.SQLite;
        globalThis.WebApi = savedGlobals.WebApi;
        friendsLoaded = false;
        delete globalThis.$pinia;
    });

    afterAll(async () => {
        await hub?.stop();
        setHubMode(HubMode.STANDALONE);
        rmSync(dataDir, { recursive: true, force: true });
    });

    describe('settings', () => {
        it('round-trips through VRCXStorage rather than the configs table', async () => {
            // They have to live here: the configs table is read through SQLite,
            // which is the very thing these settings decide how to bind.
            const storage = createFakeStorage();
            await writeHubSettings(storage, { enabled: true, url, token });

            expect(storage.map.get(HubSettingKey.ENABLED)).toBe('true');
            await expect(readHubSettings(storage)).resolves.toEqual({ enabled: true, url, token });
        });

        it('reads as disabled when nothing is configured', async () => {
            await expect(readHubSettings(createFakeStorage())).resolves.toEqual({
                enabled: false,
                url: '',
                token: ''
            });
        });
    });

    describe('attaching', () => {
        it('stays standalone when no Hub is configured', async () => {
            const result = await initMirrorMode({
                storage: createFakeStorage(),
                localWebApi: createFakeLocalWebApi(),
                clientDatabaseVersion: EXPECTED_DATABASE_VERSION
            });

            expect(result).toBeNull();
            expect(getHubMode()).not.toBe(HubMode.MIRROR);
        });

        it('stays standalone when the Hub is unreachable', async () => {
            const storage = createFakeStorage({
                [HubSettingKey.ENABLED]: 'true',
                // Nothing is listening here.
                [HubSettingKey.URL]: 'ws://127.0.0.1:1',
                [HubSettingKey.TOKEN]: token
            });

            const result = await initMirrorMode({
                storage,
                localWebApi: createFakeLocalWebApi(),
                clientDatabaseVersion: EXPECTED_DATABASE_VERSION
            });

            expect(result).toBeNull();
            expect(getHubMode()).not.toBe(HubMode.MIRROR);
        }, 20000);

        it('refuses to attach to a Hub on a different schema', async () => {
            const storage = createFakeStorage({
                [HubSettingKey.ENABLED]: 'true',
                [HubSettingKey.URL]: url,
                [HubSettingKey.TOKEN]: token
            });

            const result = await initMirrorMode({
                storage,
                localWebApi: createFakeLocalWebApi(),
                // Pretend this client is a version ahead.
                clientDatabaseVersion: EXPECTED_DATABASE_VERSION + 1
            });

            expect(result).toBeNull();
            expect(getHubMode()).not.toBe(HubMode.MIRROR);
            expect(hubClientState.lastError?.name).toBe('HubSchemaMismatchError');
        });

        it('rebinds SQLite and WebApi, and leaves the local bindings alone', async () => {
            const localWebApi = createFakeLocalWebApi();
            const localSQLite = globalThis.SQLite;
            const storage = createFakeStorage({
                [HubSettingKey.ENABLED]: 'true',
                [HubSettingKey.URL]: url,
                [HubSettingKey.TOKEN]: token
            });

            const result = await initMirrorMode({
                storage,
                localWebApi,
                clientDatabaseVersion: EXPECTED_DATABASE_VERSION
            });

            expect(result).not.toBeNull();
            expect(getHubMode()).toBe(HubMode.MIRROR);
            expect(hubClientState.active).toBe(true);
            expect(globalThis.SQLite).not.toBe(localSQLite);

            // A query now travels to the Hub and back.
            await expect(globalThis.SQLite.Execute('SELECT 1', null)).resolves.toEqual([]);
        });
    });

    describe('once attached', () => {
        beforeEach(async () => {
            await initMirrorMode({
                storage: createFakeStorage({
                    [HubSettingKey.ENABLED]: 'true',
                    [HubSettingKey.URL]: url,
                    [HubSettingKey.TOKEN]: token
                }),
                localWebApi: createFakeLocalWebApi(),
                clientDatabaseVersion: EXPECTED_DATABASE_VERSION
            });
        });

        it('feeds relayed pipeline messages into the local handler once friends are loaded', async () => {
            const seen = [];
            setPipelineInjector((args) => seen.push(args));

            const message = JSON.stringify({
                type: 'friend-online',
                content: JSON.stringify({ userId: 'usr_relay' })
            });
            // Upstream opens its socket only after the friends list is
            // loaded; until then the REST snapshot at login is the truth and
            // a relayed event would only move it backwards.
            const droppedBefore = hubClientState.stats.pipelineDroppedBeforeFriends;
            emitPipelineMessage(message);
            await vi.waitFor(() => expect(hubClientState.stats.pipelineDroppedBeforeFriends).toBe(droppedBefore + 1));
            expect(seen).toHaveLength(0);

            friendsLoaded = true;
            emitPipelineMessage(message);
            await vi.waitFor(() => expect(seen).toHaveLength(1));
            // Parsed exactly as a direct socket would have, including the
            // second parse of `content`.
            expect(seen[0].json.type).toBe('friend-online');
            expect(seen[0].json.content).toEqual({ userId: 'usr_relay' });
            expect(hubClientState.stats.pipelineByType['friend-online']).toBeGreaterThanOrEqual(1);
            setPipelineInjector(null);
        });

        it("holds the Hub's echoes until the stores exist, then replays them in order", async () => {
            const lines = [];
            const ipc = [];
            await hub.server.broadcast('gamelog', ['["a"]']);
            await hub.server.broadcast('ipc', '{"type":"OnEvent"}');
            await hub.server.broadcast('gamelog', ['["b"]']);
            await vi.waitFor(() => expect(hubClientState.stats.bootBuffered).toBeGreaterThanOrEqual(3));

            globalThis.$pinia = {
                gameLog: { addGameLogEvent: (line) => lines.push(line) },
                vrcx: { ipcEvent: (json) => ipc.push(json) },
                game: { isGameRunning: false, isSteamVRRunning: false }
            };
            await vi.waitFor(() => expect(lines).toEqual(['["a"]', '["b"]']));
            expect(ipc).toEqual(['{"type":"OnEvent"}']);

            // Once the stores exist, echoes go straight through.
            await hub.server.broadcast('gamelog', ['["c"]']);
            await vi.waitFor(() => expect(lines).toEqual(['["a"]', '["b"]', '["c"]']));
        });

        it("records the Hub's game state without applying it to this machine", async () => {
            let applied = 0;
            globalThis.$pinia = {
                gameLog: { addGameLogEvent() {} },
                vrcx: { ipcEvent() {} },
                game: {
                    isGameRunning: false,
                    isSteamVRRunning: false,
                    updateIsGameRunning: () => applied++
                }
            };
            await hub.server.broadcast('game-state', { isGameRunning: true, isSteamVRRunning: true });
            await vi.waitFor(() =>
                expect(hubClientState.hubGameState).toEqual({ isGameRunning: true, isSteamVRRunning: true })
            );
            expect(applied).toBe(0);
            expect(globalThis.$pinia.game.isGameRunning).toBe(false);
        });

        it("shows the Hub's pipeline as its own", async () => {
            const { wsState } = await import('../../services/websocket.js');
            await vi.waitFor(() => expect(hubClientState.hub).not.toBeNull());
            await hub.server.broadcast('hub-state', { pipelineConnected: true, clientCount: 1, gameState: null });
            await vi.waitFor(() => expect(hubClientState.pipelineConnected).toBe(true));
            await vi.waitFor(() => expect(wsState.connected).toBe(true));
            await hub.server.broadcast('hub-state', { pipelineConnected: false, clientCount: 1, gameState: null });
            await vi.waitFor(() => expect(wsState.connected).toBe(false));
        });

        it('re-announces game state and resyncs after the link comes back', async () => {
            const refreshed = [];
            globalThis.$pinia = {
                gameLog: { addGameLogEvent() {} },
                vrcx: { ipcEvent() {} },
                game: { isGameRunning: true, isSteamVRRunning: false },
                notification: { refreshNotifications: () => refreshed.push('notifications') },
                friend: { isRefreshFriendsLoading: false, refreshFriends: () => refreshed.push('friends') }
            };
            friendsLoaded = true;

            const reported = [];
            const original = hub.registry.report;
            hub.registry.report = (...args) => {
                reported.push(args[1]);
                return original.apply(hub.registry, args);
            };
            try {
                const connection = getHubConnection();
                const reconnectsBefore = hubClientState.reconnects;
                // Drop the socket from the Hub's side; the client reconnects on its own.
                for (const socket of hub.server.clientList) {
                    socket.terminate();
                }
                await vi.waitFor(() => expect(hubClientState.reconnects).toBe(reconnectsBefore + 1), {
                    timeout: 10000
                });
                expect(connection.state).toBe('ready');
                await vi.waitFor(() =>
                    expect(reported.at(-1)).toEqual({ isGameRunning: true, isSteamVRRunning: false })
                );
                expect(refreshed).toEqual(['notifications', 'friends']);
                expect(lastReportedGameState()).toEqual({ isGameRunning: true, isSteamVRRunning: false });
                expect(uplinkQueueDepth()).toEqual({ lines: 0, ipc: 0, backlog: 0 });
                expect(uplinkStats.flushes).toBeGreaterThanOrEqual(2);
            } finally {
                hub.registry.report = original;
            }
        }, 15000);

        it('suppresses derived writes but lets user writes through', async () => {
            const written = [];
            const guarded = guardDatabase({
                async addGPSToDatabase(row) {
                    written.push(['derived', row]);
                },
                async setUserMemo(memo) {
                    written.push(['user', memo]);
                }
            });

            await guarded.addGPSToDatabase({ id: 1 });
            await guarded.setUserMemo('note');

            expect(written).toEqual([['user', 'note']]);
        });

        it('exposes the connection so the UI can report Hub identity', () => {
            expect(getHubConnection()).not.toBeNull();
            expect(hubClientState.hub.databaseVersion).toBe(EXPECTED_DATABASE_VERSION);
        });

        it('returns to standalone when detached', () => {
            leaveMirrorMode({ reload: false });
            expect(getHubMode()).toBe(HubMode.STANDALONE);
            expect(hubClientState.active).toBe(false);
            expect(getHubConnection()).toBeNull();
        });
    });
});
