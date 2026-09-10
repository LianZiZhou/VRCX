/**
 * [hub] Boot the VRCX data core headlessly.
 *
 * This is the Node-side counterpart of `src/app.js` + `src/App.vue`. It brings
 * up exactly the parts of the app that produce and persist data, and none of
 * the UI.
 *
 * Deliberate differences from the desktop boot, each of which is load-bearing:
 *
 *  - A `render: () => null` root component is still **mounted**. It cannot be
 *    skipped: 17 stores call `useI18n()` at setup top level, which throws
 *    unless `getCurrentInstance()` is non-null. `app.runWithContext()` is not
 *    a substitute — it only sets the app for `inject()`.
 *  - `initComponents` / `initSentry` / `VueQueryPlugin` are skipped. The query
 *    client is only used imperatively (never via `useQuery`) outside `.vue`.
 *  - `initUi()` is replaced by just its language half; theme/CSS/font work is
 *    meaningless here.
 *  - `initDayjs()` is required — the DB layer and `shared/utils` call
 *    `.duration()`, `.utc()` and friends.
 *  - `getGameLogTable()`, the VRChat registry backup and the debug-logging
 *    check from `App.vue`'s `onMounted` are dropped: they all read a local
 *    VRChat install, which a Hub box does not have.
 */

import { createApp, defineComponent, watch } from 'vue';

import { createGlobalStores, pinia } from '../../stores';
import { i18n, loadLocalizedStrings } from '../../plugins/i18n';
import { addGameLogEvent } from '../../coordinators/gameLogCoordinator';
import { runUpdateIsGameRunningFlow, runUpdateIsHmdAfkFlow } from '../../coordinators/gameCoordinator';
import { initDayjs } from '../../plugins/dayjs';
import { router } from '../shims/router.js';

import configRepository from '../../services/config';
import { watchState } from '../../services/watchState';
import { reconnectWebSocket, wsState } from '../../services/websocket.js';
import vrcxJsonStorage from '../../services/jsonStorage';

/**
 * Mirror of the non-Windows branch of `plugins/interopApi.js#initInteropApi`.
 * The native globals themselves are installed by the caller (node-api-dotnet
 * in production, `nativeStubs.js` in tests) before this runs.
 *
 * @returns {Promise<void>}
 */
export async function initHubInterop() {
    await configRepository.init();
    new vrcxJsonStorage(globalThis.VRCXStorage);
    await globalThis.AppApi.SetUserAgent();
}

/**
 * The language half of `plugins/ui.js#initUi`.
 *
 * @returns {Promise<void>}
 */
export async function initHubLocale() {
    try {
        const language = await configRepository.getString('VRCX_appLanguage', 'en');
        // @ts-ignore
        i18n.locale = language;
        await loadLocalizedStrings(language);
    } catch (error) {
        console.error('Failed to initialise Hub locale:', error);
    }
}

/**
 * Construct and mount the store graph.
 *
 * @returns {{ app: import('vue').App, stores: object }}
 */
export function mountHubCore() {
    let stores = null;
    let setupError = null;

    const HubRoot = defineComponent({
        name: 'HubRoot',
        setup() {
            try {
                stores = createGlobalStores();

                // The bridge assignments from App.vue:63-65. On the Hub the
                // gamelog/game-state producers are remote clients rather than a
                // local LogWatcher, but the entry points must exist all the same.
                stores.game.updateIsGameRunning = runUpdateIsGameRunningFlow;
                stores.game.updateIsHmdAfk = runUpdateIsHmdAfkFlow;
                stores.gameLog.addGameLogEvent = addGameLogEvent;

                globalThis.$pinia = stores;
            } catch (err) {
                setupError = err;
            }
            return () => null;
        }
    });

    const app = createApp(HubRoot);
    app.config.errorHandler = (err) => {
        setupError ??= err;
        console.error('[hub] Vue error:', err);
    };
    app.use(pinia).use(i18n).use(router);
    app.mount(document.createElement('div'));

    if (setupError) {
        throw setupError;
    }
    return { app, stores };
}

/** Sign-in retry backoff: first wait, and the cap it doubles up to. */
const SIGN_IN_RETRY_MIN_MS = 30000;
const SIGN_IN_RETRY_MAX_MS = 5 * 60 * 1000;
/** How long a sign-in that came back without a user gets for upstream's detached re-login to show up. */
const SIGN_IN_SETTLE_MS = 3000;

