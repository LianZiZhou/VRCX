import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

import vue from '@vitejs/plugin-vue';
import vueJsx from '@vitejs/plugin-vue-jsx';

export default defineConfig({
    plugins: [vue(), vueJsx()],
    define: {
        NIGHTLY: JSON.stringify(false),
        WINDOWS: JSON.stringify(true),
        LINUX: JSON.stringify(false)
    },
    test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: ['./vitest.setup.js'],
        include: ['src/**/*.{test,spec}.js'],
        // [hub] Hub tests run in the node environment with their own module
        // aliases; see vitest.hub.config.js (npm run test:hub).
        exclude: ['**/node_modules/**', 'src/hub/**'],
        coverage: {
            reporter: ['text', 'text-summary'],
            exclude: [
                'src/public/**',
                'src/vr/**',
                'src/types/**',
                'src/styles/**',
                'src/ipc-electron/**',
                'src/localization/**',
                'src/lib/**/!(*.test).js',
                'src/components/ui/**/*.vue',
                'src/components/ui/**/index.js'
            ]
        }
    },
    resolve: {
        alias: {
            '@': resolve(import.meta.dirname, 'src')
        }
    }
});
