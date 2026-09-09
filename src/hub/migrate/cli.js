/**
 * [hub] `vrcx-hub-migrate`: move a VRCX's data onto a Hub, and back it up.
 *
 *   vrcx-hub-migrate migrate --hub=pi.local --token=...    desktop VRCX -> Hub
 *   vrcx-hub-migrate backup                                a copy of this VRCX's data
 *   vrcx-hub-migrate backup --hub=pi.local                 a copy of the Hub's data
 *   vrcx-hub-migrate restore --from=<backup>               put a backup back
 *
 * Ships in every release zip next to the Hub, and runs from a checkout with
 * `npm run hub-migrate -- <command>`. Uses nothing from `src/` outside
 * `src/hub/`, so it needs no bundling and no browser shims to run from source.
 *
 * The whole of a VRCX install that is worth moving is one file, `VRCX.sqlite3`
 * -- the VRChat session cookies live in it too (`dataDir.js` explains) -- so
 * "migrate" is: take a consistent snapshot of it, upload it, and let the Hub
 * restart on it. The Hub keeps whatever it had in `backups/`.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { HubSettingKey, parseCommandLine, resolveHubTarget, USAGE } from './options.js';
import {
    BACKUPS_DIR,
    DATABASE_FILE,
    STORAGE_FILE,
    TOKEN_FILE,
    defaultDataDir,
    describeDataDir,
    replaceDatabase,
    timestamp,
    writeStorage
} from './dataDir.js';
import { buildManifest, isBundleDir, readManifest, writeManifest } from './bundle.js';
import { inspectDatabase, sha256File, snapshotDatabase } from './snapshot.js';
import { connectToHub, downloadSnapshot, hubInfo, uploadDatabase, waitForHub } from './transfer.js';

/** How long to wait for the Hub to restart on an import, then to sign in. */
const RESTART_WAIT_MS = 120000;
const LOGIN_WAIT_MS = 45000;

/**
 * @returns {string}
 */
function readVersionFile() {
    try {
        return readFileSync(new URL('../../../Version', import.meta.url), 'utf8').trim();
    } catch {
        return 'dev';
    }
}

// `VERSION` is a build-time define in the bundle; from source, read the file.
const TOOL_VERSION = typeof VERSION === 'undefined' ? readVersionFile() : VERSION;

// --- output -------------------------------------------------------------

/**
 * @param {string} [text]
 */
function say(text = '') {
    console.log(text);
}

/**
 * @param {string} label
 * @param {any} value
 */
