/**
 * [hub] Entry point for the headless VRCX Hub.
 *
 * The DOM shim is imported statically and everything else dynamically, on
 * purpose. Several stores touch DOM globals at module scope, so the shim has to
 * be installed before any module under `src/` is evaluated. A static import of
 * the runner would leave that ordering up to the bundler's module-hoisting.
 */

import './bootstrap/dom.js';

const { runHub } = await import('./server/runHub.js');

await runHub().catch((err) => {
    console.error('[hub] Failed to start:', err);
    process.exit(1);
});
