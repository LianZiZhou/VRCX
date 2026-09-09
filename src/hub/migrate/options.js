/**
 * [hub] Command line for `vrcx-hub-migrate`: parsing, defaults, and where the
 * Hub address and token come from when they are not given.
 *
 * Hand-rolled for the same reason as `server/config.js`: the tool ships as one
 * bundled file and an argument parser is not worth its weight there.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { defaultDataDir, readStorage } from './dataDir.js';

export const COMMANDS = ['migrate', 'backup', 'restore', 'info', 'gui', 'help'];

const DEFAULT_PORT = 9001;

/** Keys the mirror client reads from VRCX.json; see `client/mirrorMode.js`. */
export const HubSettingKey = {
    ENABLED: 'VRCX_HubEnabled',
    URL: 'VRCX_HubUrl',
    TOKEN: 'VRCX_HubToken'
};

/**
 * @typedef {object} CommandLine
 * @property {string} command
 * @property {Record<string, string | boolean>} flags
 * @property {string[]} positional
 */

/**
 * @param {string[]} argv
 * @returns {CommandLine}
 */
export function parseCommandLine(argv) {
    /** @type {Record<string, string | boolean>} */
    const flags = {};
    /** @type {string[]} */
    const positional = [];
    for (const arg of argv) {
        if (arg === '-h') {
            flags.help = true;
        } else if (arg.startsWith('--')) {
            const body = arg.slice(2);
            const eq = body.indexOf('=');
            if (eq === -1) {
                flags[body] = true;
            } else {
                flags[body.slice(0, eq)] = body.slice(eq + 1);
            }
        } else {
            positional.push(arg);
        }
    }
    const command = flags.help ? 'help' : (positional.shift() ?? 'help');
    return { command, flags, positional };
}

/**
 * Accept the forms people actually type: a bare host, host:port, or a full
 * ws:// URL.
 *
 * @param {string} value
 * @returns {string}
 */
export function normaliseHubUrl(value) {
    let text = String(value).trim();
    if (!text) {
        return '';
    }
    if (!/^wss?:\/\//i.test(text)) {
        text = `ws://${text}`;
    }
    const url = new URL(text);
    if (!url.port) {
        url.port = String(DEFAULT_PORT);
    }
    return url.toString().replace(/\/$/, '');
}

/**
 * @typedef {object} HubTarget
 * @property {string} url
 * @property {string} token
 * @property {string} urlSource - where the address came from, for the summary line
 * @property {string} tokenSource
 */

/**
 * The Hub to talk to, from flags, environment, or the local VRCX.json (a
 * client that has already been pointed at a Hub knows both).
 *
 * @param {Record<string, string | boolean>} flags
 * @param {{ env?: Record<string, string | undefined>, localDir?: string }} [context]
 * @returns {HubTarget | null} null when no address could be found
 */
export function resolveHubTarget(flags, context = {}) {
    const { env = process.env, localDir = defaultDataDir(env) } = context;
    let storage = {};
    try {
        storage = readStorage(localDir);
    } catch {
        // A broken VRCX.json only removes one source of defaults.
    }

    let url = '';
    let urlSource = '';
    if (typeof flags.hub === 'string' && flags.hub) {
        url = flags.hub;
        urlSource = '--hub';
    } else if (env.VRCX_HUB_URL) {
        url = env.VRCX_HUB_URL;
        urlSource = 'VRCX_HUB_URL';
    } else if (storage[HubSettingKey.URL]) {
        url = String(storage[HubSettingKey.URL]);
        urlSource = `${HubSettingKey.URL} in ${localDir}`;
    }
    if (!url) {
        return null;
    }

    let token = '';
    let tokenSource = '';
    if (typeof flags.token === 'string' && flags.token) {
        token = flags.token;
        tokenSource = '--token';
    } else if (typeof flags['token-file'] === 'string' && flags['token-file']) {
        const path = resolve(flags['token-file']);
        if (!existsSync(path)) {
            throw new Error(`Token file not found: ${path}`);
        }
        token = readFileSync(path, 'utf8').trim();
        tokenSource = path;
    } else if (env.VRCX_HUB_TOKEN) {
        token = env.VRCX_HUB_TOKEN;
        tokenSource = 'VRCX_HUB_TOKEN';
    } else if (storage[HubSettingKey.TOKEN]) {
        token = String(storage[HubSettingKey.TOKEN]);
        tokenSource = `${HubSettingKey.TOKEN} in ${localDir}`;
    }

    return { url: normaliseHubUrl(url), token, urlSource, tokenSource };
}

export const USAGE = `
vrcx-hub-migrate - move VRCX data to a Hub, and back it up

  vrcx-hub-migrate migrate  [--hub=<addr>] [--token=<secret>] [--from=<dir>] [--configure-client]
  vrcx-hub-migrate backup   [--from=<dir> | --hub=<addr>] [--to=<dir>]
  vrcx-hub-migrate restore  --from=<backup> [--to=<dir>] [--with-token]
  vrcx-hub-migrate info     [--from=<dir>] [--hub=<addr>]
  vrcx-hub-migrate gui      [--port=<n>] [--no-open]

Commands
  migrate   snapshot a VRCX data directory (or a backup) and send it to a Hub,
            which keeps its current database in backups/ and restarts on the new one
  backup    take a consistent copy of a VRCX data directory, or of a running Hub
  restore   put a backup's database back into a data directory (VRCX or Hub must be stopped)
  info      show what a data directory holds, and what the Hub is running
  gui       the same four, as a page in your browser (the launchers open it when
            run with no arguments, e.g. by double-clicking vrcx-hub-migrate.cmd)

Where things come from
  --from=<dir>        a VRCX data directory, or a backup made by this tool
                      (default: this machine's VRCX data directory)
  --to=<dir>          backup: where to write (default: ./vrcx-backup-<kind>-<time>)
                      restore: the data directory to restore into (default: this machine's)
  --hub=<addr>        host, host:port, or ws://host:port
                      (default: VRCX_HUB_URL, then VRCX_HubUrl in the local VRCX.json)
  --token=<secret>    the Hub's token; or --token-file=<path>
                      (default: VRCX_HUB_TOKEN, then VRCX_HubToken in the local VRCX.json)

Options
  --configure-client  after migrating, write the Hub address and token into the local
                      VRCX.json so this VRCX attaches to the Hub on its next start
  --with-token        restore: also restore hub-token (a Hub backup only)
  --no-wait           migrate: do not wait for the Hub to come back after the import
  --yes               do not ask for confirmation
`;
