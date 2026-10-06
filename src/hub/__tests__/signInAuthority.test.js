/**
 * [hub] One authority over the Hub's VRChat sign-in: no 401 storm, no stale
 * cookies over fresh ones, no password sign-in over a pending second factor.
 */

import {
    createSignInGate,
    decodeCookies,
    encodeCookies,
    governSignIn,
    guardCookieJar,
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

/** A WebApi whose jar is a plain list. */
function fakeJar(initial) {
    let jar = [...initial];
    const calls = [];
    return {
        calls,
        jar: () => jar.map((entry) => `${entry.Name}=${entry.Value}`),
        GetCookies: async () => encodeCookies(jar),
        SetCookies: async (blob) => {
            calls.push('SetCookies');
            for (const entry of decodeCookies(blob)) {
                jar = jar.filter((existing) => existing.Name !== entry.Name);
                jar.push(entry);
            }
        },
        ClearCookies: async () => {
            calls.push('ClearCookies');
            jar = [];
        },
        ExecuteJson: async () => '{}'
    };
}

const outcome = (status, secondFactor = []) => ({ status, secondFactor, unverified: false });

describe('cookie jar guard', () => {
    it("adds what the jar lacks and never overwrites the Hub's own cookies", async () => {
        const native = fakeJar([cookie('auth', 'fresh')]);
        const lines = [];
        const webApi = guardCookieJar(native, { log: (line) => lines.push(line) });

        // upstream relogin(): setCookies(savedCredentials.cookies), an older copy
        await webApi.SetCookies(encodeCookies([cookie('auth', 'stale'), cookie('twoFactorAuth', 'device')]));
        expect(native.jar()).toEqual(['auth=fresh', 'twoFactorAuth=device']);
        expect(lines).toEqual(["Kept the Hub's own VRChat cookies over 1 older copy"]);

        // Nothing new at all: not even a call.
        native.calls.length = 0;
        await webApi.SetCookies(encodeCookies([cookie('auth', 'stale')]));
        expect(native.calls).toEqual([]);
        expect(native.jar()).toEqual(['auth=fresh', 'twoFactorAuth=device']);
    });

    it('keeps the remembered two-factor device across a sign-out', async () => {
        const native = fakeJar([cookie('auth', 'dead'), cookie('twoFactorAuth', 'device')]);
        const webApi = guardCookieJar(native, { log: () => {} });
        await webApi.ClearCookies();
        expect(native.jar()).toEqual(['twoFactorAuth=device']);
        expect(native.calls).toEqual(['ClearCookies', 'SetCookies']);
    });

    it('reads everything else through', async () => {
        const native = fakeJar([]);
        const webApi = guardCookieJar(native, { log: () => {} });
        await expect(webApi.ExecuteJson('{}')).resolves.toBe('{}');
        expect('GetCookies' in webApi).toBe(true);
    });
});

describe('sign-in gate', () => {
    it('holds off password sign-ins while a second factor is outstanding, for a while', () => {
        let time = 0;
        const gate = createSignInGate({ now: () => time });
        expect(gate.secondFactorPending()).toBe(false);

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
        expect(gate.secondFactorPending()).toBe(false);
        expect(gate.secondFactorAnswered()).toBe(true);

        gate.settled();
        expect(gate.secondFactorAnswered()).toBe(false);
        // A plain successful sign-in clears it too.
        gate.note('sign-in', outcome(200, ['otp']));
        gate.note('sign-in', outcome(200));
        expect(gate.secondFactorPending()).toBe(false);
    });
});

describe('re-login governor', () => {
    /**
     * @param {{ sessionAnswers?: () => Promise<boolean> }} [options]
     */
    function setup(options = {}) {
        let time = 0;
        const calls = [];
        const auth = {
            handleAutoLogin: async () => {
                calls.push('autoLogin');
            },
            relogin: async (user) => {
                calls.push(['relogin', user]);
            }
        };
        const gate = createSignInGate({ now: () => time });
        const checks = [];
        governSignIn(auth, {
            gate,
            log: () => {},
            now: () => time,
            sessionAnswers: async () => {
                checks.push(time);
                return options.sessionAnswers ? options.sessionAnswers() : false;
            }
        });
        return { auth, gate, calls, checks, advance: (ms) => (time += ms) };
    }

    it('answers a burst of 401s with one check and at most one re-login', async () => {
        const { auth, calls, checks } = setup();
        await Promise.all(Array.from({ length: 30 }, () => auth.handleAutoLogin()));
        expect(checks).toHaveLength(1);
        expect(calls).toEqual(['autoLogin']);
    });

    it('ignores 401s from requests that went out before the session changed', async () => {
        const { auth, calls, checks, advance } = setup({ sessionAnswers: async () => true });
        await auth.handleAutoLogin();
        // More stragglers moments later: no re-check, no re-login.
        advance(2000);
        await auth.handleAutoLogin();
        expect(checks).toHaveLength(1);
        expect(calls).toEqual([]);
        // Much later, a 401 is worth asking about again.
        advance(60000);
        await auth.handleAutoLogin();
        expect(checks).toHaveLength(2);
    });

    it('does nothing while VRChat waits for a second factor', async () => {
        const { auth, gate, calls, checks } = setup();
        gate.note('sign-in', outcome(200, ['totp', 'otp']));
        await auth.handleAutoLogin();
        expect(checks).toEqual([]);
        expect(calls).toEqual([]);
        await expect(auth.relogin({ user: { id: 'usr_x' } })).rejects.toThrow(/second factor/);
        expect(calls).toEqual([]);
    });

    it('re-logs in without restoring the saved cookies over the jar', async () => {
        const { auth, calls } = setup();
        await auth.relogin({ user: { id: 'usr_x' }, loginParams: { username: 'x' }, cookies: 'saved' }, { a: 1 });
        expect(calls).toEqual([['relogin', { user: { id: 'usr_x' }, loginParams: { username: 'x' } }]]);
    });
});
