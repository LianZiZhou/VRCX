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

import { createApp, defineComponent } from 'vue';

import { createGlobalStores, pinia } from '../../stores';
import { i18n, loadLocalizedStrings } from '../../plugins/i18n';
import { addGameLogEvent } from '../../coordinators/gameLogCoordinator';
import { runUpdateIsGameRunningFlow, runUpdateIsHmdAfkFlow } from '../../coordinators/gameCoordinator';
import { initDayjs } from '../../plugins/dayjs';
import { router } from '../shims/router.js';

import configRepository from '../../services/config';
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
 * @property {AbortSignal} [signal] - stops the retries (the Hub is shutting down)
 * @property {{ minMs?: number, maxMs?: number }} [retry]
 */

/**
 * Sign in from the stored credentials, and keep trying if VRChat cannot be
 * reached.
 *
 * On the desktop a failed start-up sign-in leaves the user at the login
 * dialog to click again. A Hub has nobody to click, and the usual cause on a
 * freshly set-up box is a network that is not there yet: DNS still coming
 * up, a proxy, a missing CA store. So the first attempt is awaited -- a Hub
 * that can sign in should be signed in before it starts serving clients --
 * and further attempts run in the background with a doubling delay.
 *
 * `getCurrentUser` failures are not seen here: `autoLoginAfterMounted`
 * already catches them and hands them to the update loop's own retry.
 *
 * @param {object} stores
 * @param {RuntimeOptions} options
 * @returns {Promise<void>}
 */
async function signInWithRetry(stores, options) {
    const { log = () => {}, onSignInFailure = null, signal = null, retry = {} } = options;
    const minMs = retry.minMs ?? SIGN_IN_RETRY_MIN_MS;
    const maxMs = retry.maxMs ?? SIGN_IN_RETRY_MAX_MS;

    let attempt = 0;
    let delay = minMs;
    /** @returns {Promise<boolean>} */
    const attemptSignIn = async () => {
        attempt += 1;
        try {
            await stores.auth.autoLoginAfterMounted();
            return true;
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            log(`Sign-in attempt ${attempt} failed: ${detail.split('\n')[0]}`);
            if (attempt === 1) {
                try {
                    await onSignInFailure?.(err);
                } catch {
                    // Diagnostics must never take the Hub down.
                }
            }
            return false;
        }
    };

    if (await attemptSignIn()) {
        return;
    }

    // Deliberately not awaited: the Hub goes on to serve clients and accept
    // an import while VRChat is unreachable.
    (async () => {
        while (!signal?.aborted && !stores.user.currentUser?.id) {
            log(`Retrying sign-in in ${Math.round(delay / 1000)}s`);
            await sleep(delay, signal);
            if (signal?.aborted) {
                return;
            }
            if (await attemptSignIn()) {
                log('Signed in.');
                return;
            }
            delay = Math.min(delay * 2, maxMs);
        }
    })().catch((err) => log(`Sign-in retry loop stopped: ${err?.message ?? err}`));
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
    // Signs in from the stored credentials. The pipeline socket follows on its
    // own: stores/auth.js watches `watchState.isFriendsLoaded` and calls
    // initWebsocket() when it flips.
    await signInWithRetry(stores, options);
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
