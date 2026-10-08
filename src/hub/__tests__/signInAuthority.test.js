/**
 * [hub] One authority over the Hub's VRChat session: changes run one at a
 * time, the jar is never cleared under a request in flight, a 401 acts only
 * on a session that is really gone, and clients cannot touch the jar.
 */

import {
    clientRequestOptions,
    createClientSessionPolicy,
    createSessionLock,
    createSignInGate,
    decodeCookies,
    deviceCookiesOnly,
    encodeCookies,
    governSignIn,
    guardCookieJar,
    MAX_SIGN_INS_PER_HOUR,
    MIN_SIGN_IN_GAP_MS,
    SECOND_FACTOR_WAIT_MS
} from '../server/signInAuthority.js';

/**
 * @param {string} name
 * @param {string} value
 * @returns {object} a cookie as WebApi serialises it
 */
function cookie(name, value) {
    return { Name: name, Value: value, Domain: 'api.vrchat.cloud', Path: '/' };
}

/** @returns {{ promise: Promise<any>, resolve: (v?: any) => void }} */
function deferred() {
    let resolve;
    const promise = new Promise((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

/**
 * A WebApi whose jar behaves like the C# one: `ClearCookies` swaps in a new
 * jar, and a response stores its cookies in the jar its request started with.
 */
function fakeWebApi(initial = []) {
    let jar = { cookies: [...initial] };
    const calls = [];
    /** @type {Map<string, ReturnType<typeof deferred>>} */
    const gates = new Map();
    return {
        calls,
        gates,
        jar: () => jar.cookies.map((entry) => `${entry.Name}=${entry.Value}`),
        GetCookies: () => encodeCookies(jar.cookies),
        SetCookies: (blob) => {
            calls.push('SetCookies');
            for (const entry of decodeCookies(blob)) {
                jar.cookies = jar.cookies.filter((existing) => existing.Name !== entry.Name);
                jar.cookies.push(entry);
            }
        },
        ClearCookies: () => {
            calls.push('ClearCookies');
            jar = { cookies: [] };
        },
        async ExecuteJson(requestJson) {
            const { url } = JSON.parse(requestJson);
            calls.push(url);
            const startedWith = jar;
            const gate = gates.get(url);
            if (gate) {
                await gate.promise;
            }
            if (url.endsWith('/sign-in')) {
                startedWith.cookies = startedWith.cookies.filter((entry) => entry.Name !== 'auth');
                startedWith.cookies.push(cookie('auth', 'fresh'));
            }
            return JSON.stringify({ status: 200, message: '{}' });
        }
    };
}

const outcome = (status, secondFactor = []) => ({ status, secondFactor, unverified: false });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('session lock', () => {
    it('runs session changes one at a time, in order', async () => {
        const lock = createSessionLock();
        const order = [];
        const first = deferred();
        const a = lock.run(async () => {
            order.push('a start');
            await first.promise;
            order.push('a end');
        });
        const b = lock.run(() => order.push('b'));
        await settle();
        expect(order).toEqual(['a start']);
        first.resolve();
        await Promise.all([a, b]);
        expect(order).toEqual(['a start', 'a end', 'b']);
    });

    it('queues work a locked task scheduled for later, however it was started', async () => {
        // The bug in the first version: a timer set inside a locked task (the
        // friend-list retry) inherited the task's context, was taken for
        // nested work, skipped the queue, and ran a re-login next to a check.
        const lock = createSessionLock();
        const order = [];
        const checking = deferred();
        let fromTimer = null;
        const declined = lock.run(async () => {
            order.push('declined sign-out');
            setTimeout(() => {
                fromTimer = lock.run(() => order.push('retry from timer'));
            }, 0);
        });
        const check = lock.run(async () => {
            order.push('check start');
            await checking.promise;
            order.push('check end');
        });
        await declined;
        await settle();
        await settle();
        expect(order).toEqual(['declined sign-out', 'check start']);
        checking.resolve();
        await check;
        await fromTimer;
        expect(order).toEqual(['declined sign-out', 'check start', 'check end', 'retry from timer']);
    });

    it('keeps going after a task fails', async () => {
        const lock = createSessionLock();
        await expect(lock.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
        await expect(lock.run(() => 'ok')).resolves.toBe('ok');
    });
});

describe('cookie jar guard', () => {
    it('waits for a sign-in in flight before clearing, so its cookie is not lost', async () => {
        // The bug: the C# clear swapped the jar under an in-flight sign-in,
        // whose fresh `auth` landed in the jar nobody reads any more.
        const native = fakeWebApi([cookie('auth', 'dead'), cookie('twoFactorAuth', 'device')]);
        const webApi = guardCookieJar(native, { log: () => {} });
        const signIn = deferred();
        native.gates.set('https://api/sign-in', signIn);

        const signingIn = webApi.ExecuteJson(JSON.stringify({ url: 'https://api/sign-in' }));
        const clearing = webApi.ClearCookies();
        await settle();
        expect(native.calls).not.toContain('ClearCookies');

        // A sign-out waiting on it would wait here too.
        let settledEarly = false;
        void webApi.whenSettled().then(() => {
            settledEarly = true;
        });
        await settle();
        expect(settledEarly).toBe(false);

        signIn.resolve();
        await Promise.all([signingIn, clearing]);
        await webApi.whenSettled();
        // Cleared after the sign-in landed: the device cookie is kept, the
        // sign-in's `auth` is gone with the rest, as a sign-out should do.
        expect(native.calls).toEqual(['https://api/sign-in', 'ClearCookies', 'SetCookies']);
        expect(native.jar()).toEqual(['twoFactorAuth=device']);
    });

    it("adds what the jar lacks and never overwrites the Hub's own cookies", async () => {
        const native = fakeWebApi([cookie('auth', 'fresh')]);
        const lines = [];
        const webApi = guardCookieJar(native, { log: (line) => lines.push(line) });

        await webApi.SetCookies(encodeCookies([cookie('auth', 'stale'), cookie('twoFactorAuth', 'device')]));
        expect(native.jar()).toEqual(['auth=fresh', 'twoFactorAuth=device']);
        expect(lines).toEqual(["Kept the Hub's own VRChat cookies over 1 older copy"]);
    });

    it('does not wait forever for a request that never returns', async () => {
        const native = fakeWebApi([cookie('auth', 'dead')]);
        const lines = [];
        const webApi = guardCookieJar(native, { log: (line) => lines.push(line), drainTimeoutMs: 10 });
        native.gates.set('https://api/hangs', deferred());
        void webApi.ExecuteJson(JSON.stringify({ url: 'https://api/hangs' }));
        await webApi.ClearCookies();
        expect(native.jar()).toEqual([]);
        expect(lines[0]).toMatch(/1 request\(s\) still out/);
    });
});

describe('sign-in gate', () => {
    it('holds off password sign-ins while a second factor is outstanding, for a while', () => {
        let time = 0;
        const gate = createSignInGate({ now: () => time });
        gate.note('sign-in', outcome(200, ['totp', 'otp']));
        expect(gate.secondFactorPending()).toBe(true);
        time += SECOND_FACTOR_WAIT_MS;
        expect(gate.secondFactorPending()).toBe(false);
    });

    it('wakes whoever waits when someone enters the code', () => {
        const gate = createSignInGate();
        const woken = [];
        gate.onAnswered(() => woken.push('wake'));
        gate.note('sign-in', outcome(200, ['otp']));
        gate.note('two-factor verification', { status: 200, secondFactor: [], unverified: true });
        expect(woken).toEqual([]);
        gate.note('two-factor verification', outcome(200));
        expect(woken).toEqual(['wake']);
        expect(gate.secondFactorAnswered()).toBe(true);
        gate.settled();
        expect(gate.secondFactorAnswered()).toBe(false);
    });
});

describe('session governor', () => {
    /**
     * @param {{ alive?: () => boolean, jar?: object, reloginGate?: Promise<void> }} [options]
     */
    function setup(options = {}) {
        let time = 0;
        const calls = [];
        const checks = [];
        const lines = [];
        const declined = [];
        const lock = createSessionLock();
        const auth = {
            loginForm: { lastUserLoggedIn: 'usr_x' },
            getSavedCredentials: async (userId) => ({ user: { id: userId }, loginParams: {}, cookies: 'saved' }),
            setAttemptingAutoLogin: () => {},
            handleAutoLogin: async () => calls.push('upstream auto-login'),
            handleLogoutEvent: async () => {
                calls.push('signed out');
            },
            relogin: async (user) => {
                calls.push(['relogin', user]);
                if (options.reloginGate) {
                    await options.reloginGate;
                }
            }
        };
        const gate = createSignInGate({ now: () => time });
        governSignIn(auth, {
            gate,
            lock,
            jar: options.jar,
            dropSession: async () => calls.push('dropped the dead auth'),
            log: (line) => lines.push(line),
            now: () => time,
            onSignOutDeclined: () => declined.push('retry friends'),
            sessionAnswers: async () => {
                checks.push(time);
                return options.alive ? options.alive() : false;
            }
        });
        return { auth, gate, lock, calls, checks, lines, declined, advance: (ms) => (time += ms) };
    }

    it('answers a burst of 401s with one check and one sign-in from the saved login', async () => {
        const { auth, calls, checks } = setup();
        await Promise.all(Array.from({ length: 30 }, () => auth.handleAutoLogin()));
        expect(checks).toHaveLength(1);
        // Upstream's own flow is not used, the dead auth goes first (with it in
        // the jar VRChat sets no new one), and the saved cookies stay out.
        expect(calls).toEqual(['dropped the dead auth', ['relogin', { user: { id: 'usr_x' }, loginParams: {} }]]);
    });

    it('never runs a sign-out and a re-login at the same time', async () => {
        // One failing friends page used to start both at once.
        const signingIn = deferred();
        const { auth, calls } = setup({ reloginGate: signingIn.promise });
        const a = auth.handleAutoLogin();
        const b = auth.handleLogoutEvent();
        await settle();
        await settle();
        expect(calls).toEqual(['dropped the dead auth', ['relogin', expect.anything()]]);
        signingIn.resolve();
        await Promise.all([a, b]);
        expect(calls.at(-1)).toBe('signed out');
    });

    it('waits for the jar clear a sign-out started before letting the next sign-in go', async () => {
        const clearing = deferred();
        let cleared = false;
        const jar = {
            whenSettled: async () => {
                await clearing.promise;
                cleared = true;
            }
        };
        const { auth, calls } = setup({ jar });
        const signOut = auth.handleLogoutEvent();
        const next = auth.relogin({ user: { id: 'usr_x' } });
        await settle();
        await settle();
        expect(calls).toEqual(['signed out']);
        clearing.resolve();
        await Promise.all([signOut, next]);
        expect(cleared).toBe(true);
        expect(calls).toEqual(['signed out', 'dropped the dead auth', ['relogin', { user: { id: 'usr_x' } }]]);
    });

    it('ignores 401s and declines sign-outs while the session works, and says so', async () => {
        const { auth, calls, checks, declined, lines, advance } = setup({ alive: () => true });
        await auth.handleAutoLogin();
        advance(2000);
        await auth.handleLogoutEvent();
        expect(calls).toEqual([]);
        expect(checks).toHaveLength(1);
        expect(declined).toEqual(['retry friends']);
        expect(lines).toContain('Not signing out: the session still works');
        advance(60000);
        await auth.handleAutoLogin();
        expect(checks).toHaveLength(2);
    });

    it('signs out when the session really is gone', async () => {
        const { auth, calls } = setup({ alive: () => false });
        await auth.handleLogoutEvent();
        expect(calls).toEqual(['signed out']);
    });

    it('leaves a signed-out Hub to the session keeper', async () => {
        const { auth, calls } = setup();
        auth.loginForm.lastUserLoggedIn = '';
        await auth.handleAutoLogin();
        expect(calls).toEqual([]);
    });

    it('does nothing while VRChat waits for a second factor', async () => {
        const { auth, gate, calls, checks } = setup();
        gate.note('sign-in', outcome(200, ['totp', 'otp']));
        await auth.handleAutoLogin();
        expect(checks).toEqual([]);
        expect(calls).toEqual([]);
        await expect(auth.relogin({ user: { id: 'usr_x' } })).rejects.toThrow(/second factor/);
    });

    it('runs the session keeper re-login under the lock without the saved cookies', async () => {
        const { auth, calls } = setup();
        await auth.relogin({ user: { id: 'usr_x' }, loginParams: { username: 'x' }, cookies: 'saved' }, { a: 1 });
        expect(calls).toEqual([
            'dropped the dead auth',
            ['relogin', { user: { id: 'usr_x' }, loginParams: { username: 'x' } }]
        ]);
    });

    it('stops signing in with the password after a few in an hour', async () => {
        // 2026-10-07: a session that died for good got eleven sign-ins in
        // eleven seconds, and VRChat refused the twelfth.
        const { auth, calls, lines, advance } = setup({ alive: () => false });
        for (let i = 0; i < 20; i++) {
            await auth.handleAutoLogin();
            advance(1000);
        }
        // One per minute at most, so only the first got through in 20 s.
        expect(calls.filter((call) => Array.isArray(call))).toHaveLength(1);
        expect(lines).toContain('Not signing in again yet: the last password sign-in was less than a minute ago');

        for (let i = 0; i < 10; i++) {
            advance(MIN_SIGN_IN_GAP_MS);
            await auth.handleAutoLogin();
        }
        expect(calls.filter((call) => Array.isArray(call))).toHaveLength(MAX_SIGN_INS_PER_HOUR);
        expect(lines.at(-1)).toMatch(/password sign-ins in the last hour already/);
        // The keeper is refused too, loudly.
        await expect(auth.relogin({ user: { id: 'usr_x' } })).rejects.toThrow(/too many password sign-ins/);

        // An hour on, it may try again.
        advance(60 * 60 * 1000);
        await auth.handleAutoLogin();
        expect(calls.filter((call) => Array.isArray(call))).toHaveLength(MAX_SIGN_INS_PER_HOUR + 1);
    });
});

describe('what a client may do to the session', () => {
    function setup({ signedIn = true } = {}) {
        const lines = [];
        const sent = [];
        const lock = createSessionLock();
        const policy = createClientSessionPolicy({
            lock,
            hubSignedIn: () => signedIn,
            log: (l) => lines.push(l),
            dropSession: async () => sent.push(['dropped the dead auth'])
        });
        const client = { clientName: 'vrcx-windows' };
        const call = (className, method, args, answer = undefined) =>
            policy(className, method, args, client, async (callArgs) => {
                sent.push([method, callArgs]);
                return answer;
            });
        return { call, sent, lines, lock };
    }

    it('hands out only the two-factor device cookie', async () => {
        const { call } = setup();
        const jar = encodeCookies([cookie('auth', 'token'), cookie('twoFactorAuth', 'device')]);
        const answered = await call('WebApi', 'GetCookies', [], jar);
        expect(decodeCookies(answered).map((entry) => entry.Name)).toEqual(['twoFactorAuth']);
        expect(deviceCookiesOnly(jar)).toBe(answered);
    });

    it('refuses cookies, and automatic sign-outs, but not the person signing out', async () => {
        const { call, sent, lines } = setup();
        await call('WebApi', 'SetCookies', ['blob']);
        await call('WebApi', 'ClearCookies', [{ userInitiated: false }]);
        await call('WebApi', 'ClearCookies', []);
        expect(sent).toEqual([]);
        await call('WebApi', 'ClearCookies', [{ userInitiated: true }]);
        expect(sent).toEqual([['ClearCookies', []]]);
        expect(lines.at(-1)).toBe('vrcx-windows signed the Hub out of VRChat');
    });

    it("answers a client's sign-in with the Hub's session while the Hub is signed in", async () => {
        const { call, sent } = setup({ signedIn: true });
        const request = {
            url: 'https://api.vrchat.cloud/api/1/auth/user',
            method: 'GET',
            headers: { Authorization: 'Basic x' }
        };
        await call('WebApi', 'ExecuteJson', [JSON.stringify(request)]);
        expect(JSON.parse(sent[0][1][0]).headers).toEqual({});
        await call('WebApi', 'Execute', [request]);
        expect(sent[1][1][0].headers).toEqual({});
    });

    it("runs a client's sign-in under the lock while the Hub is signed out, header and all", async () => {
        const { call, sent, lock } = setup({ signedIn: false });
        const busy = deferred();
        const holding = lock.run(() => busy.promise);
        const request = {
            url: 'https://api.vrchat.cloud/api/1/auth/user',
            method: 'GET',
            headers: { Authorization: 'Basic x' }
        };
        const signing = call('WebApi', 'Execute', [request]);
        await settle();
        expect(sent).toEqual([]);
        busy.resolve();
        await Promise.all([holding, signing]);
        expect(sent[0]).toEqual(['dropped the dead auth']);
        expect(sent[1][1][0].headers).toEqual({ Authorization: 'Basic x' });
    });

    it("tells the Hub when a client's request finds the session gone", async () => {
        const lines = [];
        const noticed = [];
        const policy = createClientSessionPolicy({
            lock: createSessionLock(),
            hubSignedIn: () => true,
            log: (l) => lines.push(l),
            onUnauthorized: () => noticed.push('check the session')
        });
        const request = { url: 'https://api.vrchat.cloud/api/1/users/usr_1/mutuals', method: 'GET' };
        const dead = { status: 401, message: '{"error":{"message":"\\"Missing Credentials\\"","status_code":401}}' };
        await expect(policy('WebApi', 'Execute', [request], {}, async () => dead)).resolves.toBe(dead);
        await policy('WebApi', 'Execute', [request], {}, async () => ({ status: 404, message: '{}' }));
        await policy('WebApi', 'Execute', [request], {}, async () => ({ status: 200, message: '{}' }));
        expect(noticed).toEqual(['check the session']);
    });

    it('passes everything else through', async () => {
        const { call, sent } = setup();
        await call('SQLite', 'Execute', ['SELECT 1']);
        await call('WebApi', 'ExecuteJson', [JSON.stringify({ url: 'https://api.vrchat.cloud/api/1/users/usr_1' })]);
        expect(sent).toHaveLength(2);
        expect(clientRequestOptions('ExecuteJson', ['not json'])).toBeNull();
    });
});
