/**
 * [hub] Guards the derived-write suppression list.
 *
 * The suppression list is data, matched against the real `database` object by
 * method name. That keeps the upstream diff to three lines, but it means an
 * upstream rename would silently drop a method from the set and mirror clients
 * would quietly start double-writing rows the Hub already wrote.
 *
 * The first test here is the tripwire for exactly that.
 */

import {
    DERIVED_WRITES,
    HUB_OWNED_CACHE_WRITES,
    mirrorSuppressedMethods,
    SCHEMA_WRITES
} from '../shared/derivedWrites.js';
import { getHubMode, HubMode, setHubMode } from '../shared/mode.js';
import { database } from '../../services/database';
import { guardDatabase, suppressionStats } from '../client/databaseGuard.js';

describe('derived write list', () => {
    afterEach(() => {
        setHubMode(HubMode.STANDALONE);
    });

    it('names only methods that actually exist on the database object', () => {
        const missing = [...mirrorSuppressedMethods()].filter((name) => typeof database[name] !== 'function');
        expect(
            missing,
            `these names are in the suppression list but not on \`database\` any more, ` +
                `so mirror clients would double-write them: ${missing.join(', ')}`
        ).toEqual([]);
    });

    it('does not suppress user-initiated writes', () => {
        const suppressed = mirrorSuppressedMethods();
        // A person clicking these in the UI must still reach the Hub's DB.
        for (const name of [
            'setUserMemo',
            'deleteUserMemo',
            'setWorldMemo',
            'addUserNote',
            'deleteUserNote',
            'addAvatarTag',
            'removeAvatarTag',
            'addAvatarToFavorites',
            'removeAvatarFromFavorites',
            'addWorldToFavorites',
            'addFriendToLocalFavorites',
            'addPrintToFavorites',
            'deleteNotification',
            'deleteNotificationV2',
            'seenNotificationV2',
            'deleteFriendLogHistory',
            'setModeration',
            'clearAvatarHistory'
        ]) {
            expect(suppressed.has(name), `"${name}" is user-initiated and must not be suppressed`).toBe(false);
            expect(typeof database[name]).toBe('function');
        }
    });

    it('separates derived, cache and schema writes', () => {
        // The read-modify-write counter: if both the Hub and a client ran it,
        // avatar time would double-count.
        expect(DERIVED_WRITES.has('addAvatarTimeSpent')).toBe(true);
        // Idempotent but Hub-owned to avoid duplicate traffic.
        expect(HUB_OWNED_CACHE_WRITES.has('addAvatarToCache')).toBe(true);
        expect(DERIVED_WRITES.has('addAvatarToCache')).toBe(false);
        // Migrations plus VACUUM on a shared single-connection DB.
        expect(SCHEMA_WRITES.has('upgradeDatabaseVersion')).toBe(true);
    });
});

describe('database guard', () => {
    /**
     * A stand-in for the aggregate database object, including the intra-object
     * dispatch pattern that the real modules use.
     */
    function createFakeDatabase() {
        const calls = [];
        return {
            calls,
            async addGPSToDatabase(row) {
                calls.push(['addGPSToDatabase', row]);
                return 'wrote-gps';
            },
            async setUserMemo(memo) {
                calls.push(['setUserMemo', memo]);
                return 'wrote-memo';
            },
            async upgradeDatabaseVersion() {
                calls.push(['upgradeDatabaseVersion']);
                // Mirrors tableAlter.js, which fans out through `this`.
                await this.addGPSToDatabase('from-migration');
                return 'migrated';
            }
        };
    }

    beforeEach(() => {
        setHubMode(HubMode.STANDALONE);
        suppressionStats.total = 0;
        suppressionStats.byMethod.clear();
    });

    afterEach(() => {
        setHubMode(HubMode.STANDALONE);
    });

    it('passes everything through outside mirror mode', async () => {
        const fake = createFakeDatabase();
        const guarded = guardDatabase(fake);

        await expect(guarded.addGPSToDatabase({ id: 1 })).resolves.toBe('wrote-gps');
        await expect(guarded.setUserMemo('hi')).resolves.toBe('wrote-memo');
        expect(fake.calls).toHaveLength(2);
        expect(suppressionStats.total).toBe(0);
    });

    it('suppresses derived writes in mirror mode but keeps user writes', async () => {
        const fake = createFakeDatabase();
        const guarded = guardDatabase(fake);
        setHubMode(HubMode.MIRROR);

        await expect(guarded.addGPSToDatabase({ id: 1 })).resolves.toBeUndefined();
        await expect(guarded.setUserMemo('hi')).resolves.toBe('wrote-memo');

        expect(fake.calls).toEqual([['setUserMemo', 'hi']]);
        expect(suppressionStats.byMethod.get('addGPSToDatabase')).toBe(1);
    });

    it('covers intra-object dispatch through `this`', async () => {
        const fake = createFakeDatabase();
        const guarded = guardDatabase(fake);
        setHubMode(HubMode.MIRROR);

        // upgradeDatabaseVersion is itself suppressed, so its inner
        // this.addGPSToDatabase() never runs either.
        await expect(guarded.upgradeDatabaseVersion()).resolves.toBeUndefined();
        expect(fake.calls).toEqual([]);
    });

    it('re-enters the trap for nested calls when the outer method is allowed', async () => {
        const calls = [];
        const fake = {
            async allowedOuter() {
                calls.push('allowedOuter');
                // `this` is the proxy, so this nested call is intercepted.
                await this.addGPSToDatabase('nested');
                return 'done';
            },
            async addGPSToDatabase(row) {
                calls.push(`addGPSToDatabase:${row}`);
            }
        };
        const guarded = guardDatabase(fake);
        setHubMode(HubMode.MIRROR);

        await expect(guarded.allowedOuter()).resolves.toBe('done');
        expect(calls).toEqual(['allowedOuter']);
    });

    it('blocks bare transactions, which would lock the Hub connection', async () => {
        const calls = [];
        const guarded = guardDatabase({
            begin() {
                calls.push('begin');
            },
            commit() {
                calls.push('commit');
            }
        });
        setHubMode(HubMode.MIRROR);

        await guarded.begin();
        await guarded.commit();
        expect(calls).toEqual([]);
    });

    it('leaves non-function properties alone', () => {
        const guarded = guardDatabase({ someValue: 42, addGPSToDatabase() {} });
        setHubMode(HubMode.MIRROR);
        expect(guarded.someValue).toBe(42);
    });
});

describe('run mode', () => {
    afterEach(() => {
        setHubMode(HubMode.STANDALONE);
    });

    it('defaults to standalone', () => {
        expect(getHubMode()).toBe(HubMode.STANDALONE);
    });

    it('rejects an unknown mode rather than silently ignoring it', () => {
        expect(() => setHubMode('remote')).toThrow(/unknown vrcx run mode/i);
    });
});
