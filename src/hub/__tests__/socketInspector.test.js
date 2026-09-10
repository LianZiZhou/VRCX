/**
 * [hub] The tap behind the Socket Inspect window: records everything,
 * pushes only while a window is open, and opens with history.
 */

import {
    INSPECTOR_BUFFER,
    INSPECTOR_MAX_RAW,
    inspectorStats,
    isSocketInspectorEnabled,
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

    it('installs the surface the C# side drives', () => {
        expect(typeof globalThis.__vrcxSocketInspect?.setEnabled).toBe('function');
        globalThis.__vrcxSocketInspect.setEnabled(true);
        expect(isSocketInspectorEnabled()).toBe(true);
        globalThis.__vrcxSocketInspect.setEnabled(false);
    });
});
