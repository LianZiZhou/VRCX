/**
 * [hub] Pushes locally-sourced data from a mirror client up to the Hub.
 *
 * Three kinds of data can only be collected on the machine that actually runs
 * VRChat, so the Hub cannot produce them itself:
 *
 *   - game log lines, tailed by the C# LogWatcher
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
 * The Hub's echo comes back through the very same entry points. It is
 * delivered inside `replayFromHub()`, which makes every `uplink*` call answer
 * "not taken" so the line is processed rather than sent up again.
 *
 * Dependency-free so `stores/updateLoop.js` and `stores/vrcx.js` can import it
 * without dragging the transport into the standalone bundle's hot path.
 */

export const UplinkKind = {
    GAME_LOG: 'gamelog-raw',
    IPC: 'ipc',
    GAME_STATE: 'game-state'
};

/** @type {((kind: string, data: any) => void) | null} */
let sender = null;
/** Depth of `replayFromHub` calls in progress. */
let replaying = 0;
/** Game log lines waiting for the end of the current tick. */
let pendingLines = [];
/** The last game state sent, so a once-a-second poll is not a once-a-second frame. */
let lastGameState = null;

/**
 * @param {((kind: string, data: any) => void) | null} fn
 */
export function setUplinkSender(fn) {
    sender = fn;
    pendingLines = [];
    lastGameState = null;
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
 */
function send(kind, data) {
    if (!sender) {
        return;
    }
    try {
        sender(kind, data);
    } catch (err) {
        console.error('[hub] Failed to uplink', kind, err);
    }
}

function flushGameLogLines() {
    const lines = pendingLines;
    pendingLines = [];
    if (lines.length) {
        send(UplinkKind.GAME_LOG, lines);
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
        queueMicrotask(flushGameLogLines);
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
    send(UplinkKind.GAME_LOG, lines);
    return true;
}

/**
 * @param {string} json - a raw IPC packet, as passed to vrcx.ipcEvent
 * @returns {boolean} true when the packet was taken and must not be processed here
 */
export function uplinkIpcEvent(json) {
    if (!shouldUplink()) {
        return false;
    }
    send(UplinkKind.IPC, json);
    return true;
}

/**
 * Tell the Hub whether the game is running here. Unlike the other two this
 * does not replace local processing; the caller carries on regardless.
 *
 * @param {{ isGameRunning: boolean, isSteamVRRunning: boolean }} state
 * @returns {boolean} true when there is a Hub to tell
 */
export function uplinkGameState(state) {
    if (!shouldUplink()) {
        return false;
    }
    const normalised = {
        isGameRunning: Boolean(state?.isGameRunning),
        isSteamVRRunning: Boolean(state?.isSteamVRRunning)
    };
    const key = `${normalised.isGameRunning}:${normalised.isSteamVRRunning}`;
    if (key !== lastGameState) {
        lastGameState = key;
        send(UplinkKind.GAME_STATE, normalised);
    }
    return true;
}
