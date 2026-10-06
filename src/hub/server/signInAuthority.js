/**
 * [hub] One authority over the Hub's VRChat session.
 *
 * Upstream's recovery from a 401 assumes one user in one window. On the Hub,
 * where the data core and every mirror share one cookie jar, it destroyed
 * every new session within seconds (2026-10-06; four independent code audits
 * agreed):
 *
 *   1. `WebApi.ClearCookies()` (C#) does not empty the jar: it installs a new
 *      `CookieContainer` and a new `HttpClient`. A request already in flight
 *      keeps the old client, so the `Set-Cookie` of a sign-in that is in flight
 *      when the jar is cleared lands in the container nothing reads any more.
 *      The sign-in says 200 and "Hello there"; everything after it carries no
 *      `auth` and VRChat answers "Missing Credentials".
 *   2. One failing request starts two recoveries at once: `services/request.js`
 *      calls `handleAutoLogin()` (a password sign-in) and
 *      `friendSyncCoordinator.js` calls `handleLogoutEvent()` (which clears the
 *      jar, without awaiting it). They overlap, which is (1); and the sign-out
 *      resets the auto-login counter, so upstream's three-per-hour stop never
 *      comes.
 *   3. Every 401 still in flight with the dead token starts another round;
 *      re-logins restored the cookies saved at the previous sign-in over the
 *      fresh ones; the Hub's own retry signed in with the password while a
 *      person was entering an OTP for another session; and clients could clear
 *      or replace the jar, or sign in, over the link at any moment.
 *
 * So, on the Hub:
 *
 *   - everything that changes the session -- a re-login, a sign-out, clearing
 *     or setting cookies, a client's sign-in or two-factor verification -- runs
 *     one at a time under `createSessionLock()`, and the lock is not released
 *     until work started inside it has finished (upstream's un-awaited
 *     `clearCookies()` included);
 *   - clearing the jar first waits for the requests in flight, so no response
 *     can land in a discarded container, and it keeps the `twoFactorAuth`
 *     device cookie;
 *   - a 401 or an automatic sign-out acts only if the session really is gone,
 *     checked with `auth/user` *and* an endpoint outside it, once per burst;
 *   - saved cookies never overwrite the jar;
 *   - while VRChat waits for a second factor, nothing signs in with the
 *     password; once someone answers it, the Hub resumes that session.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** A pending second factor older than this no longer holds off a password sign-in. */
export const SECOND_FACTOR_WAIT_MS = 10 * 60 * 1000;

/** A successful session check covers 401s arriving within this window. */
export const SESSION_CHECK_TTL_MS = 10 * 1000;

/** How long a jar clear waits for the requests in flight before going ahead anyway. */
export const DRAIN_TIMEOUT_MS = 15 * 1000;

const DEVICE_COOKIE = 'twoFactorAuth';

/**
 * WebApi's cookie blob: base64 of a JSON array of .NET `Cookie` objects.
 *
 * @param {string | null | undefined} blob
 * @returns {Array<{ Name: string }>}
 */
