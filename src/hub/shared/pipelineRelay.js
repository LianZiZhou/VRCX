/**
 * [hub] Relay point for VRChat pipeline messages.
 *
 * The Hub holds the one and only pipeline socket. Mirror clients do not open
 * their own — partly because the user asked for collection to be centralised,
 * partly so a single VRChat session is not carrying N sockets.
 *
 * Two directions meet here, and keeping them in one dependency-free module is
 * what avoids an import cycle with `services/websocket.js`:
 *
 *   Hub:    `services/websocket.js` calls `emitPipelineMessage(raw)` for every
 *           message it receives; the Hub registers an observer and broadcasts.
 *   Mirror: the Hub connection calls `injectPipelineMessage(raw)`, which hands
 *           the message to the same `handlePipeline` the socket would have.
 *
 * `services/websocket.js` registers its own `handlePipeline` as the injector at
 * module scope, so this module never imports it back.
 */

/** @type {((raw: string) => void) | null} */
let observer = null;

/** @type {((args: {json: any}) => void) | null} */
let injector = null;

/**
 * Registered by the Hub. Receives raw pipeline payloads exactly as VRChat sent
 * them, after the socket's duplicate-message check.
 *
 * @param {((raw: string) => void) | null} fn
 */
export function setPipelineObserver(fn) {
    observer = fn;
}

/**
 * Registered by `services/websocket.js` so relayed messages can be dispatched
 * through the same handler a live socket would use.
 *
 * @param {((args: {json: any}) => void) | null} fn
 */
export function setPipelineInjector(fn) {
    injector = fn;
}

/**
 * @param {string} raw
 */
export function emitPipelineMessage(raw) {
    if (!observer) {
        return;
    }
    try {
        observer(raw);
    } catch (err) {
        console.error('[hub] Pipeline observer failed:', err);
    }
}

/**
 * Feed a relayed pipeline message into the local stores.
 *
 * Parsing mirrors `services/websocket.js#connectWebSocket` exactly, including
 * the double parse of `content`, so a mirror client sees byte-identical input
 * to what a directly-connected client would have seen.
 *
 * @param {string} raw
 */
export function injectPipelineMessage(raw) {
    if (!injector) {
        return;
    }
    let json;
    try {
        json = JSON.parse(raw);
        json.content = JSON.parse(json.content);
    } catch {
        // Matches upstream: a content field that is not JSON is left as-is.
    }
    try {
        injector({ json });
    } catch (err) {
        console.error('[hub] Failed to handle a relayed pipeline message:', err);
    }
}

/** @returns {boolean} */
export function hasPipelineObserver() {
    return observer !== null;
}
