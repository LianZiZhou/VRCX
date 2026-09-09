/**
 * [hub] The browser front end of `vrcx-hub-migrate`.
 *
 * A GUI without a GUI toolkit: `node:http` serves one page on 127.0.0.1 and
 * opens it in whatever browser the machine already has. The page posts a
 * command with the same flags the CLI takes, then follows it over
 * Server-Sent Events -- lines, progress, and yes/no questions it answers with
 * another POST. `commands.js` never knows which front end it is talking to.
 *
 * Kept deliberately small on the security side, since it is a loopback
 * service with file-system reach:
 *
 *   - bound to 127.0.0.1 only;
 *   - every request must carry a random per-launch token (query string on the
 *     page, a header on the API), so a web page in the same browser cannot
 *     drive it -- it never learns the token;
 *   - the Host header must be the loopback address the server was told about,
 *     which defeats DNS rebinding;
 *   - one job at a time, and the process exits after a quiet quarter hour.
 */

import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createCommands, TOOL_VERSION } from '../commands.js';
import { defaultDataDir, timestamp } from '../dataDir.js';
import { resolveHubTarget } from '../options.js';
import { renderPage } from './page.js';

const IDLE_EXIT_MS = 15 * 60 * 1000;
const TOKEN_HEADER = 'x-migrate-token';
const COMMANDS = ['migrate', 'backup', 'restore', 'info'];

/**
 * @param {string} url
 */
function openInBrowser(url) {
    let command;
    let args;
    if (process.platform === 'win32') {
        // `start` is a cmd built-in; the empty string is the window title
        // it would otherwise take the URL for.
        command = 'cmd';
        args = ['/c', 'start', '', url];
    } else if (process.platform === 'darwin') {
        command = 'open';
        args = [url];
    } else {
        command = 'xdg-open';
        args = [url];
    }
    try {
        spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
    } catch {
        // Printed URL is the fallback.
    }
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {number} limit
 * @returns {Promise<any>}
 */
function readJson(request, limit = 64 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        request.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
                reject(new Error('Request body too large'));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => {
            try {
                resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
            } catch (err) {
                reject(err);
            }
        });
        request.on('error', reject);
    });
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {any} body
 */
function sendJson(response, status, body) {
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    response.end(JSON.stringify(body));
}

/**
 * The flags the page may pass through. Anything else is dropped, so the
 * browser cannot, say, hand `--token-file` a path to read.
 *
 * @param {any} raw
 * @returns {Record<string, string | boolean>}
 */
function sanitiseFlags(raw) {
    const flags = {};
    for (const key of ['from', 'to', 'hub', 'token']) {
        if (typeof raw?.[key] === 'string' && raw[key].trim()) {
            flags[key] = raw[key].trim();
        }
    }
    for (const key of ['configure-client', 'with-token', 'no-wait']) {
        if (raw?.[key] === true) {
            flags[key] = true;
        }
    }
    return flags;
}

/**
 * @typedef {object} GuiHandle
 * @property {string} url - the page, token included
 * @property {number} port
 * @property {string} token
 * @property {Promise<void>} closed - settles when the server has stopped
 * @property {() => Promise<void>} stop
 */

/**
 * @param {{ port?: number, open?: boolean, log?: (line: string) => void, exit?: boolean }} [options]
 * @returns {Promise<GuiHandle>}
 */
