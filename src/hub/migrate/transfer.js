/**
 * [hub] The client half of the admin protocol: push a database up to a Hub,
 * pull a snapshot down from one, and wait for a Hub to come back.
 *
 * Runs in Node (the CLI) on top of the same `createHubConnection` the mirror
 * client uses in the browser, so the handshake, the encryption and the frame
 * correlation are the code that is already exercised on every VRCX start.
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';

import { AdminOp } from '../shared/protocol.js';
import { createHubConnection } from '../client/connection.js';
import { validateManifest, writeManifest } from './bundle.js';

/** Snapshotting or verifying a large database on a small box takes a while. */
const LONG_TIMEOUT_MS = 15 * 60 * 1000;
const CHUNK_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (err) => {
                clearTimeout(timer);
                reject(err);
            }
        );
    });
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Connect, authenticate, and make sure the Hub speaks `admin`.
 *
 * @param {{ url: string, token: string, clientName?: string, timeoutMs?: number }} options
 * @returns {Promise<{ connection: ReturnType<typeof createHubConnection>, welcome: object }>}
 */
export async function connectToHub(options) {
    const { url, token, clientName = 'vrcx-hub-migrate', timeoutMs = 10000 } = options;
    const connection = createHubConnection({ url, token, clientName, autoReconnect: false });
    let welcome;
    try {
        welcome = await withTimeout(
            connection.connect(),
            timeoutMs,
            `No answer from ${url} within ${timeoutMs / 1000}s`
        );
    } catch (err) {
        connection.close();
        throw err;
    }
    if (!welcome.admin) {
        connection.close();
        throw new Error(
            `The Hub at ${url} (${welcome.hub ?? 'unknown version'}) predates the migration tool. Update the Hub first.`
        );
    }
    return { connection, welcome };
}

/**
 * @param {ReturnType<typeof createHubConnection>} connection
 * @returns {Promise<object>}
 */
export function hubInfo(connection) {
    return connection.admin(AdminOp.INFO, {}, { timeoutMs: 60000 });
}

/**
 * Upload a database file and have the Hub stage it.
 *
 * @param {ReturnType<typeof createHubConnection>} connection
 * @param {object} options
 * @param {string} options.file - a self-contained SQLite file (a snapshot, not a live database)
 * @param {number} options.bytes
 * @param {string} options.sha256
 * @param {import('./bundle.js').BundleManifest} options.manifest
 * @param {(done: number, total: number) => void} [options.onProgress]
 * @param {number} [options.chunkBytes] - smaller than the Hub's limit, for tests
 * @returns {Promise<{ id: string, staged: boolean, restarting: boolean, replacesExisting: boolean }>}
 */
export async function uploadDatabase(connection, options) {
    const { file, bytes, sha256, manifest, onProgress, chunkBytes } = options;
    const begun = await connection.admin(AdminOp.IMPORT_BEGIN, { bytes, sha256, manifest });
    const { id } = begun;
    const size = Math.min(chunkBytes ?? begun.chunkBytes, begun.chunkBytes);

    const fd = openSync(file, 'r');
    const buffer = Buffer.alloc(size);
    let offset = 0;
    try {
        while (offset < bytes) {
            const read = readSync(fd, buffer, 0, size, offset);
            if (read <= 0) {
                throw new Error(`${file} is shorter than announced (${offset} of ${bytes} bytes)`);
            }
            await connection.admin(
                AdminOp.IMPORT_CHUNK,
                { id, offset, data: buffer.toString('base64', 0, read) },
                { timeoutMs: CHUNK_TIMEOUT_MS }
            );
            offset += read;
            onProgress?.(offset, bytes);
        }
    } catch (err) {
        await connection.admin(AdminOp.IMPORT_ABORT, { id }).catch(() => {});
        throw err;
    } finally {
        closeSync(fd);
    }

    return connection.admin(AdminOp.IMPORT_COMMIT, { id }, { timeoutMs: LONG_TIMEOUT_MS });
}

/**
 * Pull a consistent copy of the Hub's data into a bundle directory.
 *
 * @param {ReturnType<typeof createHubConnection>} connection
 * @param {string} destDir
 * @param {{ onProgress?: (done: number, total: number) => void, chunkBytes?: number }} [options]
 * @returns {Promise<import('./bundle.js').BundleManifest>}
 */
export async function downloadSnapshot(connection, destDir, options = {}) {
    const { onProgress, chunkBytes } = options;
    const { id, manifest } = await connection.admin(AdminOp.SNAPSHOT_BEGIN, {}, { timeoutMs: LONG_TIMEOUT_MS });
    validateManifest(manifest);
    mkdirSync(destDir, { recursive: true });

    try {
        const entries = [
            { name: manifest.database.file, bytes: manifest.database.bytes, sha256: manifest.database.sha256 },
            ...manifest.files
        ];
        const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
        let done = 0;

        for (const entry of entries) {
            if (basename(entry.name) !== entry.name) {
                throw new Error(`Refusing snapshot entry with a path in its name: ${entry.name}`);
            }
            const hash = createHash('sha256');
            const fd = openSync(join(destDir, entry.name), 'w');
            let offset = 0;
            try {
                while (offset < entry.bytes) {
                    const length = Math.min(chunkBytes ?? entry.bytes, entry.bytes - offset);
                    const { data } = await connection.admin(
                        AdminOp.SNAPSHOT_READ,
                        { id, file: entry.name, offset, length },
                        { timeoutMs: CHUNK_TIMEOUT_MS }
                    );
                    const chunk = Buffer.from(data, 'base64');
                    if (chunk.length === 0) {
                        throw new Error(`The Hub returned no data for ${entry.name} at offset ${offset}`);
                    }
                    writeSync(fd, chunk);
                    hash.update(chunk);
                    offset += chunk.length;
                    done += chunk.length;
                    onProgress?.(done, total);
                }
            } finally {
                closeSync(fd);
            }
            const digest = hash.digest('hex');
            if (digest !== entry.sha256) {
                throw new Error(`${entry.name} arrived corrupted (digest ${digest}, expected ${entry.sha256})`);
            }
        }
        writeManifest(destDir, manifest);
    } finally {
        await connection.admin(AdminOp.SNAPSHOT_END, { id }).catch(() => {});
    }
    return manifest;
}

/**
 * Poll a Hub until `predicate(info)` holds or time runs out.
 *
 * Used after an import: the Hub goes away to restart, and comes back with
 * `lastImport` set once the staged file is in place.
 *
 * @param {{ url: string, token: string, predicate: (info: object) => boolean,
 *           timeoutMs?: number, intervalMs?: number, onAttempt?: (attempt: number) => void }} options
 * @returns {Promise<object | null>} the info that satisfied the predicate, or null
 */
export async function waitForHub(options) {
    const { url, token, predicate, timeoutMs = 90000, intervalMs = 2000, onAttempt } = options;
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    while (Date.now() < deadline) {
        attempt += 1;
        onAttempt?.(attempt);
        try {
            const { connection } = await connectToHub({ url, token, timeoutMs: 5000 });
            try {
                const info = await hubInfo(connection);
                if (predicate(info)) {
                    return info;
                }
            } finally {
                connection.close();
            }
        } catch {
            // Not up yet; try again.
        }
        await sleep(intervalMs);
    }
    return null;
}
