/**
 * [hub] Cross-client coalescing for outbound VRChat GET requests.
 *
 * Every mirror client runs its own copy of `stores/updateLoop.js` and its own
 * `handlePipeline`, so a pipeline event like `group-role-updated` makes *each*
 * connected client fetch the same group. They all share one VRChat session, so
 * without this the account takes N times the request volume and starts seeing
 * 429s.
 *
 * `services/request.js` already dedupes in-flight GETs, but only within a
 * single client. This is the same idea one level up.
 *
 * In-flight coalescing is always on and is always safe: callers that ask for
 * the same URL at the same instant genuinely cannot tell the difference. The
 * short response cache is a separate, riskier thing (it can serve a client a
 * result from just before its own write) so it is **off by default** and only
 * worth enabling if 429s actually show up in practice.
 */

/** Requests that must never be shared or cached between clients. */
const NEVER_SHARED = ['/auth/user', 'auth/user', '/auth', 'auth'];

/**
 * @param {any} options
 * @returns {boolean}
 */
function isCoalescableGet(options) {
    if (!options || typeof options !== 'object' || typeof options.url !== 'string') {
        return false;
    }
    const method = (options.method ?? 'GET').toUpperCase();
    if (method !== 'GET') {
        return false;
    }
    // Auth responses are session-establishing and may carry 2FA state.
    return !NEVER_SHARED.some((suffix) => options.url.endsWith(suffix));
}

/**
 * Wraps an interop handler so identical concurrent `WebApi` GETs share one
 * upstream request.
 *
 * @param {(className: string, method: string, args: any[]) => Promise<any>} handler
 * @param {{ ttlMs?: number, now?: () => number }} [options]
 * @returns {((className: string, method: string, args: any[]) => Promise<any>) & { stats: object }}
 */
export function withRequestCoalescing(handler, options = {}) {
    const { ttlMs = 0, now = () => Date.now() } = options;

    /** @type {Map<string, Promise<any>>} */
    const inFlight = new Map();
    /** @type {Map<string, {at: number, value: any}>} */
    const cache = new Map();

    const stats = { calls: 0, coalesced: 0, cacheHits: 0 };

    const wrapped = async function handleCall(className, method, args = []) {
        const isHttp = className === 'WebApi' && (method === 'Execute' || method === 'ExecuteJson');
        const requestOptions = isHttp && typeof args[0] === 'string' ? safeParse(args[0]) : args[0];

        if (!isHttp || !isCoalescableGet(requestOptions)) {
            return handler(className, method, args);
        }

        stats.calls++;
        const key = requestOptions.url;

        if (ttlMs > 0) {
            const cached = cache.get(key);
            if (cached && now() - cached.at < ttlMs) {
                stats.cacheHits++;
                return cached.value;
            }
        }

        const pending = inFlight.get(key);
        if (pending) {
            stats.coalesced++;
            return pending;
        }

        const promise = handler(className, method, args)
            .then((value) => {
                if (ttlMs > 0) {
                    cache.set(key, { at: now(), value });
                }
                return value;
            })
            .finally(() => {
                inFlight.delete(key);
            });

        inFlight.set(key, promise);
        return promise;
    };

    wrapped.stats = stats;
    return wrapped;
}

/**
 * @param {string} json
 * @returns {any}
 */
function safeParse(json) {
    try {
        return JSON.parse(json);
    } catch {
        return null;
    }
}
