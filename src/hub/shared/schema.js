/**
 * [hub] The database schema version this build of VRCX expects.
 *
 * Deliberately duplicated from `stores/vrcx.js` rather than imported. The
 * consumer is `plugins/interopApi.js`, which runs before anything else in the
 * app; importing a Pinia store from there would drag the whole store graph into
 * that very early module and invite import cycles.
 *
 * `schemaVersion.test.js` asserts this stays equal to the store's exported
 * `DATABASE_VERSION`, so an upstream migration cannot silently desynchronise
 * the two.
 */

export const EXPECTED_DATABASE_VERSION = 17;
