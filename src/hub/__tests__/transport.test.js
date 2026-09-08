/**
 * [hub] End-to-end transport test over a real localhost socket.
 *
 * The loopback test in `remoteInterop.test.js` covers framing and shape
 * adaptation without a socket. This one runs the actual `ws` server and a real
 * `WebSocket` client so that handshake, auth, call correlation, broadcast and
 * teardown are exercised for real.
 */

import { createHubConnection, ConnectionState, HubRejectedError } from '../client/connection.js';
import { createHubServer } from '../server/wsServer.js';
import { createInteropHandler } from '../server/interopHandler.js';
import { EventType, PROTOCOL_VERSION, RejectReason } from '../shared/protocol.js';
import { withRequestCoalescing } from '../server/requestCoalescer.js';

const TOKEN = 'test-token-0123456789';

function createNatives(overrides = {}) {
    return {
        SQLite: {
            async ExecuteJson() {
                return JSON.stringify([['row', 1]]);
            },
            async ExecuteNonQuery() {
                return 3;
            },
            ...overrides.SQLite
        },
        WebApi: {
            async ExecuteJson() {
                return JSON.stringify({ status: 200, message: '{}' });
            },
            async GetCookies() {
                return 'cookie-blob';
            },
            ...overrides.WebApi
        }
    };
}

/**
 * Starts a Hub server on an ephemeral port.
 */
async function startServer(options = {}) {
    const server = createHubServer({
        port: 0,
        host: '127.0.0.1',
        token: TOKEN,
        handleCall: createInteropHandler(createNatives()),
        describe: () => ({ databaseVersion: 17, hub: 'test-hub' }),
        ...options
    });
    await server.start();
    return { server, url: `ws://127.0.0.1:${server.address.port}` };
}