export function decodeCookies(blob) {
    if (!blob) {
        return [];
    }
    try {
        const list = JSON.parse(Buffer.from(String(blob), 'base64').toString('utf8'));
        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
}

/**
 * @param {Array<object>} cookies
 * @returns {string}
 */
export function encodeCookies(cookies) {
    return Buffer.from(JSON.stringify(cookies), 'utf8').toString('base64');
}

/**
 * @param {object} cookie
 * @returns {string}
 */
function cookieKey(cookie) {
    return `${String(cookie?.Domain ?? '').replace(/^\./, '')}|${cookie?.Path ?? '/'}|${cookie?.Name}`;
}

/**
 * @param {string | null | undefined} blob
 * @returns {string} the same jar with only the two-factor device cookie in it
 */
export function deviceCookiesOnly(blob) {
    return encodeCookies(decodeCookies(blob).filter((cookie) => cookie?.Name === DEVICE_COOKIE));
}

/**
 * A FIFO mutex for session changes.
 *
 * Re-entrant: work started from inside a held lock (upstream's sign-out calls
 * `clearCookies()` from inside a re-login, say) runs at once instead of
 * queueing behind the task that is waiting for it. And the holder keeps the
 * lock until that nested work has finished too, even when nobody awaited it --
 * `runLogoutFlow` does not await its `clearCookies()`, and a re-login queued
 * behind it must not start while that clear is still under way.
 *
 * @returns {{ run: <T>(task: () => Promise<T> | T) => Promise<T>, readonly held: boolean }}
 */
export function createSessionLock() {
    const context = new AsyncLocalStorage();
    let tail = Promise.resolve();
    let held = false;

    return {
        run(task) {
            const holder = context.getStore();
            if (holder) {
                const nested = Promise.resolve().then(task);
                holder.pending.add(nested.catch(() => {}));
                return nested;
            }
            const owner = { pending: new Set() };
            const result = tail.then(() =>
                context.run(owner, async () => {
                    held = true;
                    try {
                        return await task();
                    } finally {
                        // Whatever the task started and left running.
                        while (owner.pending.size > 0) {
                            const waiting = [...owner.pending];
                            owner.pending.clear();
                            await Promise.all(waiting);
                        }
                        held = false;
                    }
                })
            );
            tail = result.catch(() => {});
            return result;
        },
        get held() {
            return held;
        }
    };
}

/**
 * Keeps track of where the Hub's sign-in stands, from what `sessionAudit.js`
 * sees go past.
 *
 * @param {{ now?: () => number }} [options]
 */
export function createSignInGate(options = {}) {
    const { now = Date.now } = options;
    let secondFactorSince = null;
    let answeredSinceSignIn = false;
    const answeredListeners = new Set();

    return {
        /**
         * @param {'sign-in' | 'two-factor verification'} kind
         * @param {import('./sessionAudit.js').SessionOutcome} outcome
         */
        note(kind, outcome) {
            if (kind === 'sign-in' && outcome.status === 200) {
                secondFactorSince = outcome.secondFactor.length > 0 ? now() : null;
                answeredSinceSignIn = false;
            } else if (kind === 'two-factor verification' && outcome.status === 200 && !outcome.unverified) {
                secondFactorSince = null;
                answeredSinceSignIn = true;
                for (const listener of answeredListeners) {
                    listener();
                }
            }
        },
        /** @returns {boolean} whether VRChat is waiting for someone to enter a code */
        secondFactorPending() {
            return secondFactorSince !== null && now() - secondFactorSince < SECOND_FACTOR_WAIT_MS;
        },
        /** @returns {boolean} whether the jar holds a session a client has just verified */
        secondFactorAnswered() {
            return answeredSinceSignIn;
        },
        /** The Hub is signed in; whatever was pending is settled. */
        settled() {
            secondFactorSince = null;
            answeredSinceSignIn = false;
        },
        /** @param {() => void} listener */
        onAnswered(listener) {
            answeredListeners.add(listener);
            return () => answeredListeners.delete(listener);
        }
    };
}

/**
 * Wrap the WebApi binding so the cookie jar only ever moves forward and is
 * never cleared under a request in flight. Same Proxy-over-empty-target shape
 * as `webApiLog.js`.
 *
 * @param {object} WebApi
 * @param {object} options
 * @param {(message: string) => void} options.log
 * @param {ReturnType<typeof createSessionLock>} options.lock
 * @param {number} [options.drainTimeoutMs]
 * @returns {object}
 */
export function guardCookieJar(WebApi, options) {
    const { log, lock, drainTimeoutMs = DRAIN_TIMEOUT_MS } = options;
    let inFlight = 0;
    /** @type {Set<() => void>} */
    const idleWaiters = new Set();

    function settleOne() {
        inFlight -= 1;
        if (inFlight === 0) {
            for (const wake of idleWaiters) {
                wake();
            }
            idleWaiters.clear();
        }
    }

    /** @returns {Promise<boolean>} whether the requests in flight finished in time */
    function drained() {
        if (inFlight === 0) {
            return Promise.resolve(true);
        }
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                idleWaiters.delete(wake);
                resolve(false);
            }, drainTimeoutMs);
            const wake = () => {
                clearTimeout(timer);
                resolve(true);
            };
            idleWaiters.add(wake);
        });
    }

    const wrapped = {
        async ExecuteJson(requestJson) {
            inFlight += 1;
            try {
                return await WebApi.ExecuteJson(requestJson);
            } finally {
                settleOne();
            }
        },
        SetCookies(blob) {
            return lock.run(async () => {
                const current = new Set(decodeCookies(await WebApi.GetCookies()).map(cookieKey));
                const incoming = decodeCookies(blob);
                const missing = incoming.filter((cookie) => !current.has(cookieKey(cookie)));
                if (missing.length < incoming.length) {
                    const kept = incoming.length - missing.length;
                    log(`Kept the Hub's own VRChat cookies over ${kept} older cop${kept === 1 ? 'y' : 'ies'}`);
                }
                if (missing.length > 0) {
                    await WebApi.SetCookies(encodeCookies(missing));
                }
            });
        },
        ClearCookies() {
            return lock.run(async () => {
                if (!(await drained())) {
                    log(`Clearing the VRChat cookies with ${inFlight} request(s) still out after waiting`);
                }
                // Synchronous from here on: nothing can start in between.
                const device = deviceCookiesOnly(WebApi.GetCookies());
                WebApi.ClearCookies();
                if (decodeCookies(device).length > 0) {
                    WebApi.SetCookies(device);
                    log('Kept the remembered two-factor device across the sign-out');
                }
            });
        }
    };

    return new Proxy(
        {},
        {
            get(_, prop) {
                if (Object.hasOwn(wrapped, prop)) {
                    return wrapped[prop];
                }
                const value = WebApi[prop];
                return typeof value === 'function' ? value.bind(WebApi) : value;
            },
            has(_, prop) {
                return Object.hasOwn(wrapped, prop) || prop in WebApi;
            }
        }
    );
}

