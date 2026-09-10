/**
 * [hub] A setting changed from a client reaches the Hub's stores without a
 * restart.
 */

import { transformKey } from '../../services/config.js';
import { createConfigSync, WATCHED_CONFIG_KEYS } from '../server/configSync.js';
import { mountHubCore } from '../bootstrap/core.js';

/**
 * A configRepository backed by a Map, so the sync can be driven without SQLite.
 */
function fakeConfigRepository(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        values,
        async getString(key, defaultValue = null) {
            return values.has(key) ? values.get(key) : defaultValue;
        },
        async getBool(key, defaultValue = null) {
            return values.has(key) ? values.get(key) === 'true' : defaultValue;
        },
        async getInt(key, defaultValue = null) {
            if (!values.has(key)) {
                return defaultValue;
            }
            const parsed = parseInt(values.get(key), 10);
            return Number.isNaN(parsed) ? defaultValue : parsed;
        }
    };
}

/** Runs debounce callbacks immediately. */
const immediate = (fn) => {
    fn();
    return null;
};

/**
 * What `services/config.js#setString` sends over the wire for a key.
 */
function write(key, value) {
    return [
        'INSERT OR REPLACE INTO configs (key, value) VALUES (@key, @value)',
        { '@key': transformKey(key), '@value': value }
    ];
}

describe('watched keys', () => {
    it('name fields that exist on the real stores', () => {
        // The stores call useI18n() at setup, so they only construct inside
        // a mounted app; the Hub's own boot is the cheapest way to get one.
        const { app, stores } = mountHubCore();
        try {
            const missing = WATCHED_CONFIG_KEYS.filter(
                (entry) => !stores[entry.store] || !(entry.prop in stores[entry.store])
            );
            expect(missing.map((entry) => `${entry.store}.${entry.prop}`)).toEqual([]);
        } finally {
            app.unmount();
        }
    });
});

describe('config sync', () => {
    it('re-reads a watched key and assigns it onto the store', async () => {
        const configRepository = fakeConfigRepository();
        const stores = { advancedSettings: { gameLogDisabled: false }, generalSettings: {}, vrcx: {} };
        const sync = createConfigSync({ stores, configRepository, setTimer: immediate });

        configRepository.values.set('VRCX_gameLogDisabled', 'true');
        sync.observe(...write('VRCX_gameLogDisabled', 'true'));
        await vi.waitFor(() => expect(stores.advancedSettings.gameLogDisabled).toBe(true));
        expect(sync.stats.applied).toBe(1);
    });

    it('parses each type the way the stores do', async () => {
        const configRepository = fakeConfigRepository({
            VRCX_autoStateChangeInstanceTypes: '["public","friends"]',
            VRCX_recentActionCooldownMinutes: '15',
            VRCX_autoStateChangeAloneStatus: 'active'
        });
        const stores = { advancedSettings: {}, generalSettings: {}, vrcx: {} };
        const sync = createConfigSync({ stores, configRepository, setTimer: immediate });

        sync.observe(...write('VRCX_autoStateChangeInstanceTypes', 'x'));
        sync.observe(...write('VRCX_recentActionCooldownMinutes', 'x'));
        sync.observe(...write('VRCX_autoStateChangeAloneStatus', 'x'));
        await vi.waitFor(() => expect(sync.stats.applied).toBe(3));
        expect(stores.generalSettings.autoStateChangeInstanceTypes).toEqual(['public', 'friends']);
        expect(stores.generalSettings.recentActionCooldownMinutes).toBe(15);
        expect(stores.generalSettings.autoStateChangeAloneStatus).toBe('active');
    });

    it('falls back to the default when a row is deleted', async () => {
        const configRepository = fakeConfigRepository();
        const stores = { advancedSettings: {}, generalSettings: { logEmptyAvatars: true }, vrcx: {} };
        const sync = createConfigSync({ stores, configRepository, setTimer: immediate });

        sync.observe('DELETE FROM configs WHERE key = @key', new Map([['@key', transformKey('VRCX_logEmptyAvatars')]]));
        await vi.waitFor(() => expect(stores.generalSettings.logEmptyAvatars).toBe(false));
    });

    it('runs the side effect a store init would', async () => {
        const configRepository = fakeConfigRepository({ VRCX_maxTableSize_v2: '1000' });
        const applied = [];
        const stores = { advancedSettings: {}, generalSettings: {}, vrcx: { setMaxTableSize: (v) => applied.push(v) } };
        const sync = createConfigSync({ stores, configRepository, setTimer: immediate });
        sync.observe(...write('VRCX_maxTableSize_v2', '1000'));
        await vi.waitFor(() => expect(applied).toEqual([1000]));
        expect(stores.vrcx.maxTableSize).toBe(1000);
    });

    it('ignores statements that are not about configs, and keys it does not watch', async () => {
        const configRepository = fakeConfigRepository();
        const stores = { advancedSettings: {}, generalSettings: {}, vrcx: {} };
        const sync = createConfigSync({ stores, configRepository, setTimer: immediate });
        sync.observe('INSERT INTO feed VALUES (@key)', { '@key': 'config:vrcx_gamelogdisabled' });
        sync.observe(...write('VRCX_LocationX', '10'));
        sync.observe('VACUUM', null);
        expect(sync.stats.observed).toBe(1);
        expect(sync.stats.ignored).toBe(1);
        expect(sync.stats.applied).toBe(0);
    });

    it('wakes the sign-in retry when a client records who signed in', () => {
        const configRepository = fakeConfigRepository();
        let woken = 0;
        const sync = createConfigSync({
            stores: {},
            configRepository,
            onSignInHint: () => woken++,
            setTimer: immediate
        });
        sync.observe(...write('lastUserLoggedIn', 'usr_1'));
        expect(woken).toBe(1);
    });

    it('lists the effective values for the status page', () => {
        const stores = { advancedSettings: { gameLogDisabled: true }, generalSettings: {}, vrcx: {} };
        const sync = createConfigSync({ stores, configRepository: fakeConfigRepository() });
        expect(sync.effective().VRCX_gameLogDisabled).toBe(true);
    });
});
