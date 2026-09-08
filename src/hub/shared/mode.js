/**
 * [hub] Which of the three roles this process is playing.
 *
 * Dependency-free on purpose: `src/services/database/index.js` imports this,
 * and that module sits at the bottom of the data core. Anything heavier here
 * would create import cycles.
 *
 *   standalone - today's VRCX. Everything local. Also the offline fallback.
 *   hub        - the headless Node process. Owns the DB, the VRChat session
 *                and the single pipeline socket.
 *   mirror     - a desktop client attached to a Hub. Full UI, but SQLite and
 *                WebApi are remote, it does not open its own pipeline socket,
 *                and its derived writes are suppressed.
 */

export const HubMode = {
    STANDALONE: 'standalone',
    HUB: 'hub',
    MIRROR: 'mirror'
};

let currentMode = HubMode.STANDALONE;

/**
 * @returns {string} one of `HubMode`
 */
export function getHubMode() {
    return currentMode;
}

/**
 * Set once during boot, before the store graph is constructed.
 *
 * @param {string} mode - one of `HubMode`
 */
export function setHubMode(mode) {
    if (!Object.values(HubMode).includes(mode)) {
        throw new Error(`Unknown VRCX run mode: ${mode}`);
    }
    currentMode = mode;
}

/** @returns {boolean} */
export function isMirrorMode() {
    return currentMode === HubMode.MIRROR;
}

/** @returns {boolean} */
export function isHubMode() {
    return currentMode === HubMode.HUB;
}

/**
 * True when this process owns the data: it holds the pipeline socket, runs the
 * periodic refreshes and is the only writer of derived rows.
 *
 * @returns {boolean}
 */
export function isDataOwner() {
    return currentMode !== HubMode.MIRROR;
}
