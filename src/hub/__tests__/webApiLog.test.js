/**
 * [hub] The .NET HTTP failure reason reaches the Hub log, once per minute
 * per reason, and successful or malformed answers pass through untouched.
 */

import { logWebApiFailures } from '../server/webApiLog.js';

describe('WebApi failure logging', () => {
    it('logs a -1 answer with its reason and URL, and passes it through', async () => {
        const lines = [];
        let clock = 0;
        // Read-only members, as the node-api-dotnet proxy has: the wrapper
        // must not try to assign into the binding.
        const native = Object.freeze({
            async ExecuteJson() {
                return JSON.stringify({ status: -1, message: 'An error occurred while sending the request.' });
            },
            GetCookies() {
                return this === native ? 'cookies' : 'wrong this';
            }
        });
        const WebApi = logWebApiFailures(native, { log: (line) => lines.push(line), now: () => clock });
        expect(WebApi.GetCookies()).toBe('cookies');

        const request = JSON.stringify({ url: 'https://api.vrchat.cloud/api/1/config', method: 'GET' });
        expect(JSON.parse(await WebApi.ExecuteJson(request)).status).toBe(-1);
        await WebApi.ExecuteJson(request);
        expect(lines).toEqual([
            'VRChat request could not be sent: An error occurred while sending the request. (https://api.vrchat.cloud/api/1/config)'
        ]);

        clock = 60001;
        await WebApi.ExecuteJson(request);
        expect(lines).toHaveLength(2);
    });

    it('leaves successes and non-JSON answers alone', async () => {
        const lines = [];
        const answers = [JSON.stringify({ status: 200, message: '{}' }), 'not json'];
        const WebApi = logWebApiFailures(
            {
                async ExecuteJson() {
                    return answers.shift();
                }
            },
            { log: (line) => lines.push(line) }
        );

        expect(await WebApi.ExecuteJson('{}')).toContain('200');
        expect(await WebApi.ExecuteJson('{}')).toBe('not json');
        expect(lines).toEqual([]);
    });
});
