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
 * @returns {Promise<boolean>} whether the database came up
 */
export async function startHubRuntime(stores) {
    stores.updateLoop.updateLoop();

    const databaseReady = await stores.vrcx.waitForDatabaseInit();
    if (!databaseReady) {
        return false;
    }
    await stores.auth.migrateStoredUsers();
    // Signs in from the stored credentials. The pipeline socket follows on its
    // own: stores/auth.js watches `watchState.isFriendsLoaded` and calls
    // initWebsocket() when it flips.
    await stores.auth.autoLoginAfterMounted();
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
