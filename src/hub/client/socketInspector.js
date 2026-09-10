/**
 * [hub] A tap on every socket this client talks over, for the Socket Inspect
 * window.
 *
 * Two levels, recorded at the one place each passes:
 *
 *   Messages -- what the app sees:
 *   vrchat   the VRChat pipeline, as the socket delivered it (standalone and
 *            Hub) or as the Hub relayed it (mirror) -- `shared/pipelineRelay.js`
 *   hub      events from the Hub link other than the relayed pipeline:
 *            game log echoes, Photon, game state, session, hub state
 *   uplink   what this machine sends to the Hub
 *
 *   Frames -- what the wire carries:
 *   link     every frame of the Hub link, in both directions, as it leaves
 *            the sealer or comes out of the opener: the handshake, each
 *            `call` (every SQLite query and HTTP request a mirror makes) and
 *            its `result`/`error`, events, uplinks, admin, ping/pong. This is
 *            what the DevTools network tab shows as opaque binary, decoded.
 *
 * Every message goes into a ring buffer regardless, so the window opens with
 * history. Pushing to the window costs an interop call per message and only
 * happens while a window is open: the C# side flips `setEnabled` through
 * `window.__vrcxSocketInspect` when the window loads and closes. On the
 * headless Hub `AppApi` is a stub and nothing ever enables it.
 *
 * Dependency-free: `shared/pipelineRelay.js` and `client/connection.js`
 * import this, and both sit under `services/websocket.js`.
 */

/** How many messages the buffer keeps for a window that opens later. */
export const INSPECTOR_BUFFER = 500;
/** Link frames are far more frequent (every query is two), so they get their own. */
export const LINK_FRAME_BUFFER = 1000;
/** Longer payloads are cut for the window; the full length is still reported. */
export const INSPECTOR_MAX_RAW = 64 * 1024;

export const SocketChannel = Object.freeze({
    VRCHAT: 'vrchat',
    HUB: 'hub',
    UPLINK: 'uplink',
    LINK: 'link'
});

export const inspectorStats = { recorded: 0, frames: 0, pushed: 0, pushFailures: 0 };

/** @type {Array<object>} */
let buffer = [];
/** @type {Array<object>} */
let linkBuffer = [];
let seq = 0;
let enabled = false;
/** @type {((json: string) => void) | null} */
let pusher = null;
/** @type {Map<number, number>} call id -> when it went out, for the result's latency */
const outstanding = new Map();

const TYPE_FIELD = /"type"\s*:\s*"([^"]{1,64})"/;
const MASKED = '…';

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
 * @param {string} raw
 * @returns {{ raw: string, truncated: boolean }}
 */
function cut(raw) {
    return {
        raw: raw.length > INSPECTOR_MAX_RAW ? raw.slice(0, INSPECTOR_MAX_RAW) : raw,
        truncated: raw.length > INSPECTOR_MAX_RAW
    };
}

/**
 * Record one application-level message.
 *
 * @param {string} channel - one of `SocketChannel` other than `link`
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
        ...cut(raw)
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

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function clip(text, max) {
    const oneLine = String(text ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * One line that says what a link frame is, for the list.
 *
 * @param {object} frame
 * @returns {string}
 */
export function summariseLinkFrame(frame) {
    const p = frame?.p;
    switch (frame?.t) {
        case 'call': {
            const target = `${p?.c ?? '?'}.${p?.m ?? '?'}`;
            const first = p?.a?.[0];
            if (p?.c === 'WebApi' && first && typeof first === 'object') {
                return `${target} ${first.method ?? 'GET'} ${clip(first.url, 120)}`;
            }
            if (p?.c === 'WebApi' && typeof first === 'string') {
                try {
                    const options = JSON.parse(first);
                    return `${target} ${options.method ?? 'GET'} ${clip(options.url, 120)}`;
                } catch {
                    return target;
                }
            }
            return typeof first === 'string' ? `${target} ${clip(first, 120)}` : target;
        }
        case 'result':
            if (Array.isArray(p)) {
                return `${p.length} row${p.length === 1 ? '' : 's'}`;
            }
            if (p && typeof p === 'object' && 'status' in p) {
                return `HTTP ${p.status} ${clip(p.message, 100)}`;
            }
            return p === null || p === undefined ? 'empty' : clip(stringify(p), 120);
        case 'error':
            return `${p?.code ?? 'error'}: ${clip(p?.message, 120)}`;
        case 'event':
            return String(p?.event ?? '?');
        case 'uplink':
            return `${p?.kind ?? '?'}${Array.isArray(p?.data) ? ` ×${p.data.length}` : ''}`;
        case 'admin':
            return String(p?.op ?? '?');
        case 'hello':
            return `${p?.client ?? '?'} protocol ${p?.protocol ?? '?'}`;
        case 'welcome':
            return `${p?.hub ?? '?'} schema ${p?.databaseVersion ?? '?'}`;
        case 'reject':
            return String(p?.reason ?? '?');
        default:
            return '';
    }
}