/**
 * Written when the Hub signs itself out, cleared when it is back in. A Hub
 * restarted in between finds `lastUserLoggedIn` gone (upstream's logout flow
 * removes it) and would otherwise wait for a client; this says whom to resume.
 * A person signing out from a client never sets it, so that stays a sign-out.
 */
const RESUME_USER_KEY = 'VRCX_hubResumeUser';

/** How often the pipeline watchdog looks, and how long a gap it lets pass. */
const PIPELINE_WATCHDOG_MS = 30000;
const PIPELINE_DOWN_GRACE_MS = 90000;

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
    return new Promise((resolve) => {
        const timer = setTimeout(done, ms);
        timer.unref?.();
        function done() {
            signal?.removeEventListener('abort', done);
            clearTimeout(timer);
            resolve();
        }
        signal?.addEventListener('abort', done, { once: true });
    });
}

/**
 * @typedef {object} RuntimeOptions
 * @property {(message: string) => void} [log]
 * @property {(error: Error) => Promise<void> | void} [onSignInFailure] - called once, on the first failure
 * @property {AbortSignal} [signal] - stops the retries and the watchdog (the Hub is shutting down)
 * @property {{ minMs?: number, maxMs?: number, settleMs?: number }} [retry]
 * @property {(controls: { wake: () => void }) => void} [onRetryControls] - receives a `wake()`
 *   that cuts the current back-off short, for when a client has just signed in
 * @property {{ intervalMs?: number, graceMs?: number, reconnect?: () => void }} [watchdog]
 */

/** @returns {boolean} */
function isSignedIn() {
    return watchState.isLoggedIn === true;
}

/**
 * Upstream's own re-login runs detached: a 401 inside `getCurrentUser` calls
 * `handleAutoLogin()` without awaiting it, so the sign-in call returns while
 * that is still getting started -- `attemptingAutoLogin` is not even set yet.
 * Give it `settleMs` to appear and, once it has, up to a minute to finish,
 * before judging the attempt; otherwise the log says the session could not be
 * resumed just before "Hello there".
 *
 * @param {object} stores
 * @param {number} settleMs
 * @param {AbortSignal | null} signal
 * @returns {Promise<void>}
 */
