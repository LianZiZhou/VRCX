/**
 * [hub] Contract test for the remote interop layer.
 *
 * The design claim being verified: `src/services/sqlite.js` and
 * `src/services/webapi.js` require **no changes** to run against a Hub. This
 * test binds the real services to the remote proxies, routes every call through
 * the actual wire encoder and the server-side handler, and checks the results
 * come back in the shape those services expect.
 *
 * Everything goes through `encodeFrame`/`decodeFrame` so that serialisation
 * bugs (a `Map` that silently becomes an empty object, for instance) fail here
 * rather than on a Raspberry Pi.
 */

import { createRemoteSQLite, createRemoteWebApi, isHubBoundUrl, mustRunLocally } from '../client/remoteInterop.js';
import { decodeFrame, encodeFrame, FrameType, isCallAllowed } from '../shared/protocol.js';
import { createInteropHandler, HubInteropError } from '../server/interopHandler.js';

/**
 * A fake of the C# SQLite binding that records what it was asked to do.
 */
function createFakeNativeSQLite() {
    const calls = [];
    let rows = [];
    return {
        calls,
        setRows(next) {
            rows = next;
        },
        async ExecuteJson(sql, args) {
            calls.push({ method: 'ExecuteJson', sql, args });
            return JSON.stringify(rows);
        },
        async ExecuteNonQuery(sql, args) {
            calls.push({ method: 'ExecuteNonQuery', sql, args });
            return 1;
        }
    };
}

function createFakeNativeWebApi() {
    const calls = [];
    let response = { status: 200, message: '{"ok":true}' };
    return {
        calls,
        setResponse(next) {
            response = next;
        },
        async ExecuteJson(optionsJson) {
            calls.push({ method: 'ExecuteJson', options: JSON.parse(optionsJson) });
            return JSON.stringify(response);
        },
        async GetCookies() {
            calls.push({ method: 'GetCookies' });
            return 'cookie-blob';
        },
        async SetCookies(value) {
            calls.push({ method: 'SetCookies', value });
        },
        async ClearCookies() {
            calls.push({ method: 'ClearCookies' });
        }
    };
}

/**
 * A transport that serialises through the real frame codec and dispatches to
 * the real server handler, i.e. everything except the socket.
 */
function createLoopbackTransport(handler) {
    let seq = 0;
    const sent = [];
    return {
        sent,
        async call(className, method, args) {
            const wire = encodeFrame({
                i: ++seq,
                t: FrameType.CALL,
                p: { c: className, m: method, a: args }
            });
            sent.push(wire);
            const frame = decodeFrame(wire);
            const { c, m, a } = frame.p;
            return handler(c, m, a);
        }
    };
}

