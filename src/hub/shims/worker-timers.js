/**
 * [hub] Node replacement for the `worker-timers` package.
 *
 * `worker-timers` builds its timer worker with
 * `new Worker(URL.createObjectURL(new Blob([...])))`, and Node has no global
 * `Worker`. Since 29 modules across the data core import it, the headless Hub
 * aliases the package to this module and gets plain timers instead.
 *
 * Node timers are not throttled the way background-tab timers are, which is
 * the only reason VRCX reaches for worker-timers in the first place.
 */

/**
 * Timers are unref'd so they never, on their own, keep the process alive. The
 * Hub should stay up because it is listening on a socket, and should exit once
 * those sockets close -- not because `updateLoop` has scheduled its next tick.
 *
 * @param {any} handle
 * @returns {any}
 */
function detach(handle) {
    handle?.unref?.();
    return handle;
}

export const setTimeout = (fn, ms, ...args) => detach(globalThis.setTimeout(fn, ms, ...args));
export const setInterval = (fn, ms, ...args) => detach(globalThis.setInterval(fn, ms, ...args));
export const clearTimeout = globalThis.clearTimeout.bind(globalThis);
export const clearInterval = globalThis.clearInterval.bind(globalThis);

export default { setTimeout, clearTimeout, setInterval, clearInterval };
