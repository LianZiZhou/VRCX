/**
 * [hub] Consistent copies of a VRCX database, and what is inside one.
 *
 * `copyFile` on a live SQLite database is not a backup. Under WAL the newest
 * writes are in the `-wal` sidecar, not the main file, and under either journal
 * mode a copy taken mid-transaction is a corrupt database. Node's built-in
 * `node:sqlite` exposes SQLite's online backup API, which reads the database
 * through a real connection -- page by page, transactionally consistent, and
 * without stopping whatever else has the file open. That is what makes it
 * possible to back up a running desktop VRCX, and to take a snapshot of a Hub
 * that is busy collecting.
 *
 * `node:sqlite` is used only here and only lazily, so nothing else in the Hub
 * pays for it. It is marked experimental in Node 24; the API surface used --
 * `DatabaseSync`, `prepare().all()` and `backup()` -- has been stable since it
 * landed, and the alternative is shelling out to a `sqlite3` binary the Hub
 * box may not have.
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** The first 16 bytes of every SQLite 3 database file, NUL-terminated. */
const SQLITE_HEADER = 'SQLite format 3';

/** `configs` keys are stored lowercased with a `config:` prefix; see `services/config.js`. */
const SCHEMA_VERSION_KEY = 'config:vrcx_databaseversion';
const LAST_USER_KEY = 'config:lastuserloggedin';

/** @type {Promise<typeof import('node:sqlite')> | null} */
let sqliteModule = null;

/**
 * Load `node:sqlite` without its "experimental feature" warning.
 *
 * The warning is emitted synchronously while the module evaluates, so wrapping
 * just the import is enough. It is silenced by name rather than wholesale:
 * every other warning still gets through.
 *
 * @returns {Promise<typeof import('node:sqlite')>}
 */
export function loadSqlite() {
    if (!sqliteModule) {
        const original = process.emitWarning;
        process.emitWarning = (warning, ...rest) => {
            const text = warning instanceof Error ? warning.message : String(warning);
            if (text.includes('SQLite is an experimental feature')) {
                return;
            }
            original.call(process, warning, ...rest);
        };
        sqliteModule = import('node:sqlite').finally(() => {
            process.emitWarning = original;
        });
    }
    return sqliteModule;
}

/**
 * @param {string} path
 * @returns {boolean} whether the file starts with the SQLite magic
 */
export function isSqliteFile(path) {
    let fd = null;
    try {
        fd = openSync(path, 'r');
        const header = Buffer.alloc(16);
        const read = readSync(fd, header, 0, 16, 0);
        return read === 16 && header.toString('latin1', 0, SQLITE_HEADER.length) === SQLITE_HEADER && header[15] === 0;
    } catch {
        return false;
    } finally {
        if (fd !== null) {
            closeSync(fd);
        }
    }
}

/**
 * @param {string} path
 * @returns {Promise<string>} lowercase hex SHA-256
 */
export function sha256File(path) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        createReadStream(path)
            .on('data', (chunk) => hash.update(chunk))
            .on('error', reject)
            .on('end', () => resolve(hash.digest('hex')));
    });
}

/**
 * Open a database for reading, preferring a read-only handle.
 *
 * Read-only fails on a WAL database whose `-shm` does not exist yet and whose
 * directory cannot be written, which is rare but possible (a backup restored
 * onto a read-only mount, say). A normal open makes no changes on its own, so
 * it is an acceptable second attempt.
 *
 * @param {typeof import('node:sqlite')} sqlite
 * @param {string} path
 * @returns {import('node:sqlite').DatabaseSync}
 */
function openForReading(sqlite, path) {
    try {
        return new sqlite.DatabaseSync(path, { readOnly: true });
    } catch {
        return new sqlite.DatabaseSync(path);
    }
}

