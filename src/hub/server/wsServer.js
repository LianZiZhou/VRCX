/**
 * [hub] The Hub's WebSocket server.
 *
 * Server-only module: it imports Node builtins and `ws`, so it must never end
 * up in the client import graph. Clients only ever reach for `hub/shared/**`
 * and `hub/client/**`.
 *
 * Every connection runs the pre-shared-key handshake from
 * `shared/secureChannel.js`. Only the first two frames are plaintext, and they
 * carry nothing but a protocol version and a random nonce. Everything after
 * that is AES-GCM sealed, and a plaintext frame arriving on an established
 * connection is treated as an attack and closes it.
 */

import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';

import { WebSocketServer } from 'ws';

import {
    CLIENT_ID_MIN_LENGTH,
    decodeFrame,
    encodeFrame,
    FrameType,
    PROTOCOL_VERSION,
    RejectReason
} from '../shared/protocol.js';
import {
    ChannelSecurityError,
    createOpener,
    createSealer,
    deriveChannelKeys,
    isValidAuthProof,
    randomNonce
} from '../shared/secureChannel.js';

const HEARTBEAT_MS = 30000;

const Phase = {
    AWAITING_HELLO: 'awaiting-hello',
    AWAITING_AUTH: 'awaiting-auth',
    READY: 'ready'
};

/**
 * @typedef {object} HubServerOptions
 * @property {number} port
 * @property {string} [host]
 * @property {string} token - the pre-shared secret; never sent over the wire
 * @property {{ key: string, cert: string }} [tls] - optional TLS on top of the AEAD
 * @property {(className: string, method: string, args: any[], client: object) => Promise<any>} handleCall
 * @property {(kind: string, data: any, client: object) => void} [onUplink]
 * @property {(client: object) => void} [onConnect] - a client completed the handshake and has been welcomed
 * @property {(client: object) => void} [onDisconnect] - an authenticated client's socket closed
 * @property {(op: string, payload: any, client: object) => Promise<any>} [onAdmin] - `admin` frames;
 *   absent means every one of them is answered with an `admin-unsupported` error
 * @property {() => object} [describe] - extra fields for the `welcome` frame
 * @property {(message: string, detail?: any) => void} [log]
 */

/**
 * @param {HubServerOptions} options
 */