function row(label, value) {
    say(`  ${label.padEnd(18)}${value}`);
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(0)} KB`;
    }
    if (bytes < 1024 * 1024 * 1024) {
        return `${(bytes / 1048576).toFixed(1)} MB`;
    }
    return `${(bytes / 1073741824).toFixed(2)} GB`;
}

/**
 * A one-line progress readout that rewrites itself on a terminal and prints
 * quarter marks otherwise, so a log file gets four lines instead of thousands.
 *
 * @param {string} label
 * @returns {(done: number, total: number) => void}
 */
function progress(label) {
    const tty = Boolean(process.stdout.isTTY);
    let lastQuarter = -1;
    let finished = false;
    return (done, total) => {
        if (finished) {
            return;
        }
        const percent = total > 0 ? Math.floor((done / total) * 100) : 100;
        if (tty) {
            process.stdout.write(`\r  ${label} ${formatBytes(done)} / ${formatBytes(total)} (${percent}%)   `);
            if (done >= total) {
                process.stdout.write('\n');
                finished = true;
            }
            return;
        }
        const quarter = Math.floor(percent / 25);
        if (quarter !== lastQuarter) {
            lastQuarter = quarter;
            say(`  ${label} ${percent}%`);
        }
        if (done >= total) {
            finished = true;
        }
    };
}

/**
 * @param {string} question
 * @param {Record<string, string | boolean>} flags
 * @returns {Promise<boolean>}
 */
async function confirm(question, flags) {
    if (flags.yes) {
        return true;
    }
    if (!process.stdin.isTTY) {
        throw new Error('Not running in a terminal; pass --yes to proceed without confirmation');
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await new Promise((done) => rl.question(`${question} [y/N] `, done));
        return /^y(es)?$/i.test(String(answer).trim());
    } finally {
        rl.close();
    }
}

// --- the local machine --------------------------------------------------

/**
 * Whether a desktop VRCX is running here. Best effort: a running VRCX keeps
 * writing, so a migration taken now misses whatever comes after, and it will
 * overwrite VRCX.json on exit.
 *
 * @returns {boolean | null} null when it could not be determined
 */
function isVrcxRunning() {
    try {
        if (process.platform === 'win32') {
            const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq VRCX.exe', '/NH'], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            });
            return /VRCX\.exe/i.test(out);
        }
        execFileSync('pgrep', ['-x', '-i', 'vrcx'], { stdio: ['ignore', 'pipe', 'ignore'] });
        return true;
    } catch (err) {
        // pgrep exits 1 for "no match" and 2+ for errors.
        return process.platform !== 'win32' && err?.status === 1 ? false : null;
    }
}

/**
 * @typedef {object} Source
 * @property {'bundle' | 'data'} type
 * @property {string} dir
 * @property {string} databasePath
 * @property {import('./bundle.js').BundleManifest} [manifest] - for a bundle
 * @property {import('./dataDir.js').DataDirInfo} [dataDir] - for a data directory
 */

/**
 * @param {Record<string, string | boolean>} flags
 * @returns {Source}
 */
function locateSource(flags) {
    const dir = resolve(typeof flags.from === 'string' ? flags.from : defaultDataDir());
    if (!existsSync(dir)) {
        throw new Error(`No such directory: ${dir}`);
    }
    if (isBundleDir(dir)) {
        const manifest = readManifest(dir);
        const databasePath = join(dir, manifest.database.file);
        if (!existsSync(databasePath)) {
            throw new Error(`The backup at ${dir} is missing its ${manifest.database.file}`);
        }
        return { type: 'bundle', dir, databasePath, manifest };
    }
    const dataDir = describeDataDir(dir);
    if (!dataDir.hasDatabase) {
        throw new Error(`No ${DATABASE_FILE} in ${dir}. Pass --from=<the VRCX data directory>.`);
    }
    return { type: 'data', dir, databasePath: dataDir.databasePath, dataDir };
}

/**
 * @param {string} label
 * @param {import('./snapshot.js').DatabaseSummary & { sha256?: string }} summary
 */
function printSummary(label, summary) {
    say(label);
    row('Size', formatBytes(summary.bytes));
    row('Schema', summary.schemaVersion === null ? 'none (never signed in)' : `v${summary.schemaVersion}`);
    row('Users', summary.users.length ? summary.users.join(', ') : 'none');
    if (summary.lastUser) {
        row('Last signed in', summary.lastUser);
    }
    row('VRChat session', summary.hasCookies ? 'stored (the Hub will sign in with it)' : 'none');
}

/**
 * Take a consistent copy of a data directory into a bundle directory.
 *
 * @param {import('./dataDir.js').DataDirInfo} dataDir
 * @param {string} destDir
 * @returns {Promise<import('./bundle.js').BundleManifest>}
 */
async function snapshotToBundle(dataDir, destDir) {
    mkdirSync(destDir, { recursive: true });
    const databaseCopy = join(destDir, DATABASE_FILE);
    await snapshotDatabase(dataDir.databasePath, databaseCopy, { onProgress: progress('Snapshot') });

    const extras = [];
    for (const name of [STORAGE_FILE, TOKEN_FILE]) {
        const source = join(dataDir.dir, name);
        if (!existsSync(source)) {
            continue;
        }
        const copy = join(destDir, name);
        copyFileSync(source, copy);
        extras.push({ name, bytes: statSync(copy).size, sha256: await sha256File(copy) });
    }

    const summary = await inspectDatabase(databaseCopy);
    const manifest = buildManifest({
        tool: TOOL_VERSION,
        source: { kind: dataDir.kind, dir: dataDir.dir },
        database: { file: DATABASE_FILE, sha256: await sha256File(databaseCopy), ...summary },
        files: extras
    });
    writeManifest(destDir, manifest);
    return manifest;
}

/**
 * @param {Record<string, string | boolean>} flags
 * @returns {{ url: string, token: string, urlSource: string, tokenSource: string }}
 */
function requireHubTarget(flags) {
    const target = resolveHubTarget(flags);
    if (!target) {
        throw new Error(
            'No Hub address. Pass --hub=<host or ws://host:9001>, or set VRCX_HUB_URL, ' +
                'or point this VRCX at the Hub first (VRCX_HubUrl in VRCX.json).'
        );
    }
    if (!target.token) {
        throw new Error(
            `No Hub token for ${target.url}. Pass --token=<secret> or --token-file=<path to hub-token>, ` +
                'or set VRCX_HUB_TOKEN. The Hub prints where its token lives on start-up.'
        );
    }
    return target;
}

// --- commands -----------------------------------------------------------

/**
 * @param {Record<string, string | boolean>} flags
 */
async function migrate(flags) {
    const target = requireHubTarget(flags);
    const source = locateSource(flags);

    say(`Hub                 ${target.url}  (${target.urlSource})`);
    const { connection, welcome } = await connectToHub({ url: target.url, token: target.token });
    try {
        const info = await hubInfo(connection);
        row('Hub version', welcome.hub ?? '?');
        row('Hub data', info.database ? `${formatBytes(info.database.bytes)} in ${info.databasePath}` : 'none yet');
        if (info.database?.users?.length) {
            row('Hub users', info.database.users.join(', '));
        }
        row('Signed in', info.loggedIn ? (info.displayName ?? 'yes') : 'no');
        if (info.pendingImport) {
            row('Note', `an import (${info.pendingImport.id}) is already staged and waiting for a restart`);
        }
        say();

        /** @type {import('./bundle.js').BundleManifest} */
        let manifest;
        let bundleDir = null;
        let tempDir = null;

        if (source.type === 'bundle') {
            manifest = source.manifest;
            bundleDir = source.dir;
            printSummary(`Backup at ${source.dir} (made ${manifest.createdAt})`, manifest.database);
        } else {
            const summary = await inspectDatabase(source.databasePath);
            printSummary(`This machine's VRCX at ${source.dir}`, summary);
            if (summary.schemaVersion !== null && summary.schemaVersion > info.expectedSchemaVersion) {
                throw new Error(
                    `This VRCX's database schema (v${summary.schemaVersion}) is newer than the Hub supports ` +
                        `(v${info.expectedSchemaVersion}). Update the Hub first.`
                );
            }
            const running = isVrcxRunning();
            if (running) {
                say();
                say('  VRCX is running. The snapshot is consistent, but anything VRCX writes after');
                say('  it is taken will not reach the Hub. Close VRCX first for a clean hand-over.');
            }
        }
        say();

        const replacing = info.database && info.database.bytes > 0;
        const question = replacing
            ? `Replace the Hub's database (it will be kept in ${join(info.configDir, BACKUPS_DIR)}) and restart the Hub?`
            : 'Send this database to the Hub and start it on the data?';
        if (!(await confirm(question, flags))) {
            say('Nothing done.');
            return;
        }

        if (source.type === 'data') {
            tempDir = join(tmpdir(), `vrcx-hub-migrate-${timestamp()}`);
            manifest = await snapshotToBundle(source.dataDir, tempDir);
            bundleDir = tempDir;
        }

        let result;
        try {
            result = await uploadDatabase(connection, {
                file: join(bundleDir, manifest.database.file),
                bytes: manifest.database.bytes,
                sha256: manifest.database.sha256,
                manifest,
                onProgress: progress('Upload')
            });
        } finally {
            if (tempDir) {
                rmSync(tempDir, { recursive: true, force: true });
            }
        }

        say(`  Staged on the Hub as import ${result.id}.`);
        connection.close();

        if (!result.restarting) {
            say();
            say('  The Hub cannot restart itself where it is running. Start it again and the');
            say('  import is applied before it opens the database.');
        } else if (flags['no-wait']) {
            say('  The Hub is restarting to apply it.');
        } else {
            say('  The Hub is restarting to apply it; waiting for it to come back...');
            const applied = await waitForHub({
                url: target.url,
                token: target.token,
                timeoutMs: RESTART_WAIT_MS,
                predicate: (state) => state.lastImport?.id === result.id
            });
            if (!applied) {
                say('  The Hub did not come back in time. Check it: if it is up, the import is in place;');
                say('  if it is not, start it and the import is applied on boot.');
            } else {
                say('  Applied.');
                if (applied.lastImport?.backupPath) {
                    row('Previous data', applied.lastImport.backupPath);
                }
                if (manifest.database.hasCookies) {
                    const signedIn = await waitForHub({
                        url: target.url,
                        token: target.token,
                        timeoutMs: LOGIN_WAIT_MS,
                        predicate: (state) => Boolean(state.loggedIn)
                    });
                    row('Signed in', signedIn ? (signedIn.displayName ?? 'yes') : 'not yet; check the status page');
                } else {
                    row('Signed in', 'no session was stored; sign in from a VRCX client attached to the Hub');
                }
            }
        }

        say();
        if (flags['configure-client']) {
            const running = isVrcxRunning();
            if (running) {
                say('  VRCX is running, so VRCX.json was left alone (VRCX rewrites it on exit).');
                say('  Close VRCX and run again with --configure-client, or add the settings by hand:');
                printClientSettings(target);
            } else {
                const localDir = defaultDataDir();
                writeStorage(localDir, {
                    [HubSettingKey.ENABLED]: 'true',
                    [HubSettingKey.URL]: target.url,
                    [HubSettingKey.TOKEN]: target.token
                });
                say(`  Wrote the Hub settings into ${join(localDir, STORAGE_FILE)}.`);
                say('  This VRCX will attach to the Hub the next time it starts.');
            }
        } else if (target.urlSource === '--hub' || target.urlSource === 'VRCX_HUB_URL') {
            say('  To make this VRCX use the Hub, close it and run again with --configure-client,');
            say(`  or add these to ${join(defaultDataDir(), STORAGE_FILE)}:`);
            printClientSettings(target);
        }
    } finally {
        connection.close();
    }
}

