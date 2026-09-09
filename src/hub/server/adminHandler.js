/**
 * [hub] Executes `admin` frames: whole-database transfers in and out.
 *
 * Two flows, both chunked and both driven entirely by the client so that the
 * Hub never has to hold more than one chunk in memory:
 *
 *   import.begin -> import.chunk* -> import.commit
 *     The upload goes to a `.part` file under `import-pending/`, hashed as it
 *     arrives. `commit` compares the digest, checks the file is SQLite, stages
 *     it (see `pendingImport.js`) and asks for a restart.
 *
 *   snapshot.begin -> snapshot.read* -> snapshot.end
 *     `begin` takes a consistent copy of the live database into a private
 *     directory under `backups/` and describes it; `read` serves ranges of it;
 *     `end` removes it. Abandoned snapshots are swept on the next `begin`.
 *
 * Authentication is the channel's: an `admin` frame only arrives sealed under
 * a key derived from the token. There is no second credential, and on purpose
 * -- a holder of the token already has unrestricted SQL through `call`.
 */

import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import {
    closeSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    openSync,
    readdirSync,
    readSync,
    rmSync,
    statSync,
    writeSync
} from 'node:fs';
import { basename, join } from 'node:path';

import { ADMIN_CHUNK_BYTES, AdminOp } from '../shared/protocol.js';
import { BACKUPS_DIR, DATABASE_FILE, STORAGE_FILE, TOKEN_FILE } from '../migrate/dataDir.js';
import { buildManifest, validateManifest } from '../migrate/bundle.js';
import { inspectDatabase, isSqliteFile, sha256File, snapshotDatabase } from '../migrate/snapshot.js';
import { pendingDir, readLastImport, readPendingImport, stagePendingImport } from './pendingImport.js';

/** An upload nobody has touched for this long is abandoned. */
const UPLOAD_IDLE_MS = 10 * 60 * 1000;
/** A snapshot nobody finished downloading is swept after this long. */
const SNAPSHOT_TTL_MS = 60 * 60 * 1000;
/** Long enough for the `commit` reply to leave the socket before the restart. */
const RESTART_DELAY_MS = 250;
const SNAPSHOT_PREFIX = '.snapshot-';

export class HubAdminError extends Error {
    /**
     * @param {string} message
     * @param {string} [code]
     */
    constructor(message, code = 'admin-error') {
        super(message);
        this.name = 'HubAdminError';
        this.code = code;
    }
}

/**
 * @typedef {object} AdminHandlerOptions
 * @property {string} configDir
 * @property {string} databasePath
 * @property {string} hubVersion
 * @property {number} expectedSchemaVersion - what this build migrates a database to
 * @property {() => object} [getStatus] - live fields (login state, client count)
 * @property {((reason: string) => void) | null} [requestRestart] - null when the
 *   process cannot be restarted; imports are then applied on the next manual start
 * @property {(message: string, detail?: any) => void} [log]
 */

/**
 * @param {AdminHandlerOptions} options
 * @returns {(op: string, payload: any) => Promise<any>}
 */
