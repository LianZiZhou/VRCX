/**
 * [hub] In-memory stand-ins for the seven C# interop globals.
 *
 * Used by the boot spike and by `--dry-run` Hub starts. The real Hub binds
 * these to the .NET assemblies through node-api-dotnet; the shapes here match
 * what `src/services/sqlite.js` and `src/services/webapi.js` expect on the
 * `LINUX` code path (ExecuteJson returning a JSON string).
 */

/**
 * Resolves to `undefined`, not `''`: several callers branch on the result
 * (`if (result) return;`), and a stub that answers with a string means
 * "false" to every one of them. `AppApi.VrcClosedGracefully` returning `''`
 * had the Hub conclude VRChat crashed and write an Event row saying so.
 */
const noopAsync = () => Promise.resolve(undefined);

/**
 * @returns {object} a Proxy whose every property is an async no-op
 */
function stubObject(overrides = {}) {
    return new Proxy(overrides, {
        get(target, prop) {
            if (prop in target) {
                return target[prop];
            }
            return noopAsync;
        }
    });
}

export function installNativeStubs() {
    const store = new Map();

    globalThis.SQLite = stubObject({
        Init: noopAsync,
        Exit: noopAsync,
        Execute: async () => [],
        ExecuteJson: async () => '[]',
        ExecuteNonQuery: async () => 0
    });

    // 503 rather than 200: a stubbed Hub genuinely has no network, and every
    // caller already has a non-200 path. Returning 200 with an empty body makes
    // callers dereference fields that are not there.
    globalThis.WebApi = stubObject({
        Execute: async () => ({ Item1: 503, Item2: '' }),
        ExecuteJson: async () => JSON.stringify({ status: 503, message: '' }),
        GetCookies: noopAsync,
        SetCookies: noopAsync,
        ClearCookies: noopAsync
    });

    globalThis.VRCXStorage = stubObject({
        Get: async (key) => store.get(key) ?? '',
        Set: async (key, value) => void store.set(key, value),
        Remove: async (key) => void store.delete(key),
        GetAll: async () => '{}',
        Load: noopAsync,
        Save: noopAsync
    });

    globalThis.AppApi = stubObject({
        CurrentLanguage: async () => 'en',
        CurrentCulture: async () => 'en-US',
        CustomScript: async () => '',
        CustomCss: async () => '',
        GetVersion: async () => 'VRCX-Hub',
        GetLaunchCommand: async () => '',
        IsGameRunning: async () => false,
        IsSteamVRRunning: async () => false,
        // The Hub has no local VRChat, so nothing it sees can be a crash.
        // The crash check runs when the aggregate game state turns false,
        // which on a Hub means a *client's* game closed -- gracefully or not,
        // that client is the one to relaunch it.
        VrcClosedGracefully: async () => true,
        // Windows asks the C# side to re-announce game state through this;
        // on the Hub game state arrives over the uplink instead.
        CheckGameRunning: async () => {}
    });

    globalThis.LogWatcher = stubObject({
        Get: async () => [],
        GetLogLines: async () => []
    });

    globalThis.Discord = stubObject({
        // `discordPresence.js` stores the return value as `isDiscordActive`;
        // anything but a boolean makes it re-call Discord every tick.
        SetActive: async () => false
    });
    globalThis.AssetBundleManager = stubObject();

    if (typeof globalThis.window !== 'undefined') {
        for (const name of [
            'SQLite',
            'WebApi',
            'VRCXStorage',
            'AppApi',
            'LogWatcher',
            'Discord',
            'AssetBundleManager'
        ]) {
            globalThis.window[name] = globalThis[name];
        }
    }
}
