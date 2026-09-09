/**
 * [hub] A database import is applied at boot, not while the Hub runs.
 *
 * The .NET side holds one connection to the database for the life of the
 * process, and the data core has loaded the file's contents into forty-odd
 * stores. Swapping the file underneath both would mean reaching into
 * `SQLite.Exit()`/`Init()` and then re-running the store graph's own init
 * paths -- upstream code, and exactly the kind of coupling this fork avoids.
 *
 * So the upload lands in `<config>/import-pending/`, the Hub asks its
 * supervisor for a restart (see `RESTART_EXIT_CODE`), and the next boot calls
 * `applyPendingImport()` before anything opens the database. The current file
 * is moved into `backups/` first; nothing is ever deleted.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DATABASE_FILE, replaceDatabase, timestamp } from '../migrate/dataDir.js';
import { isSqliteFile, sha256File } from '../migrate/snapshot.js';

export const PENDING_DIR = 'import-pending';
export const LAST_IMPORT_FILE = 'last-import.json';
const STAGED_MANIFEST = 'manifest.json';

/**
 * @param {string} configDir
 * @returns {string}
 */
export function pendingDir(configDir) {
    return join(configDir, PENDING_DIR);
}

/**
 * @param {string} path
 * @returns {any | null}
 */
function readJson(path) {
    if (!existsSync(path)) {
        return null;
    }
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * @typedef {object} PendingImport
 * @property {string} id
 * @property {string} stagedAt
 * @property {number} bytes
 * @property {string} sha256
 * @property {import('../migrate/bundle.js').BundleManifest} manifest - the sender's description of the data
 */

/**
 * @param {string} configDir
 * @returns {PendingImport | null}
 */
export function readPendingImport(configDir) {
    return readJson(join(pendingDir(configDir), STAGED_MANIFEST));
}

/**
 * @param {string} configDir
 * @returns {(PendingImport & { appliedAt: string, backupPath: string | null }) | null}
 */
export function readLastImport(configDir) {
    return readJson(join(configDir, LAST_IMPORT_FILE));
}

/**
 * Move a fully received upload into the pending slot.
 *
 * @param {string} configDir
 * @param {{ id: string, partFile: string, bytes: number, sha256: string, manifest: object }} upload
 * @returns {PendingImport}
 */
export function stagePendingImport(configDir, upload) {
    const dir = pendingDir(configDir);
    mkdirSync(dir, { recursive: true });
    renameSync(upload.partFile, join(dir, DATABASE_FILE));
    const record = {
        id: upload.id,
        stagedAt: new Date().toISOString(),
        bytes: upload.bytes,
        sha256: upload.sha256,
        manifest: upload.manifest
    };
    writeFileSync(join(dir, STAGED_MANIFEST), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    return record;
}

/**
 * Install a staged import, if there is one. Call before the database is opened.
 *
 * A staged file that fails its checks is set aside rather than deleted, so a
 * half-written upload from a crashed transfer can still be looked at.
 *
 * @param {{ configDir: string, databasePath: string, log?: (message: string) => void }} options
 * @returns {Promise<{ applied: boolean, reason?: string, backupPath?: string | null, record?: PendingImport } | null>}
 *   null when nothing was staged
 */
export async function applyPendingImport(options) {
    const { configDir, databasePath, log = () => {} } = options;
    const record = readPendingImport(configDir);
    if (!record) {
        return null;
    }
    const dir = pendingDir(configDir);
    const staged = join(dir, DATABASE_FILE);

    /** @param {string} reason */
    const setAside = (reason) => {
        const dest = join(configDir, `${PENDING_DIR}.rejected-${timestamp()}`);
        renameSync(dir, dest);
        log(`Staged import rejected: ${reason}. Moved to ${dest}`);
        return { applied: false, reason };
    };

    if (!existsSync(staged)) {
        return setAside('the staged database file is missing');
    }
    if (!isSqliteFile(staged)) {
        return setAside('the staged file is not a SQLite database');
    }
    const digest = await sha256File(staged);
    if (digest !== record.sha256) {
        return setAside(`digest mismatch (expected ${record.sha256}, got ${digest})`);
    }

    const { backupPath } = replaceDatabase(databasePath, staged, { move: true, tag: 'pre-import' });
    const applied = { ...record, appliedAt: new Date().toISOString(), backupPath, databasePath };
    writeFileSync(join(configDir, LAST_IMPORT_FILE), `${JSON.stringify(applied, null, 2)}\n`, 'utf8');
    rmSync(dir, { recursive: true, force: true });

    const megabytes = (record.bytes / 1048576).toFixed(1);
    log(`Applied staged import ${record.id}: ${megabytes} MB into ${databasePath}`);
    if (backupPath) {
        log(`Previous database kept at ${backupPath}`);
    }
    return { applied: true, backupPath, record };
}
