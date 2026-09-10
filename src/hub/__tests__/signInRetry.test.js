/**
 * [hub] A Hub whose sign-in fails keeps running and keeps trying -- at boot,
 * and again after a later sign-out.
 *
 * Drives `startHubRuntime` with a hand-built store graph, since the real one
 * would talk to VRChat. Signed-in-ness is `watchState.isLoggedIn`, the flag
 * upstream flips on login and logout, so the fakes flip it too. The
 * reachability diagnostic is checked with an injected `fetch`.
 */

import { startHubRuntime } from '../bootstrap/core.js';
import { diagnoseVrchatReachability } from '../server/networkCheck.js';
import { watchState } from '../../services/watchState.js';
import { wsState } from '../../services/websocket.js';
import configRepository from '../../services/config';

/** An attempt that neither throws nor signs in: upstream's "stay at the login dialog". */
const SILENT = Symbol('silent');

/** Every runtime started by a test, so afterEach can stop its loops and watchers. */
let shutdowns = [];

/**
 * @param {object} stores
 * @param {object} [options]
 */
function start(stores, options = {}) {
    const shutdown = new AbortController();
    shutdowns.push(shutdown);
    return startHubRuntime(stores, {
        signal: shutdown.signal,
        retry: { minMs: 5, maxMs: 10, settleMs: 20 },
        ...options
    });
}

/**
 * @param {Array<Error | null | typeof SILENT>} outcomes - per boot attempt: an error to throw,
 *   SILENT to return without a user, or null to succeed
 * @param {Array<Error | null | typeof SILENT>} [resumes] - per resume attempt (`relogin`), likewise
 */
function fakeStores(outcomes, resumes = []) {
    const calls = { autoLogin: 0, relogin: [], savedCredentialsFor: [] };
    /** @type {Record<string, object>} */
    const savedCredentials = { usr_x: { user: { id: 'usr_x' }, loginParams: { username: 'x', password: 'y' } } };
    const signIn = () => {
        stores.user.currentUser = { id: 'usr_x', displayName: 'x' };
        watchState.isLoggedIn = true;
    };
    const stores = {
        updateLoop: { updateLoop: () => {} },
        vrcx: { waitForDatabaseInit: async () => true },
        user: { currentUser: null },
        advancedSettings: { enablePrimaryPassword: false },
        auth: {
            twoFactorAuthDialogVisible: false,
            migrateStoredUsers: async () => {},
            autoLoginAfterMounted: async () => {
                const outcome = outcomes[calls.autoLogin] ?? null;
                calls.autoLogin += 1;
                if (outcome === SILENT) {
                    return;
                }
                if (outcome) {
                    throw outcome;
                }
                signIn();
            },
            getSavedCredentials: async (userId) => {
                calls.savedCredentialsFor.push(userId);
                return savedCredentials[userId];
            },
            relogin: async (user) => {
                const outcome = resumes[calls.relogin.length] ?? null;
                calls.relogin.push(user);
                if (outcome === SILENT) {
                    return;
                }
                if (outcome) {
                    throw outcome;
                }
                signIn();
            }
        }
    };
    return { stores, calls, savedCredentials };
}

/**
 * @param {() => boolean} condition
 * @param {number} timeoutMs
 */
