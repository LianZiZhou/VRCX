/**
 * [hub] Keeps the Hub's console output to one line per event.
 *
 * The data core logs the way a browser console expects: `console.log('x',
 * object)`, where the object shows collapsed until someone clicks it. Node
 * expands the same object across dozens of lines instead -- a single
 * notification ran to forty -- and a Hub runs for weeks, usually with its
 * output redirected to a file on tmpfs, which is RAM on a Raspberry Pi. One
 * line per event also keeps the log greppable.
 */

import { format, inspect } from 'node:util';

/**
 * Print objects on a single line, two levels deep. Applies to every
 * `console.*` call in the process, upstream's included.
 *
 * @param {object} [options] - the inspect defaults to change (for tests)
 */
export function compactConsoleOutput(options = inspect.defaultOptions) {
    options.breakLength = Infinity;
    options.depth = 2;
}

/**
 * @param {Date} date
 * @returns {string} local time, `YYYY-MM-DD HH:MM:SS`
 */
export function formatTimestamp(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    );
}

/**
 * Prefix every console line with the local time. Without it a log that runs
 * for weeks cannot be lined up against a client's log or against when
 * something was noticed, which is what diagnosing a session that keeps dying
 * needed most.
 *
 * @param {Console} [target]
 * @param {() => Date} [now]
 */
export function stampConsoleOutput(target = console, now = () => new Date()) {
    for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
        const original = target[method].bind(target);
        target[method] = (...args) => original(`${formatTimestamp(now())} ${format(...args)}`);
    }
}

/**
 * What to log for an unhandled rejection. A failed VRChat request already got
 * its own line from services/request.js (the error toast); repeating it with a
 * full stack added nothing but length, so it is reduced to status and
 * endpoint. Anything else is logged whole, stack and all.
 *
 * @param {unknown} reason
 * @returns {unknown}
 */
export function describeRejection(reason) {
    if (
        reason instanceof Error &&
        typeof (/** @type {any} */ (reason).status) === 'number' &&
        typeof (/** @type {any} */ (reason).endpoint) === 'string'
    ) {
        const { status, endpoint } = /** @type {any} */ (reason);
        return `request failed: ${status} ${endpoint}`;
    }
    return reason;
}
