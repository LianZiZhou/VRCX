/**
 * [hub] Vitest config for the headless Hub.
 *
 * Deliberately separate from `vitest.config.js`: this one runs in the `node`
 * environment (not jsdom) with happy-dom installed by the setup file, so it
 * exercises the exact environment the Raspberry Pi Hub will run in. It also
 * applies the same module aliases the Hub's production bundle uses, so a
 * green run here means the alias set is complete.
 */

import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

const src = resolve(import.meta.dirname, 'src');
const shims = resolve(src, 'hub/shims');

export default defineConfig({
    define: {
        NIGHTLY: JSON.stringify(false),
        VERSION: JSON.stringify('hub-spike'),
        WINDOWS: JSON.stringify(false),
        LINUX: JSON.stringify(true),
        HUB: JSON.stringify(true)
    },
    test: {
        globals: true,
        environment: 'node',
        setupFiles: ['./src/hub/bootstrap/testSetup.js'],
        include: ['src/hub/**/*.{test,spec}.js'],
        testTimeout: 60000,
        hookTimeout: 60000
    },
    resolve: {
        alias: [
            { find: /^(?:\.\.\/)+plugins$/, replacement: resolve(shims, 'plugins.js') },
            { find: /^(?:\.\.\/)+plugins\/router$/, replacement: resolve(shims, 'router.js') },
            { find: /^(?:\.\.\/)+localization$/, replacement: resolve(shims, 'localization.js') },
            { find: 'worker-timers', replacement: resolve(shims, 'worker-timers.js') },
            { find: 'vue-sonner', replacement: resolve(shims, 'vue-sonner.js') },
            { find: 'noty', replacement: resolve(shims, 'noty.js') },
            { find: '@', replacement: src }
        ]
    }
});
