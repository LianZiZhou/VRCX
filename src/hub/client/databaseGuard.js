/**
 * [hub] Suppresses derived writes when running as a mirror client.
 *
 * Wraps the aggregate `database` object at its single export point. Two details
 * make this work, both of which were verified against the real modules:
 *
 *  - **`this` binding is preserved.** Several database modules dispatch to
 *    themselves (`tableAlter.js` fans `upgradeDatabaseVersion` out to fourteen
 *    `this.fix*()` calls; `gameLog.js` and `activityV2.js` do the same). When a
 *    method is invoked as `proxy.foo()`, `this` inside is the proxy, so
 *    `this.bar()` re-enters the trap. One entry in the suppression set
 *    therefore covers a whole fan-out.
 *  - **`dbVars` is not proxied.** Every submodule does
 *    `import { dbVars } from '../database'`, a circular edge back into the
 *    index. It stays a plain export.
 *
 * The mode is read at call time rather than at module init, because the mode is
 * decided during boot after this module has already been imported. The
 * decision itself is read at call time too: some methods are suppressed or
 * allowed depending on their arguments (`shared/derivedWrites.js`).
 */

import { isMirrorMode } from '../shared/mode.js';
import {
    isSuppressedOnMirror,
    mirrorSuppressedMethods,
    PERSISTED_ENTRIES_WRITES,
    PERSISTED_ENTRY_WRITES
} from '../shared/derivedWrites.js';

/**
 * `begin`/`commit` issue bare BEGIN/COMMIT on the shared connection. They have
 * no call sites upstream today. The transactional database modules
 * (`activityV2.js`, `mutualGraph.js`) issue their BEGIN/COMMIT through
 * `sqliteService.executeNonQuery` directly, bypassing this object; those are
 * serialised on the Hub by `server/sqliteGate.js`, one owner at a time.
 */
const TRANSACTION_METHODS = new Set(['begin', 'commit']);

/** Observability: what got suppressed, and how often. */
export const suppressionStats = {
    total: 0,
    /** @type {Map<string, number>} */
    byMethod: new Map()
};

/**
 * @param {string} method
 */
function record(method) {
    suppressionStats.total++;
    suppressionStats.byMethod.set(method, (suppressionStats.byMethod.get(method) ?? 0) + 1);
}

/**
 * Synthetic rowIds for entries a mirror did not write. Far above any real
 * SQLite rowid, so they never collide with a row loaded from the Hub's DB and
 * sort as the newest for a given timestamp.
 */
const SYNTHETIC_ROWID_BASE = 2 ** 50;
let syntheticRowIds = 0;

/**
 * @param {any} entry
 * @returns {any} the entry as the insert would have returned it
 */
function asPersisted(entry) {
    if (!entry || typeof entry !== 'object') {
        return undefined;
    }
    syntheticRowIds++;
    return { ...entry, rowId: SYNTHETIC_ROWID_BASE + syntheticRowIds };
}

/**
 * What a suppressed call resolves to: what a successful write would have, for
 * the inserts whose callers act on the result, and undefined otherwise.
 *
 * @param {string} method
 * @param {any[]} args
 * @returns {any}
 */
function suppressedResult(method, args) {
    if (PERSISTED_ENTRY_WRITES.has(method)) {
        return asPersisted(args[0]);
    }
    if (PERSISTED_ENTRIES_WRITES.has(method)) {
        return Array.isArray(args[0]) ? args[0].map(asPersisted).filter(Boolean) : [];
    }
    return undefined;
}

/**
 * @param {object} database - the raw aggregate database object
 * @returns {object} the same object in non-mirror modes, a guarded proxy otherwise
 */
export function guardDatabase(database) {
    const candidates = mirrorSuppressedMethods();

    return new Proxy(database, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (typeof value !== 'function' || typeof prop !== 'string') {
                return value;
            }
            if (!candidates.has(prop) && !TRANSACTION_METHODS.has(prop)) {
                return value;
            }
            if (!isMirrorMode()) {
                return value;
            }
            return function guardedWrite(...args) {
                if (!TRANSACTION_METHODS.has(prop) && !isSuppressedOnMirror(prop, args)) {
                    return Reflect.apply(value, this, args);
                }
                record(prop);
                // Callers `await` these; resolve rather than returning
                // undefined so a mirror client behaves like a fast success.
                return Promise.resolve(suppressedResult(prop, args));
            };
        }
    });
}
