/**
 * [hub] The tap behind the Socket Inspect window: records everything,
 * pushes only while a window is open, and opens with history.
 */

import {
    INSPECTOR_BUFFER,
    INSPECTOR_MAX_RAW,
    inspectorStats,
    isSocketInspectorEnabled,
    LINK_FRAME_BUFFER,
    linkFrameSnapshot,
    recordLinkFrame,
    recordSocketMessage,
    resetSocketInspector,
    setSocketInspectorEnabled,
    setSocketInspectorPusher,
    SocketChannel,
    socketInspectorSnapshot
} from '../client/socketInspector.js';
import { emitPipelineMessage, injectPipelineMessage, setPipelineInjector } from '../shared/pipelineRelay.js';

/** @type {object[]} */
let pushed;

beforeEach(() => {
    resetSocketInspector();
    pushed = [];
    setSocketInspectorPusher((json) => pushed.push(JSON.parse(json)));
});

afterEach(() => {
    setSocketInspectorPusher(null);
    setPipelineInjector(null);
});

describe('socket inspector', () => {
    it('records without pushing until a window opens', () => {
        const message = JSON.stringify({ type: 'friend-location', content: '{}' });
        const entry = recordSocketMessage(SocketChannel.VRCHAT, 'in', message);
        expect(entry).toMatchObject({
            channel: 'vrchat',
            direction: 'in',
            type: 'friend-location',
            size: message.length
        });
        expect(pushed).toEqual([]);
        expect(inspectorStats.recorded).toBe(1);
        expect(isSocketInspectorEnabled()).toBe(false);
    });

    it('opens with the history, then streams', () => {
        recordSocketMessage(SocketChannel.VRCHAT, 'in', '{"type":"a"}');
        recordSocketMessage(SocketChannel.HUB, 'in', { isGameRunning: true }, { type: 'game-state' });
        setSocketInspectorEnabled(true);
        expect(pushed).toHaveLength(1);
        expect(pushed[0].kind).toBe('backlog');
        expect(pushed[0].entries.map((entry) => entry.type)).toEqual(['a', 'game-state']);

        recordSocketMessage(SocketChannel.UPLINK, 'out', ['["line"]'], { type: 'gamelog-raw' });
        expect(pushed).toHaveLength(2);
        expect(pushed[1]).toMatchObject({
            kind: 'message',
            entry: { channel: 'uplink', direction: 'out', type: 'gamelog-raw' }
        });

        setSocketInspectorEnabled(false);
        recordSocketMessage(SocketChannel.VRCHAT, 'in', '{"type":"b"}');
        expect(pushed).toHaveLength(2);
        expect(socketInspectorSnapshot()).toHaveLength(4);
    });

    it('keeps a bounded buffer and cuts oversized payloads', () => {
        for (let i = 0; i < INSPECTOR_BUFFER + 5; i++) {
            recordSocketMessage(SocketChannel.VRCHAT, 'in', `{"type":"n${i}"}`);
        }
        const snapshot = socketInspectorSnapshot();
        expect(snapshot).toHaveLength(INSPECTOR_BUFFER);
        expect(snapshot[0].type).toBe('n5');

        const big = `{"type":"big","content":"${'x'.repeat(INSPECTOR_MAX_RAW)}"}`;
        const entry = recordSocketMessage(SocketChannel.VRCHAT, 'in', big);
        expect(entry.truncated).toBe(true);
        expect(entry.size).toBe(big.length);
        expect(entry.raw).toHaveLength(INSPECTOR_MAX_RAW);
    });

    it('is fed by the pipeline relay on both the socket and the mirror path', () => {
        setPipelineInjector(() => {});
        const raw = JSON.stringify({ type: 'friend-online', content: JSON.stringify({ userId: 'usr_1' }) });
        emitPipelineMessage(raw);
        injectPipelineMessage(raw);
        const snapshot = socketInspectorSnapshot();
        expect(snapshot.map((entry) => [entry.type, entry.via])).toEqual([
            ['friend-online', null],
            ['friend-online', 'hub']
        ]);
    });

    it('survives a pusher that throws', () => {
        setSocketInspectorPusher(() => {
            throw new Error('window gone');
        });
        setSocketInspectorEnabled(true);
        expect(() => recordSocketMessage(SocketChannel.VRCHAT, 'in', '{"type":"a"}')).not.toThrow();
        expect(inspectorStats.pushFailures).toBe(2);
    });

    it('records link frames apart from messages, with latency and a summary', () => {
        recordLinkFrame(
            'out',
            { i: 7, t: 'call', p: { c: 'SQLite', m: 'ExecuteJson', a: ['SELECT * FROM t WHERE x = @x', {}] } },
            120
        );
        const result = recordLinkFrame('in', { i: 7, t: 'result', p: [[1], [2], [3]] }, 80);
        expect(result).toMatchObject({
            channel: 'link',
            direction: 'in',
            type: 'result',
            frameId: 7,
            summary: '3 rows',
            wireBytes: 80
        });
        expect(result.latencyMs).toBeGreaterThanOrEqual(0);

        const http = recordLinkFrame('out', {
            i: 8,
            t: 'call',
            p: { c: 'WebApi', m: 'Execute', a: [{ url: 'https://api.vrchat.cloud/api/1/auth/user', method: 'GET' }] }
        });
        expect(http.summary).toBe('WebApi.Execute GET https://api.vrchat.cloud/api/1/auth/user');
        expect(
            recordLinkFrame('in', { i: 8, t: 'result', p: { status: 200, message: '{"id":"usr_1"}' } }).summary
        ).toBe('HTTP 200 {"id":"usr_1"}');
        expect(recordLinkFrame('in', { t: 'event', p: { event: 'game-state', data: {} } }).summary).toBe('game-state');
        expect(recordLinkFrame('out', { t: 'uplink', p: { kind: 'gamelog-raw', data: ['a', 'b'] } }).summary).toBe(
            'gamelog-raw ×2'
        );
        expect(
            recordLinkFrame('in', { i: 9, t: 'error', p: { code: 'not-allowed', message: 'Call not allowed' } })
                .latencyMs
        ).toBeNull();

        expect(socketInspectorSnapshot()).toHaveLength(0);
        expect(linkFrameSnapshot()).toHaveLength(7);
        expect(inspectorStats.frames).toBe(7);
    });

    it('never lets the session cookies reach the window', () => {
        const event = recordLinkFrame('in', {
            t: 'event',
            p: { event: 'session', data: { userId: 'usr_1', cookies: 'auth=secret' } }
        });
        expect(event.raw).not.toContain('secret');
        const set = recordLinkFrame('out', {
            i: 1,
            t: 'call',
            p: { c: 'WebApi', m: 'SetCookies', a: ['auth=secret'] }
        });
        expect(set.raw).not.toContain('secret');
        recordLinkFrame('out', { i: 2, t: 'call', p: { c: 'WebApi', m: 'GetCookies', a: [] } });
        const got = recordLinkFrame('in', { i: 2, t: 'result', p: 'auth=secret' });
        expect(got.raw).not.toContain('secret');
        // Other results are untouched.
        recordLinkFrame('out', { i: 3, t: 'call', p: { c: 'SQLite', m: 'Execute', a: ['SELECT 1'] } });
        expect(recordLinkFrame('in', { i: 3, t: 'result', p: [[1]] }).raw).toContain('[[1]]');
    });

    it('replays messages and frames in one ordered history', () => {
        recordSocketMessage(SocketChannel.VRCHAT, 'in', '{"type":"a"}');
        recordLinkFrame('out', { i: 1, t: 'ping' });
        recordSocketMessage(SocketChannel.VRCHAT, 'in', '{"type":"b"}');
        setSocketInspectorEnabled(true);
        expect(pushed[0].entries.map((entry) => `${entry.channel}:${entry.type}`)).toEqual([
            'vrchat:a',
            'link:ping',
            'vrchat:b'
        ]);
        for (let i = 0; i < LINK_FRAME_BUFFER + 3; i++) {
            recordLinkFrame('in', { t: 'pong' });
        }
        expect(linkFrameSnapshot()).toHaveLength(LINK_FRAME_BUFFER);
    });

    it('installs the surface the C# side drives', () => {
        expect(typeof globalThis.__vrcxSocketInspect?.setEnabled).toBe('function');
        globalThis.__vrcxSocketInspect.setEnabled(true);
        expect(isSocketInspectorEnabled()).toBe(true);
        globalThis.__vrcxSocketInspect.setEnabled(false);
    });
});
