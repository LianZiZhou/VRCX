/**
 * [hub] A Hub whose first sign-in fails keeps running and keeps trying.
 *
 * Drives `startHubRuntime` with a hand-built store graph, since the real one
 * would talk to VRChat. The reachability diagnostic is checked with an
 * injected `fetch`.
 */

import { startHubRuntime } from '../bootstrap/core.js';
import { diagnoseVrchatReachability } from '../server/networkCheck.js';

/**
 * @param {Array<Error | null>} outcomes - per attempt: an error to throw, or null to succeed
 */
function fakeStores(outcomes) {
    const calls = { autoLogin: 0 };
    const stores = {
        updateLoop: { updateLoop: () => {} },
        vrcx: { waitForDatabaseInit: async () => true },
        user: { currentUser: null },
        auth: {
            migrateStoredUsers: async () => {},
            autoLoginAfterMounted: async () => {
                const outcome = outcomes[calls.autoLogin] ?? null;
                calls.autoLogin += 1;
                if (outcome) {
                    throw outcome;
                }
                stores.user.currentUser = { id: 'usr_x', displayName: 'x' };
            }
        }
    };
    return { stores, calls };
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

describe('sign-in at boot', () => {
    it('comes back true and signed in when the first attempt works', async () => {
        const { stores, calls } = fakeStores([null]);
        expect(await startHubRuntime(stores, { retry: { minMs: 5, maxMs: 10 } })).toBe(true);
        expect(calls.autoLogin).toBe(1);
        expect(stores.user.currentUser?.id).toBe('usr_x');
    });

    it('survives a failed first attempt, diagnoses it once, and retries until it works', async () => {
        const networkError = Object.assign(new Error('Error Message: {}\nEndpoint: "config"'), { status: 0 });
        const { stores, calls } = fakeStores([networkError, networkError, null]);
        const log = [];
        const diagnosed = [];

        const started = await startHubRuntime(stores, {
            log: (line) => log.push(line),
            onSignInFailure: (err) => diagnosed.push(err),
            retry: { minMs: 5, maxMs: 10 }
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

describe('reachability diagnostic', () => {
    it('blames the .NET side when Node can reach VRChat', async () => {
        const report = await diagnoseVrchatReachability({
            configDir: '/data',
            fetchImpl: async () => ({ status: 200 })
        });
        expect(report.reachable).toBe(true);
        expect(report.detail).toMatch(/Node reached .* but the \.NET side could not/);
        expect(report.advice.join(' ')).toContain('/data/logs/VRCX.log');
    });

    it('blames the network when Node cannot either', async () => {
        const report = await diagnoseVrchatReachability({
            configDir: '/data',
            fetchImpl: async () => {
                throw Object.assign(new Error('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND') });
            }
        });
        expect(report.reachable).toBe(false);
        expect(report.detail).toContain('getaddrinfo ENOTFOUND');
    });
});