export function createAdminHandler(options) {
    const {
        configDir,
        databasePath,
        hubVersion,
        expectedSchemaVersion,
        getStatus = () => ({}),
        requestRestart = null,
        log = () => {}
    } = options;

    /** @type {{ id: string, fd: number, path: string, bytes: number, sha256: string, received: number, hash: import('node:crypto').Hash, manifest: object, touchedAt: number } | null} */
    let upload = null;
    /** @type {Map<string, { dir: string, files: Map<string, string>, createdAt: number }>} */
    const snapshots = new Map();

    /**
     * @param {any} value
     * @param {string} name
     * @returns {number}
     */
    function requireCount(value, name) {
        if (!Number.isInteger(value) || value < 0) {
            throw new HubAdminError(`${name} must be a non-negative integer`, 'bad-request');
        }
        return value;
    }

    /**
     * @param {any} value
     * @returns {string}
     */
    function requireDigest(value) {
        if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
            throw new HubAdminError('sha256 must be 64 lowercase hex characters', 'bad-request');
        }
        return value;
    }

    function discardUpload() {
        if (!upload) {
            return;
        }
        try {
            closeSync(upload.fd);
        } catch {
            // Already closed.
        }
        rmSync(upload.path, { force: true });
        upload = null;
    }

    function sweepSnapshots() {
        const backups = join(configDir, BACKUPS_DIR);
        if (!existsSync(backups)) {
            return;
        }
        const now = Date.now();
        for (const [id, snapshot] of snapshots) {
            if (now - snapshot.createdAt > SNAPSHOT_TTL_MS) {
                rmSync(snapshot.dir, { recursive: true, force: true });
                snapshots.delete(id);
            }
        }
        // Directories left by a previous process, which this map never knew.
        for (const entry of readdirSync(backups, { withFileTypes: true })) {
            if (!entry.isDirectory() || !entry.name.startsWith(SNAPSHOT_PREFIX)) {
                continue;
            }
            const dir = join(backups, entry.name);
            const isOurs = [...snapshots.values()].some((snapshot) => snapshot.dir === dir);
            if (!isOurs && now - statSync(dir).mtimeMs > SNAPSHOT_TTL_MS) {
                rmSync(dir, { recursive: true, force: true });
            }
        }
    }

    /**
     * @returns {Promise<object>}
     */
    async function info() {
        let database = null;
        if (existsSync(databasePath)) {
            try {
                database = await inspectDatabase(databasePath);
            } catch (err) {
                database = { bytes: statSync(databasePath).size, error: err.message };
            }
        }
        return {
            hub: hubVersion,
            configDir,
            databasePath,
            expectedSchemaVersion,
            chunkBytes: ADMIN_CHUNK_BYTES,
            restartSupported: Boolean(requestRestart),
            database,
            pendingImport: readPendingImport(configDir),
            lastImport: readLastImport(configDir),
            uploadInProgress: upload ? { id: upload.id, received: upload.received, bytes: upload.bytes } : null,
            ...getStatus()
        };
    }

    /**
     * @param {any} payload
     * @returns {{ id: string, chunkBytes: number }}
     */
    function importBegin(payload) {
        const bytes = requireCount(payload.bytes, 'bytes');
        const sha256 = requireDigest(payload.sha256);
        if (bytes === 0) {
            throw new HubAdminError('Refusing to import an empty database', 'bad-request');
        }
        let manifest;
        try {
            manifest = validateManifest(payload.manifest);
        } catch (err) {
            throw new HubAdminError(err.message, 'bad-manifest');
        }
        if (manifest.database.bytes !== bytes || manifest.database.sha256 !== sha256) {
            throw new HubAdminError('The manifest does not describe the announced upload', 'bad-manifest');
        }
        if (
            Number.isInteger(manifest.database.schemaVersion) &&
            manifest.database.schemaVersion > expectedSchemaVersion
        ) {
            throw new HubAdminError(
                `The database schema (v${manifest.database.schemaVersion}) is newer than this Hub supports ` +
                    `(v${expectedSchemaVersion}). Update the Hub first.`,
                'schema-too-new'
            );
        }
        if (upload && Date.now() - upload.touchedAt < UPLOAD_IDLE_MS) {
            throw new HubAdminError('Another import is in progress', 'import-busy');
        }
        discardUpload();

        const dir = pendingDir(configDir);
        mkdirSync(dir, { recursive: true });
        const id = randomUUID();
        const path = join(dir, `${DATABASE_FILE}.${id}.part`);
        upload = {
            id,
            fd: openSync(path, 'w'),
            path,
            bytes,
            sha256,
            received: 0,
            hash: createHash('sha256'),
            manifest,
            touchedAt: Date.now()
        };
        log(`Import ${id} started: ${(bytes / 1048576).toFixed(1)} MB from ${manifest.source?.kind ?? 'unknown'}`);
        return { id, chunkBytes: ADMIN_CHUNK_BYTES };
    }

    /**
     * @param {any} payload
     * @returns {{ id: string }}
     */
    function requireUpload(payload) {
        if (!upload || upload.id !== payload.id) {
            throw new HubAdminError('No such import in progress', 'no-import');
        }
        upload.touchedAt = Date.now();
        return upload;
    }

    /**
     * @param {any} payload
     * @returns {{ received: number }}
     */
    function importChunk(payload) {
        const current = requireUpload(payload);
        const offset = requireCount(payload.offset, 'offset');
        if (offset !== current.received) {
            throw new HubAdminError(`Expected offset ${current.received}, got ${offset}`, 'bad-offset');
        }
        if (typeof payload.data !== 'string') {
            throw new HubAdminError('data must be a base64 string', 'bad-request');
        }
        const chunk = Buffer.from(payload.data, 'base64');
        if (chunk.length === 0 || chunk.length > ADMIN_CHUNK_BYTES) {
            throw new HubAdminError(`Chunk must be 1..${ADMIN_CHUNK_BYTES} bytes`, 'bad-request');
        }
        if (current.received + chunk.length > current.bytes) {
            discardUpload();
            throw new HubAdminError('Upload exceeded its announced size', 'bad-request');
        }
        writeSync(current.fd, chunk);
        current.hash.update(chunk);
        current.received += chunk.length;
        return { received: current.received };
    }

    /**
     * @param {any} payload
     * @returns {Promise<{ id: string, staged: boolean, restarting: boolean, replacesExisting: boolean }>}
     */
    async function importCommit(payload) {
        const current = requireUpload(payload);
        if (current.received !== current.bytes) {
            throw new HubAdminError(`Upload incomplete: ${current.received} of ${current.bytes} bytes`, 'incomplete');
        }
        closeSync(current.fd);
        const digest = current.hash.digest('hex');
        if (digest !== current.sha256) {
            rmSync(current.path, { force: true });
            upload = null;
            throw new HubAdminError('Upload digest mismatch; nothing was changed', 'digest-mismatch');
        }
        if (!isSqliteFile(current.path)) {
            rmSync(current.path, { force: true });
            upload = null;
            throw new HubAdminError('Upload is not a SQLite database; nothing was changed', 'not-sqlite');
        }

        const record = stagePendingImport(configDir, {
            id: current.id,
            partFile: current.path,
            bytes: current.bytes,
            sha256: current.sha256,
            manifest: current.manifest
        });
        upload = null;

        const replacesExisting = existsSync(databasePath);
        log(
            `Import ${record.id} staged; ${requestRestart ? 'restarting to apply it' : 'it will be applied on the next start'}`
        );
        if (requestRestart) {
            setTimeout(() => requestRestart(`database import ${record.id} staged`), RESTART_DELAY_MS).unref?.();
        }
        return { id: record.id, staged: true, restarting: Boolean(requestRestart), replacesExisting };
    }

    /**
     * @param {any} payload
     * @returns {{ aborted: boolean }}
     */
    function importAbort(payload) {
        if (upload && upload.id === payload.id) {
            log(`Import ${upload.id} aborted by the client`);
            discardUpload();
            return { aborted: true };
        }
        return { aborted: false };
    }

    /**
     * @returns {Promise<{ id: string, manifest: object }>}
     */
    async function snapshotBegin() {
        if (!existsSync(databasePath)) {
            throw new HubAdminError('This Hub has no database yet', 'no-database');
        }
        sweepSnapshots();

        const id = randomUUID();
        const dir = join(configDir, BACKUPS_DIR, `${SNAPSHOT_PREFIX}${id}`);
        mkdirSync(dir, { recursive: true });
        const files = new Map();

        const databaseCopy = join(dir, DATABASE_FILE);
        await snapshotDatabase(databasePath, databaseCopy);
        files.set(DATABASE_FILE, databaseCopy);

        const extras = [];
        for (const name of [STORAGE_FILE, TOKEN_FILE]) {
            const source = join(configDir, name);
            if (!existsSync(source)) {
                continue;
            }
            const copy = join(dir, name);
            copyFileSync(source, copy);
            files.set(name, copy);
            extras.push({ name, bytes: statSync(copy).size, sha256: await sha256File(copy) });
        }

        const summary = await inspectDatabase(databaseCopy);
        const manifest = buildManifest({
            tool: hubVersion,
            source: { kind: 'hub', dir: configDir, hubVersion },
            database: { file: DATABASE_FILE, sha256: await sha256File(databaseCopy), ...summary },
            files: extras
        });

        snapshots.set(id, { dir, files, createdAt: Date.now() });
        log(`Snapshot ${id} ready: ${(summary.bytes / 1048576).toFixed(1)} MB`);
        return { id, manifest };
    }

    /**
     * @param {any} payload
     * @returns {{ data: string, bytes: number }}
     */
    function snapshotRead(payload) {
        const snapshot = snapshots.get(payload.id);
        if (!snapshot) {
            throw new HubAdminError('No such snapshot', 'no-snapshot');
        }
        const name = String(payload.file ?? '');
        const path = snapshot.files.get(name);
        if (!path || basename(name) !== name) {
            throw new HubAdminError(`Snapshot has no file "${name}"`, 'bad-request');
        }
        const offset = requireCount(payload.offset, 'offset');
        const length = Math.min(requireCount(payload.length, 'length'), ADMIN_CHUNK_BYTES);

        const fd = openSync(path, 'r');
        try {
            const buffer = Buffer.alloc(length);
            const read = readSync(fd, buffer, 0, length, offset);
            return { data: buffer.toString('base64', 0, read), bytes: read };
        } finally {
            closeSync(fd);
        }
    }

    /**
     * @param {any} payload
     * @returns {{ removed: boolean }}
     */
    function snapshotEnd(payload) {
        const snapshot = snapshots.get(payload.id);
        if (!snapshot) {
            return { removed: false };
        }
        rmSync(snapshot.dir, { recursive: true, force: true });
        snapshots.delete(payload.id);
        return { removed: true };
    }

    return async function handleAdmin(op, payload = {}) {
        if (payload === null || typeof payload !== 'object') {
            throw new HubAdminError('Admin payload must be an object', 'bad-request');
        }
        switch (op) {
            case AdminOp.INFO:
                return info();
            case AdminOp.IMPORT_BEGIN:
                return importBegin(payload);
            case AdminOp.IMPORT_CHUNK:
                return importChunk(payload);
            case AdminOp.IMPORT_COMMIT:
                return importCommit(payload);
            case AdminOp.IMPORT_ABORT:
                return importAbort(payload);
            case AdminOp.SNAPSHOT_BEGIN:
                return snapshotBegin();
            case AdminOp.SNAPSHOT_READ:
                return snapshotRead(payload);
            case AdminOp.SNAPSHOT_END:
                return snapshotEnd(payload);
            default:
                throw new HubAdminError(`Unknown admin operation: ${op}`, 'unknown-op');
        }
    };
}
