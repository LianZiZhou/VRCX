/**
 * [hub] Application-layer encryption for the Hub link.
 *
 * Why this exists rather than TLS: the mirror client's socket is created in the
 * VRCX renderer with the browser `WebSocket` API. A browser refuses `wss://`
 * to a self-signed certificate and exposes no way to inspect or pin a
 * fingerprint, so trust-on-first-use is simply not reachable from that layer.
 * Fixing it at the host layer would mean editing `src-electron/main.js` *and*
 * the CefSharp request handler in `Dotnet/`, which is exactly the upstream
 * footprint this fork is trying to avoid.
 *
 * So the channel is a pre-shared-key AEAD instead. The shape is deliberately
 * conventional; the only thing bespoke is the framing.
 *
 *   1. Client sends a random 16-byte `clientNonce` in the clear.
 *   2. Server replies with a random 16-byte `serverNonce` in the clear.
 *   3. Both sides derive two AES-256-GCM keys with HKDF-SHA256 over the shared
 *      token, salted with both nonces. One key per direction, so the two
 *      directions can never collide on an IV.
 *   4. The client proves it holds the token by sending a sealed `auth` frame.
 *      The token itself never goes on the wire; the GCM tag is the proof.
 *
 * Per message: a 64-bit counter, unique per key. The IV is derived from that
 * counter, so a repeated IV is impossible without a repeated key, and the key
 * is fresh for every connection. Receivers require strictly increasing
 * counters, which is what makes replay and reordering detectable — WebSocket
 * is already ordered and reliable, so a gap means tampering.
 *
 * Runs unchanged in the CefSharp renderer, the Electron renderer and Node:
 * all three provide Web Crypto (the repo already relies on it in
 * `services/security.js`).
 */

const HKDF_INFO_C2S = 'vrcx-hub/v1/client-to-server';
const HKDF_INFO_S2C = 'vrcx-hub/v1/server-to-client';
const AUTH_PROOF = 'vrcx-hub/v1/auth';

const NONCE_BYTES = 16;
const IV_BYTES = 12;
const COUNTER_BYTES = 8;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * @returns {Crypto}
 */
function webcrypto() {
    const crypto = globalThis.crypto;
    if (!crypto?.subtle) {
        throw new Error('Web Crypto is unavailable; the Hub channel cannot be secured.');
    }
    return crypto;
}

/**
 * @param {number} [bytes]
 * @returns {string} hex
 */
export function randomNonce(bytes = NONCE_BYTES) {
    const buffer = new Uint8Array(bytes);
    webcrypto().getRandomValues(buffer);
    return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Derive the per-direction AES-GCM keys for one connection.
 *
 * @param {string} token - the shared secret
 * @param {string} clientNonce - hex, from the client's hello
 * @param {string} serverNonce - hex, from the server's challenge
 * @returns {Promise<{ clientToServer: CryptoKey, serverToClient: CryptoKey }>}
 */
export async function deriveChannelKeys(token, clientNonce, serverNonce) {
    if (!token) {
        throw new Error('A Hub token is required to derive channel keys.');
    }
    if (!clientNonce || !serverNonce) {
        throw new Error('Both handshake nonces are required to derive channel keys.');
    }

    const subtle = webcrypto().subtle;
    const ikm = await subtle.importKey('raw', encoder.encode(token), 'HKDF', false, ['deriveKey']);
    const salt = encoder.encode(`${clientNonce}:${serverNonce}`);

    const derive = (info) =>
        subtle.deriveKey(
            { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) },
            ikm,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );

    const [clientToServer, serverToClient] = await Promise.all([derive(HKDF_INFO_C2S), derive(HKDF_INFO_S2C)]);
    return { clientToServer, serverToClient };
}

/**
 * @param {bigint} counter
 * @returns {Uint8Array} a 12-byte IV: four zero bytes then the counter
 */
function ivForCounter(counter) {
    const iv = new Uint8Array(IV_BYTES);
    const view = new DataView(iv.buffer);
    view.setBigUint64(IV_BYTES - COUNTER_BYTES, counter, false);
    return iv;
}

