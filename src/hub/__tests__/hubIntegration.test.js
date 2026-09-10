/**
 * [hub] End-to-end: a real Hub process object, a real encrypted socket, and a
 * real mirror-side connection.
 *
 * This is the test that exercises the pieces in the arrangement they will
 * actually run in — the data core booted headlessly, the transport sealed, the
 * pipeline relayed and local data uplinked — rather than any one of them in
 * isolation.
 *
 * It runs the Hub with `--dry-run`, so the .NET bridge is replaced by the
 * in-memory stubs and no real database or VRChat session is touched.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createHubConnection } from '../client/connection.js';
import { emitPipelineMessage } from '../shared/pipelineRelay.js';
import { EventType } from '../shared/protocol.js';
import { getHubMode, HubMode, setHubMode } from '../shared/mode.js';
import { runHub } from '../server/runHub.js';

describe('hub end to end', () => {
    let dataDir;
    let hub;
    let url;
    let token;
    const clients = [];

    beforeAll(async () => {
        dataDir = mkdtempSync(join(tmpdir(), 'vrcx-hub-test-'));
        hub = await runHub({
            argv: [`--config=${dataDir}`, '--dry-run', '--port=0', '--status-port=0'],
            startRuntime: false,
            installSignalHandlers: false
        });
        url = `ws://127.0.0.1:${hub.server.address.port}`;
        token = hub.config.token;
    }, 60000);

    afterAll(async () => {
        for (const client of clients) {
            client.close();
        }
        await hub?.stop();
        setHubMode(HubMode.STANDALONE);
        rmSync(dataDir, { recursive: true, force: true });
    });

    /**
     * @param {object} [options]
     */
    async function connectClient(options = {}) {
        const client = createHubConnection({
            url,
            token,
            autoReconnect: false,
            ...options
        });
        clients.push(client);
        await client.connect();
        return client;
    }

    it('generates and persists a token on first run', () => {
        expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
        expect(readFileSync(join(dataDir, 'hub-token'), 'utf8').trim()).toBe(token);
    });

    it('runs the data core in hub mode', () => {
        expect(getHubMode()).toBe(HubMode.HUB);
        expect(Object.keys(hub.stores).length).toBeGreaterThanOrEqual(40);
    });

    it('reports its identity and schema version to a connecting client', async () => {
        const client = await connectClient();
        expect(client.info.databaseVersion).toBeTypeOf('number');
        expect(client.info.loggedIn).toBe(false);
        expect(hub.server.clientCount).toBeGreaterThanOrEqual(1);
    });

    it('serves interop calls over the encrypted channel', async () => {
        const client = await connectClient();
        // The dry-run SQLite stub answers every query with an empty result set.
        await expect(client.call('SQLite', 'Execute', ['SELECT 1', null])).resolves.toEqual([]);
        await expect(client.call('SQLite', 'ExecuteNonQuery', ['CREATE TABLE t (a)', null])).resolves.toBe(0);
    });

    it('still refuses calls outside the allowlist', async () => {
        const client = await connectClient();
        await expect(client.call('VRCXStorage', 'Get', ['VRCX_ProxyServer'])).rejects.toThrow(/not allowed/i);
    });

    it('relays pipeline messages to every connected client', async () => {
        const received = [];
        const collect = (event, data) => {
            if (event === EventType.PIPELINE) {
                received.push(data);
            }
        };
        await connectClient({ onEvent: collect });
        await connectClient({ onEvent: collect });

        const message = JSON.stringify({
            type: 'friend-online',
            content: JSON.stringify({ userId: 'usr_test' })
        });
        // Stand in for the Hub's own pipeline socket receiving a message.
        emitPipelineMessage(message);

        await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(2));
        expect(received[0]).toBe(message);
    });

    it('accepts uplinked game log lines and echoes them to all clients', async () => {
        const received = [];
        await connectClient({
            onEvent: (event, data) => {
                if (event === EventType.GAMELOG) {
                    received.push(data);
                }
            }
        });
        const sender = await connectClient();

        // An `event` line: it writes a gamelog row without triggering the
        // user/world lookups that a player-joined would, keeping this test
        // about the relay rather than about the API stub.
        const line = JSON.stringify([
            'output_log_2026-01-01.txt',
            '2026-01-01 12:00:00',
            'event',
            'Portal to world created'
        ]);
        await sender.uplink('gamelog-raw', [line]);

        await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(1));
        expect(received[0]).toEqual([line]);
    });

    it('tells a client the Hub state as it attaches', async () => {
        const client = await connectClient();
        expect(client.info.gameState).toEqual({ isGameRunning: false, isSteamVRRunning: false });
        expect(client.info.pipelineConnected).toBe(false);
        expect(client.info.endpointDomain).toMatch(/^https:\/\//);
        expect(client.info.protocol).toBe(2);
    });

    it('derives its game state from every client, and keeps it through a grace period', async () => {
        const received = [];
        await connectClient({
            onEvent: (event, data) => {
                if (event === EventType.GAME_STATE) {
                    received.push(data);
                }
            }
        });
        // Every connection in this process shares one clientId, so the
        // second machine is simulated by reporting under another id.
        const desk = await connectClient();
        desk.uplink('game-state', { isGameRunning: true, isSteamVRRunning: false });

        await vi.waitFor(() => expect(received).toHaveLength(1));
        expect(received[0]).toEqual({ isGameRunning: true, isSteamVRRunning: false });
        // The Hub runs the flow itself: it owns the session and gates the
        // game log handlers on this.
        await vi.waitFor(() => expect(hub.stores.game.isGameRunning).toBe(true));

        // A machine that is not running the game does not end the session.
        hub.registry.report('another-machine', { isGameRunning: false, isSteamVRRunning: false }, 'laptop');
        expect(hub.registry.aggregate()).toEqual({ isGameRunning: true, isSteamVRRunning: false });
        expect(received).toHaveLength(1);

        // Nor does the gaming machine's link dropping, until the grace period runs out.
        desk.close();
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(hub.stores.game.isGameRunning).toBe(true);
        expect(hub.registry.snapshot().find((entry) => entry.clientId === desk.clientId)?.attached).toBe(false);

        // Reporting stopped ends it at once.
        hub.registry.report(desk.clientId, { isGameRunning: false, isSteamVRRunning: false });
        await vi.waitFor(() => expect(received).toHaveLength(2));
        expect(received[1]).toEqual({ isGameRunning: false, isSteamVRRunning: false });
        await vi.waitFor(() => expect(hub.stores.game.isGameRunning).toBe(false));
    });

    it('broadcasts Hub state when a client attaches or the pipeline changes', async () => {
        const received = [];
        await connectClient({
            onEvent: (event, data) => {
                if (event === EventType.HUB_STATE) {
                    received.push(data);
                }
            }
        });
        await connectClient();
        await vi.waitFor(() => expect(received.at(-1)?.clientCount).toBe(hub.server.clientCount));
        expect(received.at(-1).gameState).toEqual(hub.registry.aggregate());

        const { wsState } = await import('../../services/websocket.js');
        const before = received.length;
        wsState.connected = true;
        await vi.waitFor(() => expect(received.length).toBeGreaterThan(before));
        expect(received.at(-1).pipelineConnected).toBe(true);
        wsState.connected = false;
    });

    it('processes a start-up backlog with its own location tracking and echoes it', async () => {
        const received = [];
        await connectClient({
            onEvent: (event, data) => {
                if (event === EventType.GAMELOG_BACKLOG) {
                    received.push(data);
                }
            }
        });
        const sender = await connectClient();
        const entries = [
            { dt: '2026-01-01T12:00:00.000Z', type: 'event', event: 'first' },
            { dt: '2026-01-01T12:00:01.000Z', type: 'event', event: 'second' }
        ];
        sender.uplink('gamelog-backlog', entries);
        await vi.waitFor(() => expect(received).toHaveLength(1));
        expect(received[0]).toEqual(entries);
    });

    it('echoes Photon data but not the packets the sender also handles itself', async () => {
        const received = [];
        await connectClient({
            onEvent: (event, data) => {
                if (event === EventType.IPC) {
                    received.push(data);
                }
            }
        });
        const sender = await connectClient();
        sender.uplink('ipc', JSON.stringify({ type: 'Ping' }));
        sender.uplink('ipc', JSON.stringify({ type: 'VRCEvent', dt: '2026-01-01T12:00:00.000Z' }));
        await vi.waitFor(() => expect(received).toHaveLength(1));
        expect(JSON.parse(received[0]).type).toBe('VRCEvent');
    });

    it('applies a setting a client changed without a restart', async () => {
        const client = await connectClient();
        expect(hub.stores.generalSettings.logEmptyAvatars).toBe(false);
        // The dry-run SQLite stub answers every read with nothing, so the
        // sync re-reads the default; what matters is that the write was
        // noticed and the store touched.
        hub.stores.generalSettings.logEmptyAvatars = true;
        await client.call('SQLite', 'ExecuteNonQuery', [
            'INSERT OR REPLACE INTO configs (key, value) VALUES (@key, @value)',
            { '@key': 'config:vrcx_logemptyavatars', '@value': 'false' }
        ]);
        await vi.waitFor(() => expect(hub.stores.generalSettings.logEmptyAvatars).toBe(false));
        expect(hub.configSync.stats.applied).toBeGreaterThanOrEqual(1);
    });

    it('serialises client transactions on the one connection', async () => {
        const a = await connectClient();
        await a.call('SQLite', 'ExecuteNonQuery', ['BEGIN', null]);
        expect(hub.sqliteGate.holder).toBe(a.clientId);
        await a.call('SQLite', 'ExecuteNonQuery', ['COMMIT', null]);
        expect(hub.sqliteGate.holder).toBeNull();
        expect(hub.sqliteGate.stats.leases).toBeGreaterThanOrEqual(1);
    });

    it('rejects a client with the wrong token', async () => {
        const bad = createHubConnection({
            url,
            token: 'not-the-right-token-at-all',
            autoReconnect: false
        });
        clients.push(bad);
        await expect(bad.connect()).rejects.toThrow(/rejected the connection/i);
    });
});