async function awaitUpstreamAutoLogin(stores, settleMs, signal) {
    const settled = Date.now() + settleMs;
    const deadline = Date.now() + 60000;
    while (!isSignedIn() && !signal?.aborted) {
        const now = Date.now();
        const busy = Boolean(stores.auth?.attemptingAutoLogin);
        if (busy ? now >= deadline : now >= settled) {
            return;
        }
        await sleep(Math.min(250, settleMs || 250), signal);
    }
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function firstLine(err) {
    const detail = err instanceof Error ? err.message : String(err);
    return detail.split('\n')[0];
}

/**
 * Why a sign-in attempt returned without a user, when it did not throw.
 *
 * Upstream treats all of these as "leave the person at the login dialog";
 * a Hub has no dialog, so it says so in the log and keeps retrying, because
 * every one of them is fixed from a client without touching the Hub.
 *
 * @param {object} stores
 * @returns {Promise<string>}
 */
async function describeSilentSignInFailure(stores) {
    if (stores.advancedSettings?.enablePrimaryPassword) {
        return (
            'the primary password is enabled in the shared settings, which disables automatic sign-in; ' +
            'turn it off from a client and sign in there'
        );
    }
    if (stores.auth?.twoFactorAuthDialogVisible) {
        return 'VRChat asked for a two-factor code, which a Hub cannot answer; sign in from a client attached to this Hub';
    }
    let lastUser = null;
    try {
        lastUser = await configRepository.getString('lastUserLoggedIn');
    } catch {
        // The database may not be readable yet; the generic message covers it.
    }
    if (!lastUser) {
        return 'no stored VRChat session; sign in from a client attached to this Hub';
    }
    return 'the stored session could not be resumed; sign in again from a client';
}

/**
 * Keep the Hub signed in to VRChat.
 *
 * On the desktop a failed start-up sign-in leaves the user at the login
 * dialog to click again, and a session that dies later (VRChat invalidated
 * the cookie, or the auto-login guard gave up after three tries in an hour)
 * drops them back to that dialog. A Hub has nobody to click. So:
 *
 *  - the first attempt is awaited -- a Hub that can sign in should be signed
 *    in before it starts serving clients -- and further attempts run in the
 *    background with a doubling delay;
 *  - once it has been signed in, a later sign-out starts the same loop again,
 *    this time from the saved credentials, since upstream's logout flow drops
 *    `lastUserLoggedIn` and the cookies but keeps the saved login.
 *
 * The back-off is what stands in for upstream's three-per-hour guard: the
 * attempts are spaced out instead of counted.
 *
 * `getCurrentUser` failures are not seen here: `autoLoginAfterMounted`
 * already catches them and hands them to the update loop's own retry.
 *
 * @param {object} stores
 * @param {RuntimeOptions} options
 * @returns {{ signIn: () => Promise<void> }}
 */
function createSessionKeeper(stores, options) {
    const { log = () => {}, onSignInFailure = null, signal = null, retry = {}, onRetryControls = null } = options;
    const minMs = retry.minMs ?? SIGN_IN_RETRY_MIN_MS;
    const maxMs = retry.maxMs ?? SIGN_IN_RETRY_MAX_MS;
    const settleMs = retry.settleMs ?? SIGN_IN_SETTLE_MS;

    let attempt = 0;
    let running = false;
    /** The user the Hub was last signed in as; who to sign back in as. */
    let lastUserId = null;

    // A client signing in writes `lastUserLoggedIn`; the Hub is told and
    // stops waiting out its back-off.
    let wakeNow = () => {};
    onRetryControls?.({ wake: () => wakeNow() });

    /** Start-up: resume the stored session the way the desktop does. */
    const bootAttempt = async () => {
        attempt += 1;
        try {
            await stores.auth.autoLoginAfterMounted();
        } catch (err) {
            log(`Sign-in attempt ${attempt} failed: ${firstLine(err)}`);
            if (attempt === 1) {
                try {
                    await onSignInFailure?.(err);
                } catch {
                    // Diagnostics must never take the Hub down.
                }
            }
            return false;
        }
        await awaitUpstreamAutoLogin(stores, settleMs, signal);
        if (isSignedIn()) {
            return true;
        }
        // No throw and no user: upstream's "stay at the login dialog" case.
        log(`Sign-in attempt ${attempt} did not sign in: ${await describeSilentSignInFailure(stores)}`);
        return false;
    };

    /** After a sign-out: log in again from the saved credentials. */
    const resumeAttempt = async () => {
        attempt += 1;
        const userId = lastUserId;
        let user;
        try {
            user = await stores.auth.getSavedCredentials(userId);
        } catch (err) {
            log(`Sign-in attempt ${attempt} failed: ${firstLine(err)}`);
            return false;
        }
        if (!user) {
            log(
                `Sign-in attempt ${attempt} did not sign in: no saved credentials for ${userId}; ` +
                    'sign in again from a client attached to this Hub'
            );
            return false;
        }
        try {
            await stores.auth.relogin(user, { shouldTrackLoginNetworkIssueHint: false });
        } catch (err) {
            log(`Sign-in attempt ${attempt} failed: ${firstLine(err)}`);
            return false;
        }
        await awaitUpstreamAutoLogin(stores, settleMs, signal);
        if (isSignedIn()) {
            return true;
        }
        log(`Sign-in attempt ${attempt} did not sign in: ${await describeSilentSignInFailure(stores)}`);
        return false;
    };

    /** @returns {Promise<boolean>} */
    const attemptSignIn = () => (lastUserId ? resumeAttempt() : bootAttempt());

    /** A previous Hub process signed itself out and was restarted before it got back in. */
    async function adoptResumeMarker() {
        try {
            const marker = await configRepository.getString(RESUME_USER_KEY);
            if (!marker) {
                return;
            }
            if ((await configRepository.getString('lastUserLoggedIn')) !== null) {
                // A client has signed in since; the stored session is the one to resume.
                return;
            }
            lastUserId = marker;
            log(`The previous Hub process was signed out of VRChat; resuming ${marker} from the saved credentials`);
        } catch {
            // Not readable yet; the usual path applies.
        }
    }

    /**
     * The back-off loop. Only one runs at a time; it ends when the Hub is
     * signed in, by whichever path, or shutting down.
     */
    async function retryUntilSignedIn() {
        if (running) {
            return;
        }
        running = true;
        let delay = minMs;
        try {
            while (!signal?.aborted && !isSignedIn()) {
                log(`Retrying sign-in in ${Math.round(delay / 1000)}s`);
                const woken = new AbortController();
                wakeNow = () => woken.abort();
                const stop = () => woken.abort();
                signal?.addEventListener('abort', stop, { once: true });
                await sleep(delay, woken.signal);
                signal?.removeEventListener('abort', stop);
                wakeNow = () => {};
                if (signal?.aborted || isSignedIn()) {
                    // Shut down, or something else signed the Hub in meanwhile.
                    return;
                }
                if (await attemptSignIn()) {
                    log('Signed in.');
                    return;
                }
                delay = Math.min(delay * 2, maxMs);
            }
        } catch (err) {
            log(`Sign-in retry loop stopped: ${firstLine(err)}`);
        } finally {
            running = false;
        }
    }

    const stopWatching = watch(
        () => watchState.isLoggedIn,
        (loggedIn) => {
            if (loggedIn) {
                lastUserId = stores.user.currentUser?.id ?? lastUserId;
                configRepository.remove(RESUME_USER_KEY).catch(() => {});
                return;
            }
            if (signal?.aborted || running) {
                return;
            }
            log('Signed out of VRChat; signing back in from the saved credentials');
            if (lastUserId) {
                configRepository.setString(RESUME_USER_KEY, lastUserId).catch(() => {});
            }
            // Deliberately not awaited, and never immediate: upstream's logout
            // flow is still clearing cookies when this fires.
            void retryUntilSignedIn();
        },
        { flush: 'sync' }
    );
    signal?.addEventListener('abort', stopWatching, { once: true });

    return {
        async signIn() {
            await adoptResumeMarker();
            if (await attemptSignIn()) {
                return;
            }
            // Deliberately not awaited: the Hub goes on to serve clients and
            // accept an import while VRChat is unreachable.
            void retryUntilSignedIn();
        }
    };
}

/**
 * Reconnect the VRChat pipeline when it has been down for a while.
 *
 * `services/websocket.js` retries on its own after a close and after a
 * failed token fetch. This covers what that cannot see: a socket that never
 * opens, or a token response that was not an error but not `ok` either.
 * `reconnectWebSocket()` tears down whatever is there and starts over, and
 * declines on its own when the Hub is not signed in.
 *
 * @param {RuntimeOptions} options
 * @returns {void}
 */
function startPipelineWatchdog(options) {
    const { log = () => {}, signal = null, watchdog = {} } = options;
    const intervalMs = watchdog.intervalMs ?? PIPELINE_WATCHDOG_MS;
    const graceMs = watchdog.graceMs ?? PIPELINE_DOWN_GRACE_MS;
    const reconnect = watchdog.reconnect ?? reconnectWebSocket;

    let downSince = null;
    const timer = setInterval(() => {
        if (!watchState.isLoggedIn || !watchState.isFriendsLoaded || wsState.connected) {
            downSince = null;
            return;
        }
        const now = Date.now();
        downSince ??= now;
        if (now - downSince < graceMs) {
            return;
        }
        log(`VRChat pipeline has been down for ${Math.round((now - downSince) / 1000)}s; reconnecting`);
        downSince = now;
        try {
            reconnect();
        } catch (err) {
            log(`Pipeline reconnect failed: ${firstLine(err)}`);
        }
    }, intervalMs);
    timer.unref?.();
    signal?.addEventListener('abort', () => clearInterval(timer), { once: true });
}

/**
 * Start the periodic work and sign in.
 *
 * Separate from `startHubCore` so tests can build the store graph without
 * touching the network or starting timers.
 *
 * `App.vue`'s onMounted also calls `getGameLogTable()`,
 * `checkAutoBackupRestoreVrcRegistry()` and `runCheckVRChatDebugLoggingFlow()`.
 * All three read a local VRChat install, and `getGameLogTable()` additionally
 * sleeps for ten seconds tailing log files, so none of them belong here.
 *
 * @param {object} stores
 * @param {RuntimeOptions} [options]
 * @returns {Promise<boolean>} whether the database came up
 */
export async function startHubRuntime(stores, options = {}) {
    stores.updateLoop.updateLoop();

    const databaseReady = await stores.vrcx.waitForDatabaseInit();
    if (!databaseReady) {
        return false;
    }
    await stores.auth.migrateStoredUsers();
    // Signs in from the stored credentials, and signs back in after a later
    // sign-out. The pipeline socket follows on its own: stores/auth.js
    // watches `watchState.isFriendsLoaded` and calls initWebsocket() when it
    // flips; the watchdog is for when that socket stays down.
    await createSessionKeeper(stores, options).signIn();
    startPipelineWatchdog(options);
    return true;
}

/**
 * Full headless boot: interop -> locale -> dayjs -> stores.
 *
 * Does not start the update loop or log in; callers decide when to do that so
 * tests can stop short of touching the network.
 *
 * @returns {Promise<{ app: import('vue').App, stores: object }>}
 */
export async function startHubCore() {
    await initHubInterop();
    await initHubLocale();
    initDayjs();
    return mountHubCore();
}