/**
 * @param {{ url: string, token: string }} target
 */
function printClientSettings(target) {
    say('    {');
    say(`      "${HubSettingKey.ENABLED}": "true",`);
    say(`      "${HubSettingKey.URL}": "${target.url}",`);
    say(`      "${HubSettingKey.TOKEN}": "${target.token}"`);
    say('    }');
}

/**
 * @param {string} dir
 */
function requireEmptyDir(dir) {
    if (existsSync(dir) && readdirSync(dir).length > 0) {
        throw new Error(`${dir} already exists and is not empty`);
    }
}

/**
 * @param {Record<string, string | boolean>} flags
 */
async function backup(flags) {
    if (typeof flags.hub === 'string') {
        const target = requireHubTarget(flags);
        const dest = resolve(typeof flags.to === 'string' ? flags.to : `vrcx-backup-hub-${timestamp()}`);
        requireEmptyDir(dest);

        say(`Hub                 ${target.url}`);
        const { connection } = await connectToHub({ url: target.url, token: target.token });
        try {
            say('  Taking a snapshot on the Hub (this can take a while on a small machine)...');
            const manifest = await downloadSnapshot(connection, dest, { onProgress: progress('Download') });
            say();
            printSummary(`Backup written to ${dest}`, manifest.database);
            row('Also included', manifest.files.map((file) => file.name).join(', ') || 'nothing else');
        } finally {
            connection.close();
        }
        return;
    }

    const source = locateSource(flags);
    if (source.type === 'bundle') {
        throw new Error(`${source.dir} is already a backup. To copy it, copy the directory.`);
    }
    const dest = resolve(typeof flags.to === 'string' ? flags.to : `vrcx-backup-${source.dataDir.kind}-${timestamp()}`);
    requireEmptyDir(dest);

    say(`Backing up ${source.dir} (${source.dataDir.kind})`);
    const manifest = await snapshotToBundle(source.dataDir, dest);
    say();
    printSummary(`Backup written to ${dest}`, manifest.database);
    row('Also included', manifest.files.map((file) => file.name).join(', ') || 'nothing else');
    say();
    say('  Restore it with:');
    say(`    vrcx-hub-migrate restore --from="${dest}"`);
    say('  or send it to a Hub with:');
    say(`    vrcx-hub-migrate migrate --from="${dest}" --hub=<addr>`);
}

