/**
 * [hub] Loads VRCX's .NET assemblies into the Hub process.
 *
 * Mirrors `src-electron/InteropApi.js` and the `dotnetSetup()` block in
 * `src-electron/main.js`, minus Electron. Nothing in that path is
 * Electron-specific: it is `require('node-api-dotnet/net10.0')` plus a
 * `require` of the generated `.cjs`, both ordinary Node.
 *
 * The initialisation sequence deliberately stops short of the one the Electron
 * main process runs:
 *
 *   ProgramElectron.PreInit(version, args)   <- yes; sets the data directories
 *   VRCXStorage.Load()                       <- yes
 *   SQLite.Init()                            <- yes
 *   WebApi.Init()                            <- yes
 *   ProgramElectron.Init()                   <- NO
 *   LogWatcher.Init()                        <- NO
 *
 * `ProgramElectron.Init()` unconditionally constructs `VRCXVRElectron` and
 * starts its OpenVR polling thread (Dotnet/Program.cs and
 * Dotnet/Overlay/Electron/VRCXVRElectron.cs). There is no `openvr_api` native
 * library for linux-arm64, and an unhandled exception on a background thread
 * terminates a .NET process, so calling it would kill the Hub on a Pi.
 *
 * The consequence is that `Program.AppApiInstance` stays null. It has a private
 * setter, so it cannot be filled in from JS. The only thing that needs it is
 * `WebApi`'s image-upload path, which is why mirror clients run uploads on
 * their own local WebApi instead (see `client/remoteInterop.js`). That trade
 * is what keeps the C# tree at a zero-line diff.
 *
 * LogWatcher is skipped because a Hub box has no VRChat install; game log data
 * arrives from clients over the uplink instead.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Point the .NET host at a bundled runtime when one is shipped alongside.
 *
 * @param {string} rootDir
 */
function configureDotnetRuntime(rootDir) {
    const bundled = join(rootDir, 'dotnet-runtime');
    if (existsSync(bundled)) {
        process.env.DOTNET_ROOT = bundled;
        process.env.PATH = `${bundled}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`;
    }
}

/**
 * @param {string} rootDir - directory holding `build/Electron/*.cjs`
 * @returns {string} the assembly shim that was loaded
 */
function loadAssembly(rootDir) {
    const arm64 = join(rootDir, 'build/Electron/VRCX-Electron-arm64.cjs');
    const x64 = join(rootDir, 'build/Electron/VRCX-Electron.cjs');
    const path = process.arch === 'arm64' && existsSync(arm64) ? arm64 : x64;
    if (!existsSync(path)) {
        throw new Error(
            `VRCX .NET assembly not found at ${path}. Build it first ` +
                `(dotnet build Dotnet/VRCX-Electron.csproj) or run the Hub with --dry-run.`
        );
    }
    require(path);
    return path;
}

/**
 * @typedef {object} HubNatives
 * @property {object} SQLite
 * @property {object} WebApi
 * @property {object} VRCXStorage
 * @property {object} Program
 */

/**
 * Load the .NET side and bring up the pieces the Hub needs.
 *
 * @param {{ rootDir: string, configDir: string, version: string }} options
 * @returns {Promise<HubNatives>}
 */
export async function createNativeBridge(options) {
    const { rootDir, configDir, version } = options;

    configureDotnetRuntime(rootDir);
    loadAssembly(rootDir);

    const dotnet = require('node-api-dotnet/net10.0');
    const VRCX = dotnet.VRCX;

    const Program = new VRCX.ProgramElectron();
    const VRCXStorage = new VRCX.VRCXStorage();
    const SQLite = new VRCX.SQLite();
    const WebApi = new VRCX.WebApi();

    // `--config` is what tells Program.SetProgramDirectories where the
    // database and VRCX.json live.
    Program.PreInit(version, [`--config=${configDir}`]);
    VRCXStorage.Load();
    SQLite.Init();
    WebApi.Init();

    return { SQLite, WebApi, VRCXStorage, Program };
}

/**
 * @param {HubNatives} natives
 */
export function shutdownNativeBridge(natives) {
    try {
        natives.WebApi?.Exit();
    } catch {
        // Best effort; we are shutting down either way.
    }
    try {
        natives.VRCXStorage?.Save();
    } catch {
        // As above.
    }
    try {
        natives.SQLite?.Exit();
    } catch {
        // As above.
    }
}
