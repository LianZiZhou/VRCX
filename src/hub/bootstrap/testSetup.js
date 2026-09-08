/**
 * [hub] Setup file for `vitest.hub.config.js`.
 *
 * Order matters: the DOM must exist before any `src/` module is imported.
 */

import './dom.js';

import { installNativeStubs } from './nativeStubs.js';

installNativeStubs();