/**
 * Secrets never reach the window. The session cookie blob travels in the
 * `session` event, in `WebApi.SetCookies` calls and `GetCookies` results.
 *
 * @param {object} frame
 * @param {object | null} [call] - the outbound call this frame answers, if known
 * @returns {object} the frame, or a masked copy
 */
export function maskLinkFrame(frame, call = null) {
    const p = frame?.p;
    if (frame?.t === 'event' && p?.event === 'session' && p?.data && typeof p.data === 'object') {
        return { ...frame, p: { ...p, data: { ...p.data, cookies: MASKED } } };
    }
    if (frame?.t === 'call' && p?.c === 'WebApi' && (p?.m === 'SetCookies' || p?.m === 'GetCookies')) {
        return { ...frame, p: { ...p, a: p.a?.map(() => MASKED) ?? [] } };
    }
    if (frame?.t === 'result' && call?.p?.c === 'WebApi' && call?.p?.m === 'GetCookies') {
        return { ...frame, p: MASKED };
    }
    return frame;
}

/** @type {Map<number, object>} call id -> the outbound call frame, for masking its result */
const outstandingCalls = new Map();

/**
 * Record one frame of the Hub link, decoded.
 *
 * @param {'in' | 'out'} direction
 * @param {object} frame - the decoded frame
 * @param {number} [wireBytes] - what actually went over the socket, sealed
 * @returns {object} the entry
 */
export function recordLinkFrame(direction, frame, wireBytes = 0) {
    const now = Date.now();
    let latencyMs = null;
    let call = null;
    if (
        direction === 'out' &&
        typeof frame?.i === 'number' &&
        (frame.t === 'call' || frame.t === 'admin' || frame.t === 'ping')
    ) {
        outstanding.set(frame.i, now);
        if (frame.t === 'call') {
            outstandingCalls.set(frame.i, frame);
        }
        if (outstanding.size > 10000) {
            outstanding.clear();
            outstandingCalls.clear();
        }
    } else if (direction === 'in' && typeof frame?.i === 'number') {
        const sentAt = outstanding.get(frame.i);
        if (sentAt !== undefined) {
            latencyMs = now - sentAt;
            outstanding.delete(frame.i);
        }
        call = outstandingCalls.get(frame.i) ?? null;
        outstandingCalls.delete(frame.i);
    }
    const shown = maskLinkFrame(frame, call);
    const raw = stringify(shown);
    const entry = {
        id: ++seq,
        at: now,
        channel: SocketChannel.LINK,
        direction,
        type: String(frame?.t ?? '?'),
        via: null,
        frameId: typeof frame?.i === 'number' ? frame.i : null,
        summary: summariseLinkFrame(shown),
        size: raw.length,
        wireBytes,
        latencyMs,
        ...cut(raw)
    };
    linkBuffer.push(entry);
    if (linkBuffer.length > LINK_FRAME_BUFFER) {
        linkBuffer.shift();
    }
    inspectorStats.frames++;
    if (enabled) {
        push({ kind: 'message', entry });
    }
    return entry;
}

/** Send the whole history, for a window that just opened. */
export function replaySocketMessages() {
    const entries = [...buffer, ...linkBuffer].sort((a, b) => a.id - b.id);
    push({ kind: 'backlog', entries, stats: { ...inspectorStats } });
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

/** @returns {object[]} a copy of the message buffer */
export function socketInspectorSnapshot() {
    return [...buffer];
}

/** @returns {object[]} a copy of the link frame buffer */
export function linkFrameSnapshot() {
    return [...linkBuffer];
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
    linkBuffer = [];
    seq = 0;
    enabled = false;
    outstanding.clear();
    outstandingCalls.clear();
    inspectorStats.recorded = 0;
    inspectorStats.frames = 0;
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
        frames: linkFrameSnapshot,
        stats: inspectorStats
    };
}

installSocketInspector();
