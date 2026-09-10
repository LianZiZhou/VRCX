/**
 * [hub] Pushes locally-sourced data from a mirror client up to the Hub.
 *
 * Four kinds of data can only be collected on the machine that actually runs
 * VRChat, so the Hub cannot produce them itself:
 *
 *   - game log lines, tailed by the C# LogWatcher
 *   - the start-up backlog: what VRChat logged while VRCX was closed
 *   - Photon events, arriving over the named-pipe IPC bridge
 *   - whether the game and SteamVR are running
 *
 * The originating client sends these up and does **not** process them locally
 * (game state excepted: the machine still needs to know its own game is up).
 * The Hub processes them once, writes the rows, and broadcasts the result back
 * to every client including the sender. One code path, one writer, and no
 * double-processing on the machine that happened to produce the data.
 *
 * Where the guard lives matters. Game log lines and game state reach the app
 * by two routes: on Linux the update loop polls for them, on Windows C# calls
 * `$pinia.gameLog.addGameLogEvent` and `$pinia.game.updateIsGameRunning`
 * directly. Both routes converge on the coordinators, so that is where
 * `uplinkGameLogLine` and `uplinkGameState` are called from -- an earlier
 * version hooked only the update loop, and Windows mirrors quietly processed
 * everything locally with their derived writes suppressed, so visit counts and
 * sessions never reached the Hub.
 *
 * The link is not always up. While it is reconnecting, anything taken here is
 * queued (bounded) and flushed, in order, when `notifyUplinkReady()` is called
 * on the next `ready`. An earlier version dropped it: a game log line produced
 * during a Hub restart was neither sent nor processed, and the game state
 * dedupe latched on a frame that never went out, so the Hub never learned the
 * game was running.
 *
 * The Hub's echo comes back through the very same entry points. It is
 * delivered inside `replayFromHub()`, which makes every `uplink*` call answer
 * "not taken" so the line is processed rather than sent up again.
 *
 * Dependency-light so `stores/updateLoop.js` and `stores/vrcx.js` can import it
 * without dragging the transport into the standalone bundle's hot path.
 */

import { classifyIpc, IpcRoute } from '../shared/ipcRouting.js';

export const UplinkKind = {
    GAME_LOG: 'gamelog-raw',
    GAME_LOG_BACKLOG: 'gamelog-backlog',
    IPC: 'ipc',
    GAME_STATE: 'game-state'
};

/** How much a client will hold while the Hub is away. Oldest is dropped first. */
export const QUEUE_LIMITS = Object.freeze({ lines: 5000, ipc: 2000 });

/** Observability: what went up, what waited, what was lost. */
export const uplinkStats = {
    sent: { gamelog: 0, backlog: 0, ipc: 0, gameState: 0 },
    queued: { lines: 0, ipc: 0, backlog: 0 },
    dropped: { lines: 0, ipc: 0, backlog: 0 },
    flushes: 0,
    /** @type {string | null} */
    lastGameStateSent: null
};

/** @type {((kind: string, data: any) => boolean) | null} */
let sender = null;
/** Depth of `replayFromHub` calls in progress. */
let replaying = 0;
/** Game log lines gathered in the current tick, sent as one frame. */
let pendingLines = [];
/** What could not be sent, waiting for the link. */
const queue = { lines: [], ipc: [], backlog: null };
/** The machine's game state as last told to us, whether or not it was sent. */
let lastKnownGameState = null;
/** The last game state the Hub actually received, so a poll is not a frame. */
let lastSentGameState = null;

/**
 * @param {((kind: string, data: any) => boolean) | null} fn - returns whether the frame was sent
 */
export function setUplinkSender(fn) {
    sender = fn;
    if (!fn) {
        resetUplink();
    }
}

/** Forget everything: queues, batching, and the game state dedupe. */
export function resetUplink() {
    pendingLines = [];
    queue.lines = [];
    queue.ipc = [];
    queue.backlog = null;
    lastKnownGameState = null;
    lastSentGameState = null;
    uplinkStats.lastGameStateSent = null;
}

/** @returns {boolean} */
export function hasUplink() {
    return sender !== null;
}

/**
 * Whether data produced on this machine should go up rather than be handled
 * here: there is a Hub to send it to, and it is not the Hub's own echo.
 *
 * @returns {boolean}
 */
