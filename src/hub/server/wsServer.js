/**
 * [hub] The Hub's WebSocket server.
 *
 * Server-only module: it imports Node builtins and `ws`, so it must never end
 * up in the client import graph. Clients only ever reach for `hub/shared/**`
 * and `hub/client/**`.
 */

import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

import { WebSocketServer } from 'ws';

import { decodeFrame, encodeFrame, FrameType, PROTOCOL_VERSION, RejectReason } from '../shared/protocol.js';

const HEARTBEAT_MS = 30000;

/**
 * Constant-time token comparison. The token is a shared secret on a LAN, but
 * comparing it with `===` leaks its length and prefix to anything that can
 * reach the port.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function tokensMatch(a, b) {
    const left = Buffer.from(String(a ?? ''), 'utf8');
    const right = Buffer.from(String(b ?? ''), 'utf8');
    if (left.length !== right.length || left.length === 0) {
        return false;
    }
    return timingSafeEqual(left, right);
}

/**
 * @typedef {object} HubServerOptions
 * @property {number} port
 * @property {string} [host]
 * @property {string} token - shared secret every client must present
 * @property {{ key: string, cert: string }} [tls] - omit for a plain ws:// listener
 * @property {(className: string, method: string, args: any[]) => Promise<any>} handleCall
 * @property {(kind: string, data: any, client: object) => void} [onUplink]
 * @property {() => object} [describe] - extra fields for the `welcome` frame
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
        describe = () => ({})
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
     * @param {object} frame
     */
    function send(socket, frame) {
        if (socket.readyState === socket.OPEN) {
            socket.send(encodeFrame(frame));
        }
    }

    /**
     * @param {import('ws').WebSocket} socket
     * @param {string} reason
     */
    function reject(socket, reason) {
        send(socket, { t: FrameType.REJECT, p: { reason } });
        socket.close(4001, reason);
    }

    wss.on('connection', (socket, request) => {
        socket.isAuthenticated = false;
        socket.isAlive = true;
        socket.remoteLabel = request.socket.remoteAddress ?? 'unknown';

        socket.on('pong', () => {
            socket.isAlive = true;
        });

        socket.on('message', async (raw) => {
            let frame;
            try {
                frame = decodeFrame(raw);
            } catch {
                reject(socket, 'malformed-frame');
                return;
            }

            if (!socket.isAuthenticated) {
                // Nothing but `hello` is accepted before the handshake.
                if (frame.t !== FrameType.HELLO) {
                    reject(socket, RejectReason.BAD_TOKEN);
                    return;
                }
                if (!tokensMatch(frame.p?.token, token)) {
                    reject(socket, RejectReason.BAD_TOKEN);
                    return;
                }
                if (frame.p?.protocol !== PROTOCOL_VERSION) {
                    reject(socket, RejectReason.PROTOCOL_MISMATCH);
                    return;
                }
                socket.isAuthenticated = true;
                socket.clientName = String(frame.p?.client ?? 'unknown');
                clients.add(socket);
                send(socket, {
                    t: FrameType.WELCOME,
                    p: { protocol: PROTOCOL_VERSION, ...describe() }
                });
                return;
            }

            switch (frame.t) {
                case FrameType.CALL: {
                    const { c, m, a } = frame.p ?? {};
                    try {
                        const value = await handleCall(c, m, a ?? []);
                        send(socket, { i: frame.i, t: FrameType.RESULT, p: value });
                    } catch (err) {
                        send(socket, {
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

                case FrameType.PING:
                    send(socket, { i: frame.i, t: FrameType.PONG });
                    break;

                default:
                    break;
            }
        });

        socket.on('close', () => {
            clients.delete(socket);
        });

        socket.on('error', () => {
            clients.delete(socket);
        });
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
         * @param {string} event - one of `EventType`
         * @param {any} payload
         * @param {{ except?: object }} [opts]
         */
        broadcast(event, payload, opts = {}) {
            const frame = encodeFrame({ t: FrameType.EVENT, p: { event, data: payload } });
            for (const socket of clients) {
                if (socket === opts.except) {
                    continue;
                }
                if (socket.readyState === socket.OPEN) {
                    socket.send(frame);
                }
            }
        },

        /** @returns {number} */
        get clientCount() {
            return clients.size;
        },

        /** @returns {number} the port actually bound (useful when port is 0) */
        get address() {
            return httpServer.address();
        }
    };
}
