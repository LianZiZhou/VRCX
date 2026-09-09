/**
 * [hub] Where VRCX keeps its data, and the files in there that matter.
 *
 * A VRCX data directory -- desktop or Hub -- is the same shape on every
 * platform, because both are laid out by `Program.SetProgramDirectories` in
 * `Dotnet/Program.cs`:
 *
 *   VRCX.sqlite3     everything: feed, friend log, settings, and the VRChat
 *                    session cookies (WebApi keeps them in the `cookies`
 *                    table, not in a file). Moving this file moves the login.
 *   VRCX.json        per-machine settings: window geometry, GPU flags, proxy,
 *                    the database location override, and on a client the Hub
 *                    connection settings. Never worth moving between machines.
 *   hub-token        only on a Hub. The shared secret clients connect with.
 *
 * Everything else in the directory (`userdata/` is a Chromium profile,
 * `ImageCache/`, `logs/`) is a cache that regenerates.
 *
 * Node-only: uses the filesystem. Nothing here may be reached from the browser
 * bundle.
 */

import { Buffer } from 'node:buffer';
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export const DATABASE_FILE = 'VRCX.sqlite3';
export const STORAGE_FILE = 'VRCX.json';
export const TOKEN_FILE = 'hub-token';
export const BACKUPS_DIR = 'backups';

/** The key in VRCX.json that relocates the database. Empty means the default. */
export const DATABASE_LOCATION_KEY = 'VRCX_DatabaseLocation';

/**
 * SQLite's sidecar files. A write-ahead log and its index belong to the
 * database they sit beside; leaving them next to a *different* database file
 * would make SQLite replay the wrong log into it.
 */
export const DATABASE_SIDECARS = ['-wal', '-shm', '-journal'];

/**
 * The platform's VRCX data directory, matching `Program.SetProgramDirectories`
 * so this tool, a desktop VRCX and the Hub all agree on the path.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [platform]
 * @returns {string}
 */
export function defaultDataDir(env = process.env, platform = process.platform) {
    if (env.XDG_CONFIG_HOME) {
        return join(env.XDG_CONFIG_HOME, 'VRCX');
    }
    if (platform === 'darwin') {
        return join(homedir(), 'Library', 'Application Support', 'VRCX');
    }
    if (platform === 'win32') {
        return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'VRCX');
    }
    return join(homedir(), '.config', 'VRCX');
}

/**
 * Read VRCX.json. The .NET side writes it with a UTF-8 byte-order mark, which
 * `JSON.parse` rejects, so strip it.
 *
 * @param {string} dir
 * @returns {Record<string, string>} empty when the file does not exist
 */
export function readStorage(dir) {
    const path = join(dir, STORAGE_FILE);
    if (!existsSync(path)) {
        return {};
    }
    const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
}

/**
 * Merge keys into VRCX.json, keeping everything else in the file intact.
 *
 * Only safe while VRCX is not running: `VRCXStorage.Save` writes the whole
 * dictionary from memory, so a running VRCX would overwrite this on its next
 * save. Callers are expected to have checked.
 *
 * @param {string} dir
 * @param {Record<string, string>} values
 */
export function writeStorage(dir, values) {
    const path = join(dir, STORAGE_FILE);
    const hadBom =
        existsSync(path) &&
        readFileSync(path)
            .subarray(0, 3)
            .equals(Buffer.from([0xef, 0xbb, 0xbf]));
    const merged = { ...readStorage(dir), ...values };
    mkdirSync(dir, { recursive: true });
    // Two-space indentation and a BOM when there was one, so the file diffs
    // cleanly against what .NET's serializer would have produced.
    writeFileSync(path, `${hadBom ? '﻿' : ''}${JSON.stringify(merged, null, 2)}`, 'utf8');
}

/**
 * Where the database actually is, honouring `VRCX_DatabaseLocation`.
 *
 * @param {string} dir
 * @returns {string}
 */
export function resolveDatabasePath(dir) {
    let override = '';
    try {
        override = String(readStorage(dir)[DATABASE_LOCATION_KEY] ?? '').trim();
    } catch {
        // A malformed VRCX.json is VRCX's problem; the default location still holds.
    }
    if (!override) {
        return join(dir, DATABASE_FILE);
    }
    return isAbsolute(override) ? override : resolve(dir, override);
}

/**
 * @typedef {object} DataDirInfo
 * @property {string} dir
 * @property {string} databasePath
 * @property {boolean} hasDatabase
 * @property {number} databaseBytes
 * @property {'hub' | 'desktop' | 'empty'} kind - a `hub-token` marks a Hub;
 *   a database with no token marks a desktop VRCX
 */

/**
 * @param {string} dir
 * @returns {DataDirInfo}
 */
export function describeDataDir(dir) {
    const databasePath = resolveDatabasePath(dir);
    const hasDatabase = existsSync(databasePath);
    const hasToken = existsSync(join(dir, TOKEN_FILE));
    return {
        dir,
        databasePath,
        hasDatabase,
        databaseBytes: hasDatabase ? statSync(databasePath).size : 0,
        kind: hasToken ? 'hub' : hasDatabase ? 'desktop' : 'empty'
    };
}

/**
 * @returns {string} a filesystem-safe timestamp, e.g. `2026-09-09T10-36-00-000Z`
 */
export function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Put a new database file in place of the current one.
 *
 * The current file is never deleted: it is moved into `backups/` beside it
 * with a tag saying why, matching what `hub-merge-offline.js` does. Its
 * sidecars are removed rather than moved -- see `DATABASE_SIDECARS` -- and the
 * new file arrives with none, which is correct: a snapshot has already had its
 * log folded in.
 *
 * @param {string} databasePath - where the live database lives (or will)
 * @param {string} sourceFile - the file to install
 * @param {{ move?: boolean, tag?: string }} [options] - `move` renames the
 *   source in (same filesystem, atomic); the default copies it
 * @returns {{ backupPath: string | null }}
 */
export function replaceDatabase(databasePath, sourceFile, options = {}) {
    const { move = false, tag = 'replaced' } = options;
    let backupPath = null;

    if (existsSync(databasePath)) {
        const backupsDir = join(dirname(databasePath), BACKUPS_DIR);
        mkdirSync(backupsDir, { recursive: true });
        backupPath = join(backupsDir, `${basename(databasePath)}.${timestamp()}.${tag}.bak`);
        renameSync(databasePath, backupPath);
    }
    for (const suffix of DATABASE_SIDECARS) {
        rmSync(`${databasePath}${suffix}`, { force: true });
    }

    mkdirSync(dirname(databasePath), { recursive: true });
    if (move) {
        renameSync(sourceFile, databasePath);
    } else {
        copyFileSync(sourceFile, databasePath);
    }
    return { backupPath };
}