function shouldUplink() {
    return sender !== null && replaying === 0;
}

/** @returns {boolean} */
export function isReplayingUplink() {
    return replaying > 0;
}

/**
 * Run `fn` with the uplink guards answering "not taken", for delivering the
 * Hub's echo through the normal entry points.
 *
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function replayFromHub(fn) {
    replaying += 1;
    try {
        return fn();
    } finally {
        replaying -= 1;
    }
}

/**
 * @param {string} kind
 * @param {any} data
 * @returns {boolean} whether the frame went out
 */
function send(kind, data) {
    if (!sender) {
        return false;
    }
    try {
        return sender(kind, data) === true;
    } catch (err) {
        console.error('[hub] Failed to uplink', kind, err);
        return false;
    }
}

/**
 * @param {string[]} lines
 */
function enqueueLines(lines) {
    for (const line of lines) {
        queue.lines.push(line);
        uplinkStats.queued.lines++;
    }
    const excess = queue.lines.length - QUEUE_LIMITS.lines;
    if (excess > 0) {
        queue.lines.splice(0, excess);
        uplinkStats.dropped.lines += excess;
    }
}

/**
 * @param {string[]} lines
 */
function deliverLines(lines) {
    // Never overtake what is already waiting: the Hub tracks the current
    // instance from the order these arrive in.
    if (queue.lines.length || !send(UplinkKind.GAME_LOG, lines)) {
        enqueueLines(lines);
        return;
    }
    uplinkStats.sent.gamelog += lines.length;
}

function flushPendingLines() {
    const lines = pendingLines;
    pendingLines = [];
    if (lines.length) {
        deliverLines(lines);
    }
}

/**
 * One raw game log line, as LogWatcher produced it. Lines arriving in the
 * same tick go up in one frame.
 *
 * @param {string} json
 * @returns {boolean} true when the line was taken and must not be processed here
 */
export function uplinkGameLogLine(json) {
    if (!shouldUplink()) {
        return false;
    }
    if (pendingLines.push(json) === 1) {
        queueMicrotask(flushPendingLines);
    }
    return true;
}

/**
 * @param {string[]} lines - raw JSON strings, exactly as LogWatcher produced them
 * @returns {boolean} true when the lines were taken
 */
export function uplinkGameLogLines(lines) {
    if (!shouldUplink() || !lines?.length) {
        return false;
    }
    deliverLines(lines);
    return true;
}

/**
 * The start-up backlog: parsed entries from `gameLogService.getAll()`, which
 * `gameLogCoordinator.js#updateGameLog` would otherwise process locally with
 * every write suppressed, so the Hub never learned what VRChat logged while
 * VRCX was closed. Parsed rather than raw because the coordinator tracks the
 * location from the backlog's own `location` entries, which is only possible
 * once they are parsed and in order.
 *
 * @param {object[]} entries
 * @returns {boolean} true when the backlog was taken
 */
export function uplinkGameLogBacklog(entries) {
    if (!shouldUplink()) {
        return false;
    }
    if (!entries?.length) {
        return true;
    }
    if (send(UplinkKind.GAME_LOG_BACKLOG, entries)) {
        uplinkStats.sent.backlog += entries.length;
        return true;
    }
    if (queue.backlog) {
        uplinkStats.dropped.backlog += queue.backlog.length;
    }
    queue.backlog = entries;
    uplinkStats.queued.backlog += entries.length;
    return true;
}

/**
 * @param {string} json
 */
function deliverIpc(json) {
    if (queue.ipc.length || !send(UplinkKind.IPC, json)) {
        queue.ipc.push(json);
        uplinkStats.queued.ipc++;
        const excess = queue.ipc.length - QUEUE_LIMITS.ipc;
        if (excess > 0) {
            queue.ipc.splice(0, excess);
            uplinkStats.dropped.ipc += excess;
        }
        return;
    }
    uplinkStats.sent.ipc++;
}

/**
 * @param {string} json - a raw IPC packet, as passed to vrcx.ipcEvent
 * @returns {boolean} true when the packet was taken and must not be processed here
 */
export function uplinkIpcEvent(json) {
    if (!shouldUplink()) {
        return false;
    }
    const route = classifyIpc(json);
    if (route === IpcRoute.LOCAL) {
        return false;
    }
    deliverIpc(json);
    // `both`: the Hub needs it, and so does this machine.
    return route === IpcRoute.HUB;
}

