// @ts-nocheck
import InteropApi from '../ipc-electron/interopApi.js';
import configRepository from '../services/config.js';
import vrcxJsonStorage from '../services/jsonStorage.js';

// [hub] Optionally rebinds SQLite and WebApi to a remote Hub. See
// src/hub/client/mirrorMode.js.
import { EXPECTED_DATABASE_VERSION } from '../hub/shared/schema.js';
import { initMirrorMode } from '../hub/client/mirrorMode.js';

export async function initInteropApi(isVrOverlay = false) {
    if (isVrOverlay) {
        if (WINDOWS) {
            await CefSharp.BindObjectAsync('AppApiVr');
        } else {
            // @ts-ignore
            window.AppApiVr = InteropApi.AppApiVrElectron;
        }
    } else {
        // #region | Init Cef C# bindings
        if (WINDOWS) {
            await CefSharp.BindObjectAsync(
                'AppApi',
                'WebApi',
                'VRCXStorage',
                'SQLite',
                'LogWatcher',
                'Discord',
                'AssetBundleManager'
            );
        } else {
            window.AppApi = InteropApi.AppApiElectron;
            window.WebApi = InteropApi.WebApi;
            window.VRCXStorage = InteropApi.VRCXStorage;
            window.SQLite = InteropApi.SQLite;
            window.LogWatcher = InteropApi.LogWatcher;
            window.Discord = InteropApi.Discord;
            window.AssetBundleManager = InteropApi.AssetBundleManager;
            window.AppApiVrElectron = InteropApi.AppApiVrElectron;
        }

        new vrcxJsonStorage(VRCXStorage);

        // [hub] Must happen before configRepository.init(): the `configs` table
        // is read through SQLite, so rebinding afterwards would leave this
        // client's settings on its own local database rather than the Hub's.
        // Returns null and changes nothing if there is no Hub configured or
        // reachable, in which case VRCX runs exactly as it does today.
        await initMirrorMode({
            storage: VRCXStorage,
            localWebApi: WebApi,
            clientDatabaseVersion: EXPECTED_DATABASE_VERSION,
            clientName: WINDOWS ? 'vrcx-windows' : 'vrcx-linux'
        });

        await configRepository.init();

        AppApi.SetUserAgent();
    }
}
