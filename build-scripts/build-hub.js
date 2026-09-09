/**
 * [hub] Packages the headless Hub for deployment.
 *
 * Runs the Node bundle, then writes a small package.json alongside it so the
 * output directory can be copied to a Raspberry Pi and installed on its own.
 *
 *   node ./build-scripts/build-hub.js [--arch=arm64]
 *
 * The result is `build/hub/`, containing two bundled entry points -- `main.js`,
 * the Hub, and `migrate.js`, the migration and backup tool -- plus a manifest
 * of the handful of dependencies that cannot be bundled: the .NET interop
 * addon (native), `ws` (native/optional requires) and happy-dom (resolves its
 * internals dynamically).
 *
 * The .NET assemblies themselves are built separately, by
 * `dotnet publish Dotnet/VRCX-Electron-arm64.csproj`, and are expected at
 * `build/Electron/` relative to wherever the Hub is run from.
 */

const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const rootDir = resolve(__dirname, '..');
const outDir = join(rootDir, 'build', 'hub');

/** Dependencies the bundle keeps external; see `src/vite.hub.config.js`. */
const RUNTIME_DEPENDENCIES = ['node-api-dotnet', 'ws', 'happy-dom', '@happy-dom/global-registrator'];

/**
 * @param {string[]} argv
 * @returns {{ arch: string }}
 */
function parseArgs(argv) {
    const arch = argv.find((arg) => arg.startsWith('--arch='))?.split('=')[1] ?? process.arch;
    return { arch };
}

function build() {
    const { arch } = parseArgs(process.argv.slice(2));
    const rootManifest = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
    const version = readFileSync(join(rootDir, 'Version'), 'utf8').trim();

    console.log(`Building VRCX Hub ${version} for ${arch}`);

    // Resolve vite's own entry rather than shelling out to npx: on Windows
    // spawning a .cmd needs a shell, and going through node keeps this working
    // identically on the Pi.
    execFileSync(
        process.execPath,
        [join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', 'src', '--config', 'src/vite.hub.config.js'],
        { cwd: rootDir, stdio: 'inherit' }
    );

    /**
     * Pin each external to the version this repo was built against, so the Pi
     * install cannot silently drift from what the bundle was compiled with.
     */
    const dependencies = {};
    for (const name of RUNTIME_DEPENDENCIES) {
        const range = rootManifest.dependencies?.[name] ?? rootManifest.devDependencies?.[name];
        if (!range) {
            throw new Error(`Hub dependency "${name}" is not in the root package.json`);
        }
        dependencies[name] = range;
    }

    writeFileSync(
        join(outDir, 'package.json'),
        `${JSON.stringify(
            {
                name: 'vrcx-hub',
                version,
                private: true,
                description: 'Headless VRCX backend',
                // The bundle is ESM. Without this Node reparses it and warns.
                type: 'module',
                main: 'main.js',
                scripts: { start: 'node main.js', migrate: 'node migrate.js' },
                dependencies,
                engines: { node: rootManifest.engines?.node ?? '>=24' }
            },
            null,
            4
        )}\n`,
        'utf8'
    );

    for (const entry of ['main.js', 'migrate.js']) {
        if (!existsSync(join(outDir, entry))) {
            throw new Error(`The bundle did not produce ${entry}`);
        }
    }

    console.log(`\nHub built to ${outDir}`);
    console.log('Deploy with:');
    console.log('  rsync -a build/hub/ build/Electron/ pi:~/vrcx-hub/');
    console.log('  ssh pi "cd ~/vrcx-hub && npm install --omit=dev && node main.js"');
}

build();
