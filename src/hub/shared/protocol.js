/**
 * [hub] Wire protocol shared by the Hub server and mirror clients.
 *
 * One WSS connection per client, JSON frames. A LAN link makes JSON fast
 * enough; if large result sets ever justify it, a binary channel can be added
 * behind the same frame envelope.
 */

/**
 * Bumped whenever a frame shape or the interop contract changes. The Hub and
 * the client must agree exactly — a half-compatible pair fails in ways that are
 * very hard to diagnose, so `hello`/`welcome` rejects a mismatch outright.
 */
export const PROTOCOL_VERSION = 1;

export const FrameType = {
    /** client -> hub: versions + client nonce. Cleartext, carries no secret. */
    HELLO: 'hello',
    /** hub -> client: server nonce. Cleartext; both sides now derive keys. */
    CHALLENGE: 'challenge',
    /** client -> hub: sealed proof of token possession. First encrypted frame. */
    AUTH: 'auth',
    /** hub -> client: accepted, with hub identity and schema version */
    WELCOME: 'welcome',
    /** hub -> client: rejected (bad token, version mismatch) */
    REJECT: 'reject',
    /** client -> hub: interop call */
    CALL: 'call',
    /** hub -> client: interop result */
    RESULT: 'result',
    /** hub -> client: interop failure */
    ERROR: 'error',
    /** hub -> clients: broadcast (pipeline, gamelog, ipc, game-state, session) */
    EVENT: 'event',
    /** client -> hub: locally-sourced data (gamelog lines, photon, game state) */
    UPLINK: 'uplink',
    /** client -> hub: a maintenance operation (see `AdminOp`); answered with result/error */
    ADMIN: 'admin',
    PING: 'ping',
    PONG: 'pong'
};

export const EventType = {
    /** raw VRChat pipeline message, fed to handlePipeline() on each client */
    PIPELINE: 'pipeline',
    /** a processed gamelog entry, already persisted by the Hub */
    GAMELOG: 'gamelog',
    /** Photon/IPC event originating from whichever client is running VRChat */
    IPC: 'ipc',
    /** isGameRunning / isHmdAfk / current location */
    GAME_STATE: 'game-state',
    /** login state changes, and the cookie blob clients mirror for offline use */
    SESSION: 'session',
    /** connection count, pipeline health, uptime */
    HUB_STATE: 'hub-state'
};

/**
 * Operations carried by the `admin` frame: moving a whole database in or out
 * of the Hub. They need no privilege beyond the shared token -- a client that
 * holds it already has unrestricted SQL through `call` -- but they are kept off
 * the interop path because they touch files, not rows, and because the Hub has
 * to restart to apply an import.
 *
 * The import is chunked so a multi-gigabyte database neither has to fit in one
 * frame nor be held in memory on a Raspberry Pi. Chunks are acknowledged one at
 * a time, which is all the flow control a LAN needs.
 */
export const AdminOp = {
    /** what the Hub is running, where its data lives, and any staged import */
    INFO: 'hub.info',
    /** announce an upload: size, digest, and the sender's manifest */
    IMPORT_BEGIN: 'import.begin',
    /** one base64 chunk at the offset the Hub last acknowledged */
    IMPORT_CHUNK: 'import.chunk',
    /** verify the upload, stage it, and (if a supervisor is present) restart */
    IMPORT_COMMIT: 'import.commit',
    IMPORT_ABORT: 'import.abort',
    /** take a consistent copy of the Hub's database and offer it for download */
    SNAPSHOT_BEGIN: 'snapshot.begin',
    SNAPSHOT_READ: 'snapshot.read',
    SNAPSHOT_END: 'snapshot.end'
};

/** Bytes per `import.chunk` / `snapshot.read`. Base64 grows this by a third. */
export const ADMIN_CHUNK_BYTES = 4 * 1024 * 1024;

export const RejectReason = {
    BAD_TOKEN: 'bad-token',
    BAD_HANDSHAKE: 'bad-handshake',
    PROTOCOL_MISMATCH: 'protocol-mismatch',
    SCHEMA_MISMATCH: 'schema-mismatch'
};

/**
 * Class/method allowlist for the `call` frame.
 *
 * This is deliberately far narrower than the in-process Electron bridge
 * (`src-electron/InteropApi.js`), which can construct *any* public class in the
 * `VRCX` namespace by name. That is acceptable for a same-process IPC channel
 * and unacceptable for one exposed on a network, even a LAN.
 *
 * `VRCXStorage` is intentionally absent: it backs `VRCX.json`, which holds
 * per-machine host settings (window geometry, GPU flags, DB path, proxy) and
 * must stay local on every client.
 */
export const CALL_ALLOWLIST = Object.freeze({
    SQLite: Object.freeze(['Execute', 'ExecuteJson', 'ExecuteNonQuery']),
    WebApi: Object.freeze(['Execute', 'ExecuteJson', 'GetCookies', 'SetCookies', 'ClearCookies'])
});

/**
 * @param {string} className
 * @param {string} method
 * @returns {boolean}
 */
export function isCallAllowed(className, method) {
    return CALL_ALLOWLIST[className]?.includes(method) ?? false;
}

/**
 * `services/sqlite.js` passes a `Map` for args on the LINUX path and a plain
 * object on the Windows path. Neither survives `JSON.stringify` identically, so
 * the wire always carries a plain object (or null).
 *
 * @param {Map<string, any> | Record<string, any> | null | undefined} args
 * @returns {Record<string, any> | null}
 */
export function argsToWire(args) {
    if (args === null || args === undefined) {
        return null;
    }
    if (args instanceof Map) {
        return Object.fromEntries(args);
    }
    return args;
}

/**
 * @param {Record<string, any> | null} wire
 * @returns {Map<string, any> | null}
 */
export function argsFromWire(wire) {
    if (wire === null || wire === undefined) {
        return null;
    }
    return new Map(Object.entries(wire));
}

/**
 * @param {object} frame
 * @returns {string}
 */
export function encodeFrame(frame) {
    return JSON.stringify(frame);
}

/**
 * @param {string | Buffer} data
 * @returns {object}
 * @throws {Error} when the payload is not a valid frame
 */
export function decodeFrame(data) {
    const frame = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
    if (frame === null || typeof frame !== 'object' || typeof frame.t !== 'string') {
        throw new Error('Malformed hub frame');
    }
    return frame;
}