export async function startGui(options = {}) {
    const { port = 0, open = true, log = () => {}, exit = true } = options;
    const token = randomBytes(24).toString('base64url');

    /** @type {{ id: string, events: object[], listeners: Set<Function>, answer: Function | null, done: boolean } | null} */
    let job = null;
    let idleTimer = null;
    let stopping = false;
    /** @type {Function} */
    let markClosed;
    const closed = new Promise((resolve) => {
        markClosed = resolve;
    });

    /**
     * @param {object} event
     */
    function emit(event) {
        if (!job) {
            return;
        }
        job.events.push(event);
        for (const listener of job.listeners) {
            listener(event);
        }
    }

    const ui = {
        say: (text = '') => emit({ type: 'line', text }),
        progress: (label) => (done, total) => emit({ type: 'progress', label, done, total }),
        confirm: (question, flags) => {
            if (flags.yes) {
                return Promise.resolve(true);
            }
            return new Promise((resolve) => {
                job.answer = resolve;
                emit({ type: 'confirm', question });
            });
        }
    };
    const commands = createCommands(ui);

    function touch() {
        if (idleTimer) {
            clearTimeout(idleTimer);
        }
        idleTimer = setTimeout(() => {
            if (!job || job.done) {
                log('No activity for a while; closing.');
                stop();
            } else {
                touch();
            }
        }, IDLE_EXIT_MS);
        idleTimer.unref?.();
    }

    /**
     * @param {string} command
     * @param {Record<string, string | boolean>} flags
     */
    async function runJob(command, flags) {
        const current = job;
        try {
            await commands[command](flags);
            emit({ type: 'done', ok: true });
        } catch (err) {
            emit({ type: 'done', ok: false, message: err instanceof Error ? err.message : String(err) });
        } finally {
            current.done = true;
        }
    }

    /**
     * @returns {object}
     */
    function describeState() {
        const localDir = defaultDataDir();
        let hub;
        try {
            hub = resolveHubTarget({});
        } catch {
            hub = null;
        }
        return {
            version: TOOL_VERSION,
            platform: process.platform,
            localDir,
            backupDir: join(homedir(), 'vrcx-backups', `vrcx-backup-${timestamp()}`),
            hub: hub ? { url: hub.url, token: hub.token, urlSource: hub.urlSource } : null,
            busy: Boolean(job && !job.done)
        };
    }

    const server = createServer(async (request, response) => {
        touch();
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const expectedHost = `127.0.0.1:${server.address()?.port}`;
        if (request.headers.host !== expectedHost && request.headers.host !== `localhost:${server.address()?.port}`) {
            sendJson(response, 421, { error: 'Wrong host' });
            return;
        }

        if (url.pathname === '/') {
            if (url.searchParams.get('t') !== token) {
                response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
                response.end('This page needs the link the tool printed when it started.');
                return;
            }
            response.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'Content-Security-Policy':
                    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'"
            });
            response.end(renderPage({ token, version: TOOL_VERSION }));
            return;
        }

        if (!url.pathname.startsWith('/api/')) {
            sendJson(response, 404, { error: 'Not found' });
            return;
        }
        // EventSource cannot set headers, so the event stream alone may carry
        // the token in its query string instead.
        const presented =
            request.headers[TOKEN_HEADER] ?? (url.pathname === '/api/events' ? url.searchParams.get('t') : null);
        if (presented !== token) {
            sendJson(response, 403, { error: 'Missing or wrong token' });
            return;
        }

        try {
            switch (`${request.method} ${url.pathname}`) {
                case 'GET /api/state':
                    sendJson(response, 200, describeState());
                    return;

                case 'POST /api/run': {
                    const body = await readJson(request);
                    if (!COMMANDS.includes(body.command)) {
                        sendJson(response, 400, { error: `Unknown command: ${body.command}` });
                        return;
                    }
                    if (job && !job.done) {
                        sendJson(response, 409, { error: 'Another operation is still running' });
                        return;
                    }
                    job = {
                        id: randomBytes(8).toString('hex'),
                        events: [],
                        listeners: new Set(),
                        answer: null,
                        done: false
                    };
                    const id = job.id;
                    runJob(body.command, sanitiseFlags(body.flags));
                    sendJson(response, 200, { id });
                    return;
                }

                case 'GET /api/events': {
                    if (!job || job.id !== url.searchParams.get('id')) {
                        sendJson(response, 404, { error: 'No such job' });
                        return;
                    }
                    response.writeHead(200, {
                        'Content-Type': 'text/event-stream; charset=utf-8',
                        'Cache-Control': 'no-store',
                        Connection: 'keep-alive'
                    });
                    /** @param {object} event */
                    const send = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
                    // Everything so far, then whatever follows. A `done` that
                    // has already happened is in the replay too.
                    for (const event of job.events) {
                        send(event);
                    }
                    const current = job;
                    current.listeners.add(send);
                    request.on('close', () => current.listeners.delete(send));
                    return;
                }

                case 'POST /api/answer': {
                    const body = await readJson(request);
                    if (!job || job.id !== body.id || !job.answer) {
                        sendJson(response, 409, { error: 'Nothing is waiting for an answer' });
                        return;
                    }
                    const answer = job.answer;
                    job.answer = null;
                    answer(Boolean(body.yes));
                    sendJson(response, 200, { ok: true });
                    return;
                }

                case 'POST /api/quit':
                    sendJson(response, 200, { ok: true });
                    setTimeout(() => stop(), 100);
                    return;

                default:
                    sendJson(response, 404, { error: 'Not found' });
            }
        } catch (err) {
            sendJson(response, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    });

    /**
     * @returns {Promise<void>}
     */
    function stop() {
        if (stopping) {
            return closed;
        }
        stopping = true;
        if (idleTimer) {
            clearTimeout(idleTimer);
        }
        server.closeAllConnections?.();
        server.close(() => {
            markClosed();
            if (exit) {
                process.exit(0);
            }
        });
        return closed;
    }

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve();
        });
    });

    const actualPort = server.address().port;
    const pageUrl = `http://127.0.0.1:${actualPort}/?t=${token}`;
    log(`vrcx-hub-migrate ${TOOL_VERSION}`);
    log(`Open this page (it should open on its own): ${pageUrl}`);
    log('Close the page or press Ctrl+C to quit.');
    touch();
    if (open) {
        openInBrowser(pageUrl);
    }

    return { url: pageUrl, port: actualPort, token, closed, stop };
}
