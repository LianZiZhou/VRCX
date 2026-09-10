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
import { buildAuthProof, createOpener, createSealer, deriveChannelKeys, randomNonce } from '../shared/secureChannel.js';
import { coalescingKey, withRequestCoalescing } from '../server/requestCoalescer.js';

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
                        p: {
                            protocol: PROTOCOL_VERSION + 99,
                            client: 'x',
                            clientNonce: randomNonce(),
                            clientId: randomNonce()
                        }
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
        expect(rejection.p.reason).toBe(RejectReason.BAD_HANDSHAKE);
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

    it('encrypts everything after the handshake', async () => {
        // Drive the handshake by hand so we can inspect the raw wire bytes.
        const raw = new WebSocket(url);
        raw.binaryType = 'arraybuffer';
        const clientNonce = randomNonce();
        const frames = [];

        const serverNonce = await new Promise((resolve) => {
            raw.onopen = () => {
                raw.send(
                    JSON.stringify({
                        t: 'hello',
                        p: { protocol: PROTOCOL_VERSION, client: 'probe', clientNonce, clientId: randomNonce() }
                    })
                );
            };
            raw.onmessage = (message) => {
                frames.push(message.data);
                resolve(JSON.parse(message.data).p.serverNonce);
            };
        });

        const keys = await deriveChannelKeys(TOKEN, clientNonce, serverNonce);
        const sealed = await new Promise((resolve) => {
            raw.onmessage = (message) => resolve(message.data);
            createSealer(keys.clientToServer)
                .seal({ t: 'auth', p: buildAuthProof(clientNonce, serverNonce) })
                .then((bytes) => raw.send(bytes));
        });

        // The welcome frame is binary, and its plaintext is nowhere in it.
        expect(sealed).toBeInstanceOf(ArrayBuffer);
        const asText = new TextDecoder().decode(new Uint8Array(sealed));
        expect(asText).not.toContain('databaseVersion');
        expect(asText).not.toContain('test-hub');

        // It does decrypt with the right key.
        const welcome = await createOpener(keys.serverToClient).open(sealed);
        expect(welcome.t).toBe('welcome');
        expect(welcome.p.databaseVersion).toBe(17);
        raw.close();
    });

    it('drops a client that sends plaintext on an established channel', async () => {
        client = createHubConnection({ url, token: TOKEN, autoReconnect: false });
        await client.connect();
        expect(server.clientCount).toBe(1);

        // Reach past the connection wrapper to inject an unencrypted frame.
        const raw = new WebSocket(url);
        raw.binaryType = 'arraybuffer';
        const clientNonce = randomNonce();
        const serverNonce = await new Promise((resolve) => {
            raw.onopen = () => {
                raw.send(
                    JSON.stringify({
                        t: 'hello',
                        p: { protocol: PROTOCOL_VERSION, client: 'probe', clientNonce, clientId: randomNonce() }
                    })
                );
            };
            raw.onmessage = (message) => resolve(JSON.parse(message.data).p.serverNonce);
        });
        const keys = await deriveChannelKeys(TOKEN, clientNonce, serverNonce);
        await new Promise((resolve) => {
            raw.onmessage = () => resolve();
            createSealer(keys.clientToServer)
                .seal({ t: 'auth', p: buildAuthProof(clientNonce, serverNonce) })
                .then((bytes) => raw.send(bytes));
        });
        await vi.waitFor(() => expect(server.clientCount).toBe(2));

        const closed = new Promise((resolve) => {
            raw.onclose = resolve;
        });
        raw.send(JSON.stringify({ i: 1, t: 'call', p: { c: 'SQLite', m: 'Execute', a: [] } }));
        await closed;
        await vi.waitFor(() => expect(server.clientCount).toBe(1));
    });

    it('refuses to start without a token', () => {
        expect(() => createHubServer({ port: 0, token: '', handleCall: async () => null })).toThrow(
            /token is required/i
        );
    });

    it('identifies the client by a stable id and tells the Hub when it is welcomed', async () => {
        await server.stop();
        const connected = [];
        ({ server, url } = await startServer({
            onConnect: (socket) => connected.push({ clientId: socket.clientId, name: socket.clientName })
        }));

        client = createHubConnection({ url, token: TOKEN, clientName: 'desk', autoReconnect: false });
        await client.connect();

        await vi.waitFor(() => expect(connected).toHaveLength(1));
        expect(connected[0]).toEqual({ clientId: client.clientId, name: 'desk' });
        expect(client.clientId).toMatch(/^[0-9a-f]{32}$/);

        // The same process reconnecting presents the same id.
        const again = createHubConnection({ url, token: TOKEN, autoReconnect: false });
        await again.connect();
        expect(again.clientId).toBe(client.clientId);
        again.close();
    });

    it('refuses a hello without a client id', async () => {
        const raw = new WebSocket(url);
        const rejection = await new Promise((resolve) => {
            raw.onopen = () => {
                raw.send(
                    JSON.stringify({
                        t: 'hello',
                        p: { protocol: PROTOCOL_VERSION, client: 'old', clientNonce: randomNonce() }
                    })
                );
            };
            raw.onmessage = (message) => resolve(JSON.parse(message.data));
        });
        raw.close();

        expect(rejection.t).toBe('reject');
        expect(rejection.p.reason).toBe(RejectReason.BAD_HANDSHAKE);
    });

    it('can address one client rather than all of them', async () => {
        const received = [];
        client = createHubConnection({
            url,
            token: TOKEN,
            autoReconnect: false,
            onEvent: (event, data) => received.push({ who: 'first', event, data })
        });
        await client.connect();
        const second = createHubConnection({
            url,
            token: TOKEN,
            autoReconnect: false,
            onEvent: (event, data) => received.push({ who: 'second', event, data })
        });
        await second.connect();

        const target = server.clientList.find((socket) => socket !== server.clientList[0]);
        await server.sendTo(target, EventType.SESSION, { cookies: 'x' });
        await server.broadcast(EventType.HUB_STATE, { clientCount: 2 });

        await vi.waitFor(() => expect(received.filter((r) => r.event === EventType.HUB_STATE)).toHaveLength(2));
        const sessions = received.filter((r) => r.event === EventType.SESSION);
        expect(sessions).toHaveLength(1);
        second.close();
    });

    it('hands the calling client to the call handler', async () => {
        await server.stop();
        const seen = [];
        ({ server, url } = await startServer({
            handleCall: async (c, m, a, socket) => {
                seen.push(socket?.clientId);
                return [];
            }
        }));
        client = createHubConnection({ url, token: TOKEN, autoReconnect: false });
        await client.connect();
        await client.call('SQLite', 'Execute', ['SELECT 1', null]);
        expect(seen).toEqual([client.clientId]);
    });

    it('answers synchronously whether an uplink frame went out', async () => {
        client = createHubConnection({ url, token: TOKEN, autoReconnect: false });
        expect(client.uplink('gamelog-raw', ['x'])).toBe(false);
        await client.connect();
        expect(client.uplink('gamelog-raw', ['x'])).toBe(true);
        client.close();
        expect(client.uplink('gamelog-raw', ['x'])).toBe(false);
    });

    it('records every frame of the link for the Socket Inspect window', async () => {
        const { linkFrameSnapshot, resetSocketInspector } = await import('../client/socketInspector.js');
        resetSocketInspector();
        client = createHubConnection({ url, token: TOKEN, autoReconnect: false });
        await client.connect();
        await client.call('SQLite', 'Execute', ['SELECT 1', null]);
        const frames = linkFrameSnapshot().map((entry) => `${entry.direction}:${entry.type}`);
        expect(frames).toEqual(['out:hello', 'in:challenge', 'out:auth', 'in:welcome', 'out:call', 'in:result']);
        const result = linkFrameSnapshot().at(-1);
        expect(result.frameId).toBe(1);
        expect(result.latencyMs).toBeGreaterThanOrEqual(0);
        expect(result.wireBytes).toBeGreaterThan(0);
    });

    it('says which Hub an interop error came from', async () => {
        await server.stop();
        ({ server, url } = await startServer({
            handleCall: async () => {
                throw new Error('database or disk is full');
            }
        }));
        client = createHubConnection({ url, token: TOKEN, autoReconnect: false });
        await client.connect();
        const failure = await client.call('SQLite', 'Execute', ['SELECT 1', null]).catch((err) => err);
        expect(failure.message).toMatch(/^Hub \(127\.0\.0\.1:\d+\): database or disk is full$/);
        expect(failure.hubMessage).toBe('database or disk is full');
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

    it('keeps GETs apart when their headers differ', async () => {
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

        const url = 'https://api.vrchat.cloud/api/1/worlds/wrld_1';
        const a = handler('WebApi', 'Execute', [{ url, method: 'GET' }]);
        const b = handler('WebApi', 'Execute', [{ url, method: 'GET', headers: { Accept: 'image/png' } }]);
        release();
        await Promise.all([a, b]);

        expect(upstreamCalls).toBe(2);
        expect(coalescingKey({ url, method: 'get', headers: { B: 1, A: 2 } })).toBe(`GET ${url} a=2&b=1`);
    });

    it('passes the calling client through to the wrapped handler', async () => {
        const seen = [];
        const handler = withRequestCoalescing(async (c, m, a, client) => {
            seen.push(client);
            return { status: 200, message: '{}' };
        });
        const who = { clientId: 'abc' };
        await handler('WebApi', 'Execute', [{ url: 'https://api.vrchat.cloud/api/1/x', method: 'GET' }], who);
        await handler('SQLite', 'Execute', ['SELECT 1', null], who);
        expect(seen).toEqual([who, who]);
    });
});

describe('hub transport under a burst', () => {
    it('answers fifty concurrent calls issued in one tick', async () => {
        const server = createHubServer({
            port: 0,
            host: '127.0.0.1',
            token: TOKEN,
            handleCall: createInteropHandler(createNatives()),
            describe: () => ({ databaseVersion: 17, hub: 'test-hub' })
        });
        await server.start();
        const client = createHubConnection({
            url: `ws://127.0.0.1:${server.address.port}`,
            token: TOKEN,
            autoReconnect: false
        });
        try {
            await client.connect();
            // What a desktop client does on attach: every store fires its
            // queries at once. Before the receive path was serialised, the
            // Hub reported all but the first as dropped frames.
            const results = await Promise.all(
                Array.from({ length: 50 }, () => client.call('SQLite', 'Execute', ['SELECT 1', null]))
            );
            expect(results).toHaveLength(50);
            expect(results.every((rows) => rows[0][0] === 'row')).toBe(true);
            expect(client.state).toBe(ConnectionState.READY);
        } finally {
            client.close();
            await server.stop();
        }
    });
});