/**
 * Replace the auth store's session entry points on the Hub. Upstream reaches
 * these through the store object -- `services/request.js` and
 * `friendSyncCoordinator.js` call `authStore.handleAutoLogin()` /
 * `authStore.handleLogoutEvent()`, `authAutoLoginCoordinator.js` and the session
 * keeper call `authStore.relogin()` -- so replacing the store's members catches
 * them. What the store calls from inside its own closure (`relogin`'s sign-out
 * on failure, `login()`'s clearCookies) is not caught here; the cookie guard's
 * lock and drain cover those.
 *
 * @param {object} auth - the auth store. Its session actions are replaced, deliberately;
 *   this is not state, and the lint rule against store assignment does not apply to it.
 * @param {object} options
 * @param {ReturnType<typeof createSignInGate>} options.gate
 * @param {ReturnType<typeof createSessionLock>} options.lock
 * @param {() => Promise<boolean>} options.sessionAnswers - does the current jar get a user and data back
 * @param {(message: string) => void} options.log
 * @param {() => void} [options.onSignOutDeclined] - an automatic sign-out was skipped; e.g. load the friends again
 * @param {() => number} [options.now]
 */
export function governSignIn(auth, options) {
    const { gate, lock, sessionAnswers, log, onSignOutDeclined = () => {}, now = Date.now } = options;
    const handleAutoLogin = auth.handleAutoLogin;
    const handleLogoutEvent = auth.handleLogoutEvent;
    const relogin = auth.relogin;
    let autoLoginInFlight = null;
    let signOutInFlight = null;
    let verifiedAt = -Infinity;

    /** @returns {Promise<boolean>} */
    async function answers() {
        if (now() - verifiedAt < SESSION_CHECK_TTL_MS) {
            return true;
        }
        let ok = false;
        try {
            ok = await sessionAnswers();
        } catch {
            // Could not tell; treat it as gone, which is what upstream assumes.
        }
        if (ok) {
            verifiedAt = now();
        }
        return ok;
    }

    auth.handleAutoLogin = () => {
        if (autoLoginInFlight) {
            return autoLoginInFlight;
        }
        autoLoginInFlight = lock
            .run(async () => {
                if (gate.secondFactorPending()) {
                    log('Not signing in again: VRChat is waiting for a second factor, which a client has to enter');
                    return;
                }
                if (await answers()) {
                    log(
                        'A 401 from a request sent with an older session; the session still works, not signing in again'
                    );
                    return;
                }
                verifiedAt = -Infinity;
                await handleAutoLogin();
            })
            .finally(() => {
                autoLoginInFlight = null;
            });
        return autoLoginInFlight;
    };

    // Upstream also signs out by itself: the friend list failing to load, or
    // the fourth auto-login in an hour. On the Hub every one of those is a
    // reaction to a 401, and a sign-out clears the jar and starts a password
    // sign-in, so it is only worth doing when the session really is gone.
    auth.handleLogoutEvent = (...args) => {
        if (signOutInFlight) {
            return signOutInFlight;
        }
        signOutInFlight = lock
            .run(async () => {
                if (await answers()) {
                    log('Not signing out: the session still works');
                    onSignOutDeclined();
                    return;
                }
                verifiedAt = -Infinity;
                await handleLogoutEvent(...args);
            })
            .finally(() => {
                signOutInFlight = null;
            });
        return signOutInFlight;
    };

    auth.relogin = (user, reloginOptions) =>
        lock.run(async () => {
            if (gate.secondFactorPending()) {
                throw new Error('VRChat is waiting for a second factor; a client has to enter it');
            }
            verifiedAt = -Infinity;
            // The jar is the source of truth on the Hub; the saved copy is older.
            const { cookies: _saved, ...withoutCookies } = user ?? {};
            return relogin(withoutCookies, reloginOptions);
        });
}

