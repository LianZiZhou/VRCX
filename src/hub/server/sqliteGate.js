/**
 * [hub] A transaction lease over the Hub's single SQLite connection.
 *
 * The C# side holds one connection behind one lock, and every statement --
 * the Hub's own and every mirror's -- lands on it. That is fine for single
 * statements: SQLite serialises them. It is not fine for `BEGIN ... COMMIT`
 * sequences issued as separate statements, which is what
 * `services/database/activityV2.js` and `mutualGraph.js` do through
 * `sqliteService.executeNonQuery('BEGIN')`. Two such sequences from two
 * processes interleave: A's `BEGIN`, B's `DELETE`, A's `COMMIT` publishing
 * B's half-done work, or B's `ROLLBACK` discarding A's inserts.
 *
 * The gate gives each *owner* (the Hub itself, or one attached client) a
 * lease: a statement that begins a transaction takes it, other owners'
 * statements wait until it is released by `COMMIT`/`ROLLBACK`/`END`, and a
 * lease that is not released in time is force-rolled-back so a crashed client
 * cannot hold the database forever.
 *
 * Statement text is inspected only for the transaction keywords; nothing else
 * is parsed.
 */

/** A lease older than this is rolled back and released. */
export const DEFAULT_LEASE_TIMEOUT_MS = 30000;

const GATED_METHODS = new Set(['Execute', 'ExecuteJson', 'ExecuteNonQuery']);

/**
 * @param {string} sql
 * @returns {'begin' | 'end' | 'other'}
 */
export function classifyStatement(sql) {
    const head = String(sql ?? '')
        .trimStart()
        .slice(0, 12)
        .toUpperCase();
    if (head.startsWith('BEGIN')) {
        return 'begin';
    }
    if (head.startsWith('COMMIT') || head.startsWith('ROLLBACK') || head.startsWith('END')) {
        return 'end';
    }
    return 'other';
}

/**
 * @param {object} native - the SQLite binding (node-api-dotnet proxy or a stub)
 * @param {{ log?: (message: string, detail?: any) => void, leaseTimeoutMs?: number,
 *           setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} [options]
 */
export function createSqliteGate(native, options = {}) {
    const {
        log = () => {},
        leaseTimeoutMs = DEFAULT_LEASE_TIMEOUT_MS,
        setTimer = setTimeout,
        clearTimer = clearTimeout
    } = options;

    /** @type {string | null} */
    let holder = null;
    /** @type {Array<() => void>} */
    let waiters = [];
    let leaseTimer = null;

    const stats = { leases: 0, waits: 0, forcedRollbacks: 0 };

    function wakeWaiters() {
        const woken = waiters;
        waiters = [];
        for (const resolve of woken) {
            resolve();
        }
    }

    function release() {
        holder = null;
        if (leaseTimer) {
            clearTimer(leaseTimer);
            leaseTimer = null;
        }
        wakeWaiters();
    }

    /**
     * @param {string} owner
     */
    function take(owner) {
        holder = owner;
        stats.leases++;
        leaseTimer = setTimer(async () => {
            leaseTimer = null;
            if (holder !== owner) {
                return;
            }
            stats.forcedRollbacks++;
            log(`Transaction held by ${owner} for ${leaseTimeoutMs} ms; rolling it back`);
            try {
                await native.ExecuteNonQuery('ROLLBACK', null);
            } catch (err) {
                log('Forced rollback failed', err);
            }
            release();
        }, leaseTimeoutMs);
        leaseTimer?.unref?.();
    }

    /**
     * @param {string} owner
     * @param {string} method
     * @param {any[]} args
     */
    async function run(owner, method, args) {
        const kind = classifyStatement(args[0]);
        // The check and the take must have no await between them: two owners
        // beginning in the same tick would otherwise both see the lease free.
        while (holder !== null && holder !== owner) {
            stats.waits++;
            await new Promise((resolve) => waiters.push(resolve));
        }
        if (kind === 'begin' && holder === null) {
            take(owner);
            try {
                return await native[method](...args);
            } catch (err) {
                release();
                throw err;
            }
        }
        if (kind === 'end' && holder === owner) {
            try {
                return await native[method](...args);
            } finally {
                release();
            }
        }
        return native[method](...args);
    }

    return {
        /**
         * The binding as seen by one owner. Members outside the three query
         * methods are read through to the native object and bound to it.
         *
         * @param {string} owner
         * @returns {object}
         */
        forOwner(owner) {
            // An empty target on purpose: the node-api-dotnet proxy exposes
            // read-only members, and a Proxy over it would be held to their
            // invariants (see server/webApiLog.js).
            return new Proxy(
                {},
                {
                    get(_, prop) {
                        if (typeof prop === 'string' && GATED_METHODS.has(prop)) {
                            return (...args) => run(owner, prop, args);
                        }
                        const value = native[prop];
                        return typeof value === 'function' ? value.bind(native) : value;
                    },
                    has(_, prop) {
                        return prop in native;
                    }
                }
            );
        },

        /** @returns {string | null} */
        get holder() {
            return holder;
        },

        stats,

        /** Test seam and shutdown: drop the lease without touching the database. */
        reset() {
            release();
        }
    };
}
