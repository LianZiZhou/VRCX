/**
 * [hub] A tap on every socket this client talks over, for the Socket Inspect
 * window.
 *
 * Three channels, each recorded at the one place the traffic passes:
 *
 *   vrchat   the VRChat pipeline, as the socket delivered it (standalone and
 *            Hub) or as the Hub relayed it (mirror) -- `shared/pipelineRelay.js`
 *   hub      events from the Hub link other than the relayed pipeline:
 *            game log echoes, Photon, game state, session, hub state
 *   uplink   what this machine sends to the Hub
 *
 * Every message goes into a ring buffer regardless, so the window opens with
 * history. Pushing to the window costs an interop call per message and only
 * happens while a window is open: the C# side flips `setEnabled` through
 * `window.__vrcxSocketInspect` when the window loads and closes. On the
 * headless Hub `AppApi` is a stub and nothing ever enables it.
 *
 * Dependency-free: `shared/pipelineRelay.js` imports this, and that module
 * sits under `services/websocket.js`.
 */

/** How many messages the buffer keeps for a window that opens later. */
export const INSPECTOR_BUFFER = 500;
/** Longer payloads are cut for the window; the full length is still reported. */
export const INSPECTOR_MAX_RAW = 64 * 1024;

export const SocketChannel = Object.freeze({
    VRCHAT: 'vrchat',
    HUB: 'hub',
    UPLINK: 'uplink'
});

export const inspectorStats = { recorded: 0, pushed: 0, pushFailures: 0 };

/** @type {Array<object>} */
let buffer = [];
let seq = 0;
let enabled = false;
/** @type {((json: string) => void) | null} */
let pusher = null;

const TYPE_FIELD = /"type"\s*:\s*"([^"]{1,64})"/;

/**
 * @param {any} value
 * @returns {string}
 */
function stringify(value) {
    if (typeof value === 'string') {
        return value;
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

/**
 * @param {string} channel
 * @param {string} raw
 * @param {any} payload
 * @returns {string}
 */
function deriveType(channel, raw, payload) {
    if (channel === SocketChannel.VRCHAT) {
        // The cheap way: one regex rather than a parse per pipeline message.
        return TYPE_FIELD.exec(raw)?.[1] ?? '?';
    }
    if (payload && typeof payload === 'object' && typeof payload.type === 'string') {
        return payload.type;
    }
    return '?';
}

/**
 * Hand a message to the C# side, which forwards it to the window.
 *
 * @param {object} frame
 */
function push(frame) {
    const send = pusher ?? defaultPusher;
    try {
        send(JSON.stringify(frame));
        inspectorStats.pushed++;
    } catch (err) {
        inspectorStats.pushFailures++;
        if (inspectorStats.pushFailures === 1) {
            console.warn('[hub] Socket inspector push failed:', err);
        }
    }
}

/**
 * @param {string} json
 */
function defaultPusher(json) {
    const api = globalThis.AppApi;
    if (typeof api?.SocketInspectPush === 'function') {
        api.SocketInspectPush(json);
    }
}

/**
 * Record one message.
 *
 * @param {string} channel - one of `SocketChannel`
 * @param {'in' | 'out'} direction
 * @param {any} payload - the raw string, or the object as it was handed over
 * @param {{ type?: string, via?: string }} [meta]
 * @returns {object} the entry
 */
export function recordSocketMessage(channel, direction, payload, meta = {}) {
    const raw = stringify(payload);
    const entry = {
        id: ++seq,
        at: Date.now(),
        channel,
        direction,
        type: meta.type ?? deriveType(channel, raw, payload),
        via: meta.via ?? null,
        size: raw.length,
        raw: raw.length > INSPECTOR_MAX_RAW ? raw.slice(0, INSPECTOR_MAX_RAW) : raw,
        truncated: raw.length > INSPECTOR_MAX_RAW
    };
    buffer.push(entry);
    if (buffer.length > INSPECTOR_BUFFER) {
        buffer.shift();
    }
    inspectorStats.recorded++;
    if (enabled) {
        push({ kind: 'message', entry });
    }
    return entry;
}

/** Send the whole buffer, for a window that just opened. */
export function replaySocketMessages() {
    push({ kind: 'backlog', entries: buffer, stats: { ...inspectorStats } });
}

/**
 * @param {boolean} on
 */
export function setSocketInspectorEnabled(on) {
    enabled = Boolean(on);
    if (enabled) {
        replaySocketMessages();
    }
}

/** @returns {boolean} */
export function isSocketInspectorEnabled() {
    return enabled;
}

/** @returns {object[]} a copy of the buffer */
export function socketInspectorSnapshot() {
    return [...buffer];
}

/**
 * @param {((json: string) => void) | null} fn - test seam; null restores the AppApi route
 */
export function setSocketInspectorPusher(fn) {
    pusher = fn;
}

/** Test seam. */
export function resetSocketInspector() {
    buffer = [];
    seq = 0;
    enabled = false;
    inspectorStats.recorded = 0;
    inspectorStats.pushed = 0;
    inspectorStats.pushFailures = 0;
}

/**
 * The surface the C# side drives with `ExecuteScriptAsync`.
 *
 * @param {object} [target]
 */
export function installSocketInspector(target = globalThis) {
    target.__vrcxSocketInspect = {
        setEnabled: setSocketInspectorEnabled,
        replay: replaySocketMessages,
        snapshot: socketInspectorSnapshot,
        stats: inspectorStats
    };
}

installSocketInspector();
