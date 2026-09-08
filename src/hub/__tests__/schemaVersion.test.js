/**
 * [hub] Drift guard for the duplicated schema version.
 *
 * `hub/shared/schema.js` copies the number rather than importing it, to keep
 * the very early `plugins/interopApi.js` module graph free of Pinia stores.
 * This is what stops the copy from going stale: an upstream migration bumps
 * `DATABASE_VERSION` and this test fails until the Hub constant follows.
 */

import { DATABASE_VERSION } from '../../stores/vrcx.js';
import { EXPECTED_DATABASE_VERSION } from '../shared/schema.js';

describe('schema version', () => {
    it('matches the version the app actually migrates to', () => {
        expect(
            EXPECTED_DATABASE_VERSION,
            'src/hub/shared/schema.js is out of date with DATABASE_VERSION in ' +
                'src/stores/vrcx.js. A mirror client compares these during the Hub ' +
                'handshake, so a stale copy would let it attach to the wrong schema.'
        ).toBe(DATABASE_VERSION);
    });
});