/**
 * Seals frames for one direction.
 *
 * Encryption is async, so sends are serialised through a promise chain. Without
 * that, two concurrent seals could resolve out of order and arrive with
 * non-monotonic counters, which the receiver would (correctly) treat as
 * tampering.
 *
 * The counter is taken inside the chain, after the frame has been encoded: a
 * frame that cannot be serialised must not burn a number, or every frame
 * after it would be rejected as a gap.
 *
 * @param {CryptoKey} key
 * @returns {{ seal: (frame: object) => Promise<Uint8Array>, counter: () => bigint }}
 */
export function createSealer(key) {
    let counter = 0n;
    let chain = Promise.resolve();

    return {
        /**
         * @param {object} frame
         * @returns {Promise<Uint8Array>} counter prefix followed by ciphertext
         */
        seal(frame) {
            const result = chain.then(async () => {
                const plaintext = encoder.encode(JSON.stringify(frame));
                const seq = counter++;
                const ciphertext = new Uint8Array(
                    await webcrypto().subtle.encrypt({ name: 'AES-GCM', iv: ivForCounter(seq) }, key, plaintext)
                );
                const out = new Uint8Array(COUNTER_BYTES + ciphertext.length);
                new DataView(out.buffer).setBigUint64(0, seq, false);
                out.set(ciphertext, COUNTER_BYTES);
                return out;
            });
            // Keep the chain alive but never let one failure poison the rest.
            chain = result.then(
                () => undefined,
                () => undefined
            );
            return result;
        },
        counter: () => counter
    };
}

export class ChannelSecurityError extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = 'ChannelSecurityError';
    }
}

/**
 * Opens frames for one direction, enforcing strictly increasing counters.
 *
 * Serialised the same way as the sealer, and for a reason that only shows up
 * under load: a socket's message events fire back to back for frames that
 * arrived in one read, and decryption is asynchronous. Without the chain,
 * every frame in the burst checked its counter against the *same* expected
 * value while the first one was still being decrypted, and all but the first
 * were reported as dropped -- which is exactly what a desktop client's start-up
 * flurry of queries produced against a real Hub.
 *
 * @param {CryptoKey} key
 * @returns {{ open: (bytes: ArrayBuffer | Uint8Array) => Promise<object> }}
 */
export function createOpener(key) {
    let expected = 0n;
    let chain = Promise.resolve();

    /**
     * @param {ArrayBuffer | Uint8Array} bytes
     * @returns {Promise<object>}
     */
    async function openNow(bytes) {
        const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        if (data.length <= COUNTER_BYTES) {
            throw new ChannelSecurityError('Truncated hub frame');
        }
        const seq = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(0, false);
        if (seq < expected) {
            throw new ChannelSecurityError(`Replayed or reordered hub frame (seq ${seq})`);
        }
        if (seq > expected) {
            throw new ChannelSecurityError(`Dropped hub frame (expected ${expected}, got ${seq})`);
        }

        let plaintext;
        try {
            plaintext = await webcrypto().subtle.decrypt(
                { name: 'AES-GCM', iv: ivForCounter(seq) },
                key,
                data.subarray(COUNTER_BYTES)
            );
        } catch {
            // A bad tag means either the wrong token or a tampered frame.
            // They are indistinguishable here, and should be.
            throw new ChannelSecurityError('Hub frame failed authentication');
        }

        expected = seq + 1n;
        return JSON.parse(decoder.decode(plaintext));
    }

    return {
        /**
         * @param {ArrayBuffer | Uint8Array} bytes
         * @returns {Promise<object>}
         */
        open(bytes) {
            const result = chain.then(() => openNow(bytes));
            // A rejected frame ends that connection anyway; the chain itself
            // must not stay rejected.
            chain = result.then(
                () => undefined,
                () => undefined
            );
            return result;
        }
    };
}

/**
 * The client's proof-of-possession payload. Sealed under the client-to-server
 * key: producing a frame the server can open *is* the proof, so the token
 * itself never travels.
 *
 * @param {string} clientNonce
 * @param {string} serverNonce
 * @returns {object}
 */
export function buildAuthProof(clientNonce, serverNonce) {
    return { proof: AUTH_PROOF, clientNonce, serverNonce };
}

/**
 * @param {any} frame
 * @param {string} clientNonce
 * @param {string} serverNonce
 * @returns {boolean}
 */
export function isValidAuthProof(frame, clientNonce, serverNonce) {
    return frame?.proof === AUTH_PROOF && frame?.clientNonce === clientNonce && frame?.serverNonce === serverNonce;
}
