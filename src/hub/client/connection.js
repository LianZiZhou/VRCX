/**
 * [hub] Mirror-client side of the Hub link.
 *
 * Runs inside the VRCX renderer (CefSharp or Electron) and, in tests, in Node.
 * All three provide a global `WebSocket`, so this module uses that rather than
 * any Node-specific socket library — nothing here may pull in a Node builtin.
 *
 * The URL scheme is deliberately not this module's concern: `ws://` and
 * `wss://` behave identically here. How the client comes to trust the Hub's
 * certificate is a deployment question, handled outside this file.
 */

import { decodeFrame, encodeFrame, FrameType, PROTOCOL_VERSION } from '../shared/protocol.js';

/** How long a single interop call may take before it is abandoned. */
const CALL_TIMEOUT_MS = 30000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export const ConnectionState = {
    IDLE: 'idle',
    CONNECTING: 'connecting',
    READY: 'ready',
    CLOSED: 'closed',
    REJECTED: 'rejected'
};

export class HubRejectedError extends Error {
    /**
     * @param {string} reason - one of `RejectReason`
     */
    constructor(reason) {
        super(`Hub rejected the connection: ${reason}`);
        this.name = 'HubRejectedError';
        this.reason = reason;
    }
}

/**
 * @typedef {object} HubConnectionOptions
 * @property {string} url
 * @property {string} token
 * @property {string} [clientName]
 * @property {(event: string, data: any) => void} [onEvent]
 * @property {(state: string, detail?: any) => void} [onStateChange]
 * @property {boolean} [autoReconnect]
 * @property {typeof WebSocket} [WebSocketImpl]
 */

/**
 * @param {HubConnectionOptions} options
 */
export function createHubConnection(options) {
    const {
        url,
        token,
        clientName = 'vrcx-client',
        onEvent = () => {},
        onStateChange = () => {},
        autoReconnect = true,
        WebSocketImpl = globalThis.WebSocket
    } = options;

    /** @type {WebSocket | null} */
    let socket = null;
    let state = ConnectionState.IDLE;
    let seq = 0;
    let reconnectAttempts = 0;
    let reconnectTimer = null;
    let closedByUs = false;

    /** @type {Map<number, {resolve: Function, reject: Function, timer: any}>} */
    const pending = new Map();
    /** Resolved once the current connection attempt reaches `welcome`. */
    let handshake = null;
    let welcomeInfo = null;

    /**
     * @param {string} next
     * @param {any} [detail]
     */
    function setState(next, detail) {
        state = next;
        onStateChange(next, detail);
    }

    /**
     * Fail every in-flight call. Called whenever the socket goes away: leaving
     * them pending would hang the UI on a dead link.
     *
     * @param {Error} error
     */
    function failPending(error) {
        for (const [, entry] of pending) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }
        pending.clear();
    }

    function scheduleReconnect() {
        if (!autoReconnect || closedByUs || reconnectTimer) {
            return;
        }
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
        reconnectAttempts++;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect().catch(() => {
                // connect() already reported the failure through onStateChange.
            });
        }, delay);
    }

    /**
     * @param {MessageEvent} message
     */
    function handleMessage(message) {
        let frame;
        try {
            frame = decodeFrame(message.data);
        } catch {
            return;
        }

        switch (frame.t) {
            case FrameType.WELCOME:
                welcomeInfo = frame.p ?? {};
                reconnectAttempts = 0;
                setState(ConnectionState.READY, welcomeInfo);
                handshake?.resolve(welcomeInfo);
                handshake = null;
                break;

            case FrameType.REJECT: {
                const error = new HubRejectedError(frame.p?.reason ?? 'unknown');
                setState(ConnectionState.REJECTED, error);
                handshake?.reject(error);
                handshake = null;
                // A rejection is a configuration problem (bad token, version
                // mismatch). Retrying on a timer would just hammer the Hub.
                closedByUs = true;
                break;
            }

            case FrameType.RESULT: {
                const entry = pending.get(frame.i);
                if (entry) {
                    pending.delete(frame.i);
                    clearTimeout(entry.timer);
                    entry.resolve(frame.p);
                }
                break;
            }

            case FrameType.ERROR: {
                const entry = pending.get(frame.i);
                if (entry) {
                    pending.delete(frame.i);
                    clearTimeout(entry.timer);
                    const error = new Error(frame.p?.message ?? 'Hub call failed');
                    error.code = frame.p?.code;
                    entry.reject(error);
                }
                break;
            }

            case FrameType.EVENT:
                onEvent(frame.p?.event, frame.p?.data);
                break;

            default:
                break;
        }
    }

    /**
     * @returns {Promise<object>} the `welcome` payload
     */
    function connect() {
        if (state === ConnectionState.CONNECTING || state === ConnectionState.READY) {
            return handshake?.promise ?? Promise.resolve(welcomeInfo);
        }
        closedByUs = false;
        setState(ConnectionState.CONNECTING);

        let resolve;
        let reject;
        const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });
        handshake = { promise, resolve, reject };

        socket = new WebSocketImpl(url);

        socket.onopen = () => {
            socket.send(
                encodeFrame({
                    t: FrameType.HELLO,
                    p: { token, protocol: PROTOCOL_VERSION, client: clientName }
                })
            );
        };

        socket.onmessage = handleMessage;

        socket.onerror = () => {
            // `onclose` always follows; do the teardown there so it happens once.
        };

        socket.onclose = () => {
            socket = null;
            const wasReady = state === ConnectionState.READY;
            if (state !== ConnectionState.REJECTED) {
                setState(ConnectionState.CLOSED);
            }
            const error = new Error('Hub connection closed');
            failPending(error);
            handshake?.reject(error);
            handshake = null;
            if (wasReady || !closedByUs) {
                scheduleReconnect();
            }
        };

        return promise;
    }

    return {
        connect,

        /** @returns {string} */
        get state() {
            return state;
        },

        /** @returns {object | null} the `welcome` payload from the current session */
        get info() {
            return welcomeInfo;
        },

        /**
         * Issue an interop call.
         *
         * @param {string} className
         * @param {string} method
         * @param {any[]} args
         * @returns {Promise<any>}
         */
        call(className, method, args = []) {
            if (state !== ConnectionState.READY || !socket) {
                return Promise.reject(new Error('Hub connection is not ready'));
            }
            const id = ++seq;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`Hub call timed out: ${className}.${method}`));
                }, CALL_TIMEOUT_MS);
                pending.set(id, { resolve, reject, timer });
                socket.send(encodeFrame({ i: id, t: FrameType.CALL, p: { c: className, m: method, a: args } }));
            });
        },

        /**
         * Push locally-sourced data (gamelog lines, Photon events, game state)
         * to the Hub. Fire and forget: the Hub persists it and echoes it back
         * as a broadcast event.
         *
         * @param {string} kind
         * @param {any} data
         */
        uplink(kind, data) {
            if (state !== ConnectionState.READY || !socket) {
                return;
            }
            socket.send(encodeFrame({ t: FrameType.UPLINK, p: { kind, data } }));
        },

        close() {
            closedByUs = true;
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            failPending(new Error('Hub connection closed by client'));
            socket?.close(1000, 'client-shutdown');
            socket = null;
            setState(ConnectionState.CLOSED);
        }
    };
}