/**
 * @param {string} method - `Execute` or `ExecuteJson`
 * @param {any[]} args
 * @returns {any | null} the request options a client's WebApi call carries
 */
export function clientRequestOptions(method, args) {
    const raw = args?.[0];
    if (method === 'ExecuteJson' && typeof raw === 'string') {
        try {
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }
    return raw && typeof raw === 'object' ? raw : null;
}

/**
 * What a client may do to the Hub's session over the link.
 *
 * - `GetCookies` answers with the two-factor device cookie only. Upstream's
 *   `updateStoredUser` on every mirror stored the whole jar, `auth` token
 *   included, in the shared `savedCredentials`, from where it was later
 *   written back over fresher cookies.
 * - `SetCookies` is refused: the jar is the Hub's, and every client call of it
 *   was upstream restoring a stale saved copy.
 * - `ClearCookies` goes through only when the person asked to sign out (the
 *   mirror marks it, see `client/sessionGuard.js`); otherwise it is an
 *   automatic sign-out on the client, and the session is the Hub's to repair.
 * - A password sign-in from a client is served with the current session while
 *   the Hub is signed in (the Authorization header is dropped), and otherwise
 *   runs under the session lock, as does a two-factor verification.
 *
 * @param {object} options
 * @param {ReturnType<typeof createSessionLock>} options.lock
 * @param {() => boolean} options.hubSignedIn
 * @param {(message: string) => void} options.log
 * @returns {(className: string, method: string, args: any[], client: any, next: () => Promise<any>) => Promise<any>}
 */
export function createClientSessionPolicy({ lock, hubSignedIn, log }) {
    return async function apply(className, method, args, client, next) {
        if (className !== 'WebApi') {
            return next(args);
        }
        const who = client?.clientName ?? 'a client';
        switch (method) {
            case 'GetCookies':
                return deviceCookiesOnly(await next(args));
            case 'SetCookies':
                log(`Ignored ${who}'s VRChat cookies: the jar is the Hub's`);
                return undefined;
            case 'ClearCookies':
                if (args?.[0]?.userInitiated === true) {
                    log(`${who} signed the Hub out of VRChat`);
                    return next([]);
                }
                log(`Ignored an automatic sign-out from ${who}: the Hub looks after its own session`);
                return undefined;
            case 'Execute':
            case 'ExecuteJson': {
                const request = clientRequestOptions(method, args);
                const headers = request?.headers ?? {};
                const authorization = Object.keys(headers).find((name) => name.toLowerCase() === 'authorization');
                let path = '';
                try {
                    path = new URL(String(request?.url)).pathname;
                } catch {
                    // Not ours to judge; pass it on.
                }
                if (authorization && path.endsWith('/auth/user')) {
                    if (hubSignedIn()) {
                        log(`${who} asked to sign in; the Hub is signed in already, answering with its session`);
                        const { [authorization]: _dropped, ...rest } = headers;
                        const stripped = { ...request, headers: rest };
                        return next([method === 'ExecuteJson' ? JSON.stringify(stripped) : stripped]);
                    }
                    return lock.run(() => next(args));
                }
                if (/\/auth\/twofactorauth\/[^/]+\/verify$/.test(path)) {
                    return lock.run(() => next(args));
                }
                return next(args);
            }
            default:
                return next(args);
        }
    };
}
