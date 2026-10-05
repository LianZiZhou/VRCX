/**
 * [hub] The log says who touched the Hub's VRChat session and how VRChat answered.
 */

import { auditSessionChanges, classifySessionRequest, sessionCaller } from '../server/sessionAudit.js';

const API = 'https://api.vrchat.cloud/api/1';

/**
 * @param {Record<string, { status: number, message: string }>} answers - by URL path suffix
 * @returns {object}
 */
function fakeWebApi(answers) {
    const calls = [];
    return {
        calls,
        async ExecuteJson(requestJson) {
            const { url } = JSON.parse(requestJson);
            calls.push(url);
            const key = Object.keys(answers).find((suffix) => url.endsWith(suffix));
            return JSON.stringify(key ? answers[key] : { status: 200, message: '{}' });
        },
        ClearCookies() {
            calls.push('ClearCookies');
        },
        SetCookies(value) {
            calls.push(`SetCookies:${value}`);
        },
        GetCookies() {
            return 'jar';
        }
    };
}

describe('session audit', () => {
    it('recognises sign-ins and two-factor verifications, and nothing else', () => {
        expect(classifySessionRequest({ url: `${API}/auth/user`, headers: { Authorization: 'Basic x' } })).toBe(
            'sign-in'
        );
        expect(classifySessionRequest({ url: `${API}/auth/user`, method: 'GET' })).toBeNull();
        expect(classifySessionRequest({ url: `${API}/auth/twofactorauth/otp/verify`, method: 'POST' })).toBe(
            'two-factor verification'
        );
        expect(classifySessionRequest({ url: `${API}/auth/twofactorauth/emailotp/verify` })).toBe(
            'two-factor verification'
        );
        expect(classifySessionRequest({ url: `${API}/users/usr_1` })).toBeNull();
        expect(classifySessionRequest({ url: 'not a url' })).toBeNull();
    });

    it('logs a sign-in that VRChat answered with a second-factor demand, by whoever asked', async () => {
        const lines = [];
        const native = fakeWebApi({
            '/auth/user': { status: 200, message: JSON.stringify({ requiresTwoFactorAuth: ['totp', 'otp'] }) },
            '/otp/verify': { status: 200, message: JSON.stringify({ verified: true }) }
        });
        const webApi = auditSessionChanges(native, { log: (line) => lines.push(line) });

        await webApi.ExecuteJson(JSON.stringify({ url: `${API}/auth/user`, headers: { Authorization: 'Basic x' } }));
        await sessionCaller.run('vrcx-windows', () =>
            webApi.ExecuteJson(JSON.stringify({ url: `${API}/auth/twofactorauth/otp/verify`, method: 'POST' }))
        );
        await webApi.ExecuteJson(JSON.stringify({ url: `${API}/auth/user`, method: 'GET' }));

        expect(lines).toEqual([
            'VRChat sign-in by the Hub: 200, but VRChat wants a second factor (totp, otp)',
            'VRChat two-factor verification by vrcx-windows: 200'
        ]);
        // Nothing secret: no header or body made it into the log.
        expect(lines.join('\n')).not.toContain('Basic');
    });

    it('logs the cookie jar being cleared or replaced, and still does it', async () => {
        const lines = [];
        const native = fakeWebApi({});
        const webApi = auditSessionChanges(native, { log: (line) => lines.push(line) });

        await sessionCaller.run('vrcx-windows', async () => webApi.ClearCookies());
        webApi.SetCookies('saved');

        expect(lines).toEqual(['VRChat cookies cleared by vrcx-windows', 'VRChat cookies replaced by the Hub']);
        expect(native.calls).toEqual(['ClearCookies', 'SetCookies:saved']);
        // Everything else reads through.
        expect(webApi.GetCookies()).toBe('jar');
    });
});
