/**
 * [hub] The uplink guards: what goes up, what stays local, what waits for the
 * link, and how the Hub's echo gets back in without going up again.
 */

import {
    hasUplink,
    isReplayingUplink,
    lastReportedGameState,
    notifyUplinkReady,
    QUEUE_LIMITS,
    replayFromHub,
    resetUplink,
    setUplinkSender,
    uplinkGameLogBacklog,
    uplinkGameLogLine,
    uplinkGameLogLines,
    uplinkGameState,
    uplinkIpcEvent,
    UplinkKind,
    uplinkQueueDepth,
    uplinkStats
} from '../client/uplink.js';
import { classifyIpc, IpcRoute, isEchoedIpc } from '../shared/ipcRouting.js';

/** @type {Array<[string, any]>} */
let sent;
/** Whether the fake link accepts frames. */
let linkUp;

beforeEach(() => {
    sent = [];
    linkUp = true;
    resetUplink();
    setUplinkSender((kind, data) => {
        if (!linkUp) {
            return false;
        }
        sent.push([kind, data]);
        return true;
    });
});

afterEach(() => {
    setUplinkSender(null);
    delete globalThis.$pinia;
});

describe('without a Hub', () => {
    it('takes nothing, so everything is processed locally', () => {
        setUplinkSender(null);
        expect(hasUplink()).toBe(false);
        expect(uplinkGameLogLine('["a"]')).toBe(false);
        expect(uplinkIpcEvent('{"type":"OnEvent"}')).toBe(false);
        expect(uplinkGameLogBacklog([{ type: 'location' }])).toBe(false);
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

    it('sends the start-up backlog as parsed entries', () => {
        const entries = [{ type: 'location', location: 'wrld_1:1' }, { type: 'player-joined' }];
        expect(uplinkGameLogBacklog(entries)).toBe(true);
        expect(sent).toEqual([[UplinkKind.GAME_LOG_BACKLOG, entries]]);
        // An empty backlog is still "taken": nothing to process locally.
        expect(uplinkGameLogBacklog([])).toBe(true);
        expect(sent).toHaveLength(1);
    });

    it('sends game state only when it changes', () => {
        expect(uplinkGameState({ isGameRunning: true, isSteamVRRunning: false })).toBe(true);
        expect(uplinkGameState({ isGameRunning: true, isSteamVRRunning: false })).toBe(true);
        expect(uplinkGameState({ isGameRunning: true, isSteamVRRunning: true })).toBe(true);
        expect(sent).toEqual([
            [UplinkKind.GAME_STATE, { isGameRunning: true, isSteamVRRunning: false }],
            [UplinkKind.GAME_STATE, { isGameRunning: true, isSteamVRRunning: true }]
        ]);
        expect(lastReportedGameState()).toEqual({ isGameRunning: true, isSteamVRRunning: true });
    });

    it('re-announces the game state when the link comes back, so a new Hub is told', () => {
        uplinkGameState({ isGameRunning: true, isSteamVRRunning: false });
        expect(sent).toHaveLength(1);
        notifyUplinkReady();
        expect(sent).toHaveLength(2);
        expect(sent[1]).toEqual([UplinkKind.GAME_STATE, { isGameRunning: true, isSteamVRRunning: false }]);
        // And not again until it changes.
        uplinkGameState({ isGameRunning: true, isSteamVRRunning: false });
        expect(sent).toHaveLength(2);
    });

    it('reads the game state from the store when nothing reported it yet', () => {
        globalThis.$pinia = { game: { isGameRunning: true, isSteamVRRunning: true } };
        expect(notifyUplinkReady().gameState).toBe(true);
        expect(sent).toEqual([[UplinkKind.GAME_STATE, { isGameRunning: true, isSteamVRRunning: true }]]);
    });

    it('lets the echo through: nothing is taken while replaying', async () => {
        expect(isReplayingUplink()).toBe(false);
        const result = replayFromHub(() => {
            expect(isReplayingUplink()).toBe(true);
            expect(uplinkGameLogLine('["echo"]')).toBe(false);
            expect(uplinkIpcEvent('{"type":"OnEvent"}')).toBe(false);
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
        expect(uplinkIpcEvent('{"type":"OnEvent"}')).toBe(true);
    });
});

describe('IPC routing', () => {
    it('classifies packets by who needs them', () => {
        expect(classifyIpc('{"type":"OnEvent"}')).toBe(IpcRoute.HUB);
        expect(classifyIpc({ type: 'VRCEvent' })).toBe(IpcRoute.HUB);
        expect(classifyIpc({ type: 'VrcxMessage', MsgType: 'Noty' })).toBe(IpcRoute.HUB);
        expect(classifyIpc({ type: 'VrcxMessage', MsgType: 'External' })).toBe(IpcRoute.HUB);
        expect(classifyIpc({ type: 'Ping' })).toBe(IpcRoute.BOTH);
        expect(classifyIpc({ type: 'MsgPing', version: 22 })).toBe(IpcRoute.BOTH);
        expect(classifyIpc({ type: 'Event7List' })).toBe(IpcRoute.BOTH);
        expect(classifyIpc({ type: 'LaunchCommand', command: 'user/usr_1' })).toBe(IpcRoute.LOCAL);
        expect(classifyIpc({ type: 'VRCXLaunch' })).toBe(IpcRoute.LOCAL);
        expect(classifyIpc({ type: 'VrcxMessage', MsgType: 'CustomTag' })).toBe(IpcRoute.LOCAL);
        expect(classifyIpc({ type: 'VrcxMessage', MsgType: 'ClearCustomTags' })).toBe(IpcRoute.LOCAL);
        // Garbage goes to the Hub, whose log is the one being watched.
        expect(classifyIpc('not json')).toBe(IpcRoute.HUB);
        expect(isEchoedIpc({ type: 'Ping' })).toBe(false);
        expect(isEchoedIpc({ type: 'OnEvent' })).toBe(true);
    });

    it('keeps machine-local control on the machine', () => {
        const launch = JSON.stringify({ type: 'LaunchCommand', command: 'user/usr_1' });
        expect(uplinkIpcEvent(launch)).toBe(false);
        expect(sent).toEqual([]);
    });

    it('sends shared facts up and still processes them locally', () => {
        const ping = JSON.stringify({ type: 'Ping' });
        expect(uplinkIpcEvent(ping)).toBe(false);
        expect(sent).toEqual([[UplinkKind.IPC, ping]]);
    });

    it('sends Photon data up and not to the local handler', () => {
        const event = JSON.stringify({ type: 'OnEvent', OnEventData: {} });
        expect(uplinkIpcEvent(event)).toBe(true);
        expect(sent).toEqual([[UplinkKind.IPC, event]]);
    });
});

describe('while the link is down', () => {
    beforeEach(() => {
        linkUp = false;
    });

    it('still takes lines, and queues them instead of dropping them', async () => {
        expect(uplinkGameLogLine('["a"]')).toBe(true);
        await Promise.resolve();
        expect(uplinkGameLogLines(['["b"]', '["c"]'])).toBe(true);
        expect(sent).toEqual([]);
        expect(uplinkQueueDepth()).toEqual({ lines: 3, ipc: 0, backlog: 0 });

        linkUp = true;
        const flushed = notifyUplinkReady();
        expect(flushed).toEqual({ gameState: false, backlog: 0, lines: 3, ipc: 0 });
        expect(sent).toEqual([[UplinkKind.GAME_LOG, ['["a"]', '["b"]', '["c"]']]]);
        expect(uplinkQueueDepth()).toEqual({ lines: 0, ipc: 0, backlog: 0 });
    });

    it('queues Photon and the backlog too, and flushes in the right order', () => {
        const event = JSON.stringify({ type: 'OnEvent' });
        uplinkGameState({ isGameRunning: true, isSteamVRRunning: false });
        expect(uplinkIpcEvent(event)).toBe(true);
        uplinkGameLogBacklog([{ type: 'location', location: 'wrld_1:1' }]);
        uplinkGameLogLines(['["line"]']);
        expect(sent).toEqual([]);

        linkUp = true;
        const flushed = notifyUplinkReady();
        expect(flushed).toEqual({ gameState: true, backlog: 1, lines: 1, ipc: 1 });
        // Game state first so the Hub's `isGameRunning` gate is open before
        // any of the rest lands; then backlog, live lines, Photon.
        expect(sent.map(([kind]) => kind)).toEqual([
            UplinkKind.GAME_STATE,
            UplinkKind.GAME_LOG_BACKLOG,
            UplinkKind.GAME_LOG,
            UplinkKind.IPC
        ]);
    });

    it('does not latch the game state dedupe on a frame that never went out', () => {
        uplinkGameState({ isGameRunning: true, isSteamVRRunning: false });
        expect(sent).toEqual([]);
        linkUp = true;
        // The same state again: it must go now, because it never did.
        uplinkGameState({ isGameRunning: true, isSteamVRRunning: false });
        expect(sent).toEqual([[UplinkKind.GAME_STATE, { isGameRunning: true, isSteamVRRunning: false }]]);
    });

    it('never overtakes what is already queued once the link is back', () => {
        uplinkGameLogLines(['["old"]']);
        linkUp = true;
        // The link is up but the queue is not flushed yet: a new line waits
        // behind the old one rather than arriving before it.
        uplinkGameLogLines(['["new"]']);
        expect(sent).toEqual([]);
        notifyUplinkReady();
        expect(sent).toEqual([[UplinkKind.GAME_LOG, ['["old"]', '["new"]']]]);
    });

    it('bounds the queues and counts what it had to drop', () => {
        const before = uplinkStats.dropped.lines;
        uplinkGameLogLines(Array.from({ length: QUEUE_LIMITS.lines + 7 }, (_, i) => `["${i}"]`));
        expect(uplinkQueueDepth().lines).toBe(QUEUE_LIMITS.lines);
        expect(uplinkStats.dropped.lines - before).toBe(7);

        const ipcBefore = uplinkStats.dropped.ipc;
        for (let i = 0; i < QUEUE_LIMITS.ipc + 3; i++) {
            uplinkIpcEvent(JSON.stringify({ type: 'OnEvent', i }));
        }
        expect(uplinkQueueDepth().ipc).toBe(QUEUE_LIMITS.ipc);
        expect(uplinkStats.dropped.ipc - ipcBefore).toBe(3);

        uplinkGameLogBacklog([{ type: 'a' }]);
        uplinkGameLogBacklog([{ type: 'b' }, { type: 'c' }]);
        expect(uplinkQueueDepth().backlog).toBe(2);
    });

    it('keeps the rest queued when the link drops again mid-flush', () => {
        uplinkGameLogLines(['["a"]']);
        uplinkIpcEvent(JSON.stringify({ type: 'OnEvent' }));
        let accepted = 0;
        setUplinkSender((kind, data) => {
            if (accepted++ >= 1) {
                return false;
            }
            sent.push([kind, data]);
            return true;
        });
        const flushed = notifyUplinkReady();
        expect(flushed).toEqual({ gameState: false, backlog: 0, lines: 1, ipc: 0 });
        expect(uplinkQueueDepth()).toEqual({ lines: 0, ipc: 1, backlog: 0 });
    });

    it('forgets everything when the Hub link is given up', () => {
        uplinkGameLogLines(['["a"]']);
        setUplinkSender(null);
        expect(uplinkQueueDepth()).toEqual({ lines: 0, ipc: 0, backlog: 0 });
        expect(lastReportedGameState()).toBeNull();
    });
});
