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
 * The originating client sends these up and does **not** process them locally.
 * The Hub processes them once, writes the rows, and broadcasts the result back
 * to every client including the sender. One code path, one writer, and no
 * double-processing on the machine that happened to produce the data.
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

/**
 * @param {((kind: string, data: any) => void) | null} fn
 */
export function setUplinkSender(fn) {
    sender = fn;
}

/** @returns {boolean} */
export function hasUplink() {
    return sender !== null;
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

/**
 * @param {string[]} lines - raw JSON strings, exactly as LogWatcher produced them
 */
export function uplinkGameLogLines(lines) {
    if (!lines?.length) {
        return;
    }
    send(UplinkKind.GAME_LOG, lines);
}

/**
 * @param {string} json - a raw IPC packet, as passed to vrcx.ipcEvent
 */
export function uplinkIpcEvent(json) {
    send(UplinkKind.IPC, json);
}

/**
 * @param {{ isGameRunning: boolean, isSteamVRRunning: boolean }} state
 */
export function uplinkGameState(state) {
    send(UplinkKind.GAME_STATE, state);
}
