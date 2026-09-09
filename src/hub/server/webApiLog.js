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
 * @param {object} WebApi - the native binding, with `ExecuteJson(json)`
 * @param {{ log: (message: string) => void, now?: () => number }} options
 * @returns {object} the same binding, with `ExecuteJson` wrapped
 */
export function logWebApiFailures(WebApi, options) {
    const { log, now = Date.now } = options;
    const original = WebApi.ExecuteJson.bind(WebApi);
    /** @type {Map<string, number>} reason -> when it was last logged */
    const lastLogged = new Map();

    WebApi.ExecuteJson = async function ExecuteJson(requestJson) {
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
    return WebApi;
}
