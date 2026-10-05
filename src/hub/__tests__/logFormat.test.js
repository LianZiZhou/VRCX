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
