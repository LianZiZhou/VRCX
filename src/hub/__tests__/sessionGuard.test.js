/**
 * [hub] A mirror's automatic sign-out leaves the Hub's session alone.
 */

import { consumeSignOutIntent, createSessionGuard, MAX_RELOADS, SIGN_OUT_INTENT_MS } from '../client/sessionGuard.js';

/** A sessionStorage stand-in. */
function memoryStorage() {
    const values = new Map();
    return { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) };
}
import { HubMode, setHubMode } from '../shared/mode.js';

/**
 * A stand-in for the auth store as the plugin sees it: the exported
 * `handleLogoutEvent`, and a `logout()` that, like upstream's, calls the
 * closure-held original rather than the export.
 *
 * @returns {object}
 */
function fakeAuthStore() {
    const calls = [];
    const handleLogoutEvent = async () => {
        calls.push('signed out');
    };
    return {
        $id: 'Auth',
        calls,
        handleLogoutEvent,
        logout: () => handleLogoutEvent()
    };
}

/** @returns {{ timers: Function[], setTimer: (fn: Function) => void, runNext: () => Promise<void> }} */
function manualTimers() {
    const timers = [];
    return {
        timers,
        setTimer: (fn) => timers.push(fn),
        runNext: async () => {
            await timers.shift()();
        }
    };
}

describe('mirror sign-out guard', () => {
    afterEach(() => {
        setHubMode(HubMode.STANDALONE);
    });

    it('does not sign out on an automatic logout, and reloads once the Hub is back', async () => {
        setHubMode(HubMode.MIRROR);
        const store = fakeAuthStore();
        const clock = manualTimers();
        let usable = false;
        const reloads = [];
        const guard = createSessionGuard({
            isHubSessionUsable: async () => usable,
            reload: () => reloads.push('reload'),
            log: () => {},
            setTimer: clock.setTimer,
            storage: memoryStorage()
        });
        guard.plugin({ store });

        // e.g. friendSyncCoordinator after the friend list failed to load.
        await store.handleLogoutEvent();
        await store.handleLogoutEvent();
        expect(store.calls).toEqual([]);
        expect(guard.recovering()).toBe(true);
        // One recovery, however many sign-outs were asked for.
        expect(clock.timers).toHaveLength(1);

        await clock.runNext();
        expect(reloads).toEqual([]);
        expect(clock.timers).toHaveLength(1);

        // Usable once is not enough: the Hub's sessions used to die seconds in.
        usable = true;
        await clock.runNext();
        expect(reloads).toEqual([]);
        await clock.runNext();
        expect(reloads).toEqual(['reload']);
    });

    it('stops reloading after a few, so a Hub whose session keeps dying does not loop the window', async () => {
        setHubMode(HubMode.MIRROR);
        const storage = memoryStorage();
        const reloads = [];
        for (let round = 0; round < MAX_RELOADS + 1; round++) {
            // Each reload is a fresh page: a fresh guard, the same sessionStorage.
            const store = fakeAuthStore();
            const clock = manualTimers();
            const guard = createSessionGuard({
                isHubSessionUsable: async () => true,
                reload: () => reloads.push(round),
                log: () => {},
                setTimer: clock.setTimer,
                storage
            });
            guard.plugin({ store });
            await store.handleLogoutEvent();
            await clock.runNext();
            await clock.runNext();
        }
        expect(reloads).toEqual([0, 1, 2]);
    });

    it("marks the person's own Log out so the Hub knows the cookie clear is theirs", async () => {
        setHubMode(HubMode.MIRROR);
        const store = fakeAuthStore();
        let time = 1000;
        const guard = createSessionGuard({
            isHubSessionUsable: async () => true,
            reload: () => {},
            log: () => {},
            now: () => time
        });
        guard.plugin({ store });
        expect(consumeSignOutIntent(time)).toBe(false);
        await store.logout();
        expect(consumeSignOutIntent(time)).toBe(true);
        // Once only.
        expect(consumeSignOutIntent(time)).toBe(false);
        // And not forever: a dismissed dialog does not arm a clear minutes later.
        await store.logout();
        time += SIGN_OUT_INTENT_MS + 1;
        expect(consumeSignOutIntent(time)).toBe(false);
    });

    it('still signs out when the person asks to, which signs the Hub out as documented', async () => {
        setHubMode(HubMode.MIRROR);
        const store = fakeAuthStore();
        const guard = createSessionGuard({ isHubSessionUsable: async () => true, reload: () => {}, log: () => {} });
        guard.plugin({ store });

        await store.logout();
        expect(store.calls).toEqual(['signed out']);
    });

    it('changes nothing outside mirror mode, or on other stores', async () => {
        const store = fakeAuthStore();
        const untouched = async () => {};
        const other = { $id: 'User', handleLogoutEvent: untouched };
        const guard = createSessionGuard({ isHubSessionUsable: async () => true, reload: () => {}, log: () => {} });
        guard.plugin({ store });
        guard.plugin({ store: other });

        // Standalone: upstream's automatic sign-out behaves as it always has.
        await store.handleLogoutEvent();
        expect(store.calls).toEqual(['signed out']);
        expect(other.handleLogoutEvent).toBe(untouched);
    });
});

describe('mirror sign-out guard on a real Pinia store', () => {
    afterEach(() => {
        setHubMode(HubMode.STANDALONE);
    });

    it('wraps the exported action of a setup store and leaves the closure alone', async () => {
        const { createApp } = await import('vue');
        const { createPinia, defineStore } = await import('pinia');
        const calls = [];
        const useAuth = defineStore('Auth', () => {
            async function handleLogoutEvent() {
                calls.push('signed out');
            }
            function logout() {
                return handleLogoutEvent();
            }
            return { handleLogoutEvent, logout };
        });

        const pinia = createPinia();
        const guard = createSessionGuard({
            isHubSessionUsable: async () => false,
            reload: () => {},
            log: () => {},
            setTimer: () => {}
        });
        // Registered before the app installs Pinia, as initMirrorMode does.
        pinia.use(guard.plugin);
        createApp({ render: () => null }).use(pinia);
        setHubMode(HubMode.MIRROR);

        const auth = useAuth(pinia);
        // A component destructuring the action gets the guarded one too.
        const { handleLogoutEvent } = auth;
        await handleLogoutEvent();
        await auth.handleLogoutEvent();
        expect(calls).toEqual([]);

        await auth.logout();
        expect(calls).toEqual(['signed out']);
    });
});
