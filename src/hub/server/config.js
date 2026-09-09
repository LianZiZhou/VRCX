/**
 * [hub] Hub configuration: CLI flags, environment, and the shared token.
 *
 * Arguments are parsed by hand rather than with yargs. The Hub bundles its
 * dependencies into a single file for the Raspberry Pi, and a dozen lines here
 * is cheaper than pulling an argument parser into that bundle.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import { defaultDataDir, TOKEN_FILE } from '../migrate/dataDir.js';

const DEFAULT_PORT = 9001;
const DEFAULT_STATUS_PORT = 9002;

/**
 * The exit code with which the Hub asks to be started again.
 *
 * A staged database import is applied at boot, before the .NET side opens the
 * file, so applying one means a full restart. The launchers in the release
 * zips loop on this code, systemd's `Restart=always` covers it, and a Docker
 * `--restart` policy does too. Run by hand, the Hub simply exits and the import
 * waits for the next start. 75 is `EX_TEMPFAIL` in sysexits.h -- "try again",
 * which is exactly the request.
 */
export const RESTART_EXIT_CODE = 75;

/**
 * @returns {string}
 */
function defaultConfigDir() {
    if (process.env.VRCX_HUB_DATA) {
        return resolve(process.env.VRCX_HUB_DATA);
    }
    return defaultDataDir();
}

/**
 * @param {string[]} argv
 * @returns {Record<string, string | boolean>}
 */
function parseArgs(argv) {
    /** @type {Record<string, string | boolean>} */
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
 * Read the persisted token, creating one on first run.
 *
 * The token is the only secret in the system: it authenticates clients and,
 * through HKDF, is the root of the channel encryption keys. 32 random bytes.
 *
 * @param {string} configDir
 * @returns {string}
 */
export function loadOrCreateToken(configDir) {
    const path = join(configDir, TOKEN_FILE);
    if (existsSync(path)) {
        const token = readFileSync(path, 'utf8').trim();
        if (token) {
            return token;
        }
    }
    const token = randomBytes(32).toString('base64url');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
        chmodSync(path, 0o600);
    } catch {
        // Windows and some filesystems do not support this; not fatal.
    }
    return token;
}

/**
 * @typedef {object} HubConfig
 * @property {string} configDir
 * @property {number} port
 * @property {string} host
 * @property {number} statusPort
 * @property {string} token
 * @property {boolean} dryRun - boot the core against stubs, touch no real data
 * @property {{key: string, cert: string} | null} tls
 * @property {boolean} verbose
 */

/**
 * @param {string[]} [argv]
 * @param {Record<string, string | undefined>} [env]
 * @returns {HubConfig}
 */
export function loadHubConfig(argv = process.argv.slice(2), env = process.env) {
    const args = parseArgs(argv);

    const configDir = resolve(String(args.config ?? env.VRCX_HUB_DATA ?? defaultConfigDir()));
    mkdirSync(configDir, { recursive: true });

    const token = String(args.token ?? env.VRCX_HUB_TOKEN ?? loadOrCreateToken(configDir));

    let tls = null;
    if (args['tls-cert'] && args['tls-key']) {
        tls = {
            cert: readFileSync(String(args['tls-cert']), 'utf8'),
            key: readFileSync(String(args['tls-key']), 'utf8')
        };
    }

    return {
        configDir,
        port: Number(args.port ?? env.VRCX_HUB_PORT ?? DEFAULT_PORT),
        host: String(args.host ?? env.VRCX_HUB_HOST ?? '0.0.0.0'),
        statusPort: Number(args['status-port'] ?? env.VRCX_HUB_STATUS_PORT ?? DEFAULT_STATUS_PORT),
        token,
        dryRun: Boolean(args['dry-run']),
        tls,
        verbose: Boolean(args.verbose ?? env.VRCX_HUB_VERBOSE)
    };
}

export const HUB_USAGE = `
VRCX Hub - headless VRCX backend

  --config=<dir>        data directory (default: platform VRCX config dir)
  --port=<n>            client port (default ${DEFAULT_PORT})
  --host=<addr>         bind address (default 0.0.0.0)
  --status-port=<n>     read-only status page (default ${DEFAULT_STATUS_PORT}, 0 to disable)
  --token=<secret>      override the stored token
  --tls-cert=<file>     optional TLS, on top of the built-in encryption
  --tls-key=<file>
  --dry-run             boot the data core against stubs; touches no real data
  --verbose             log every interop call
  --help

The shared token is generated on first run and stored in <config>/${TOKEN_FILE}.
Clients need the host, the port and that token.
`;
