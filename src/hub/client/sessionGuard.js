/**
 * [hub] A mirror does not sign the Hub out on its own initiative.
 *
 * Upstream signs out by itself when a request says the session is gone: the
 * friend list failing to load, `config` answering 403, three auto-logins in an
 * hour. On a mirror all of those report on the *Hub's* session, which the Hub
 * looks after itself (it re-authenticates; see `bootstrap/core.js`). Letting
 * the mirror go ahead made it worse: its sign-out clears the cookies, and on a
 * mirror `WebApi.ClearCookies` runs on the Hub, so the Hub lost its session
 * and its remembered two-factor device mid-recovery, and the next sign-in
 * asked for an OTP.
 *
 * Those automatic paths all call `authStore.handleLogoutEvent()` from outside
 * the store. The person's own "Log out" goes through the store's `logout()`,
 * which calls the same function from inside its closure, so it is untouched
 * and still signs the Hub out, as documented. The guard therefore replaces only
 * the store's exported `handleLogoutEvent`, as a Pinia plugin so it is in place
 * before any caller can hold a reference.
 *
 * Instead of signing out, the mirror waits for the Hub to answer `auth/user`
 * again and reloads, which is what restarting it by hand did.
 */

import { isMirrorMode } from '../shared/mode.js';

/** How often to ask whether the Hub's session is back. */
export const RECOVERY_POLL_MS = 15000;

/**
 * @typedef {object} SessionGuardOptions
 * @property {() => Promise<boolean>} isHubSessionUsable - whether the Hub answers `auth/user` with a user
 * @property {() => void} reload - start this client over
 * @property {(message: string) => void} [log]
 * @property {number} [pollMs]
 * @property {typeof setTimeout} [setTimer]
 */

/**
 * @param {SessionGuardOptions} options
 * @returns {{ plugin: (context: { store: any }) => void, recovering: () => boolean }}
 */
export function createSessionGuard(options) {
    const {
        isHubSessionUsable,
        reload,
        log = (message) => console.warn(message),
        pollMs = RECOVERY_POLL_MS,
        setTimer = setTimeout
    } = options;
    let recovering = false;

    async function poll() {
        let usable = false;
        try {
            usable = await isHubSessionUsable();
        } catch {
            // The Hub link is down or the request failed; ask again later.
        }
        if (usable) {
            log('[hub] The Hub is signed in to VRChat again; reloading');
            reload();
            return;
        }
        setTimer(poll, pollMs);
    }

    function recover() {
        if (recovering) {
            return;
        }
        recovering = true;
        log("[hub] Not signing out: the VRChat session is the Hub's, and it signs back in by itself");
        setTimer(poll, pollMs);
    }

    function plugin({ store }) {
        if (store.$id !== 'Auth' || typeof store.handleLogoutEvent !== 'function') {
            return;
        }
        const handleLogoutEvent = store.handleLogoutEvent;
        store.handleLogoutEvent = async (...args) => {
            if (!isMirrorMode()) {
                return handleLogoutEvent(...args);
            }
            recover();
        };
    }

    return { plugin, recovering: () => recovering };
}
