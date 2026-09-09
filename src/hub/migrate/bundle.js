/**
 * [hub] The backup bundle: a directory holding a database and a manifest.
 *
 * A backup is a plain directory rather than an archive on purpose. The one file
 * that matters is `VRCX.sqlite3`, and a directory keeps it directly usable:
 * restoring by hand is a copy, inspecting it is opening it, and there is no
 * container format to get wrong for a file that can run to gigabytes.
 *
 *   <bundle>/
 *     manifest.json     what this is, where it came from, digests
 *     VRCX.sqlite3      a consistent snapshot (see snapshot.js)
 *     VRCX.json         the source's per-machine settings, for reference
 *     hub-token         only from a Hub; restored only on request
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const BUNDLE_FORMAT = 'vrcx-hub-backup/1';
export const MANIFEST_FILE = 'manifest.json';

/**
 * @typedef {object} BundleFile
 * @property {string} name
 * @property {number} bytes
 * @property {string} sha256
 */

/**
 * @typedef {object} BundleManifest
 * @property {string} format - `BUNDLE_FORMAT`
 * @property {string} createdAt - ISO 8601
 * @property {string} tool - the VRCX / Hub version that wrote it
 * @property {{ kind: 'hub' | 'desktop' | 'empty', dir?: string, host?: string, hubVersion?: string }} source
 * @property {import('./snapshot.js').DatabaseSummary & { file: string, sha256: string }} database
 * @property {BundleFile[]} files - everything in the bundle other than the manifest
 */

/**
 * @param {string} dir
 * @returns {boolean}
 */
export function isBundleDir(dir) {
    return existsSync(join(dir, MANIFEST_FILE));
}

/**
 * @param {string} dir
 * @returns {BundleManifest}
 * @throws {Error} when the manifest is missing, unreadable, or of another format
 */
export function readManifest(dir) {
    const path = join(dir, MANIFEST_FILE);
    if (!existsSync(path)) {
        throw new Error(`${dir} is not a backup made by this tool (no ${MANIFEST_FILE})`);
    }
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    return validateManifest(manifest);
}

/**
 * Enough checking that a manifest which arrived over the network, or from a
 * hand-edited file, cannot lead to a nonsense import.
 *
 * @param {any} manifest
 * @returns {BundleManifest}
 */
export function validateManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') {
        throw new Error('Backup manifest is not an object');
    }
    if (manifest.format !== BUNDLE_FORMAT) {
        throw new Error(`Backup manifest format is "${manifest.format}", expected "${BUNDLE_FORMAT}"`);
    }
    const database = manifest.database;
    if (!database || typeof database.file !== 'string' || !/^[0-9a-f]{64}$/.test(database.sha256 ?? '')) {
        throw new Error('Backup manifest has no usable database entry');
    }
    if (!Number.isInteger(database.bytes) || database.bytes <= 0) {
        throw new Error('Backup manifest reports an empty database');
    }
    if (!Array.isArray(manifest.files)) {
        manifest.files = [];
    }
    return manifest;
}

/**
 * @param {string} dir
 * @param {BundleManifest} manifest
 */
export function writeManifest(dir, manifest) {
    writeFileSync(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * @param {object} parts
 * @param {BundleManifest['source']} parts.source
 * @param {BundleManifest['database']} parts.database
 * @param {BundleFile[]} parts.files
 * @param {string} parts.tool
 * @returns {BundleManifest}
 */
export function buildManifest(parts) {
    return {
        format: BUNDLE_FORMAT,
        createdAt: new Date().toISOString(),
        tool: parts.tool,
        source: parts.source,
        database: parts.database,
        files: parts.files
    };
}
