/**
 * [hub] Mirror-client side of the Hub link.
 *
 * Runs inside the VRCX renderer (CefSharp or Electron) and, in tests, in Node.
 * All three provide a global `WebSocket` and Web Crypto, so this module uses
 * those rather than any Node-specific library — nothing here may pull in a Node
 * builtin, or it would break the browser bundle.
 *
 * Handshake (see `shared/secureChannel.js` for why it is done this way):
 *
 *   -> hello      plaintext, protocol version + our random nonce
 *   <- challenge  plaintext, the Hub's random nonce
 *      ...both sides now derive per-direction AES-GCM keys from the token...
 *   -> auth       sealed; being able to produce it is the proof we hold the token
 *   <- welcome    sealed; Hub identity and database schema version
 *
 * After that every frame in both directions is sealed.
 */

import { decodeFrame, encodeFrame, FrameType, PROTOCOL_VERSION } from '../shared/protocol.js';
import {
    buildAuthProof,
    ChannelSecurityError,
    createOpener,
    createSealer,
    deriveChannelKeys,
    randomNonce
} from '../shared/secureChannel.js';

/** How long a single interop call may take before it is abandoned. */
const CALL_TIMEOUT_MS = 30000;
const HANDSHAKE_TIMEOUT_MS = 15000;
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
    let handshakeTimer = null;
    let closedByUs = false;

    let sealer = null;
    let opener = null;
    let clientNonce = null;

    /** @type {Map<number, {resolve: Function, reject: Function, timer: any}>} */
    const pending = new Map();
    /** Resolved once the current attempt reaches `welcome`. */
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
     * Fail every in-flight call. Leaving them pending would hang the UI on a
     * dead link.
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

    function clearHandshakeTimer() {
        if (handshakeTimer) {
            clearTimeout(handshakeTimer);
            handshakeTimer = null;
        }
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
                // connect() already reported this through onStateChange.
            });
        }, delay);
    }

    /**
     * @param {object} frame
     * @returns {Promise<void>}
     */
    async function sendSealed(frame) {
        if (!socket || !sealer) {
            throw new Error('Hub channel is not established');
        }
        socket.send(await sealer.seal(frame));
    }

    /**
     * Plaintext handshake frames. Only `challenge` and `reject` are accepted
     * here; anything else means the Hub is not speaking our protocol.
     *
     * @param {string} data
     */
    async function handlePlaintext(data) {
        let frame;
        try {
            frame = decodeFrame(data);
        } catch {
            return;
        }

        if (frame.t === FrameType.REJECT) {
            const error = new HubRejectedError(frame.p?.reason ?? 'unknown');
            clearHandshakeTimer();
            setState(ConnectionState.REJECTED, error);
            handshake?.reject(error);
            handshake = null;
            // A rejection is a configuration problem (wrong token, version
            // mismatch). Retrying on a timer would just hammer the Hub.
            closedByUs = true;
            return;
        }

        if (frame.t !== FrameType.CHALLENGE || typeof frame.p?.serverNonce !== 'string') {
            return;
        }
        if (sealer) {
            // A second challenge on an established channel is not legitimate.
            throw new ChannelSecurityError('Unexpected challenge frame');
        }

        const serverNonce = frame.p.serverNonce;
        const keys = await deriveChannelKeys(token, clientNonce, serverNonce);
        sealer = createSealer(keys.clientToServer);
        opener = createOpener(keys.serverToClient);
        await sendSealed({ t: FrameType.AUTH, p: buildAuthProof(clientNonce, serverNonce) });
    }

    /**
     * @param {ArrayBuffer} data
     */
    async function handleSealed(data) {
        if (!opener) {
            throw new ChannelSecurityError('Sealed frame before the channel was established');
        }
        const frame = await opener.open(data);

        switch (frame.t) {
            case FrameType.WELCOME:
                welcomeInfo = frame.p ?? {};
                reconnectAttempts = 0;
                clearHandshakeTimer();
                setState(ConnectionState.READY, welcomeInfo);
                handshake?.resolve(welcomeInfo);
                handshake = null;
                break;

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
        sealer = null;
        opener = null;
        clientNonce = randomNonce();
        setState(ConnectionState.CONNECTING);

        let resolve;
        let reject;
        const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });
        handshake = { promise, resolve, reject };

        socket = new WebSocketImpl(url);
        socket.binaryType = 'arraybuffer';

        handshakeTimer = setTimeout(() => {
            handshakeTimer = null;
            // A Hub that accepts the socket but never completes the handshake
            // would otherwise leave the client waiting forever.
            socket?.close(4008, 'handshake-timeout');
        }, HANDSHAKE_TIMEOUT_MS);

        socket.onopen = () => {
            socket.send(
                encodeFrame({
                    t: FrameType.HELLO,
                    p: { protocol: PROTOCOL_VERSION, client: clientName, clientNonce }
                })
            );
        };

        socket.onmessage = (message) => {
            const handler =
                typeof message.data === 'string' ? handlePlaintext(message.data) : handleSealed(message.data);
            handler.catch((err) => {
                if (err instanceof ChannelSecurityError) {
                    setState(ConnectionState.REJECTED, err);
                    handshake?.reject(err);
                    handshake = null;
                    closedByUs = true;
                    socket?.close(4009, 'channel-security');
                    return;
                }
                console.error('[hub] Failed to process a frame:', err);
            });
        };

        socket.onerror = () => {
            // `onclose` always follows; do the teardown there so it happens once.
        };

        socket.onclose = () => {
            socket = null;
            sealer = null;
            opener = null;
            clearHandshakeTimer();
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
                sendSealed({ i: id, t: FrameType.CALL, p: { c: className, m: method, a: args } }).catch((err) => {
                    pending.delete(id);
                    clearTimeout(timer);
                    reject(err);
                });
            });
        },

        /**
         * Issue a maintenance operation (see `AdminOp` in `shared/protocol.js`).
         *
         * Same correlation as `call`, with a caller-chosen timeout: taking a
         * snapshot of a large database on a Raspberry Pi can legitimately take
         * longer than an interop call ever should.
         *
         * @param {string} op
         * @param {any} [payload]
         * @param {{ timeoutMs?: number }} [options]
         * @returns {Promise<any>}
         */
        admin(op, payload = {}, options = {}) {
            if (state !== ConnectionState.READY || !socket) {
                return Promise.reject(new Error('Hub connection is not ready'));
            }
            const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
            const id = ++seq;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`Hub admin call timed out: ${op}`));
                }, timeoutMs);
                pending.set(id, { resolve, reject, timer });
                sendSealed({ i: id, t: FrameType.ADMIN, p: { op, payload } }).catch((err) => {
                    pending.delete(id);
                    clearTimeout(timer);
                    reject(err);
                });
            });
        },

        /**
         * Push locally-sourced data (gamelog lines, Photon events, game state)
         * to the Hub. Fire and forget: the Hub persists it and echoes it back
         * as a broadcast event.
         *
         * @param {string} kind
         * @param {any} data
         * @returns {Promise<void>}
         */
        async uplink(kind, data) {
            if (state !== ConnectionState.READY || !socket) {
                return;
            }
            try {
                await sendSealed({ t: FrameType.UPLINK, p: { kind, data } });
            } catch (err) {
                console.error('[hub] Failed to uplink:', err);
            }
        },

        close() {
            closedByUs = true;
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            clearHandshakeTimer();
            failPending(new Error('Hub connection closed by client'));
            socket?.close(1000, 'client-shutdown');
            socket = null;
            sealer = null;
            opener = null;
            setState(ConnectionState.CLOSED);
        }
    };
}
