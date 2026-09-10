/**
 * [hub] Per-client game state, and the one value the Hub derives from it.
 *
 * Whether VRChat is running is a fact about a machine. The Hub has no machine
 * of its own, so its `isGameRunning` -- which opens and closes the session the
 * activity views are built on, gates the game log handlers, and decides
 * whether Photon events are processed -- is the OR over every attached
 * client. An earlier design kept a single "reporter" and let any client's
 * `false` overwrite it, so a laptop opening VRCX ended the desktop's session
 * on the Hub, and nothing re-opened it.
 *
 * Entries are keyed by the client's stable `clientId`, not by socket. A link
 * blip closes the socket; the client reconnects with the same id a few seconds
 * later. Dropping its state on the close would have the Hub record a full
 * session end (`runLastLocationResetFlow` writes an `OnPlayerLeft` for every
 * player in the instance) for what was a Wi-Fi hiccup. So a detached entry is
 * kept for a grace period and only then removed.
 *
 * Pure module: no sockets, no stores, injectable timers and clock.
 */

/** How long a detached client's game state survives before it is dropped. */
export const DEFAULT_GRACE_MS = 90000;

/**
 * @typedef {{ isGameRunning: boolean, isSteamVRRunning: boolean }} GameState
 */

/**
 * @param {GameState | null | undefined} state
 * @returns {GameState}
 */
export function normaliseGameState(state) {
    return {
        isGameRunning: Boolean(state?.isGameRunning),
        isSteamVRRunning: Boolean(state?.isSteamVRRunning)
    };
}

/**
 * @param {GameState} a
 * @param {GameState} b
 * @returns {boolean}
 */
export function sameGameState(a, b) {
    return a.isGameRunning === b.isGameRunning && a.isSteamVRRunning === b.isSteamVRRunning;
}

/**
 * @param {{ graceMs?: number, now?: () => number,
 *           setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} [options]
 */
export function createGameStateRegistry(options = {}) {
    const { graceMs = DEFAULT_GRACE_MS, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = options;

    /**
     * @type {Map<string, { clientName: string, attached: boolean, reported: boolean,
     *                      state: GameState, updatedAt: number, attachedAt: number, graceTimer: any }>}
     */
    const entries = new Map();
    /** @type {Set<(state: GameState) => void>} */
    const listeners = new Set();
    let last = normaliseGameState(null);

    /** @returns {GameState} */
    function aggregate() {
        let isGameRunning = false;
        let isSteamVRRunning = false;
        for (const entry of entries.values()) {
            isGameRunning ||= entry.state.isGameRunning;
            isSteamVRRunning ||= entry.state.isSteamVRRunning;
        }
        return { isGameRunning, isSteamVRRunning };
    }

    function notifyIfChanged() {
        const next = aggregate();
        if (sameGameState(next, last)) {
            return;
        }
        last = next;
        for (const listener of listeners) {
            try {
                listener(next);
            } catch (err) {
                console.error('[hub] Game state listener failed:', err);
            }
        }
    }

    /**
     * @param {string} clientId
     * @param {string} [clientName]
     */
    function ensure(clientId, clientName) {
        let entry = entries.get(clientId);
        if (!entry) {
            entry = {
                clientName: clientName ?? 'unknown',
                attached: false,
                reported: false,
                state: normaliseGameState(null),
                updatedAt: 0,
                attachedAt: 0,
                graceTimer: null
            };
            entries.set(clientId, entry);
        } else if (clientName) {
            entry.clientName = clientName;
        }
        return entry;
    }

    function cancelGrace(entry) {
        if (entry.graceTimer) {
            clearTimer(entry.graceTimer);
            entry.graceTimer = null;
        }
    }

    return {
        /**
         * A client completed the handshake. Cancels any grace period a
         * previous socket of the same client started.
         *
         * @param {string} clientId
         * @param {string} [clientName]
         */
        attach(clientId, clientName) {
            const entry = ensure(clientId, clientName);
            cancelGrace(entry);
            entry.attached = true;
            entry.attachedAt = now();
        },

        /**
         * @param {string} clientId
         * @param {GameState} state
         * @param {string} [clientName]
         */
        report(clientId, state, clientName) {
            const entry = ensure(clientId, clientName);
            entry.state = normaliseGameState(state);
            entry.reported = true;
            entry.updatedAt = now();
            notifyIfChanged();
        },

        /**
         * A client's socket closed. Its state is kept for the grace period.
         *
         * @param {string} clientId
         */
        detach(clientId) {
            const entry = entries.get(clientId);
            if (!entry) {
                return;
            }
            entry.attached = false;
            cancelGrace(entry);
            entry.graceTimer = setTimer(() => {
                entry.graceTimer = null;
                if (!entry.attached) {
                    entries.delete(clientId);
                    notifyIfChanged();
                }
            }, graceMs);
            entry.graceTimer?.unref?.();
        },

        /** @returns {GameState} */
        aggregate,

        /**
         * @param {(state: GameState) => void} listener - called only when the aggregate changes
         * @returns {() => void} unsubscribe
         */
        onChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },

        /** For the status page. */
        snapshot() {
            return [...entries.entries()].map(([clientId, entry]) => ({
                clientId,
                clientName: entry.clientName,
                attached: entry.attached,
                reported: entry.reported,
                isGameRunning: entry.state.isGameRunning,
                isSteamVRRunning: entry.state.isSteamVRRunning,
                updatedAt: entry.updatedAt,
                attachedAt: entry.attachedAt
            }));
        },

        /** @returns {number} */
        get size() {
            return entries.size;
        },

        dispose() {
            for (const entry of entries.values()) {
                cancelGrace(entry);
            }
            entries.clear();
            listeners.clear();
        }
    };
}