/**
 * Turn a per-user table prefix back into the user id it was made from.
 *
 * `services/database/index.js` builds the prefix by stripping `-` and `_` from
 * the id, so `usr_1258d274-5faa-400b-ad8f-f93771a4bd0f` becomes
 * `usr1258d2745faa400bad8ff93771a4bd0f`. That is reversible for the UUID form
 * every current account has; anything else is reported as the prefix itself.
 *
 * @param {string} prefix
 * @returns {string}
 */
export function userIdFromPrefix(prefix) {
    const match = /^usr([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/.exec(prefix);
    if (!match) {
        return prefix;
    }
    return `usr_${match[1]}-${match[2]}-${match[3]}-${match[4]}-${match[5]}`;
}

/**
 * @typedef {object} DatabaseSummary
 * @property {number} bytes
 * @property {number | null} schemaVersion - `VRCX_databaseVersion`, or null for a fresh file
 * @property {string[]} users - ids of every user with per-user tables
 * @property {string | null} lastUser - who was signed in last
 * @property {boolean} hasCookies - whether a VRChat session is stored
 * @property {string} journalMode
 */

/**
 * What a database holds, read without modifying it.
 *
 * Every query tolerates a missing table: a database from a very old VRCX, or
 * one that was created but never signed into, simply has fewer of them.
 *
 * @param {string} path
 * @returns {Promise<DatabaseSummary>}
 */
export async function inspectDatabase(path) {
    const sqlite = await loadSqlite();
    const db = openForReading(sqlite, path);
    try {
        /** @param {string} sql @returns {any[]} */
        const rows = (sql) => {
            try {
                return db.prepare(sql).all();
            } catch {
                return [];
            }
        };

        const configs = new Map(rows('SELECT key, value FROM configs').map((row) => [row.key, row.value]));
        const version = configs.get(SCHEMA_VERSION_KEY);
        const users = rows(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%\\_feed\\_gps' ESCAPE '\\'"
        )
            .map((row) => userIdFromPrefix(String(row.name).slice(0, -'_feed_gps'.length)))
            .sort();
        const cookies = rows("SELECT length(value) AS bytes FROM cookies WHERE key = 'default'");
        const journal = rows('PRAGMA journal_mode');

        return {
            bytes: statSync(path).size,
            schemaVersion: version === undefined ? null : Number(version),
            users,
            lastUser: configs.get(LAST_USER_KEY) ?? null,
            hasCookies: cookies.length > 0 && Number(cookies[0].bytes) > 0,
            journalMode: journal.length > 0 ? String(journal[0].journal_mode) : 'unknown'
        };
    } finally {
        db.close();
    }
}

/**
 * Copy a database consistently, whether or not something else has it open.
 *
 * The result is a single self-contained file: SQLite's backup API folds the
 * source's write-ahead log in as it goes, so the copy never needs a `-wal`.
 *
 * @param {string} sourcePath
 * @param {string} destPath - overwritten if present
 * @param {{ onProgress?: (done: number, total: number) => void }} [options]
 * @returns {Promise<number>} the size of the copy in bytes
 */
export async function snapshotDatabase(sourcePath, destPath, options = {}) {
    if (!isSqliteFile(sourcePath)) {
        throw new Error(`${sourcePath} is not a SQLite database`);
    }
    const sqlite = await loadSqlite();
    mkdirSync(dirname(destPath), { recursive: true });

    const source = openForReading(sqlite, sourcePath);
    let total = 0;
    try {
        await sqlite.backup(source, destPath, {
            // Pages per step. Small enough that a busy writer is never held
            // off for long; the backup simply restarts a step it lost to one.
            rate: 256,
            // Called between steps only, so a database that fits in one step
            // reports nothing here; the completion call below covers it.
            progress: ({ totalPages, remainingPages }) => {
                total = totalPages;
                options.onProgress?.(totalPages - remainingPages, totalPages);
            }
        });
    } finally {
        source.close();
    }
    options.onProgress?.(total || 1, total || 1);
    return statSync(destPath).size;
}