/**
 * @param {Record<string, string | boolean>} flags
 */
async function restore(flags) {
    if (typeof flags.hub === 'string') {
        throw new Error('To restore onto a Hub, use: vrcx-hub-migrate migrate --from=<backup> --hub=<addr>');
    }
    if (typeof flags.from !== 'string') {
        throw new Error('restore needs --from=<a backup made by this tool>');
    }
    const source = locateSource(flags);
    if (source.type !== 'bundle') {
        throw new Error(`${source.dir} is a VRCX data directory, not a backup. Use backup to copy it.`);
    }
    const { manifest } = source;
    const dest = resolve(typeof flags.to === 'string' ? flags.to : defaultDataDir());
    const targetDir = describeDataDir(dest);

    say(`Checking ${source.dir}...`);
    const digest = await sha256File(source.databasePath);
    if (digest !== manifest.database.sha256) {
        throw new Error(`${source.databasePath} does not match its manifest (digest ${digest}); the backup is damaged`);
    }
    printSummary(
        `Backup from ${manifest.source.kind} at ${manifest.source.dir ?? manifest.source.host ?? '?'}`,
        manifest.database
    );
    say();
    row('Restore into', targetDir.databasePath);
    row(
        'Currently there',
        targetDir.hasDatabase ? `${formatBytes(targetDir.databaseBytes)} (kept in ${BACKUPS_DIR}/)` : 'nothing'
    );

    const withToken = Boolean(flags['with-token']);
    const bundledToken = join(source.dir, TOKEN_FILE);
    if (withToken && !existsSync(bundledToken)) {
        throw new Error(`--with-token given, but the backup has no ${TOKEN_FILE} (it was not taken from a Hub)`);
    }

    // Only this machine's own VRCX can be checked for; a Hub's directory or
    // a copy elsewhere is the caller's responsibility.
    const isLocalVrcx = dest.toLowerCase() === resolve(defaultDataDir()).toLowerCase();
    if (isLocalVrcx && isVrcxRunning()) {
        throw new Error('VRCX is running. Close it before restoring, or it will keep writing to the old file.');
    }
    say();
    say('  Make sure nothing (VRCX or a Hub) has this data directory open.');
    if (!(await confirm('Restore now?', flags))) {
        say('Nothing done.');
        return;
    }

    const { backupPath } = replaceDatabase(targetDir.databasePath, source.databasePath, { tag: 'pre-restore' });
    row('Restored', targetDir.databasePath);
    if (backupPath) {
        row('Previous data', backupPath);
    }
    if (withToken) {
        const tokenPath = join(dest, TOKEN_FILE);
        if (existsSync(tokenPath)) {
            const backups = join(dest, BACKUPS_DIR);
            mkdirSync(backups, { recursive: true });
            copyFileSync(tokenPath, join(backups, `${TOKEN_FILE}.${timestamp()}.bak`));
        }
        copyFileSync(bundledToken, tokenPath);
        row('Token', 'restored; clients configured for the old Hub will connect to this one');
    }
}

