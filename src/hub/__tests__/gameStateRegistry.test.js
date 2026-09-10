/**
 * [hub] The Hub's game state is the OR over its clients, and a client that
 * drops off the link keeps its say for a grace period.
 */

import { createGameStateRegistry } from '../server/gameStateRegistry.js';

/**
 * Timers under test control.
 */
function fakeTimers() {
    let now = 1000;
    let nextId = 1;
    const pending = new Map();
    return {
        now: () => now,
        setTimer: (fn, ms) => {
            const id = nextId++;
            pending.set(id, { at: now + ms, fn });
            return id;
        },
        clearTimer: (id) => pending.delete(id),
        advance(ms) {
            now += ms;
            for (const [id, timer] of [...pending.entries()].sort((a, b) => a[1].at - b[1].at)) {
                if (timer.at <= now) {
                    pending.delete(id);
                    timer.fn();
                }
            }
        },
        get pendingCount() {
            return pending.size;
        }
    };
}

const running = { isGameRunning: true, isSteamVRRunning: false };
const stopped = { isGameRunning: false, isSteamVRRunning: false };

describe('game state registry', () => {
    let timers;
    let registry;
    let changes;

    beforeEach(() => {
        timers = fakeTimers();
        registry = createGameStateRegistry({ graceMs: 90000, ...timers });
        changes = [];
        registry.onChange((state) => changes.push(state));
    });

    it('starts stopped and reports only real changes', () => {
        expect(registry.aggregate()).toEqual(stopped);
        registry.attach('a', 'desk');
        registry.report('a', stopped);
        expect(changes).toEqual([]);
        registry.report('a', running);
        registry.report('a', running);
        expect(changes).toEqual([running]);
    });

    it("is the OR over every client, so a second machine cannot end the first one's session", () => {
        registry.attach('a');
        registry.attach('b');
        registry.report('a', running);
        registry.report('b', stopped);
        expect(registry.aggregate()).toEqual(running);
        registry.report('b', { isGameRunning: false, isSteamVRRunning: true });
        expect(registry.aggregate()).toEqual({ isGameRunning: true, isSteamVRRunning: true });
        registry.report('a', stopped);
        expect(registry.aggregate()).toEqual({ isGameRunning: false, isSteamVRRunning: true });
        expect(changes).toEqual([
            running,
            { isGameRunning: true, isSteamVRRunning: true },
            { isGameRunning: false, isSteamVRRunning: true }
        ]);
    });

    it("keeps a detached client's state through the grace period", () => {
        registry.attach('a');
        registry.report('a', running);
        registry.detach('a');
        expect(registry.aggregate()).toEqual(running);
        timers.advance(89999);
        expect(registry.aggregate()).toEqual(running);
        expect(changes).toEqual([running]);
        timers.advance(1);
        expect(registry.aggregate()).toEqual(stopped);
        expect(changes).toEqual([running, stopped]);
        expect(registry.size).toBe(0);
    });

    it('cancels the grace period when the same client comes back', () => {
        registry.attach('a');
        registry.report('a', running);
        registry.detach('a');
        timers.advance(60000);
        registry.attach('a');
        timers.advance(60000);
        expect(registry.aggregate()).toEqual(running);
        expect(timers.pendingCount).toBe(0);
        expect(changes).toEqual([running]);
    });

    it('describes every client for the status page', () => {
        registry.attach('a', 'desk');
        registry.report('a', running, 'desk');
        registry.attach('b', 'laptop');
        registry.detach('b');
        const snapshot = registry.snapshot();
        expect(snapshot).toEqual([
            expect.objectContaining({
                clientId: 'a',
                clientName: 'desk',
                attached: true,
                reported: true,
                isGameRunning: true
            }),
            expect.objectContaining({
                clientId: 'b',
                clientName: 'laptop',
                attached: false,
                reported: false,
                isGameRunning: false
            })
        ]);
    });

    it('drops everything on dispose', () => {
        registry.attach('a');
        registry.report('a', running);
        registry.detach('a');
        registry.dispose();
        expect(registry.size).toBe(0);
        expect(timers.pendingCount).toBe(0);
    });
});
