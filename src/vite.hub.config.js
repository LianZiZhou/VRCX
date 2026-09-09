/**
 * [hub] Build config for the headless Hub.
 *
 * Deliberately separate from `vite.config.js`, which targets chrome145 with
 * lightningcss and emits two HTML entries. Nothing about that build is useful
 * for a Node daemon on a Raspberry Pi, and keeping them apart means the Hub
 * needs no change at all to the upstream config.
 *
 * The aliases are the interesting part. Without them the Hub's module graph
 * would pull in every `views/*.vue`, because `stores/index.js` imports from the
 * `plugins` barrel and that barrel re-exports `./router` and `./components`.
 * With them, zero `.vue` files are reachable from the data core, which is why
 * this build needs no Vue SFC plugin, no Tailwind and no UI dependencies.
 */

import fs from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'vite';

const here = import.meta.dirname;
const shims = resolve(here, 'hub/shims');

export default defineConfig(({ mode }) => {
    const version = fs.readFileSync(new URL('../Version', import.meta.url), 'utf-8').trim();

    return {
        define: {
            VERSION: JSON.stringify(version),
            NIGHTLY: JSON.stringify(mode === 'development'),
            // These two are runtime globals in the browser builds (injected by
            // the CefSharp render-process handler or by the Electron preload).
            // Folding them at build time is what makes `services/sqlite.js` and
            // `services/webapi.js` take their ExecuteJson paths, which is the
            // JSON-over-interop shape the Hub and the RPC both want.
            WINDOWS: JSON.stringify(false),
            LINUX: JSON.stringify(true),
            HUB: JSON.stringify(true)
        },
        build: {
            // `ssr` rather than `lib`: it implies the node platform and gives
            // control over which dependencies stay external.
            ssr: true,
            outDir: '../build/hub',
            emptyOutDir: true,
            target: 'node24',
            // Stack traces on a headless box are worth more than bytes.
            minify: false,
            sourcemap: true,
            rollupOptions: {
                input: {
                    // The Hub itself, and the migration/backup tool that ships
                    // beside it. The tool shares the protocol and channel code
                    // with the Hub, which Rollup puts in a common chunk.
                    main: resolve(here, 'hub/main.js'),
                    migrate: resolve(here, 'hub/migrate/cli.js')
                },
                output: { entryFileNames: '[name].js' }
            }
        },
        ssr: {
            // Bundle everything so the Pi gets one file plus a couple of
            // native/optional packages, rather than a node_modules tree.
            noExternal: true,
            external: [
                // Native addon; cannot be bundled.
                'node-api-dotnet',
                // Ships its own native/optional requires.
                'ws',
                // Large, and resolves internal modules dynamically.
                'happy-dom',
                '@happy-dom/global-registrator'
            ]
        },
        resolve: {
            alias: [
                // Keep the UI out of the Node bundle.
                { find: /^(?:\.\.\/)+plugins$/, replacement: resolve(shims, 'plugins.js') },
                { find: /^(?:\.\.\/)+plugins\/router$/, replacement: resolve(shims, 'router.js') },
                // The real module resolves locale JSON by URL and fetches it,
                // which throws in Node and would leave every t() returning its key.
                { find: /^(?:\.\.\/)+localization$/, replacement: resolve(shims, 'localization.js') },
                // Builds its timer worker with new Worker(URL.createObjectURL(...)).
                { find: 'worker-timers', replacement: resolve(shims, 'worker-timers.js') },
                // Retains toasts forever without a mounted <Toaster>.
                { find: 'vue-sonner', replacement: resolve(shims, 'vue-sonner.js') },
                { find: 'noty', replacement: resolve(shims, 'noty.js') },
                // Lazy-loaded by shared/utils/chart.js for the Charts views;
                // unreachable here, but ~2.7 MB if bundled anyway.
                { find: 'echarts', replacement: resolve(shims, 'echarts.js') },
                { find: '@', replacement: here }
            ]
        },
        // No vue(), no vueJsx(), no tailwindcss(): nothing here renders.
        plugins: []
    };
});