/**
 * @param {Record<string, string | boolean>} flags
 */
async function info(flags) {
    const source = locateSource(flags);
    if (source.type === 'bundle') {
        printSummary(
            `Backup at ${source.dir} (made ${source.manifest.createdAt} by ${source.manifest.tool})`,
            source.manifest.database
        );
        row('Also included', source.manifest.files.map((file) => file.name).join(', ') || 'nothing else');
    } else {
        const summary = await inspectDatabase(source.databasePath);
        printSummary(`${source.dataDir.kind === 'hub' ? 'Hub' : 'VRCX'} data at ${source.dir}`, summary);
        row('Database file', source.databasePath);
        row('Journal mode', summary.journalMode);
    }

    let target = null;
    try {
        target = resolveHubTarget(flags);
    } catch (err) {
        say(`\nHub: ${err.message}`);
    }
    if (!target) {
        if (typeof flags.hub === 'string') {
            throw new Error('Could not work out the Hub address');
        }
        return;
    }
    say();
    say(`Hub at ${target.url} (${target.urlSource})`);
    if (!target.token) {
        say('  No token known; pass --token to query it.');
        return;
    }
    const { connection, welcome } = await connectToHub({ url: target.url, token: target.token });
    try {
        const state = await hubInfo(connection);
        row('Version', welcome.hub ?? '?');
        row('Data directory', state.configDir);
        row('Signed in', state.loggedIn ? (state.displayName ?? 'yes') : 'no');
        row('Can restart', state.restartSupported ? 'yes' : 'no (imports apply on the next manual start)');
        if (state.database) {
            printSummary('  Database:', state.database);
        } else {
            row('Database', 'none yet');
        }
        if (state.pendingImport) {
            row(
                'Staged import',
                `${state.pendingImport.id} (${formatBytes(state.pendingImport.bytes)}), waiting for a restart`
            );
        }
        if (state.lastImport) {
            row('Last import', `${state.lastImport.id} applied ${state.lastImport.appliedAt}`);
        }
    } finally {
        connection.close();
    }
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} exit code
 */
export async function run(argv) {
    const { command, flags } = parseCommandLine(argv);
    try {
        switch (command) {
            case 'migrate':
                await migrate(flags);
                break;
            case 'backup':
                await backup(flags);
                break;
            case 'restore':
                await restore(flags);
                break;
            case 'info':
                await info(flags);
                break;
            case 'help':
                say(`vrcx-hub-migrate ${TOOL_VERSION}`);
                say(USAGE);
                break;
            default:
                say(`Unknown command: ${command}`);
                say(USAGE);
                return 2;
        }
        return 0;
    } catch (err) {
        say();
        console.error(`vrcx-hub-migrate: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
    }
}

/**
 * @returns {boolean} whether this module is the process entry point
 */
function isEntryPoint() {
    if (!process.argv[1]) {
        return false;
    }
    const self = fileURLToPath(import.meta.url);
    const entry = resolve(process.argv[1]);
    return process.platform === 'win32' ? self.toLowerCase() === entry.toLowerCase() : self === entry;
}

if (isEntryPoint()) {
    process.exitCode = await run(process.argv.slice(2));
}
