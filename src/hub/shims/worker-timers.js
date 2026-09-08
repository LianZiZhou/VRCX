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

export const setTimeout = globalThis.setTimeout.bind(globalThis);
export const clearTimeout = globalThis.clearTimeout.bind(globalThis);
export const setInterval = globalThis.setInterval.bind(globalThis);
export const clearInterval = globalThis.clearInterval.bind(globalThis);

export default { setTimeout, clearTimeout, setInterval, clearInterval };
