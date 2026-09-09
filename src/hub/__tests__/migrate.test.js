/**
 * [hub] The migration and backup tool, end to end.
 *
 * Builds real SQLite databases with `node:sqlite`, keeps a writer on them to
 * prove the snapshot is taken from a live file, and then runs the actual admin
 * protocol over a real encrypted socket: upload -> staged -> applied on
 * "restart", and snapshot -> downloaded -> verified.
 */

import { Buffer } from 'node:buffer';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createAdminHandler } from '../server/adminHandler.js';
import { createHubConnection } from '../client/connection.js';
import { createHubServer } from '../server/wsServer.js';
import { createInteropHandler } from '../server/interopHandler.js';
import { AdminOp } from '../shared/protocol.js';
import { applyPendingImport, readLastImport, readPendingImport } from '../server/pendingImport.js';
import {
    DATABASE_FILE,
    defaultDataDir,
    describeDataDir,
    readStorage,
    replaceDatabase,
    resolveDatabasePath,
    writeStorage
} from '../migrate/dataDir.js';
import {
    inspectDatabase,
    isSqliteFile,
    loadSqlite,
    sha256File,
    snapshotDatabase,
    userIdFromPrefix
} from '../migrate/snapshot.js';
import { buildManifest, isBundleDir, readManifest, validateManifest, writeManifest } from '../migrate/bundle.js';
import { connectToHub, downloadSnapshot, hubInfo, uploadDatabase } from '../migrate/transfer.js';
import { normaliseHubUrl, parseCommandLine, resolveHubTarget } from '../migrate/options.js';

const TOKEN = 'migrate-test-token-0123456789';
const USER_ID = 'usr_1258d274-5faa-400b-ad8f-f93771a4bd0f';
const USER_PREFIX = 'usr1258d2745faa400bad8ff93771a4bd0f';

/** @type {string} */
let work;

beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'vrcx-hub-migrate-'));
});

afterAll(() => {
    rmSync(work, { recursive: true, force: true });
});

/**
 * @param {string} name
 * @returns {string}
 */
function scratch(name) {
    const dir = join(work, name);
    mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * A database shaped like a real VRCX one: `configs`, `cookies`, and one
 * user's `_feed_gps` table with enough rows to span several pages.
 *
 * @param {string} path
 * @param {{ rows?: number, schemaVersion?: number, cookies?: boolean }} [options]
 * @returns {Promise<import('node:sqlite').DatabaseSync>} left open, so the file is "live"
 */
async function createVrcxDatabase(path, options = {}) {
    const { rows = 2000, schemaVersion = 16, cookies = true } = options;
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('CREATE TABLE configs (`key` TEXT PRIMARY KEY, `value` TEXT)');
    db.exec('CREATE TABLE cookies (`key` TEXT PRIMARY KEY, `value` TEXT)');
    db.exec(`CREATE TABLE ${USER_PREFIX}_feed_gps (id INTEGER PRIMARY KEY, created_at TEXT, location TEXT)`);
    db.prepare('INSERT INTO configs VALUES (?, ?)').run('config:vrcx_databaseversion', String(schemaVersion));
    db.prepare('INSERT INTO configs VALUES (?, ?)').run('config:lastuserloggedin', USER_ID);
    if (cookies) {
        db.prepare('INSERT INTO cookies VALUES (?, ?)').run('default', Buffer.from('cookie-jar').toString('base64'));
    }
    // One transaction: a fsync per row is what makes this slow on Windows.
    const insert = db.prepare(`INSERT INTO ${USER_PREFIX}_feed_gps (created_at, location) VALUES (?, ?)`);
    db.exec('BEGIN');
    for (let i = 0; i < rows; i += 1) {
        insert.run(new Date(i * 1000).toISOString(), `wrld_${i}:${'x'.repeat(200)}`);
    }
    db.exec('COMMIT');
    return db;
}

/**
 * @param {string} path
 * @returns {Promise<number>}
 */
async function countFeedRows(path) {
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        return Number(db.prepare(`SELECT count(*) AS n FROM ${USER_PREFIX}_feed_gps`).get().n);
    } finally {
        db.close();
    }
}

/**
 * Bundle a database file the way the CLI does, without the CLI.
 *
 * @param {string} dir
 * @param {string} databasePath
 * @returns {Promise<import('../migrate/bundle.js').BundleManifest>}
 */
