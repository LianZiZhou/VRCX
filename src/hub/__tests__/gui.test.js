/**
 * [hub] The browser front end of the migration tool, driven the way the page
 * drives it: a token-bearing request to start a job, an event stream to
 * follow it, and a second POST to answer its question.
 *
 * Talks `node:http` directly rather than `fetch`: the test setup installs
 * happy-dom's `fetch`, which enforces a same-origin policy against a page
 * that does not exist here.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DATABASE_FILE } from '../migrate/dataDir.js';
import { loadSqlite } from '../migrate/snapshot.js';
import { startGui } from '../migrate/gui/server.js';

/** @type {string} */
let work;
/** @type {Awaited<ReturnType<typeof startGui>>} */
let gui;

beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'vrcx-hub-gui-'));
    gui = await startGui({ open: false, exit: false });
});

afterAll(async () => {
    await gui.stop();
    rmSync(work, { recursive: true, force: true });
});

/**
 * @param {string} path
 * @param {{ method?: string, headers?: Record<string, string>, body?: object, token?: boolean }} [options]
 * @returns {Promise<{ status: number, headers: object, text: string, json: any }>}
 */
function call(path, options = {}) {
    const { method = 'GET', headers = {}, body, token = true } = options;
    return new Promise((resolve, reject) => {
        const req = httpRequest(
            {
                host: '127.0.0.1',
                port: gui.port,
                path,
                method,
                headers: { 'content-type': 'application/json', ...headers }
            },
            (res) => {
                let text = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => (text += chunk));
                res.on('end', () => {
                    let json = null;
                    try {
                        json = JSON.parse(text);
                    } catch {
                        // Not JSON; the page, for instance.
                    }
                    resolve({ status: res.statusCode, headers: res.headers, text, json });
                });
            }
        );
        if (token) {
            req.setHeader('x-migrate-token', gui.token);
        }
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
    });
}

/**
 * @param {string} command
 * @param {object} flags
 * @returns {Promise<string>} the job id
 */
async function start(command, flags) {
    const response = await call('/api/run', { method: 'POST', body: { command, flags } });
    expect(response.status).toBe(200);
    return response.json.id;
}

/**
 * Read the event stream until `done`, answering any question with `answer`.
 *
 * @param {string} id
 * @param {boolean} answer
 * @returns {Promise<object[]>}
 */
function follow(id, answer) {
    return new Promise((resolve, reject) => {
        const req = httpRequest(
            {
                host: '127.0.0.1',
                port: gui.port,
                path: `/api/events?id=${id}`,
                headers: { 'x-migrate-token': gui.token }
            },
            (res) => {
                expect(res.headers['content-type']).toMatch(/text\/event-stream/);
                const events = [];
                let buffer = '';
                res.setEncoding('utf8');
                res.on('data', async (chunk) => {
                    buffer += chunk;
                    let cut;
                    while ((cut = buffer.indexOf('\n\n')) !== -1) {
                        const frame = buffer.slice(0, cut);
                        buffer = buffer.slice(cut + 2);
                        const event = JSON.parse(frame.replace(/^data: /, ''));
                        events.push(event);
                        if (event.type === 'confirm') {
                            await call('/api/answer', { method: 'POST', body: { id, yes: answer } });
                        }
                        if (event.type === 'done') {
                            req.destroy();
                            resolve(events);
                        }
                    }
                });
                res.on('error', () => resolve(events));
            }
        );
        req.on('error', reject);
        req.end();
    });
}

/**
 * @param {string} dir
 */
async function makeDataDir(dir) {
    mkdirSync(dir, { recursive: true });
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(join(dir, DATABASE_FILE));
    db.exec('CREATE TABLE configs (`key` TEXT PRIMARY KEY, `value` TEXT)');
    db.prepare('INSERT INTO configs VALUES (?, ?)').run('config:vrcx_databaseversion', '16');
    db.close();
}

describe('gui server', () => {
    it('serves the page only with the launch token, and only on loopback host names', async () => {
        expect((await call('/', { token: false })).status).toBe(403);

        const page = await call(`/?t=${gui.token}`, { token: false });
        expect(page.status).toBe(200);
        expect(page.text).toContain(`data-token="${gui.token}"`);
        expect(page.text).toContain('VRCX Hub 迁移工具');

        expect((await call('/api/state', { token: false })).status).toBe(403);
        expect((await call('/api/state', { headers: { host: 'evil.example:80' } })).status).toBe(421);
    });

    it('describes the machine', async () => {
        const { json: state } = await call('/api/state');
        expect(state.version).toBeTypeOf('string');
        expect(state.localDir).toMatch(/VRCX/);
        expect(state.busy).toBe(false);
    });

    it('runs a command and streams its output', async () => {
        const dir = join(work, 'data');
        await makeDataDir(dir);

        const events = await follow(await start('info', { from: dir }), true);
        expect(events.at(-1)).toEqual({ type: 'done', ok: true });
        const lines = events.filter((e) => e.type === 'line').map((e) => e.text);
        expect(lines.some((line) => /Schema\s+v16/.test(line))).toBe(true);
    });

    it('reports a failure as a done event, not a dead stream', async () => {
        const events = await follow(await start('info', { from: join(work, 'nowhere') }), true);
        expect(events.at(-1)).toMatchObject({
            type: 'done',
            ok: false,
            message: expect.stringMatching(/No such directory/)
        });
    });

    it('asks before restoring and honours a no', async () => {
        const dir = join(work, 'data-2');
        await makeDataDir(dir);
        const backup = join(work, 'bk');
        expect((await follow(await start('backup', { from: dir, to: backup }), true)).at(-1)).toEqual({
            type: 'done',
            ok: true
        });
        expect(existsSync(join(backup, 'manifest.json'))).toBe(true);

        const target = join(work, 'target');
        const events = await follow(await start('restore', { from: backup, to: target }), false);
        expect(events.some((e) => e.type === 'confirm' && /Restore now/.test(e.question))).toBe(true);
        expect(events.at(-1)).toEqual({ type: 'done', ok: true });
        expect(existsSync(join(target, DATABASE_FILE))).toBe(false);
    });

    it('refuses unknown commands, and flags the page may not pass', async () => {
        expect((await call('/api/run', { method: 'POST', body: { command: 'rm', flags: {} } })).status).toBe(400);

        // `token-file` is not on the allow list: the tool must not read an
        // arbitrary file for the browser. With it dropped, `info` has an
        // address but no token, and says so instead of reading the file.
        const events = await follow(
            await start('info', { from: join(work, 'data'), hub: '127.0.0.1:1', 'token-file': 'C:/secret' }),
            true
        );
        expect(events.at(-1)).toEqual({ type: 'done', ok: true });
        expect(events.some((e) => e.type === 'line' && /No token known/.test(e.text))).toBe(true);
    });
});
