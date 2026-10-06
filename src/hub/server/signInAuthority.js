/**
 * [hub] One authority over the Hub's VRChat sign-in.
 *
 * On a desktop, upstream's recovery from a 401 is fine: one user, one
 * window, a re-login now and then. On the Hub, where everything shares one
 * cookie jar, the same code turned every revoked session into a storm
 * (2026-10-06, read off `sessionAudit.js`):
 *
 *   1. Every request already in flight with the dead token comes back 401,
 *      and each one calls `handleAutoLogin()`. They arrive after the first
 *      re-login has finished, so each starts another.
 *   2. Each re-login begins with `setCookies(savedCredentials.cookies)`, the
 *      copy saved at the previous sign-in, which overwrites the `auth` the
 *      last re-login just obtained -- and the `twoFactorAuth` device cookie
 *      with it. Then the fourth in an hour signs out, which clears the jar,
 *      device cookie included, so the next password sign-in wants an OTP.
 *   3. While a person answered that OTP on a mirror, the Hub's own retry
 *      signed in with the password again, replacing the session the code was
 *      being entered for. The verification succeeded and the Hub was still
 *      signed out.
 *
 * So, on the Hub only:
 *
 *   - a 401 first asks `auth/user` whether the session really is gone, once
 *     for any number of 401s, and a re-login happens only if it is;
 *   - saved cookies never overwrite the jar: `relogin` does not restore them,
 *     and `SetCookies` (from a client, or anything else) only adds cookies the
 *     jar lacks;
 *   - clearing the jar keeps the `twoFactorAuth` device cookie, so signing out
 *     does not cost the next sign-in an OTP;
 *   - while VRChat waits for a second factor, nothing signs in with the
 *     password; once someone answers it, the Hub resumes that session.
 */

/** A pending second factor older than this no longer holds off a password sign-in. */
export const SECOND_FACTOR_WAIT_MS = 10 * 60 * 1000;

/** A successful session check covers 401s arriving within this window. */
export const SESSION_CHECK_TTL_MS = 10 * 1000;

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
 * Wrap the WebApi binding so the cookie jar only ever moves forward.
 * Same Proxy-over-empty-target shape as `webApiLog.js`.
 *
 * @param {object} WebApi
 * @param {{ log: (message: string) => void }} options
 * @returns {object}
 */
export function guardCookieJar(WebApi, options) {
    const { log } = options;

    const wrapped = {
        async SetCookies(blob) {
            const current = new Set(decodeCookies(await WebApi.GetCookies()).map(cookieKey));
            const incoming = decodeCookies(blob);
            const missing = incoming.filter((cookie) => !current.has(cookieKey(cookie)));
            if (missing.length < incoming.length) {
                log(
                    `Kept the Hub's own VRChat cookies over ${incoming.length - missing.length} older ` +
                        `cop${incoming.length - missing.length === 1 ? 'y' : 'ies'}`
                );
            }
            if (missing.length === 0) {
                return;
            }
            return WebApi.SetCookies(encodeCookies(missing));
        },
        async ClearCookies() {
            const device = decodeCookies(await WebApi.GetCookies()).filter((cookie) => cookie?.Name === DEVICE_COOKIE);
            await WebApi.ClearCookies();
            if (device.length > 0) {
                await WebApi.SetCookies(encodeCookies(device));
                log('Kept the remembered two-factor device across the sign-out');
            }
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
 * Replace the auth store's re-login entry points on the Hub. Upstream calls
 * both through the store (`services/request.js` -> `authStore.handleAutoLogin()`,
 * `authAutoLoginCoordinator.js` -> `authStore.relogin()`), so replacing the
 * store's members is enough.
 *
 * @param {object} auth - the auth store. Its two re-login actions are replaced, deliberately;
 *   this is not state, and the lint rule against store assignment does not apply to it.
 * @param {object} options
 * @param {ReturnType<typeof createSignInGate>} options.gate
 * @param {() => Promise<boolean>} options.sessionAnswers - does `auth/user` return a user with the current jar
 * @param {(message: string) => void} options.log
 * @param {() => number} [options.now]
 */
export function governSignIn(auth, options) {
    const { gate, sessionAnswers, log, now = Date.now } = options;
    const handleAutoLogin = auth.handleAutoLogin;
    const relogin = auth.relogin;
    let inFlight = null;
    let verifiedAt = -Infinity;

    auth.handleAutoLogin = () => {
        if (inFlight) {
            return inFlight;
        }
        inFlight = (async () => {
            if (gate.secondFactorPending()) {
                log('Not signing in again: VRChat is waiting for a second factor, which a client has to enter');
                return;
            }
            if (now() - verifiedAt < SESSION_CHECK_TTL_MS) {
                return;
            }
            let answers = false;
            try {
                answers = await sessionAnswers();
            } catch {
                // Could not tell; treat it as gone, which is what upstream assumes.
            }
            if (answers) {
                verifiedAt = now();
                log('A 401 from a request sent with an older session; the session still works, not signing in again');
                return;
            }
            await handleAutoLogin();
        })().finally(() => {
            inFlight = null;
        });
        return inFlight;
    };

    auth.relogin = async (user, reloginOptions) => {
        if (gate.secondFactorPending()) {
            throw new Error('VRChat is waiting for a second factor; a client has to enter it');
        }
        // The jar is the source of truth on the Hub; the saved copy is older.
        const { cookies: _saved, ...withoutCookies } = user ?? {};
        return relogin(withoutCookies, reloginOptions);
    };
}