describe('hub transport over a real socket', () => {
    let server;
    let url;
    let client;

    beforeEach(async () => {
        ({ server, url } = await startServer());
    });

    afterEach(async () => {
        client?.close();
        client = null;
        await server.stop();
    });

    it('completes the handshake and reports Hub identity', async () => {
        client = createHubConnection({ url, token: TOKEN, autoReconnect: false });
        const welcome = await client.connect();

        expect(welcome.protocol).toBe(PROTOCOL_VERSION);
        expect(welcome.databaseVersion).toBe(17);
        expect(client.state).toBe(ConnectionState.READY);
        expect(server.clientCount).toBe(1);
    });

    it('round-trips an interop call', async () => {
        client = createHubConnection({ url, token: TOKEN, autoReconnect: false });
        await client.connect();

        await expect(client.call('SQLite', 'Execute', ['SELECT 1', null])).resolves.toEqual([['row', 1]]);
        await expect(client.call('SQLite', 'ExecuteNonQuery', ['DELETE FROM t', null])).resolves.toBe(3);
    });

    it('propagates a server-side error as a rejected call', async () => {
        client = createHubConnection({ url, token: TOKEN, autoReconnect: false });
        await client.connect();

        await expect(client.call('AppApi', 'StartGame', [])).rejects.toThrow(/not allowed/i);
    });

    it('refuses a bad token', async () => {
        client = createHubConnection({ url, token: 'wrong-token-value', autoReconnect: false });

        await expect(client.connect()).rejects.toBeInstanceOf(HubRejectedError);
        expect(client.state).toBe(ConnectionState.REJECTED);
        expect(server.clientCount).toBe(0);
    });

    it('refuses a protocol version mismatch', async () => {
        // Talk to the server by hand so we can send a wrong version.
        const raw = new WebSocket(url);
        const rejection = await new Promise((resolve) => {
            raw.onopen = () => {
                raw.send(
                    JSON.stringify({
                        t: 'hello',
                        p: { token: TOKEN, protocol: PROTOCOL_VERSION + 99, client: 'x' }
                    })
                );
            };
            raw.onmessage = (message) => resolve(JSON.parse(message.data));
        });
        raw.close();

        expect(rejection.t).toBe('reject');
        expect(rejection.p.reason).toBe(RejectReason.PROTOCOL_MISMATCH);
    });

    it('rejects any frame sent before the handshake', async () => {
        const raw = new WebSocket(url);
        const rejection = await new Promise((resolve) => {
            raw.onopen = () => {
                raw.send(JSON.stringify({ i: 1, t: 'call', p: { c: 'SQLite', m: 'Execute', a: [] } }));
            };
            raw.onmessage = (message) => resolve(JSON.parse(message.data));
        });
        raw.close();

        expect(rejection.t).toBe('reject');
        expect(rejection.p.reason).toBe(RejectReason.BAD_TOKEN);
    });

    it('broadcasts events to every connected client', async () => {
        const received = [];
        client = createHubConnection({
            url,
            token: TOKEN,
            autoReconnect: false,
            onEvent: (event, data) => received.push({ event, data })
        });
        await client.connect();

        const second = createHubConnection({
            url,
            token: TOKEN,
            autoReconnect: false,
            onEvent: (event, data) => received.push({ event, data })
        });
        await second.connect();
        expect(server.clientCount).toBe(2);

        server.broadcast(EventType.PIPELINE, { type: 'friend-online' });
        await vi.waitFor(() => expect(received).toHaveLength(2));

        expect(received[0].event).toBe(EventType.PIPELINE);
        expect(received[0].data).toEqual({ type: 'friend-online' });
        second.close();
    });

    it('delivers uplinked client data to the Hub', async () => {
        await server.stop();
        const seen = [];
        ({ server, url } = await startServer({
            onUplink: (kind, data) => seen.push({ kind, data })
        }));

        client = createHubConnection({ url, token: TOKEN, autoReconnect: false });
        await client.connect();
        client.uplink('gamelog-raw', ['2026-01-01', 'player-joined', 'alice']);

        await vi.waitFor(() => expect(seen).toHaveLength(1));
        expect(seen[0].kind).toBe('gamelog-raw');
        expect(seen[0].data).toEqual(['2026-01-01', 'player-joined', 'alice']);
    });

    it('fails in-flight calls when the connection drops', async () => {
        await server.stop();
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        ({ server, url } = await startServer({
            handleCall: async () => {
                await gate;
                return [];
            }
        }));

        client = createHubConnection({ url, token: TOKEN, autoReconnect: false });
        await client.connect();

        const inFlight = client.call('SQLite', 'Execute', ['SELECT 1', null]);
        client.close();

        await expect(inFlight).rejects.toThrow(/closed/i);
        release();
    });

    it('refuses to start without a token', () => {
        expect(() => createHubServer({ port: 0, token: '', handleCall: async () => null })).toThrow(
            /token is required/i
        );
    });
});

describe('cross-client GET coalescing', () => {
    it('shares one upstream request between concurrent identical GETs', async () => {
        let upstreamCalls = 0;
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });

        const handler = withRequestCoalescing(async () => {
            upstreamCalls++;
            await gate;
            return { status: 200, message: '{}' };
        });

        const options = { url: 'https://api.vrchat.cloud/api/1/groups/grp_1', method: 'GET' };
        const a = handler('WebApi', 'Execute', [options]);
        const b = handler('WebApi', 'Execute', [options]);
        const c = handler('WebApi', 'Execute', [options]);
        release();
        await Promise.all([a, b, c]);

        expect(upstreamCalls).toBe(1);
        expect(handler.stats.coalesced).toBe(2);
    });

    it('never shares auth requests', async () => {
        let upstreamCalls = 0;
        const handler = withRequestCoalescing(async () => {
            upstreamCalls++;
            return { status: 200, message: '{}' };
        });

        const options = { url: 'https://api.vrchat.cloud/api/1/auth/user', method: 'GET' };
        await Promise.all([handler('WebApi', 'Execute', [options]), handler('WebApi', 'Execute', [options])]);

        expect(upstreamCalls).toBe(2);
    });

    it('never coalesces writes', async () => {
        let upstreamCalls = 0;
        const handler = withRequestCoalescing(async () => {
            upstreamCalls++;
            return { status: 200, message: '{}' };
        });

        const options = { url: 'https://api.vrchat.cloud/api/1/user/usr_1', method: 'PUT' };
        await Promise.all([handler('WebApi', 'Execute', [options]), handler('WebApi', 'Execute', [options])]);

        expect(upstreamCalls).toBe(2);
    });
});
