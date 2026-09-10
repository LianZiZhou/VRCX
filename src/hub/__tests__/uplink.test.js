/**
 * [hub] The uplink guards: what goes up, what stays local, and how the Hub's
 * echo gets back in without going up again.
 */

import {
    hasUplink,
    isReplayingUplink,
    replayFromHub,
    setUplinkSender,
    uplinkGameLogLine,
    uplinkGameLogLines,
    uplinkGameState,
    uplinkIpcEvent,
    UplinkKind
} from '../client/uplink.js';

/** @type {Array<[string, any]>} */
let sent;

beforeEach(() => {
    sent = [];
    setUplinkSender((kind, data) => sent.push([kind, data]));
});

afterEach(() => {
    setUplinkSender(null);
});

describe('without a Hub', () => {
    it('takes nothing, so everything is processed locally', () => {
        setUplinkSender(null);
        expect(hasUplink()).toBe(false);
        expect(uplinkGameLogLine('["a"]')).toBe(false);
        expect(uplinkIpcEvent('{}')).toBe(false);
        expect(uplinkGameState({ isGameRunning: true, isSteamVRRunning: false })).toBe(false);
        expect(sent).toEqual([]);
    });
});

describe('with a Hub', () => {
    it('batches game log lines from one tick into one frame', async () => {
        expect(uplinkGameLogLine('["a"]')).toBe(true);
        expect(uplinkGameLogLine('["b"]')).toBe(true);
        expect(sent).toEqual([]);
        await Promise.resolve();
        expect(sent).toEqual([[UplinkKind.GAME_LOG, ['["a"]', '["b"]']]]);

        expect(uplinkGameLogLines(['["c"]'])).toBe(true);
        expect(sent.at(-1)).toEqual([UplinkKind.GAME_LOG, ['["c"]']]);
    });

    it('sends game state only when it changes', () => {
        expect(uplinkGameState({ isGameRunning: true, isSteamVRRunning: false })).toBe(true);
        expect(uplinkGameState({ isGameRunning: true, isSteamVRRunning: false })).toBe(true);
        expect(uplinkGameState({ isGameRunning: true, isSteamVRRunning: true })).toBe(true);
        expect(sent).toEqual([
            [UplinkKind.GAME_STATE, { isGameRunning: true, isSteamVRRunning: false }],
            [UplinkKind.GAME_STATE, { isGameRunning: true, isSteamVRRunning: true }]
        ]);
    });

    it('forgets the last state when the Hub goes away, so a new Hub is told', () => {
        uplinkGameState({ isGameRunning: true, isSteamVRRunning: false });
        setUplinkSender((kind, data) => sent.push([kind, data]));
        uplinkGameState({ isGameRunning: true, isSteamVRRunning: false });
        expect(sent).toHaveLength(2);
    });

    it('lets the echo through: nothing is taken while replaying', async () => {
        expect(isReplayingUplink()).toBe(false);
        const result = replayFromHub(() => {
            expect(isReplayingUplink()).toBe(true);
            expect(uplinkGameLogLine('["echo"]')).toBe(false);
            expect(uplinkIpcEvent('{}')).toBe(false);
            expect(uplinkGameState({ isGameRunning: true, isSteamVRRunning: false })).toBe(false);
            return 'done';
        });
        expect(result).toBe('done');
        expect(isReplayingUplink()).toBe(false);
        await Promise.resolve();
        expect(sent).toEqual([]);
    });

    it('restores the guard even when the replayed handler throws', () => {
        expect(() =>
            replayFromHub(() => {
                throw new Error('boom');
            })
        ).toThrow('boom');
        expect(isReplayingUplink()).toBe(false);
        expect(uplinkIpcEvent('{}')).toBe(true);
    });
});
