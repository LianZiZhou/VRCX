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
    ALLOWED_ON_MIRROR,
    CONDITIONAL_WRITES,
    DERIVED_WRITES,
    isSuppressedOnMirror,
    mirrorSuppressedMethods,
    PERSISTED_ENTRIES_WRITES,
    PERSISTED_ENTRY_WRITES,
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
        const missing = [...mirrorSuppressedMethods(), ...ALLOWED_ON_MIRROR].filter(
            (name) => typeof database[name] !== 'function'
        );
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
            'clearAvatarHistory'
        ]) {
            expect(suppressed.has(name), `"${name}" is user-initiated and must not be suppressed`).toBe(false);
            expect(typeof database[name]).toBe('function');
        }
    });

    it('separates derived, allowed and schema writes', () => {
        // The read-modify-write counter: if both the Hub and a client ran it,
        // avatar time would double-count.
        expect(DERIVED_WRITES.has('addAvatarTimeSpent')).toBe(true);
        // INSERT OR REPLACE, and written together with a user's local
        // favourite: suppressing it left favourites without names.
        expect(ALLOWED_ON_MIRROR.has('addAvatarToCache')).toBe(true);
        expect(DERIVED_WRITES.has('addAvatarToCache')).toBe(false);
        // Migrations on a shared single-connection DB.
        expect(SCHEMA_WRITES.has('upgradeDatabaseVersion')).toBe(true);
        // The user's purge-and-compact must actually compact.
        expect(SCHEMA_WRITES.has('vacuum')).toBe(false);
        expect(ALLOWED_ON_MIRROR.has('vacuum')).toBe(true);
        // Photon-derived: only stores/photon.js writes these, and Photon
        // reaches the Hub through the client uplink.
        expect(DERIVED_WRITES.has('setModeration')).toBe(true);
        // The bio diff's cache: only the Hub may move it, or the Hub would
        // compare against a bio a mirror already stored and miss the change.
        expect(DERIVED_WRITES.has('setUserProfile')).toBe(true);
        expect(mirrorSuppressedMethods().has('getUserProfile')).toBe(false);
    });

    it('knows which suppressed inserts their callers expect an entry back from', () => {
        for (const name of [...PERSISTED_ENTRY_WRITES, ...PERSISTED_ENTRIES_WRITES]) {
            expect(DERIVED_WRITES.has(name), `${name} is answered with an entry, so it must be suppressed`).toBe(true);
        }
        // Tripwire for an upstream change of shape: these resolve to
        // `{ ...entry, rowId }` today, which is what the guard imitates.
        for (const name of PERSISTED_ENTRY_WRITES) {
            expect(database[name].toString(), `${name} no longer returns { ...entry, rowId }`).toMatch(
                /return rowId \? \{ \.\.\.entry, rowId \} : undefined/
            );
        }
        // And every insert that does return one is listed.
        const returningEntries = Object.keys(database).filter(
            (name) => typeof database[name] === 'function' && /\{ \.\.\.entry, rowId \}/.test(database[name].toString())
        );
        expect(returningEntries.filter((name) => !PERSISTED_ENTRY_WRITES.has(name))).toEqual([]);
    });

    it('tells a friend request the user sent from a friendship the pipeline reported', () => {
        expect(Object.keys(CONDITIONAL_WRITES)).toEqual(['addFriendLogHistory']);
        expect(isSuppressedOnMirror('addFriendLogHistory', [{ type: 'FriendRequest' }])).toBe(false);
        expect(isSuppressedOnMirror('addFriendLogHistory', [{ type: 'CancelFriendRequest' }])).toBe(false);
        expect(isSuppressedOnMirror('addFriendLogHistory', [{ type: 'Friend' }])).toBe(true);
        expect(isSuppressedOnMirror('addFriendLogHistory', [{ type: 'Unfriend' }])).toBe(true);
        expect(isSuppressedOnMirror('addFriendLogHistory', [])).toBe(true);
        expect(isSuppressedOnMirror('addGPSToDatabase', [{}])).toBe(true);
        expect(isSuppressedOnMirror('setFriendLogCurrent', [{}])).toBe(false);
        expect(isSuppressedOnMirror('setUserMemo', ['x'])).toBe(false);
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
            },
            async addFriendLogHistory(row) {
                calls.push(['addFriendLogHistory', row]);
                return 'wrote-history';
            },
            async addWorldToCache(ref) {
                calls.push(['addWorldToCache', ref]);
                return 'cached';
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

        await expect(guarded.addGPSToDatabase({ id: 1 })).resolves.toMatchObject({ id: 1 });
        await expect(guarded.setUserMemo('hi')).resolves.toBe('wrote-memo');

        expect(fake.calls).toEqual([['setUserMemo', 'hi']]);
        expect(suppressionStats.byMethod.get('addGPSToDatabase')).toBe(1);
    });

    it('answers a suppressed insert as if it had been written', async () => {
        const guarded = guardDatabase({
            async addGPSToDatabase() {
                throw new Error('must not run on a mirror');
            },
            async addGamelogJoinLeaveBulk() {
                throw new Error('must not run on a mirror');
            }
        });
        setHubMode(HubMode.MIRROR);

        // The feed only shows what the insert hands back, keyed on rowId.
        const first = await guarded.addGPSToDatabase({ userId: 'usr_a', type: 'GPS' });
        const second = await guarded.addGPSToDatabase({ userId: 'usr_b', type: 'GPS' });
        expect(first).toMatchObject({ userId: 'usr_a', type: 'GPS' });
        expect(typeof first.rowId).toBe('number');
        expect(second.rowId).toBeGreaterThan(first.rowId);
        expect(first.rowId).toBeGreaterThan(2 ** 40);

        const bulk = await guarded.addGamelogJoinLeaveBulk([{ displayName: 'A' }, { displayName: 'B' }]);
        expect(bulk.map((entry) => entry.displayName)).toEqual(['A', 'B']);
        expect(new Set(bulk.map((entry) => entry.rowId)).size).toBe(2);
        await expect(guarded.addGamelogJoinLeaveBulk([])).resolves.toEqual([]);
    });

    it('decides conditional writes on their arguments', async () => {
        const fake = createFakeDatabase();
        const guarded = guardDatabase(fake);
        setHubMode(HubMode.MIRROR);

        await expect(guarded.addFriendLogHistory({ type: 'Friend' })).resolves.toBeUndefined();
        await expect(guarded.addFriendLogHistory({ type: 'FriendRequest' })).resolves.toBe('wrote-history');
        await expect(guarded.addWorldToCache({ id: 'wrld_1' })).resolves.toBe('cached');

        expect(fake.calls).toEqual([
            ['addFriendLogHistory', { type: 'FriendRequest' }],
            ['addWorldToCache', { id: 'wrld_1' }]
        ]);
        expect(suppressionStats.byMethod.get('addFriendLogHistory')).toBe(1);
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