export function createHubServer(options) {
    const {
        port,
        host = '0.0.0.0',
        token,
        tls = null,
        handleCall,
        onUplink = () => {},
        onConnect = () => {},
        onDisconnect = () => {},
        onAdmin = null,
        describe = () => ({}),
        log = () => {}
    } = options;

    if (!token) {
        throw new Error('A Hub token is required; refusing to listen without one.');
    }

    const httpServer = tls ? createHttpsServer({ key: tls.key, cert: tls.cert }) : createHttpServer();
    const wss = new WebSocketServer({ server: httpServer });

    /** Sockets that completed the handshake. */
    const clients = new Set();
    let heartbeat = null;

    /**
     * @param {import('ws').WebSocket} socket
     * @param {string} reason
     */
    function reject(socket, reason) {
        try {
            socket.send(encodeFrame({ t: FrameType.REJECT, p: { reason } }));
        } catch {
            // The socket may already be gone; closing is what matters.
        }
        socket.close(4001, reason);
    }

    /**
     * @param {import('ws').WebSocket} socket
     * @param {object} frame
     * @returns {Promise<void>}
     */
    async function sendSealed(socket, frame) {
        if (socket.readyState !== socket.OPEN || !socket.sealer) {
            return;
        }
        try {
            socket.send(await socket.sealer.seal(frame), { binary: true });
        } catch (err) {
            log('Failed to send sealed frame', err);
        }
    }

    /**
     * Step 1. Plaintext, carries only a protocol version and the client nonce.
     */
    async function handleHello(socket, raw, isBinary) {
        if (isBinary) {
            reject(socket, RejectReason.BAD_HANDSHAKE);
            return;
        }
        let frame;
        try {
            frame = decodeFrame(raw);
        } catch {
            reject(socket, RejectReason.BAD_HANDSHAKE);
            return;
        }
        if (frame.t !== FrameType.HELLO) {
            reject(socket, RejectReason.BAD_HANDSHAKE);
            return;
        }
        if (frame.p?.protocol !== PROTOCOL_VERSION) {
            reject(socket, RejectReason.PROTOCOL_MISMATCH);
            return;
        }
        const clientNonce = frame.p?.clientNonce;
        if (typeof clientNonce !== 'string' || clientNonce.length < 16) {
            reject(socket, RejectReason.BAD_HANDSHAKE);
            return;
        }
        // Stable across reconnects, so the Hub can keep a client's game state
        // through a link blip instead of ending its session on every close.
        const clientId = frame.p?.clientId;
        if (typeof clientId !== 'string' || clientId.length < CLIENT_ID_MIN_LENGTH) {
            reject(socket, RejectReason.BAD_HANDSHAKE);
            return;
        }

        const serverNonce = randomNonce();
        const keys = await deriveChannelKeys(token, clientNonce, serverNonce);
        socket.clientNonce = clientNonce;
        socket.serverNonce = serverNonce;
        socket.sealer = createSealer(keys.serverToClient);
        socket.opener = createOpener(keys.clientToServer);
        socket.clientName = String(frame.p?.client ?? 'unknown');
        socket.clientId = clientId;
        socket.connectedAt = Date.now();
        socket.phase = Phase.AWAITING_AUTH;

        socket.send(encodeFrame({ t: FrameType.CHALLENGE, p: { serverNonce } }));
    }

    /**
     * Step 2. The first sealed frame. Being able to open it at all is the proof
     * that the client holds the token, so there is no secret to compare here.
     */
    async function handleAuth(socket, raw, isBinary) {
        if (!isBinary) {
            reject(socket, RejectReason.BAD_HANDSHAKE);
            return;
        }
        const frame = await socket.opener.open(raw);
        const proofValid = isValidAuthProof(frame.p, socket.clientNonce, socket.serverNonce);
        if (frame.t !== FrameType.AUTH || !proofValid) {
            reject(socket, RejectReason.BAD_HANDSHAKE);
            return;
        }

        socket.phase = Phase.READY;
        clients.add(socket);
        log(`Client connected: ${socket.clientName} (${socket.remoteLabel})`);
        await sendSealed(socket, {
            t: FrameType.WELCOME,
            p: { protocol: PROTOCOL_VERSION, ...describe() }
        });
        try {
            onConnect(socket);
        } catch (err) {
            log('onConnect handler failed', err);
        }
    }

    /**
     * Steady state. Plaintext is no longer acceptable: allowing it would let
     * anyone who can reach the port inject unauthenticated frames.
     */
    async function handleSealed(socket, raw, isBinary) {
        if (!isBinary) {
            throw new ChannelSecurityError('Plaintext frame on an established channel');
        }
        const frame = await socket.opener.open(raw);

        switch (frame.t) {
            case FrameType.CALL: {
                const { c, m, a } = frame.p ?? {};
                try {
                    const value = await handleCall(c, m, a ?? [], socket);
                    await sendSealed(socket, { i: frame.i, t: FrameType.RESULT, p: value });
                } catch (err) {
                    await sendSealed(socket, {
                        i: frame.i,
                        t: FrameType.ERROR,
                        p: {
                            message: err instanceof Error ? err.message : String(err),
                            code: err?.code ?? 'interop-error'
                        }
                    });
                }
                break;
            }

            case FrameType.UPLINK:
                onUplink(frame.p?.kind, frame.p?.data, socket);
                break;

            case FrameType.ADMIN: {
                try {
                    if (!onAdmin) {
                        const error = new Error('This Hub does not support admin operations');
                        error.code = 'admin-unsupported';
                        throw error;
                    }
                    const value = await onAdmin(frame.p?.op, frame.p?.payload ?? {}, socket);
                    await sendSealed(socket, { i: frame.i, t: FrameType.RESULT, p: value ?? null });
                } catch (err) {
                    await sendSealed(socket, {
                        i: frame.i,
                        t: FrameType.ERROR,
                        p: {
                            message: err instanceof Error ? err.message : String(err),
                            code: err?.code ?? 'admin-error'
                        }
                    });
                }
                break;
            }

            case FrameType.PING:
                await sendSealed(socket, { i: frame.i, t: FrameType.PONG });
                break;

            default:
                break;
        }
    }

    wss.on('connection', (socket, request) => {
        socket.phase = Phase.AWAITING_HELLO;
        socket.isAlive = true;
        socket.remoteLabel = request.socket.remoteAddress ?? 'unknown';
        socket.sealer = null;
        socket.opener = null;

        socket.on('pong', () => {
            socket.isAlive = true;
        });

        socket.on('message', async (raw, isBinary) => {
            try {
                if (socket.phase === Phase.AWAITING_HELLO) {
                    await handleHello(socket, raw, isBinary);
                } else if (socket.phase === Phase.AWAITING_AUTH) {
                    await handleAuth(socket, raw, isBinary);
                } else {
                    await handleSealed(socket, raw, isBinary);
                }
            } catch (err) {
                if (err instanceof ChannelSecurityError) {
                    log(`Channel security failure from ${socket.remoteLabel}`, err.message);
                    clients.delete(socket);
                    reject(socket, RejectReason.BAD_TOKEN);
                    return;
                }
                log('Unhandled error while processing a hub frame', err);
                clients.delete(socket);
                socket.close(1011, 'internal-error');
            }
        });

        // `delete` is true only for a client that completed the handshake,
        // and only once, so the callback fires once per attached client.
        const gone = () => {
            if (clients.delete(socket)) {
                onDisconnect(socket);
            }
        };
        socket.on('close', gone);
        socket.on('error', gone);
    });

    return {
        /** @returns {Promise<void>} */
        start() {
            return new Promise((resolve, reject_) => {
                httpServer.once('error', reject_);
                httpServer.listen(port, host, () => {
                    httpServer.removeListener('error', reject_);
                    heartbeat = setInterval(() => {
                        for (const socket of clients) {
                            if (!socket.isAlive) {
                                socket.terminate();
                                clients.delete(socket);
                                continue;
                            }
                            socket.isAlive = false;
                            socket.ping();
                        }
                    }, HEARTBEAT_MS);
                    heartbeat.unref?.();
                    resolve();
                });
            });
        },

        /** @returns {Promise<void>} */
        stop() {
            if (heartbeat) {
                clearInterval(heartbeat);
                heartbeat = null;
            }
            for (const socket of clients) {
                socket.close(1001, 'hub-shutdown');
            }
            clients.clear();
            return new Promise((resolve) => {
                wss.close(() => httpServer.close(() => resolve()));
            });
        },

        /**
         * Push an event to every authenticated client.
         *
         * Each client has its own key and counter, so unlike a plaintext design
         * this cannot share one encoded buffer across sockets.
         *
         * @param {string} event - one of `EventType`
         * @param {any} payload
         * @param {{ except?: object }} [opts]
         * @returns {Promise<void>}
         */
        async broadcast(event, payload, opts = {}) {
            const frame = { t: FrameType.EVENT, p: { event, data: payload } };
            await Promise.all(
                [...clients].filter((socket) => socket !== opts.except).map((socket) => sendSealed(socket, frame))
            );
        },

        /**
         * Push an event to one authenticated client.
         *
         * @param {object} socket - a client handed to `onConnect`/`onUplink`
         * @param {string} event - one of `EventType`
         * @param {any} payload
         * @returns {Promise<void>}
         */
        async sendTo(socket, event, payload) {
            if (!clients.has(socket)) {
                return;
            }
            await sendSealed(socket, { t: FrameType.EVENT, p: { event, data: payload } });
        },

        /** @returns {number} */
        get clientCount() {
            return clients.size;
        },

        /** @returns {object[]} the attached clients, for status reporting */
        get clientList() {
            return [...clients];
        },

        /** @returns {object} the bound address (useful when port is 0) */
        get address() {
            return httpServer.address();
        }
    };
}