async function until(condition, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error('Timed out waiting');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

/** What upstream's `runLogoutFlow` does to the state this code reads. */
function signOut() {
    watchState.isLoggedIn = false;
    watchState.isFriendsLoaded = false;
}

beforeEach(() => {
    watchState.isLoggedIn = false;
    watchState.isFriendsLoaded = false;
    wsState.connected = false;
});

afterEach(() => {
    for (const shutdown of shutdowns) {
        shutdown.abort();
    }
    shutdowns = [];
    watchState.isLoggedIn = false;
    watchState.isFriendsLoaded = false;
    wsState.connected = false;
    vi.restoreAllMocks();
});

/**
 * Stand in for the shared `configs` table.
 *
 * @param {Record<string, string>} values
 * @returns {{ values: Record<string, string>, writes: string[] }}
 */
function fakeConfigs(values) {
    const writes = [];
    vi.spyOn(configRepository, 'getString').mockImplementation(async (key, defaultValue = null) =>
        key in values ? values[key] : defaultValue
    );
    vi.spyOn(configRepository, 'setString').mockImplementation(async (key, value) => {
        values[key] = String(value);
        writes.push(`set ${key}=${value}`);
    });
    vi.spyOn(configRepository, 'remove').mockImplementation(async (key) => {
        delete values[key];
        writes.push(`remove ${key}`);
    });
    return { values, writes };
}

describe('sign-in at boot', () => {
    it('comes back true and signed in when the first attempt works', async () => {
        const { stores, calls } = fakeStores([null]);
        expect(await start(stores)).toBe(true);
        expect(calls.autoLogin).toBe(1);
        expect(stores.user.currentUser?.id).toBe('usr_x');
        expect(watchState.isLoggedIn).toBe(true);
    });

    it('survives a failed first attempt, diagnoses it once, and retries until it works', async () => {
        const networkError = Object.assign(new Error('Error Message: {}\nEndpoint: "config"'), { status: 0 });
        const { stores, calls } = fakeStores([networkError, networkError, null]);
        const log = [];
        const diagnosed = [];

        const started = await start(stores, {
            log: (line) => log.push(line),
            onSignInFailure: (err) => diagnosed.push(err)
        });
        expect(started).toBe(true);
        expect(stores.user.currentUser).toBeNull();

        await until(() => stores.user.currentUser?.id === 'usr_x');
        expect(calls.autoLogin).toBe(3);
        expect(diagnosed).toEqual([networkError]);
        expect(log.filter((line) => /Sign-in attempt \d failed: Error Message/.test(line))).toHaveLength(2);
        expect(log.some((line) => /Retrying sign-in in/.test(line))).toBe(true);
        expect(log.at(-1)).toBe('Signed in.');
    });

    it('treats a silent non-sign-in as a failure and says why', async () => {
        const { stores, calls } = fakeStores([SILENT, null]);
        stores.advancedSettings.enablePrimaryPassword = true;
        const log = [];
        expect(await start(stores, { log: (line) => log.push(line) })).toBe(true);
        expect(stores.user.currentUser).toBeNull();
        expect(log[0]).toMatch(/did not sign in: the primary password is enabled/);
        await until(() => stores.user.currentUser?.id === 'usr_x');
        expect(calls.autoLogin).toBe(2);
    });

    it('waits for an upstream auto-login that a 401 set off before judging the attempt', async () => {
        const { stores, calls } = fakeStores([SILENT]);
        const inner = stores.auth.autoLoginAfterMounted;
        stores.auth.autoLoginAfterMounted = async () => {
            await inner();
            // What request.js does on "Missing Credentials": handleAutoLogin(),
            // not awaited, and only flagged once its own awaits have run.
            setTimeout(() => {
                stores.auth.attemptingAutoLogin = true;
            }, 10);
            setTimeout(() => {
                stores.user.currentUser = { id: 'usr_x', displayName: 'x' };
                watchState.isLoggedIn = true;
                stores.auth.attemptingAutoLogin = false;
            }, 80);
        };
        const log = [];
        await start(stores, { log: (line) => log.push(line), retry: { minMs: 5, maxMs: 10, settleMs: 30 } });
        expect(watchState.isLoggedIn).toBe(true);
        expect(calls.autoLogin).toBe(1);
        expect(log).toEqual([]);
    });

    it('names a pending two-factor prompt, which only a client can answer', async () => {
        const { stores } = fakeStores([SILENT, null]);
        stores.auth.twoFactorAuthDialogVisible = true;
        const log = [];
        await start(stores, { log: (line) => log.push(line) });
        expect(log[0]).toMatch(/did not sign in: VRChat asked for a two-factor code/);
    });

    it('can be woken out of its back-off when a client signs in', async () => {
        const failing = new Error('down');
        const { stores, calls } = fakeStores([failing, null]);
        let controls = null;
        await start(stores, {
            retry: { minMs: 60000, maxMs: 60000 },
            onRetryControls: (c) => {
                controls = c;
            }
        });
        expect(calls.autoLogin).toBe(1);
        await until(() => controls !== null);
        // Without the wake this would wait a minute.
        controls.wake();
        await until(() => stores.user.currentUser?.id === 'usr_x');
        expect(calls.autoLogin).toBe(2);
    });

    it('stops retrying when the Hub shuts down', async () => {
        const failing = new Error('down');
        const { stores, calls } = fakeStores([failing, failing, failing, failing, failing, failing]);
        const shutdown = new AbortController();
        await startHubRuntime(stores, { signal: shutdown.signal, retry: { minMs: 5, maxMs: 10 } });
        await until(() => calls.autoLogin >= 2);
        shutdown.abort();
        const seen = calls.autoLogin;
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(calls.autoLogin).toBe(seen);
    });
});

describe('sign-in after a later sign-out', () => {
    it('signs back in from the saved credentials of the user it was signed in as', async () => {
        const { stores, calls } = fakeStores([null]);
        const log = [];
        await start(stores, { log: (line) => log.push(line) });
        expect(watchState.isLoggedIn).toBe(true);

        signOut();
        await until(() => watchState.isLoggedIn);
        expect(calls.savedCredentialsFor).toEqual(['usr_x']);
        expect(calls.relogin.map((user) => user.user.id)).toEqual(['usr_x']);
        // The boot path is not what brought it back.
        expect(calls.autoLogin).toBe(1);
        expect(log).toContain('Signed out of VRChat; signing back in from the saved credentials');
        expect(log.at(-1)).toBe('Signed in.');
    });

    it('does not sign back in synchronously inside the logout flow', async () => {
        const { stores, calls } = fakeStores([null]);
        await start(stores);
        signOut();
        // Upstream is still clearing cookies at this point; a relogin now
        // would race it.
        expect(calls.relogin).toHaveLength(0);
        await until(() => watchState.isLoggedIn);
    });

    it('keeps trying through failed and silent attempts with a back-off', async () => {
        const failing = Object.assign(new Error('Error Message: {}\nEndpoint: "auth/user"'), { status: 0 });
        const { stores, calls } = fakeStores([null], [failing, SILENT, null]);
        const log = [];
        await start(stores, { log: (line) => log.push(line) });

        signOut();
        await until(() => watchState.isLoggedIn);
        expect(calls.relogin).toHaveLength(3);
        expect(log.filter((line) => /Retrying sign-in in/.test(line))).toHaveLength(3);
        expect(log.some((line) => /Sign-in attempt 2 failed: Error Message/.test(line))).toBe(true);
        expect(log.some((line) => /Sign-in attempt 3 did not sign in/.test(line))).toBe(true);
    });

    it('says so, and keeps waiting, when the saved login is gone', async () => {
        const { stores, calls, savedCredentials } = fakeStores([null]);
        const log = [];
        await start(stores, { log: (line) => log.push(line) });

        delete savedCredentials.usr_x;
        signOut();
        await until(() => calls.savedCredentialsFor.length >= 2);
        expect(calls.relogin).toHaveLength(0);
        expect(log.some((line) => /no saved credentials for usr_x; sign in again from a client/.test(line))).toBe(true);

        // A client saves the login again: the next attempt uses it.
        savedCredentials.usr_x = { user: { id: 'usr_x' }, loginParams: {} };
        await until(() => watchState.isLoggedIn);
        expect(calls.relogin).toHaveLength(1);
    });

    it('stands down when something else signed the Hub back in meanwhile', async () => {
        const { stores, calls } = fakeStores([null]);
        await start(stores, { retry: { minMs: 40, maxMs: 40 } });
        signOut();
        // Upstream's own auto-login (a straggling 401) got there first.
        watchState.isLoggedIn = true;
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(calls.relogin).toHaveLength(0);
    });

    it('runs one loop at a time across repeated sign-outs', async () => {
        const { stores, calls } = fakeStores([null], [null, null]);
        await start(stores);
        signOut();
        await until(() => watchState.isLoggedIn);
        signOut();
        await until(() => calls.relogin.length === 2);
        // A second loop would have called relogin a third time by now.
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(calls.relogin).toHaveLength(2);
    });
});

describe('sign-in after a restart in the signed-out state', () => {
    it('leaves a marker when it signs itself out, and clears it once back in', async () => {
        const { values, writes } = fakeConfigs({});
        const { stores } = fakeStores([null]);
        await start(stores);
        expect(writes).toEqual(['remove VRCX_hubResumeUser']);

        signOut();
        await until(() => watchState.isLoggedIn);
        expect(writes).toEqual([
            'remove VRCX_hubResumeUser',
            'set VRCX_hubResumeUser=usr_x',
            'remove VRCX_hubResumeUser'
        ]);
        expect(values).toEqual({});
    });

    it('resumes the marked user from the saved credentials when the stored session is gone', async () => {
        fakeConfigs({ VRCX_hubResumeUser: 'usr_x' });
        const { stores, calls } = fakeStores([SILENT]);
        const log = [];
        await start(stores, { log: (line) => log.push(line) });
        expect(watchState.isLoggedIn).toBe(true);
        expect(calls.autoLogin).toBe(0);
        expect(calls.relogin.map((user) => user.user.id)).toEqual(['usr_x']);
        expect(log[0]).toMatch(/previous Hub process was signed out of VRChat; resuming usr_x/);
    });

    it('prefers the stored session when a client has signed in since', async () => {
        fakeConfigs({ VRCX_hubResumeUser: 'usr_x', lastUserLoggedIn: 'usr_x' });
        const { stores, calls } = fakeStores([null]);
        await start(stores);
        expect(calls.autoLogin).toBe(1);
        expect(calls.relogin).toHaveLength(0);
    });

    it('does not mind the table being unreadable', async () => {
        vi.spyOn(configRepository, 'getString').mockRejectedValue(new Error('database is locked'));
        const { stores, calls } = fakeStores([null]);
        expect(await start(stores)).toBe(true);
        expect(calls.autoLogin).toBe(1);
    });
});

describe('pipeline watchdog', () => {
    it('reconnects a pipeline that stays down while signed in, and only then', async () => {
        const { stores } = fakeStores([null]);
        const reconnects = [];
        const log = [];
        await start(stores, {
            log: (line) => log.push(line),
            watchdog: { intervalMs: 5, graceMs: 30, reconnect: () => reconnects.push(Date.now()) }
        });

        // Signed in, friends not loaded yet: the socket is not due.
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(reconnects).toHaveLength(0);

        watchState.isFriendsLoaded = true;
        await until(() => reconnects.length >= 1);
        expect(log.some((line) => /VRChat pipeline has been down for \d+s; reconnecting/.test(line))).toBe(true);

        // Back up: no more nudges.
        wsState.connected = true;
        const seen = reconnects.length;
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(reconnects.length).toBe(seen);

        // Down again: the grace period starts over rather than firing at once.
        const downAt = Date.now();
        wsState.connected = false;
        await until(() => reconnects.length > seen);
        expect(reconnects.at(-1) - downAt).toBeGreaterThanOrEqual(25);
    });

    it('stops with the Hub', async () => {
        const { stores } = fakeStores([null]);
        const reconnects = [];
        const shutdown = new AbortController();
        await startHubRuntime(stores, {
            signal: shutdown.signal,
            retry: { minMs: 5, maxMs: 10 },
            watchdog: { intervalMs: 5, graceMs: 10, reconnect: () => reconnects.push(1) }
        });
        watchState.isFriendsLoaded = true;
        await until(() => reconnects.length >= 1);
        shutdown.abort();
        const seen = reconnects.length;
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(reconnects.length).toBe(seen);
    });
});

describe('reachability diagnostic', () => {
    it('blames the .NET side when Node can reach VRChat', async () => {
        const report = await diagnoseVrchatReachability({
            configDir: '/data',
            probe: async () => ({ status: 200 })
        });
        expect(report.reachable).toBe(true);
        expect(report.detail).toMatch(/Node reached .* but the \.NET side could not/);
        expect(report.advice.join(' ')).toContain('system TLS stack');
    });

    it('blames the network when Node cannot either', async () => {
        const report = await diagnoseVrchatReachability({
            configDir: '/data',
            probe: async () => {
                throw Object.assign(new Error('getaddrinfo ENOTFOUND api.vrchat.cloud'), { code: 'ENOTFOUND' });
            }
        });
        expect(report.reachable).toBe(false);
        expect(report.detail).toContain('ENOTFOUND: getaddrinfo ENOTFOUND');
    });
});

describe('reachability probe', () => {
    it('uses the Node HTTP stack, not the DOM shim fetch', async () => {
        // happy-dom's fetch is on the global in this environment and would
        // refuse the cross-origin request; the real probe must not use it.
        const report = await diagnoseVrchatReachability({ configDir: '/data' });
        expect(report.detail).not.toMatch(/Cross-Origin/);
    });
});

describe('.NET runtime switches', () => {
    it('disables TLS resumption on Linux unless the operator decided', async () => {
        const { configureDotnetSwitches } = await import('../server/nativeBridge.js');
        const env = {};
        expect(configureDotnetSwitches(env, 'linux')).toEqual(['DOTNET_SYSTEM_NET_SECURITY_DISABLETLSRESUME=1']);
        expect(env.DOTNET_SYSTEM_NET_SECURITY_DISABLETLSRESUME).toBe('1');

        const chosen = { DOTNET_SYSTEM_NET_SECURITY_DISABLETLSRESUME: '0' };
        expect(configureDotnetSwitches(chosen, 'linux')).toEqual([]);
        expect(chosen.DOTNET_SYSTEM_NET_SECURITY_DISABLETLSRESUME).toBe('0');

        expect(configureDotnetSwitches({}, 'win32')).toEqual([]);
    });
});
