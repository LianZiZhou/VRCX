/**
 * [hub] The boot spike.
 *
 * This is the load-bearing test for the whole headless-Hub architecture: it
 * proves that VRCX's Pinia store graph — all 40 stores, their coordinators and
 * the database layer — can be constructed in a plain Node process with only a
 * happy-dom shim and the module aliases in `vitest.hub.config.js`.
 *
 * If this goes red, the Hub cannot run the upstream `src/` code as-is and the
 * fallback (headless Electron under xvfb) becomes necessary.
 *
 * It exercises the real production boot (`bootstrap/core.js`), not a copy, so
 * it doubles as the regression guard: when upstream adds a store that reaches
 * for a browser API the shim does not cover, this is what catches it.
 */

import { startHubCore } from '../bootstrap/core.js';
import { i18n } from '../../plugins/i18n';

describe('headless Hub boot', () => {
    let app = null;
    let stores = null;
    let bootError = null;

    beforeAll(async () => {
        try {
            ({ app, stores } = await startHubCore());
        } catch (err) {
            bootError = err;
        }
    });

    afterAll(() => {
        app?.unmount();
    });

    it('boots the data core without throwing', () => {
        if (bootError) {
            throw bootError;
        }
        expect(stores).toBeTruthy();
    });

    it('constructs every store', () => {
        expect(bootError).toBeNull();
        // 40 stores as of the current upstream; assert a floor rather than an
        // exact count so an upstream addition does not fail the spike.
        expect(Object.keys(stores).length).toBeGreaterThanOrEqual(40);
        for (const [name, store] of Object.entries(stores)) {
            expect(store, `store "${name}" is not constructed`).toBeTruthy();
        }
    });

    it('exposes the stores the Hub actually drives', () => {
        expect(bootError).toBeNull();
        for (const name of [
            'auth',
            'user',
            'friend',
            'feed',
            'gameLog',
            'notification',
            'instance',
            'location',
            'updateLoop',
            'vrcx'
        ]) {
            expect(stores[name], `store "${name}" missing`).toBeTruthy();
        }
    });

    it('wires the App.vue bridge assignments', () => {
        expect(bootError).toBeNull();
        expect(typeof stores.gameLog.addGameLogEvent).toBe('function');
        expect(typeof stores.game.updateIsGameRunning).toBe('function');
        expect(typeof stores.game.updateIsHmdAfk).toBe('function');
    });

    it('loads real i18n messages rather than passing keys through', () => {
        expect(bootError).toBeNull();
        const key = 'view.login.savedAccounts';
        expect(i18n.global.t(key)).toBe('Saved Accounts');
    });

    it('runs on plain Node timers, not worker-timers', async () => {
        const timers = await import('../shims/worker-timers.js');
        await new Promise((resolve) => timers.setTimeout(resolve, 1));
        const handle = timers.setInterval(() => {}, 1000);
        timers.clearInterval(handle);
        expect(typeof timers.setTimeout).toBe('function');
    });
});
