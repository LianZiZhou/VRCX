/**
 * [hub] One line per event in the Hub's log.
 */

import { inspect } from 'node:util';

import { compactConsoleOutput, describeRejection } from '../server/logFormat.js';

describe('Hub log format', () => {
    it('prints a nested object on one line', () => {
        const options = { ...inspect.defaultOptions };
        compactConsoleOutput(options);
        const notification = {
            type: 'group.announcement',
            data: { groupName: 'A group', announcementTitle: 'Tonight' },
            responses: [{ type: 'delete', icon: 'check', text: 'Acknowledge and dismiss this notification' }]
        };
        const text = inspect(notification, options);
        expect(text).not.toContain('\n');
        expect(text).toContain('Tonight');
    });

    it('reduces a failed VRChat request to status and endpoint', () => {
        const err = Object.assign(new Error('401 Unauthorized\nError Message: Missing Credentials'), {
            status: 401,
            endpoint: 'auth/user'
        });
        expect(describeRejection(err)).toBe('request failed: 401 auth/user');
    });

    it('keeps any other rejection whole', () => {
        const err = new TypeError('x is not a function');
        expect(describeRejection(err)).toBe(err);
        expect(describeRejection('plain')).toBe('plain');
        expect(describeRejection(undefined)).toBeUndefined();
    });
});

describe('Hub log timestamps', () => {
    it('prefixes every console line with the local time', async () => {
        const { formatTimestamp, stampConsoleOutput } = await import('../server/logFormat.js');
        const lines = [];
        const target = { log: (line) => lines.push(line), info() {}, warn() {}, error() {}, debug() {} };
        stampConsoleOutput(target, () => new Date(2026, 9, 5, 21, 43, 7));
        target.log('[hub] Signed in.', { id: 1 });
        expect(lines).toEqual(['2026-10-05 21:43:07 [hub] Signed in. { id: 1 }']);
        expect(formatTimestamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02 03:04:05');
    });
});
