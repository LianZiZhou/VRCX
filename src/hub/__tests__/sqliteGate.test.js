/**
 * [hub] One SQLite connection, many writers: a transaction belongs to whoever
 * began it until they end it.
 */

import { classifyStatement, createSqliteGate } from '../server/sqliteGate.js';

/**
 * A native binding that records statements in the order they reached it.
 */
function createFakeNative() {
    const statements = [];
    return {
        statements,
        async ExecuteJson(sql) {
            statements.push(sql);
            return '[]';
        },
        async ExecuteNonQuery(sql) {
            statements.push(sql);
            return 1;
        },
        Init() {
            return 'init';
        },
        readOnlyValue: 42
    };
}

/** Let every pending microtask and immediate run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('statement classification', () => {
    it('recognises the transaction keywords and nothing else', () => {
        expect(classifyStatement('BEGIN')).toBe('begin');
        expect(classifyStatement('  begin transaction')).toBe('begin');
        expect(classifyStatement('COMMIT')).toBe('end');
        expect(classifyStatement('rollback')).toBe('end');
        expect(classifyStatement('END TRANSACTION')).toBe('end');
        expect(classifyStatement('SELECT 1')).toBe('other');
        expect(classifyStatement('INSERT INTO beginnings VALUES (1)')).toBe('other');
        expect(classifyStatement(undefined)).toBe('other');
    });
});

describe('sqlite gate', () => {
    it('reads other members through to the native binding', () => {
        const native = createFakeNative();
        const gate = createSqliteGate(native);
        const view = gate.forOwner('hub');
        expect(view.Init()).toBe('init');
        expect(view.readOnlyValue).toBe(42);
        expect('ExecuteJson' in view).toBe(true);
    });

    it('lets single statements from different owners interleave freely', async () => {
        const native = createFakeNative();
        const gate = createSqliteGate(native);
        const a = gate.forOwner('a');
        const b = gate.forOwner('b');
        await Promise.all([a.ExecuteJson('SELECT 1'), b.ExecuteNonQuery('INSERT 1'), a.ExecuteJson('SELECT 2')]);
        expect(native.statements).toEqual(['SELECT 1', 'INSERT 1', 'SELECT 2']);
        expect(gate.stats.waits).toBe(0);
    });

    it("holds everyone else's statements until the transaction ends", async () => {
        const native = createFakeNative();
        const gate = createSqliteGate(native);
        const a = gate.forOwner('a');
        const b = gate.forOwner('b');
        const hub = gate.forOwner('hub');

        await a.ExecuteNonQuery('BEGIN');
        expect(gate.holder).toBe('a');

        const others = [b.ExecuteNonQuery('DELETE FROM t'), hub.ExecuteJson('SELECT * FROM t')];
        await settle();
        // B and the Hub are waiting; A's own statements keep flowing.
        await a.ExecuteNonQuery('INSERT INTO t VALUES (1)');
        expect(native.statements).toEqual(['BEGIN', 'INSERT INTO t VALUES (1)']);

        await a.ExecuteNonQuery('COMMIT');
        await Promise.all(others);
        expect(native.statements).toEqual([
            'BEGIN',
            'INSERT INTO t VALUES (1)',
            'COMMIT',
            'DELETE FROM t',
            'SELECT * FROM t'
        ]);
        expect(gate.holder).toBeNull();
        expect(gate.stats.waits).toBe(2);
    });

    it('serialises two transactions instead of interleaving them', async () => {
        const native = createFakeNative();
        const gate = createSqliteGate(native);
        const a = gate.forOwner('a');
        const b = gate.forOwner('b');

        const first = (async () => {
            await a.ExecuteNonQuery('BEGIN');
            await settle();
            await a.ExecuteNonQuery('DELETE FROM s WHERE user = a');
            await settle();
            await a.ExecuteNonQuery('INSERT INTO s VALUES (a)');
            await a.ExecuteNonQuery('COMMIT');
        })();
        const second = (async () => {
            await b.ExecuteNonQuery('BEGIN');
            await b.ExecuteNonQuery('DELETE FROM s WHERE user = b');
            await b.ExecuteNonQuery('ROLLBACK');
        })();
        await Promise.all([first, second]);

        expect(native.statements).toEqual([
            'BEGIN',
            'DELETE FROM s WHERE user = a',
            'INSERT INTO s VALUES (a)',
            'COMMIT',
            'BEGIN',
            'DELETE FROM s WHERE user = b',
            'ROLLBACK'
        ]);
        expect(gate.stats.leases).toBe(2);
    });

    it('releases the lease when BEGIN itself fails', async () => {
        const native = createFakeNative();
        native.ExecuteNonQuery = async (sql) => {
            if (sql === 'BEGIN') {
                throw new Error('cannot start a transaction within a transaction');
            }
            native.statements.push(sql);
            return 1;
        };
        const gate = createSqliteGate(native);
        await expect(gate.forOwner('a').ExecuteNonQuery('BEGIN')).rejects.toThrow(/within a transaction/);
        expect(gate.holder).toBeNull();
    });

    it('rolls back a lease nobody released', async () => {
        const native = createFakeNative();
        let fire;
        const gate = createSqliteGate(native, {
            leaseTimeoutMs: 1,
            setTimer: (fn) => {
                fire = fn;
                return 1;
            },
            clearTimer: () => {},
            log: () => {}
        });
        const a = gate.forOwner('a');
        const b = gate.forOwner('b');
        await a.ExecuteNonQuery('BEGIN');
        const blocked = b.ExecuteNonQuery('SELECT 1');
        await settle();
        expect(native.statements).toEqual(['BEGIN']);

        await fire();
        await blocked;
        expect(native.statements).toEqual(['BEGIN', 'ROLLBACK', 'SELECT 1']);
        expect(gate.stats.forcedRollbacks).toBe(1);
        expect(gate.holder).toBeNull();
    });
});
