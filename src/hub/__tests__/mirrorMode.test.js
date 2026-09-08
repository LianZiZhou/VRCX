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
    writeHubSettings
} from '../client/mirrorMode.js';
import { getHubMode, HubMode, setHubMode } from '../shared/mode.js';
import { emitPipelineMessage, setPipelineInjector } from '../shared/pipelineRelay.js';
import { EXPECTED_DATABASE_VERSION } from '../shared/schema.js';
import { guardDatabase } from '../client/databaseGuard.js';
import { runHub } from '../server/runHub.js';

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
    }, 60000);

    afterEach(() => {
        leaveMirrorMode({ reload: false });
        setHubMode(HubMode.HUB);
        globalThis.SQLite = savedGlobals.SQLite;
        globalThis.WebApi = savedGlobals.WebApi;
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

        it('feeds relayed pipeline messages into the local handler', async () => {
            const seen = [];
            setPipelineInjector((args) => seen.push(args));

            const message = JSON.stringify({
                type: 'friend-online',
                content: JSON.stringify({ userId: 'usr_relay' })
            });
            emitPipelineMessage(message);

            await vi.waitFor(() => expect(seen).toHaveLength(1));
            // Parsed exactly as a direct socket would have, including the
            // second parse of `content`.
            expect(seen[0].json.type).toBe('friend-online');
            expect(seen[0].json.content).toEqual({ userId: 'usr_relay' });
            setPipelineInjector(null);
        });

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
