/**
 * [hub] Get the .NET side's HTTP failure reason into the Hub's own log.
 *
 * When `WebApi.ExecuteJson` cannot send a request at all it answers with
 * status -1 and the exception message. `services/webapi.js` turns that into a
 * thrown Error, and `services/request.js` then formats the Error with
 * `JSON.stringify`, which yields `{}` -- so by the time anything upstream
 * logs it, the reason is gone. Wrapping the binding here, before the data
 * core sees it, is the one place the message still exists.
 *
 * The .NET side also writes the inner exception to `<config>/logs/VRCX.log`
 * through NLog; this is the pointer to it.
 */

/** Identical reasons are logged once per this interval, not per request. */
const REPEAT_INTERVAL_MS = 60000;

/**
 * Wrap the binding so that `ExecuteJson` is observed.
 *
 * A new object rather than an assignment: the node-api-dotnet proxy exposes
 * its methods as read-only properties, and assigning to one throws. Every
 * other member is read through to the .NET object, with methods bound to it
 * so `this` is still the CLR instance when they run.
 *
 * @param {object} WebApi - the native binding, with `ExecuteJson(json)`
 * @param {{ log: (message: string) => void, now?: () => number }} options
 * @returns {object} a binding to use in place of `WebApi`
 */
export function logWebApiFailures(WebApi, options) {
    const { log, now = Date.now } = options;
    const original = WebApi.ExecuteJson.bind(WebApi);
    /** @type {Map<string, number>} reason -> when it was last logged */
    const lastLogged = new Map();

    const executeJson = async function ExecuteJson(requestJson) {
        const json = await original(requestJson);
        let status;
        let message;
        try {
            ({ status, message } = JSON.parse(json));
        } catch {
            return json;
        }
        if (status === -1) {
            const reason = String(message ?? 'unknown');
            const at = now();
            if ((lastLogged.get(reason) ?? -Infinity) <= at - REPEAT_INTERVAL_MS) {
                lastLogged.set(reason, at);
                let url = '?';
                try {
                    url = JSON.parse(requestJson).url ?? '?';
                } catch {
                    // The request was not ours to parse; the URL is a nicety.
                }
                log(`VRChat request could not be sent: ${reason} (${url})`);
            }
        }
        return json;
    };

    // The Proxy's own target is empty on purpose. A Proxy over the binding
    // itself would be held to its invariants: a read-only, non-configurable
    // member must be returned as-is, which rules out returning it bound.
    return new Proxy(
        {},
        {
            get(_, prop) {
                if (prop === 'ExecuteJson') {
                    return executeJson;
                }
                const value = WebApi[prop];
                return typeof value === 'function' ? value.bind(WebApi) : value;
            },
            has(_, prop) {
                return prop === 'ExecuteJson' || prop in WebApi;
            }
        }
    );
}
