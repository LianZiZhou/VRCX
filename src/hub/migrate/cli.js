/**
 * [hub] `vrcx-hub-migrate`: move a VRCX's data onto a Hub, and back it up.
 *
 *   vrcx-hub-migrate migrate --hub=pi.local --token=...    desktop VRCX -> Hub
 *   vrcx-hub-migrate backup                                a copy of this VRCX's data
 *   vrcx-hub-migrate backup --hub=pi.local                 a copy of the Hub's data
 *   vrcx-hub-migrate restore --from=<backup>               put a backup back
 *   vrcx-hub-migrate gui                                   the same, in a browser page
 *
 * Ships in every release zip next to the Hub, and runs from a checkout with
 * `npm run hub-migrate -- <command>`. Uses nothing from `src/` outside
 * `src/hub/`, so it needs no bundling and no browser shims to run from source.
 *
 * The whole of a VRCX install that is worth moving is one file, `VRCX.sqlite3`
 * -- the VRChat session cookies live in it too (`dataDir.js` explains) -- so
 * "migrate" is: take a consistent snapshot of it, upload it, and let the Hub
 * restart on it. The Hub keeps whatever it had in `backups/`.
 *
 * This file is only the terminal front end; `commands.js` holds the logic and
 * `gui/server.js` is the other front end.
 */

import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { parseCommandLine, USAGE } from './options.js';
import { createCommands, formatBytes, TOOL_VERSION } from './commands.js';
import { startGui } from './gui/server.js';

/**
 * @param {string} [text]
 */
function say(text = '') {
    console.log(text);
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

/**
 * @param {string[]} argv
 * @returns {Promise<number>} exit code
 */
export async function run(argv) {
    const { command, flags } = parseCommandLine(argv);
    const commands = createCommands({ say, progress, confirm });
    try {
        switch (command) {
            case 'migrate':
                await commands.migrate(flags);
                break;
            case 'backup':
                await commands.backup(flags);
                break;
            case 'restore':
                await commands.restore(flags);
                break;
            case 'info':
                await commands.info(flags);
                break;
            case 'gui': {
                const gui = await startGui({
                    port: typeof flags.port === 'string' ? Number(flags.port) : 0,
                    open: !flags['no-open'],
                    log: say
                });
                // Stays up until the page's Quit button, Ctrl+C, or idleness.
                await gui.closed;
                break;
            }
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
