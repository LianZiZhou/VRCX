/**
 * [hub] A mirror does not sign the Hub out on its own initiative.
 *
 * Upstream signs out by itself when a request says the session is gone: the
 * friend list failing to load, `config` answering 403. On a mirror all of
 * those report on the *Hub's* session, which the Hub looks after itself, and
 * a mirror's sign-out clears the cookies -- which on a mirror runs on the Hub.
 *
 * Two pieces:
 *
 *   - The auth store's exported `handleLogoutEvent` (what those automatic
 *     paths call) is replaced: on a mirror it waits for the Hub instead, and
 *     reloads once the Hub's session has stayed usable for two checks in a
 *     row. Reloads are capped, so a Hub whose session keeps dying does not
 *     reload the mirror every few seconds.
 *   - The exported `logout` -- the person's own "Log out", which upstream
 *     confirms in a dialog and then signs out from inside the store -- marks a
 *     sign-out intent. `remoteInterop.js` sends it with `ClearCookies`, and
 *     the Hub clears its session only when it is there.
 *
 * Both are replaced from a Pinia plugin, registered before the app is mounted,
 * so even a component that destructures the action gets the replacement.
 */

import { isMirrorMode } from '../shared/mode.js';

/** How often to ask whether the Hub's session is back. */
export const RECOVERY_POLL_MS = 15000;

/** How long the person's "Log out" counts as asking for the Hub to sign out. */
export const SIGN_OUT_INTENT_MS = 2 * 60 * 1000;

/** At most this many recovery reloads per window. */
export const MAX_RELOADS = 3;
export const RELOAD_WINDOW_MS = 10 * 60 * 1000;

const RELOADS_KEY = 'vrcx-hub-recovery-reloads';

let signOutIntentUntil = 0;

/** The person asked to log out; the next cookie clear is theirs. */
export function markSignOutIntent(now = Date.now()) {
    signOutIntentUntil = now + SIGN_OUT_INTENT_MS;
}

/**
 * @param {number} [now]
 * @returns {boolean} whether the cookie clear now being sent is one the person asked for
 */
export function consumeSignOutIntent(now = Date.now()) {
    const intended = now < signOutIntentUntil;
    signOutIntentUntil = 0;
    return intended;
}

/**
 * Recovery reloads, remembered across reloads in `sessionStorage`.
 *
 * @param {{ getItem: (k: string) => string | null, setItem: (k: string, v: string) => void } | null} storage
 * @param {() => number} now
 */
function reloadBudget(storage, now) {
    const read = () => {
        try {
            const list = JSON.parse(storage?.getItem(RELOADS_KEY) ?? '[]');
            return Array.isArray(list) ? list.filter((at) => now() - at < RELOAD_WINDOW_MS) : [];
        } catch {
            return [];
        }
    };
    return {
        available: () => read().length < MAX_RELOADS,
        spend: () => {
            try {
                storage?.setItem(RELOADS_KEY, JSON.stringify([...read(), now()]));
            } catch {
                // No storage: the cap just does not survive the reload.
            }
        }
    };
}

/**
 * @typedef {object} SessionGuardOptions
 * @property {() => Promise<boolean>} isHubSessionUsable - whether the Hub answers `auth/user` with a user
 * @property {() => void} reload - start this client over
 * @property {(message: string) => void} [log]
 * @property {number} [pollMs]
 * @property {typeof setTimeout} [setTimer]
 * @property {any} [storage] - `sessionStorage`, for the reload cap
 * @property {() => number} [now]
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
        setTimer = setTimeout,
        storage = globalThis.sessionStorage ?? null,
        now = Date.now
    } = options;
    const budget = reloadBudget(storage, now);
    let recovering = false;
    let usableInARow = 0;

    async function poll() {
        let usable = false;
        try {
            usable = await isHubSessionUsable();
        } catch {
            // The Hub link is down or the request failed; ask again later.
        }
        usableInARow = usable ? usableInARow + 1 : 0;
        if (usableInARow >= 2) {
            if (budget.available()) {
                budget.spend();
                log('[hub] The Hub is signed in to VRChat again; reloading');
                reload();
                return;
            }
            log('[hub] The Hub is signed in again, but this window reloaded often already; reload it by hand');
            recovering = false;
            return;
        }
        setTimer(poll, pollMs);
    }

    function recover() {
        if (recovering) {
            return;
        }
        recovering = true;
        usableInARow = 0;
        log("[hub] Not signing out: the VRChat session is the Hub's, and it signs back in by itself");
        setTimer(poll, pollMs);
    }

    function plugin({ store }) {
        if (store.$id !== 'Auth') {
            return;
        }
        if (typeof store.handleLogoutEvent === 'function') {
            const handleLogoutEvent = store.handleLogoutEvent;
            store.handleLogoutEvent = async (...args) => {
                if (!isMirrorMode()) {
                    return handleLogoutEvent(...args);
                }
                recover();
            };
        }
        if (typeof store.logout === 'function') {
            const logout = store.logout;
            store.logout = (...args) => {
                if (isMirrorMode()) {
                    markSignOutIntent(now());
                }
                return logout(...args);
            };
        }
    }

    return { plugin, recovering: () => recovering };
}