/**
 * @param {{ isGameRunning: boolean, isSteamVRRunning: boolean } | null | undefined} state
 * @returns {{ isGameRunning: boolean, isSteamVRRunning: boolean }}
 */
function normaliseGameState(state) {
    return {
        isGameRunning: Boolean(state?.isGameRunning),
        isSteamVRRunning: Boolean(state?.isSteamVRRunning)
    };
}

/**
 * @param {{ isGameRunning: boolean, isSteamVRRunning: boolean }} state
 * @returns {boolean} whether it went out
 */
function sendGameState(state) {
    const key = `${state.isGameRunning}:${state.isSteamVRRunning}`;
    if (key === lastSentGameState) {
        return true;
    }
    if (!send(UplinkKind.GAME_STATE, state)) {
        return false;
    }
    lastSentGameState = key;
    uplinkStats.sent.gameState++;
    uplinkStats.lastGameStateSent = key;
    return true;
}

/**
 * Tell the Hub whether the game is running here. Unlike the other kinds this
 * does not replace local processing; the caller carries on regardless.
 *
 * The state is remembered even when it cannot be sent, and the dedupe only
 * advances on a frame that went out, so a change during a Hub outage is
 * delivered by `notifyUplinkReady()` rather than lost.
 *
 * @param {{ isGameRunning: boolean, isSteamVRRunning: boolean }} state
 * @returns {boolean} true when there is a Hub to tell
 */
export function uplinkGameState(state) {
    if (!shouldUplink()) {
        return false;
    }
    lastKnownGameState = normaliseGameState(state);
    sendGameState(lastKnownGameState);
    return true;
}

/**
 * The machine's game state as the store knows it, for a reconnect that
 * happens before anything has called `uplinkGameState` in this process.
 *
 * @returns {{ isGameRunning: boolean, isSteamVRRunning: boolean } | null}
 */
function gameStateFromStore() {
    const game = globalThis.$pinia?.game;
    if (!game) {
        return null;
    }
    return normaliseGameState({ isGameRunning: game.isGameRunning, isSteamVRRunning: game.isSteamVRRunning });
}

/**
 * The link is (back) up. Re-announce the game state -- the Hub may be a fresh
 * process that knows nothing -- then flush what waited, oldest first:
 * backlog, then live lines, then Photon. Game state goes first so the Hub
 * has `isGameRunning` set before it processes any of the rest.
 *
 * @returns {{ gameState: boolean, backlog: number, lines: number, ipc: number }} what went out
 */
export function notifyUplinkReady() {
    const result = { gameState: false, backlog: 0, lines: 0, ipc: 0 };
    if (!sender) {
        return result;
    }
    uplinkStats.flushes++;
    lastSentGameState = null;
    const state = lastKnownGameState ?? gameStateFromStore();
    if (state) {
        lastKnownGameState = state;
        result.gameState = sendGameState(state);
        if (!result.gameState) {
            return result;
        }
    }

    if (queue.backlog) {
        const entries = queue.backlog;
        if (!send(UplinkKind.GAME_LOG_BACKLOG, entries)) {
            return result;
        }
        queue.backlog = null;
        result.backlog = entries.length;
        uplinkStats.sent.backlog += entries.length;
    }

    if (queue.lines.length) {
        const lines = queue.lines;
        queue.lines = [];
        if (!send(UplinkKind.GAME_LOG, lines)) {
            queue.lines = lines;
            return result;
        }
        result.lines = lines.length;
        uplinkStats.sent.gamelog += lines.length;
    }

    while (queue.ipc.length) {
        const json = queue.ipc[0];
        if (!send(UplinkKind.IPC, json)) {
            return result;
        }
        queue.ipc.shift();
        result.ipc++;
        uplinkStats.sent.ipc++;
    }
    return result;
}

/** @returns {{ lines: number, ipc: number, backlog: number }} what is waiting for the link */
export function uplinkQueueDepth() {
    return { lines: queue.lines.length, ipc: queue.ipc.length, backlog: queue.backlog?.length ?? 0 };
}

/** @returns {{ isGameRunning: boolean, isSteamVRRunning: boolean } | null} */
export function lastReportedGameState() {
    return lastKnownGameState;
}
