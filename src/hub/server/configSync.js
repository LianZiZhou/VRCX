/**
 * [hub] Keeps the Hub's settings stores in step with the shared `configs` table.
 *
 * Application settings live in the `configs` table, which follows the database
 * to the Hub, so a mirror client's settings UI writes straight into the Hub's
 * database. But every settings store reads `configs` once, at construction
 * (`initAdvancedSettings()` and friends), and the Hub -- the one process that
 * writes derived rows -- would otherwise run on whatever the settings were at
 * boot: game log collection stays on after it is turned off, the auto status
 * change keeps the old statuses, and so on.
 *
 * The `init*` functions are not exported, so the fix is a table: the config
 * keys whose values matter on the Hub, which store field each one feeds and
 * how it is parsed. When a client's `call` writes the `configs` table the key
 * is looked up here, re-read through `configRepository` (so the parsing rules
 * stay upstream's), and assigned onto the store. Pinia setup stores expose
 * their refs as writable properties, so `stores.generalSettings.x = v` is the
 * same assignment `initGeneralSettings` makes.
 *
 * Keys that only matter on a desktop (window placement, notification sounds,
 * TTS voices) are deliberately absent; the Hub has nothing to do with them.
 */

import { transformKey } from '../../services/config.js';

/**
 * @typedef {object} WatchedKey
 * @property {string} key - the config key as the stores spell it
 * @property {string} store - a key of `createGlobalStores()`
 * @property {string} prop - the store field
 * @property {'bool' | 'string' | 'int' | 'json'} type
 * @property {any} defaultValue - what the store uses when the row is absent
 * @property {(stores: object, value: any) => void} [after] - a side effect the store's own init runs
 */

/**
 * @param {string} key
 * @param {string} store
 * @param {string} prop
 * @param {'bool' | 'string' | 'int' | 'json'} type
 * @param {any} defaultValue
 * @param {(stores: object, value: any) => void} [after]
 * @returns {WatchedKey}
 */
function watched(key, store, prop, type, defaultValue, after) {
    return { key, store, prop, type, defaultValue, after };
}

/** @type {WatchedKey[]} */
export const WATCHED_CONFIG_KEYS = [
    // settings/advanced.js
    watched('enablePrimaryPassword', 'advancedSettings', 'enablePrimaryPassword', 'bool', false),
    watched('VRCX_relaunchVRChatAfterCrash', 'advancedSettings', 'relaunchVRChatAfterCrash', 'bool', false),
    watched('VRCX_vrcQuitFix', 'advancedSettings', 'vrcQuitFix', 'bool', true),
    watched('VRCX_autoSweepVRChatCache', 'advancedSettings', 'autoSweepVRChatCache', 'bool', false),
    watched('VRCX_selfInviteOverride', 'advancedSettings', 'selfInviteOverride', 'bool', false),
    watched('VRCX_saveInstancePrints', 'advancedSettings', 'saveInstancePrints', 'bool', false),
    watched('VRCX_cropInstancePrints', 'advancedSettings', 'cropInstancePrints', 'bool', false),
    watched('VRCX_saveInstanceStickers', 'advancedSettings', 'saveInstanceStickers', 'bool', false),
    watched('VRCX_saveInstanceEmoji', 'advancedSettings', 'saveInstanceEmoji', 'bool', false),
    watched('VRCX_avatarRemoteDatabase', 'advancedSettings', 'avatarRemoteDatabase', 'bool', true),
    watched('VRCX_gameLogDisabled', 'advancedSettings', 'gameLogDisabled', 'bool', false),
    watched('VRCX_avatarAutoCleanup', 'advancedSettings', 'avatarAutoCleanup', 'string', 'Off'),
    watched('VRCX_autoDeleteOldPrints', 'advancedSettings', 'autoDeleteOldPrints', 'bool', false),

    // settings/general.js
    watched('VRCX_udonExceptionLogging', 'generalSettings', 'udonExceptionLogging', 'bool', false),
    watched('VRCX_logResourceLoad', 'generalSettings', 'logResourceLoad', 'bool', false),
    watched('VRCX_logEmptyAvatars', 'generalSettings', 'logEmptyAvatars', 'bool', false),
    watched('VRCX_localFavoriteFriendsGroups', 'generalSettings', 'localFavoriteFriendsGroups', 'json', '[]'),
    watched('VRCX_autoStateChangeEnabled', 'generalSettings', 'autoStateChangeEnabled', 'bool', false),
    watched('VRCX_autoStateChangeAloneStatus', 'generalSettings', 'autoStateChangeAloneStatus', 'string', 'join me'),
    watched('VRCX_autoStateChangeCompanyStatus', 'generalSettings', 'autoStateChangeCompanyStatus', 'string', 'busy'),
    watched('VRCX_autoStateChangeInstanceTypes', 'generalSettings', 'autoStateChangeInstanceTypes', 'json', '[]'),
    watched('VRCX_autoStateChangeNoFriends', 'generalSettings', 'autoStateChangeNoFriends', 'bool', false),
    watched(
        'VRCX_autoStateChangeAloneDescEnabled',
        'generalSettings',
        'autoStateChangeAloneDescEnabled',
        'bool',
        false
    ),
    watched('VRCX_autoStateChangeAloneDesc', 'generalSettings', 'autoStateChangeAloneDesc', 'string', ''),
    watched(
        'VRCX_autoStateChangeCompanyDescEnabled',
        'generalSettings',
        'autoStateChangeCompanyDescEnabled',
        'bool',
        false
    ),
    watched('VRCX_autoStateChangeCompanyDesc', 'generalSettings', 'autoStateChangeCompanyDesc', 'string', ''),
    watched('VRCX_autoStateChangeGroups', 'generalSettings', 'autoStateChangeGroups', 'json', '[]'),
    watched('VRCX_autoAcceptInviteRequests', 'generalSettings', 'autoAcceptInviteRequests', 'string', 'Off'),
    watched('VRCX_autoAcceptInviteGroups', 'generalSettings', 'autoAcceptInviteGroups', 'json', '[]'),
    watched('VRCX_recentActionCooldownEnabled', 'generalSettings', 'recentActionCooldownEnabled', 'bool', false),
    watched('VRCX_recentActionCooldownMinutes', 'generalSettings', 'recentActionCooldownMinutes', 'int', 60),
    watched('VRCX_autoDeclineFriendRequests', 'generalSettings', 'autoDeclineFriendRequests', 'bool', false),

    // stores/vrcx.js
    watched('VRCX_maxTableSize_v2', 'vrcx', 'maxTableSize', 'int', 500, (stores, value) =>
        stores.vrcx.setMaxTableSize?.(value)
    ),
    watched('VRCX_clearVRCXCacheFrequency', 'vrcx', 'clearVRCXCacheFrequency', 'int', 172800)
];

