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

import { inspect } from 'node:util';

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
