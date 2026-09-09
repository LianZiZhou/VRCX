/**
 * [hub] When VRChat cannot be reached, say which layer is at fault.
 *
 * All of the Hub's VRChat traffic goes through the .NET `WebApi`, whose HTTP
 * stack sits on the box's OpenSSL, CA store and proxy environment -- none of
 * which Node shares. So a request that fails with status 0 there can mean
 * "this machine has no route to VRChat" or ".NET specifically cannot make
 * the request", and on a headless box the two need very different fixes.
 * Asking Node's own `fetch` for the same endpoint tells them apart.
 */

const PROBE_URL = 'https://api.vrchat.cloud/api/1/config';
const PROBE_TIMEOUT_MS = 10000;

/**
 * @typedef {object} ReachabilityReport
 * @property {boolean} reachable - whether Node reached the API
 * @property {string} detail - one line to log
 * @property {string[]} advice - what to look at next
 */

/**
 * @param {{ configDir: string, fetchImpl?: typeof fetch, url?: string }} options
 * @returns {Promise<ReachabilityReport>}
 */
export async function diagnoseVrchatReachability(options) {
    const { configDir, fetchImpl = globalThis.fetch, url = PROBE_URL } = options;
    const dotnetLog = `${configDir}/logs/VRCX.log`;
    try {
        const response = await fetchImpl(url, {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
            headers: { 'User-Agent': 'VRCX-Hub reachability probe' }
        });
        return {
            reachable: true,
            detail: `Node reached ${url} (HTTP ${response.status}) but the .NET side could not.`,
            advice: [
                `The reason is in the .NET log: ${dotnetLog}`,
                'Usual causes on Linux: no CA certificates (install ca-certificates), a missing OpenSSL 3 (libssl3),',
                'or a proxy in http_proxy/https_proxy that .NET honours and Node ignores.'
            ]
        };
    } catch (err) {
        const cause = err?.cause?.message ?? err?.message ?? String(err);
        return {
            reachable: false,
            detail: `This machine cannot reach ${url}: ${cause}`,
            advice: [
                'Check DNS and the route out (ping api.vrchat.cloud, curl -I https://api.vrchat.cloud/api/1/config).',
                `The .NET side's own error is in ${dotnetLog}.`
            ]
        };
    }
}
