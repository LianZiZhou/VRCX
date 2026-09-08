/**
 * [hub] Merge a client's offline database back into the Hub's.
 *
 * When a mirror client loses the Hub it falls back to standalone and writes to
 * its own local database. Nothing merges that back automatically, because doing
 * so safely means reconciling two independently-grown SQLite files — which is
 * exactly what `Dotnet/DBMerger` already does. This is a wrapper that runs it
 * with the right arguments and the right safety checks.
 *
 *   node ./build-scripts/hub-merge-offline.js \
 *     --client-db=/path/to/the/client/VRCX.sqlite3 \
 *     [--hub-db=/var/lib/vrcx-hub/VRCX.sqlite3] \
 *     [--dbmerger=/opt/vrcx-hub/DBMerger] \
 *     [--yes]
 *
 * Run it on the Hub machine, with the Hub stopped. DBMerger opens both files
 * directly; merging underneath a running Hub would race its writes.
 *
 * Build DBMerger with:
 *   dotnet publish Dotnet/DBMerger/DBMerger.csproj -c Release -r linux-arm64
 */

const { copyFileSync, existsSync, mkdirSync, statSync } = require('node:fs');
const { createConnection } = require('node:net');
const { basename, dirname, join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');
const { homedir } = require('node:os');

/**
 * @param {string[]} argv
 * @returns {Record<string, string | boolean>}
 */
function parseArgs(argv) {
    const parsed = {};
    for (const arg of argv) {
        if (!arg.startsWith('--')) {
            continue;
        }
        const body = arg.slice(2);
        const eq = body.indexOf('=');
        if (eq === -1) {
            parsed[body] = true;
        } else {
            parsed[body.slice(0, eq)] = body.slice(eq + 1);
        }
    }
    return parsed;
}

/**
 * @returns {string}
 */
function defaultHubDataDir() {
    if (process.env.VRCX_HUB_DATA) {
        return resolve(process.env.VRCX_HUB_DATA);
    }
    const xdg = process.env.XDG_CONFIG_HOME;
    return xdg ? join(xdg, 'VRCX') : join(homedir(), '.config', 'VRCX');
}

/**
 * A listening Hub port is the cheapest reliable signal that it is running.
 *
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function isPortListening(port) {
    return new Promise((done) => {
        const socket = createConnection({ host: '127.0.0.1', port });
        const settle = (value) => {
            socket.destroy();
            done(value);
        };
        socket.setTimeout(500);
        socket.once('connect', () => settle(true));
        socket.once('timeout', () => settle(false));
        socket.once('error', () => settle(false));
    });
}

/**
 * @param {string} dbPath
 * @returns {string} the backup path
 */
function backup(dbPath) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = join(dirname(dbPath), 'backups');
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `${basename(dbPath)}.${stamp}.bak`);
    copyFileSync(dbPath, target);
    return target;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    const clientDb = args['client-db'] ? resolve(String(args['client-db'])) : null;
    const hubDb = resolve(String(args['hub-db'] ?? join(defaultHubDataDir(), 'VRCX.sqlite3')));
    const dbMerger = resolve(String(args.dbmerger ?? join(dirname(hubDb), 'DBMerger')));
    const port = Number(args.port ?? process.env.VRCX_HUB_PORT ?? 9001);

    if (!clientDb) {
        console.error('Missing --client-db=<path to the offline client database>');
        process.exitCode = 1;
        return;
    }
    for (const [label, path] of [
        ['client database', clientDb],
        ['hub database', hubDb],
        ['DBMerger', dbMerger]
    ]) {
        if (!existsSync(path)) {
            console.error(`Cannot find the ${label}: ${path}`);
            process.exitCode = 1;
            return;
        }
    }
    if (resolve(clientDb) === resolve(hubDb)) {
        console.error('The client and hub databases are the same file.');
        process.exitCode = 1;
        return;
    }

    if (await isPortListening(port)) {
        console.error(
            `Something is listening on port ${port}, which suggests the Hub is running.\n` +
                'Stop it first (systemctl stop vrcx-hub) — DBMerger opens both databases\n' +
                'directly and would race the Hub’s writes.'
        );
        process.exitCode = 1;
        return;
    }

    const sizeMb = (statSync(hubDb).size / 1024 / 1024).toFixed(1);
    console.log(`Hub database:    ${hubDb} (${sizeMb} MB)`);
    console.log(`Offline database: ${clientDb}`);

    // Unconditional. A merge rewrites the Hub's database in place, and that
    // database is the thing this whole feature exists to protect.
    const backupPath = backup(hubDb);
    console.log(`Backup written:  ${backupPath}`);

    console.log('\nMerging…');
    execFileSync(dbMerger, [`--new-db-path=${hubDb}`, `--old-db-path=${clientDb}`], {
        stdio: 'inherit'
    });

    console.log('\nDone. Start the Hub again and check its status page.');
    console.log(`If anything looks wrong, restore the backup:\n  cp "${backupPath}" "${hubDb}"`);
}

main().catch((err) => {
    console.error('Merge failed:', err.message);
    console.error('The Hub database was not modified, or a backup is in its backups/ directory.');
    process.exitCode = 1;
});