/** Writes to these keys mean a client has (re)established the VRChat session. */
const SIGN_IN_HINT_KEYS = new Set(['lastUserLoggedIn'].map(transformKey));

const CONFIGS_TABLE = /\bconfigs\b/i;

/**
 * @param {{ stores: object, configRepository: object,
 *           log?: (message: string, detail?: any) => void, verbose?: boolean,
 *           onSignInHint?: () => void, debounceMs?: number,
 *           setTimer?: typeof setTimeout }} options
 */
export function createConfigSync(options) {
    const {
        stores,
        configRepository,
        log = () => {},
        verbose = false,
        onSignInHint = () => {},
        debounceMs = 50,
        setTimer = setTimeout
    } = options;

    /** @type {Map<string, WatchedKey>} transformed key -> entry */
    const byKey = new Map(WATCHED_CONFIG_KEYS.map((entry) => [transformKey(entry.key), entry]));
    /** @type {Map<string, any>} transformed key -> pending timer */
    const pending = new Map();
    const stats = { observed: 0, applied: 0, ignored: 0 };

    /**
     * @param {WatchedKey} entry
     * @returns {Promise<any>}
     */
    async function readValue(entry) {
        switch (entry.type) {
            case 'bool':
                return configRepository.getBool(entry.key, entry.defaultValue);
            case 'int':
                return configRepository.getInt(entry.key, entry.defaultValue);
            case 'json': {
                const raw = await configRepository.getString(entry.key, entry.defaultValue);
                try {
                    return JSON.parse(raw);
                } catch {
                    return JSON.parse(entry.defaultValue);
                }
            }
            default:
                return configRepository.getString(entry.key, entry.defaultValue);
        }
    }

    /**
     * @param {WatchedKey} entry
     */
    async function apply(entry) {
        const store = stores[entry.store];
        if (!store) {
            return;
        }
        try {
            const value = await readValue(entry);
            store[entry.prop] = value;
            entry.after?.(stores, value);
            stats.applied++;
            log(`Setting ${entry.key} -> ${JSON.stringify(value)} (changed from a client)`);
        } catch (err) {
            log(`Failed to re-read setting ${entry.key}`, err);
        }
    }

    return {
        /**
         * Called for every `SQLite.ExecuteNonQuery` a client issues.
         *
         * @param {string} sql
         * @param {Map<string, any> | Record<string, any> | null} args
         */
        observe(sql, args) {
            if (typeof sql !== 'string' || !CONFIGS_TABLE.test(sql)) {
                return;
            }
            const key = args instanceof Map ? args.get('@key') : args?.['@key'];
            if (typeof key !== 'string') {
                return;
            }
            stats.observed++;
            if (SIGN_IN_HINT_KEYS.has(key)) {
                onSignInHint();
                return;
            }
            const entry = byKey.get(key);
            if (!entry) {
                stats.ignored++;
                if (verbose) {
                    log(`Setting ${key} written by a client; not mirrored on the Hub`);
                }
                return;
            }
            if (pending.has(key)) {
                return;
            }
            const timer = setTimer(() => {
                pending.delete(key);
                apply(entry).catch(() => {});
            }, debounceMs);
            timer?.unref?.();
            pending.set(key, timer);
        },

        /** For the status page: the settings that gate what the Hub writes. */
        effective() {
            const result = {};
            for (const entry of WATCHED_CONFIG_KEYS) {
                const store = stores[entry.store];
                if (store) {
                    result[entry.key] = store[entry.prop];
                }
            }
            return result;
        },

        stats
    };
}