async function bundleOf(dir, databasePath) {
    const copy = join(dir, DATABASE_FILE);
    await snapshotDatabase(databasePath, copy);
    const manifest = buildManifest({
        tool: 'test',
        source: { kind: 'desktop', dir },
        database: { file: DATABASE_FILE, sha256: await sha256File(copy), ...(await inspectDatabase(copy)) },
        files: []
    });
    writeManifest(dir, manifest);
    return manifest;
}

describe('data directory helpers', () => {
    it('finds the platform default and honours the database location override', () => {
        expect(defaultDataDir({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, 'win32')).toMatch(/VRCX$/);
        expect(defaultDataDir({ XDG_CONFIG_HOME: '/xdg' }, 'linux')).toBe(join('/xdg', 'VRCX'));

        const dir = scratch('datadir');
        expect(resolveDatabasePath(dir)).toBe(join(dir, DATABASE_FILE));
        writeStorage(dir, { VRCX_DatabaseLocation: join(dir, 'elsewhere', 'db.sqlite3') });
        expect(resolveDatabasePath(dir)).toBe(join(dir, 'elsewhere', 'db.sqlite3'));
    });

    it('reads and rewrites VRCX.json through the BOM .NET writes', () => {
        const dir = scratch('storage');
        writeFileSync(join(dir, 'VRCX.json'), '\uFEFF{\n  "VRCX_LocationX": "1",\n  "VRCX_ProxyServer": ""\n}', 'utf8');
        expect(readStorage(dir)).toEqual({ VRCX_LocationX: '1', VRCX_ProxyServer: '' });

        writeStorage(dir, { VRCX_HubEnabled: 'true' });
        const raw = readFileSync(join(dir, 'VRCX.json'));
        expect(raw.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
        expect(readStorage(dir)).toEqual({ VRCX_LocationX: '1', VRCX_ProxyServer: '', VRCX_HubEnabled: 'true' });
    });

    it('classifies a directory by what is in it', async () => {
        const empty = scratch('kind-empty');
        expect(describeDataDir(empty).kind).toBe('empty');

        const desktop = scratch('kind-desktop');
        (await createVrcxDatabase(join(desktop, DATABASE_FILE), { rows: 1 })).close();
        expect(describeDataDir(desktop).kind).toBe('desktop');

        const hub = scratch('kind-hub');
        writeFileSync(join(hub, 'hub-token'), 'abc\n');
        expect(describeDataDir(hub).kind).toBe('hub');
    });

    it('replaces a database keeping the old one and dropping its sidecars', async () => {
        const dir = scratch('replace');
        const live = join(dir, DATABASE_FILE);
        (await createVrcxDatabase(live, { rows: 1 })).close();
        writeFileSync(`${live}-wal`, 'stale');
        writeFileSync(`${live}-shm`, 'stale');
        const incoming = join(dir, 'incoming.sqlite3');
        (await createVrcxDatabase(incoming, { rows: 5 })).close();

        const { backupPath } = replaceDatabase(live, incoming, { tag: 'test' });
        expect(backupPath).toMatch(/backups[\\/]VRCX\.sqlite3\..*\.test\.bak$/);
        expect(existsSync(backupPath)).toBe(true);
        expect(existsSync(`${live}-wal`)).toBe(false);
        expect(existsSync(`${live}-shm`)).toBe(false);
        expect(existsSync(incoming)).toBe(true); // copy, not move
        expect(await countFeedRows(live)).toBe(5);
    });
});

describe('snapshot', () => {
    it('copies a live WAL database consistently and describes it', async () => {
        const dir = scratch('snapshot');
        const live = join(dir, DATABASE_FILE);
        const writer = await createVrcxDatabase(live, { rows: 3000 });
        try {
            // Writes sitting in the WAL, not yet checkpointed into the main file.
            writer
                .prepare(`INSERT INTO ${USER_PREFIX}_feed_gps (created_at, location) VALUES (?, ?)`)
                .run('t', 'after');
            expect(existsSync(`${live}-wal`)).toBe(true);

            const copy = join(dir, 'copy.sqlite3');
            const progress = [];
            const bytes = await snapshotDatabase(live, copy, {
                onProgress: (done, total) => progress.push([done, total])
            });

            expect(bytes).toBe(statSync(copy).size);
            expect(isSqliteFile(copy)).toBe(true);
            expect(existsSync(`${copy}-wal`)).toBe(false);
            expect(progress.length).toBeGreaterThan(0);
            expect(await countFeedRows(copy)).toBe(3001);

            const summary = await inspectDatabase(copy);
            expect(summary).toMatchObject({
                schemaVersion: 16,
                users: [USER_ID],
                lastUser: USER_ID,
                hasCookies: true
            });
        } finally {
            writer.close();
        }
    });

    it('tolerates a database with none of the expected tables', async () => {
        const { DatabaseSync } = await loadSqlite();
        const path = join(scratch('bare'), 'bare.sqlite3');
        const db = new DatabaseSync(path);
        db.exec('CREATE TABLE t (x)');
        db.close();

        expect(await inspectDatabase(path)).toMatchObject({ schemaVersion: null, users: [], hasCookies: false });
    });

    it('recognises SQLite files and user prefixes', () => {
        const dir = scratch('magic');
        writeFileSync(join(dir, 'text.txt'), 'SQLite format 3 but not really, no NUL');
        expect(isSqliteFile(join(dir, 'text.txt'))).toBe(false);
        expect(isSqliteFile(join(dir, 'missing'))).toBe(false);

        expect(userIdFromPrefix(USER_PREFIX)).toBe(USER_ID);
        expect(userIdFromPrefix('8JoV9XEdpo')).toBe('8JoV9XEdpo');
    });
});

describe('bundle manifest', () => {
    it('round-trips and rejects nonsense', async () => {
        const dir = scratch('bundle');
        const live = join(dir, 'src.sqlite3');
        (await createVrcxDatabase(live, { rows: 10 })).close();

        expect(isBundleDir(dir)).toBe(false);
        const manifest = await bundleOf(dir, live);
        expect(isBundleDir(dir)).toBe(true);
        expect(readManifest(dir)).toEqual(manifest);

        expect(() => validateManifest({ format: 'other' })).toThrow(/format/);
        expect(() => validateManifest({ ...manifest, database: { ...manifest.database, sha256: 'nope' } })).toThrow(
            /database entry/
        );
        expect(() => validateManifest({ ...manifest, database: { ...manifest.database, bytes: 0 } })).toThrow(/empty/);
    });
});

describe('pending import', () => {
    it('applies a staged database at boot and keeps the old one', async () => {
        const configDir = scratch('apply');
        const databasePath = join(configDir, DATABASE_FILE);
        (await createVrcxDatabase(databasePath, { rows: 1 })).close();

        const staged = join(configDir, 'import-pending');
        mkdirSync(staged);
        (await createVrcxDatabase(join(staged, DATABASE_FILE), { rows: 7 })).close();
        const sha256 = await sha256File(join(staged, DATABASE_FILE));
        writeFileSync(
            join(staged, 'manifest.json'),
            JSON.stringify({
                id: 'abc',
                stagedAt: 't',
                bytes: statSync(join(staged, DATABASE_FILE)).size,
                sha256,
                manifest: {}
            })
        );
        expect(readPendingImport(configDir)?.id).toBe('abc');

        const log = [];
        const result = await applyPendingImport({ configDir, databasePath, log: (m) => log.push(m) });
        expect(result.applied).toBe(true);
        expect(existsSync(staged)).toBe(false);
        expect(await countFeedRows(databasePath)).toBe(7);
        expect(readLastImport(configDir)).toMatchObject({ id: 'abc', backupPath: result.backupPath });
        expect(existsSync(result.backupPath)).toBe(true);
        expect(log.some((line) => /Applied staged import abc/.test(line))).toBe(true);

        expect(await applyPendingImport({ configDir, databasePath })).toBeNull();
    });

    it('sets aside a staged file that does not match its record', async () => {
        const configDir = scratch('apply-bad');
        const databasePath = join(configDir, DATABASE_FILE);
        (await createVrcxDatabase(databasePath, { rows: 1 })).close();

        const staged = join(configDir, 'import-pending');
        mkdirSync(staged);
        (await createVrcxDatabase(join(staged, DATABASE_FILE), { rows: 2 })).close();
        writeFileSync(
            join(staged, 'manifest.json'),
            JSON.stringify({ id: 'bad', stagedAt: 't', bytes: 1, sha256: 'f'.repeat(64), manifest: {} })
        );

        const result = await applyPendingImport({ configDir, databasePath });
        expect(result.applied).toBe(false);
        expect(result.reason).toMatch(/digest/);
        expect(await countFeedRows(databasePath)).toBe(1);
        expect(readdirSync(configDir).some((name) => name.startsWith('import-pending.rejected-'))).toBe(true);
    });
});

describe('admin protocol over a real socket', () => {
    let configDir;
    let databasePath;
    let server;
    let url;
    let restarts;
    let clients;

    beforeEach(async () => {
        configDir = mkdtempSync(join(work, 'hub-'));
        databasePath = join(configDir, DATABASE_FILE);
        restarts = [];
        clients = [];
        const handleAdmin = createAdminHandler({
            configDir,
            databasePath,
            hubVersion: 'test-hub',
            expectedSchemaVersion: 17,
            getStatus: () => ({ loggedIn: false, clientCount: 1 }),
            requestRestart: (reason) => restarts.push(reason)
        });
        server = createHubServer({
            port: 0,
            host: '127.0.0.1',
            token: TOKEN,
            handleCall: createInteropHandler({ SQLite: {}, WebApi: {} }),
            describe: () => ({ hub: 'test-hub', admin: true, databaseVersion: 17 }),
            onAdmin: handleAdmin
        });
        await server.start();
        url = `ws://127.0.0.1:${server.address.port}`;
    });

    afterEach(async () => {
        for (const client of clients) {
            client.close();
        }
        await server.stop();
    });

    /**
     * @returns {Promise<ReturnType<typeof createHubConnection>>}
     */
    async function connect() {
        const { connection } = await connectToHub({ url, token: TOKEN });
        clients.push(connection);
        return connection;
    }

    it('answers admin-unsupported on a Hub without a handler', async () => {
        const plain = createHubServer({
            port: 0,
            host: '127.0.0.1',
            token: TOKEN,
            handleCall: async () => null,
            describe: () => ({ hub: 'old-hub' })
        });
        await plain.start();
        try {
            await expect(connectToHub({ url: `ws://127.0.0.1:${plain.address.port}`, token: TOKEN })).rejects.toThrow(
                /predates the migration tool/
            );

            const raw = createHubConnection({
                url: `ws://127.0.0.1:${plain.address.port}`,
                token: TOKEN,
                autoReconnect: false
            });
            clients.push(raw);
            await raw.connect();
            await expect(raw.admin(AdminOp.INFO)).rejects.toMatchObject({ code: 'admin-unsupported' });
        } finally {
            await plain.stop();
        }
    });

    it('describes the Hub, including a database it has', async () => {
        const client = await connect();
        expect(await hubInfo(client)).toMatchObject({
            hub: 'test-hub',
            configDir,
            database: null,
            pendingImport: null,
            lastImport: null,
            restartSupported: true,
            loggedIn: false
        });

        (await createVrcxDatabase(databasePath, { rows: 3 })).close();
        const info = await hubInfo(client);
        expect(info.database).toMatchObject({ users: [USER_ID], schemaVersion: 16 });
    });

    it('uploads in chunks, stages, requests a restart, and applies at the next boot', async () => {
        (await createVrcxDatabase(databasePath, { rows: 2 })).close();

        const source = scratch('upload-src');
        const live = join(source, 'live.sqlite3');
        (await createVrcxDatabase(live, { rows: 1500 })).close();
        const manifest = await bundleOf(source, live);
        expect(manifest.database.bytes).toBeGreaterThan(200 * 1024);

        const client = await connect();
        const seen = [];
        const result = await uploadDatabase(client, {
            file: join(source, DATABASE_FILE),
            bytes: manifest.database.bytes,
            sha256: manifest.database.sha256,
            manifest,
            chunkBytes: 64 * 1024,
            onProgress: (done, total) => seen.push([done, total])
        });

        expect(result).toMatchObject({ staged: true, restarting: true, replacesExisting: true });
        expect(seen.length).toBeGreaterThan(3);
        expect(seen.at(-1)[0]).toBe(manifest.database.bytes);
        expect(readPendingImport(configDir)).toMatchObject({ id: result.id, sha256: manifest.database.sha256 });
        expect((await hubInfo(client)).pendingImport?.id).toBe(result.id);

        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(restarts).toEqual([`database import ${result.id} staged`]);

        // What the next boot does.
        const applied = await applyPendingImport({ configDir, databasePath });
        expect(applied.applied).toBe(true);
        expect(await countFeedRows(databasePath)).toBe(1500);
        expect((await hubInfo(client)).lastImport?.id).toBe(result.id);
    });

    it('rejects a wrong digest without touching anything', async () => {
        const source = scratch('upload-bad');
        const live = join(source, 'live.sqlite3');
        (await createVrcxDatabase(live, { rows: 20 })).close();
        const manifest = await bundleOf(source, live);
        const lie = { ...manifest, database: { ...manifest.database, sha256: 'a'.repeat(64) } };

        const client = await connect();
        await expect(
            uploadDatabase(client, {
                file: join(source, DATABASE_FILE),
                bytes: manifest.database.bytes,
                sha256: 'a'.repeat(64),
                manifest: lie
            })
        ).rejects.toMatchObject({ code: 'digest-mismatch' });

        expect(readPendingImport(configDir)).toBeNull();
        expect(
            existsSync(join(configDir, 'import-pending')) ? readdirSync(join(configDir, 'import-pending')) : []
        ).toEqual([]);
        expect(restarts).toEqual([]);
    });

    it('refuses a database newer than the Hub can migrate', async () => {
        const source = scratch('upload-newer');
        const live = join(source, 'live.sqlite3');
        (await createVrcxDatabase(live, { rows: 1, schemaVersion: 99 })).close();
        const manifest = await bundleOf(source, live);

        const client = await connect();
        await expect(
            uploadDatabase(client, {
                file: join(source, DATABASE_FILE),
                bytes: manifest.database.bytes,
                sha256: manifest.database.sha256,
                manifest
            })
        ).rejects.toMatchObject({ code: 'schema-too-new' });
    });

    it('serves a consistent snapshot of a live database as a bundle', async () => {
        const writer = await createVrcxDatabase(databasePath, { rows: 1200 });
        writeFileSync(join(configDir, 'hub-token'), `${TOKEN}\n`);
        writeFileSync(join(configDir, 'VRCX.json'), '{}');
        try {
            const client = await connect();
            const dest = join(scratch('download'), 'bundle');
            const manifest = await downloadSnapshot(client, dest, { chunkBytes: 100 * 1024 });

            expect(isBundleDir(dest)).toBe(true);
            expect(readManifest(dest)).toEqual(manifest);
            expect(manifest.source).toMatchObject({ kind: 'hub', hubVersion: 'test-hub' });
            expect(manifest.files.map((file) => file.name).sort()).toEqual(['VRCX.json', 'hub-token']);
            expect(readFileSync(join(dest, 'hub-token'), 'utf8').trim()).toBe(TOKEN);
            expect(await sha256File(join(dest, DATABASE_FILE))).toBe(manifest.database.sha256);
            expect(await countFeedRows(join(dest, DATABASE_FILE))).toBe(1200);

            // The Hub's working copy is gone once the download is done.
            const leftovers = readdirSync(join(configDir, 'backups')).filter((name) => name.startsWith('.snapshot-'));
            expect(leftovers).toEqual([]);
        } finally {
            writer.close();
        }
    });
});

describe('command line', () => {
    it('parses commands and flags', () => {
        expect(parseCommandLine(['migrate', '--hub=pi', '--yes'])).toEqual({
            command: 'migrate',
            flags: { hub: 'pi', yes: true },
            positional: []
        });
        expect(parseCommandLine([]).command).toBe('help');
        expect(parseCommandLine(['backup', '-h']).command).toBe('help');
    });

    it('accepts the address forms people type', () => {
        expect(normaliseHubUrl('pi.local')).toBe('ws://pi.local:9001');
        expect(normaliseHubUrl('192.168.1.50:9100')).toBe('ws://192.168.1.50:9100');
        expect(normaliseHubUrl('wss://hub.example/')).toBe('wss://hub.example:9001');
    });

    it('falls back to the local VRCX.json for the Hub address and token', () => {
        const localDir = scratch('client');
        writeStorage(localDir, { VRCX_HubUrl: 'ws://pi:9001', VRCX_HubToken: 'from-json' });

        expect(resolveHubTarget({}, { env: {}, localDir })).toMatchObject({
            url: 'ws://pi:9001',
            token: 'from-json',
            urlSource: expect.stringContaining('VRCX_HubUrl')
        });
        expect(resolveHubTarget({ hub: 'other', token: 'flag' }, { env: {}, localDir })).toMatchObject({
            url: 'ws://other:9001',
            token: 'flag',
            urlSource: '--hub',
            tokenSource: '--token'
        });
        expect(resolveHubTarget({}, { env: {}, localDir: scratch('client-empty') })).toBeNull();

        const tokenFile = join(localDir, 'token.txt');
        writeFileSync(tokenFile, 'from-file\n');
        expect(resolveHubTarget({ hub: 'pi', 'token-file': tokenFile }, { env: {}, localDir }).token).toBe('from-file');
    });
});