describe('remote interop', () => {
    let nativeSQLite;
    let nativeWebApi;
    let transport;

    beforeEach(() => {
        nativeSQLite = createFakeNativeSQLite();
        nativeWebApi = createFakeNativeWebApi();
        transport = createLoopbackTransport(createInteropHandler({ SQLite: nativeSQLite, WebApi: nativeWebApi }));
    });

    describe('the unmodified sqliteService', () => {
        it('reads rows through the Hub', async () => {
            nativeSQLite.setRows([
                ['alice', 3],
                ['bob', 7]
            ]);
            globalThis.SQLite = createRemoteSQLite(transport);
            const { SQLiteService } = await import('../../services/sqlite.js');
            const service = new SQLiteService();

            const seen = [];
            await service.execute((row) => seen.push(row), 'SELECT name, n FROM t');

            expect(seen).toEqual([
                ['alice', 3],
                ['bob', 7]
            ]);
        });

        it('carries named parameters across the wire', async () => {
            globalThis.SQLite = createRemoteSQLite(transport);
            const { SQLiteService } = await import('../../services/sqlite.js');
            const service = new SQLiteService();

            await service.executeNonQuery('INSERT INTO t VALUES (@name)', { '@name': 'alice' });

            // sqlite.js converts args to a Map on the LINUX path. A Map does not
            // survive JSON.stringify, so the protocol converts it to a plain
            // object on the way out and back to a Map on the way in.
            const call = nativeSQLite.calls.at(-1);
            expect(call.method).toBe('ExecuteNonQuery');
            expect(call.args).toBeInstanceOf(Map);
            expect(call.args.get('@name')).toBe('alice');
        });
    });

    describe('the unmodified webApiService', () => {
        it('performs a request through the Hub', async () => {
            nativeWebApi.setResponse({ status: 200, message: '{"displayName":"alice"}' });
            globalThis.WebApi = createRemoteWebApi(transport, nativeWebApi);
            const { WebApiService } = await import('../../services/webapi.js');
            const service = new WebApiService();

            const result = await service.execute({ url: 'https://api/user', method: 'GET' });

            expect(result).toEqual({ status: 200, data: '{"displayName":"alice"}' });
            expect(nativeWebApi.calls.at(-1).options.url).toBe('https://api/user');
        });

        it('surfaces transport failures the way callers expect', async () => {
            nativeWebApi.setResponse({ status: -1, message: 'connection refused' });
            globalThis.WebApi = createRemoteWebApi(transport, nativeWebApi);
            const { WebApiService } = await import('../../services/webapi.js');
            const service = new WebApiService();

            await expect(service.execute({ url: 'https://api/user' })).rejects.toThrow('connection refused');
        });
    });

    describe('dual-shape adaptation', () => {
        it('returns CefSharp shapes for the Windows calling convention', async () => {
            nativeSQLite.setRows([[1, 'x']]);
            nativeWebApi.setResponse({ status: 204, message: '' });
            const sqlite = createRemoteSQLite(transport);
            const webApi = createRemoteWebApi(transport, nativeWebApi);

            // CefSharp: Execute returns rows directly, not a JSON string.
            await expect(sqlite.Execute('SELECT 1')).resolves.toEqual([[1, 'x']]);
            // CefSharp: WebApi returns a marshalled Tuple.
            await expect(webApi.Execute({ url: 'https://api/x' })).resolves.toEqual({
                Item1: 204,
                Item2: ''
            });
        });

        it('returns Electron shapes for the Linux calling convention', async () => {
            nativeSQLite.setRows([[1, 'x']]);
            const sqlite = createRemoteSQLite(transport);

            await expect(sqlite.ExecuteJson('SELECT 1')).resolves.toBe('[[1,"x"]]');
        });
    });

    describe('the call allowlist', () => {
        it('permits exactly the data-core primitives', () => {
            expect(isCallAllowed('SQLite', 'ExecuteNonQuery')).toBe(true);
            expect(isCallAllowed('WebApi', 'ExecuteJson')).toBe(true);
        });

        it('refuses everything else, including other interop classes', () => {
            // VRCXStorage backs per-machine host settings and must stay local.
            expect(isCallAllowed('VRCXStorage', 'Get')).toBe(false);
            expect(isCallAllowed('AppApi', 'StartGame')).toBe(false);
            expect(isCallAllowed('LogWatcher', 'Get')).toBe(false);
            expect(isCallAllowed('SQLite', 'Init')).toBe(false);
        });

        it('rejects a disallowed call at the server boundary', async () => {
            const handler = createInteropHandler({ SQLite: nativeSQLite, WebApi: nativeWebApi });
            await expect(handler('AppApi', 'StartGame', [])).rejects.toBeInstanceOf(HubInteropError);
        });
    });

    describe('upload routing', () => {
        it('recognises the request shapes the Hub cannot serve', () => {
            expect(mustRunLocally({ uploadImage: true })).toBe(true);
            expect(mustRunLocally({ uploadFilePUT: true })).toBe(true);
            expect(mustRunLocally({ url: 'https://api/user', method: 'GET' })).toBe(false);
            expect(mustRunLocally(null)).toBe(false);
        });

        it('knows which hosts carry the VRChat session', () => {
            expect(isHubBoundUrl('https://api.vrchat.cloud/api/1/auth/user')).toBe(true);
            expect(isHubBoundUrl('https://files.vrchat.cloud/thumbnails/x.png')).toBe(true);
            expect(isHubBoundUrl('https://VRCHAT.cloud/')).toBe(true);
            expect(isHubBoundUrl('https://api.example.test/api/1/x', 'https://api.example.test/api/1')).toBe(true);
            expect(isHubBoundUrl('https://api.github.com/repos/vrcx-team/VRCX/releases')).toBe(false);
            expect(isHubBoundUrl('https://avtrdb.example/avatar/1')).toBe(false);
            expect(isHubBoundUrl('https://notvrchat.cloud.example/')).toBe(false);
            expect(isHubBoundUrl('https://api/user')).toBe(false);
            // Not a URL at all: let the Hub report it.
            expect(isHubBoundUrl('not a url')).toBe(true);
            expect(isHubBoundUrl(undefined)).toBe(true);
        });

        it('runs third-party requests on the local WebApi', async () => {
            const localWebApi = createFakeNativeWebApi();
            localWebApi.setResponse({ status: 200, message: '{"tag_name":"v1"}' });
            const webApi = createRemoteWebApi(transport, localWebApi, {
                endpointDomain: () => 'https://api.vrchat.cloud/api/1'
            });

            const result = await webApi.Execute({
                url: 'https://api.github.com/repos/vrcx-team/VRCX/releases',
                method: 'GET'
            });

            expect(result).toEqual({ Item1: 200, Item2: '{"tag_name":"v1"}' });
            expect(localWebApi.calls).toHaveLength(1);
            expect(transport.sent).toHaveLength(0);

            // The session hosts still go to the Hub.
            await webApi.Execute({ url: 'https://files.vrchat.cloud/x.png', method: 'GET' });
            expect(transport.sent).toHaveLength(1);
        });

        it('runs uploads on the local WebApi, never over the wire', async () => {
            const localWebApi = createFakeNativeWebApi();
            localWebApi.setResponse({ status: 200, message: '{"id":"file_1"}' });
            const webApi = createRemoteWebApi(transport, localWebApi);

            const result = await webApi.Execute({ url: 'https://api/file', uploadImage: true });

            expect(result).toEqual({ Item1: 200, Item2: '{"id":"file_1"}' });
            expect(localWebApi.calls).toHaveLength(1);
            // Nothing was sent to the Hub.
            expect(transport.sent).toHaveLength(0);
            expect(nativeWebApi.calls).toHaveLength(0);
        });
    });
});
