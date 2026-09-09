/**
 * [hub] Builds self-contained release zips of the headless Hub.
 *
 *   node ./build-scripts/package-hub.js [--platforms=...] [--variants=...]
 *
 * Each zip unpacks to a directory that runs the Hub with nothing else
 * installed:
 *
 *   vrcx-hub-<version>-<platform>-<variant>/
 *     start-hub.sh | .cmd     launcher; cd's to its own directory first
 *     main.js, assets/        the Vite bundle from build-hub.js
 *     node_modules/           ws, happy-dom, node-api-dotnet and friends
 *     dotnet/                 VRCX's .NET assemblies for this RID
 *     dotnet-runtime/         a private .NET runtime (see below)
 *     node/                   the Node binary (the `full` variant only)
 *
 * Why a private .NET runtime rather than a self-contained publish: the Hub does
 * not launch a .NET executable. `node-api-dotnet` brings its own native host,
 * which starts the CLR through hostfxr and then loads VRCX's assemblies into
 * it. That is a framework-dependent hosting model -- the runtime files a
 * `--self-contained` publish drops next to VRCX.dll are simply never consulted.
 * What hostfxr does honour is DOTNET_ROOT, so the runtime is shipped in the
 * layout it expects and `server/nativeBridge.js` points DOTNET_ROOT at it.
 *
 * Verified: with DOTNET_ROOT unset the host loads whatever .NET the machine
 * has; with it set to the bundled directory it loads the bundled one.
 *
 * The `slim` variant leaves out Node and asks for a system install instead.
 * Everything else is identical.
 */

const { execFileSync } = require('node:child_process');
const { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } = require('node:fs');
const { basename, join, resolve } = require('node:path');

const { zipDirectory, unzip, untargz, listZip, hashFile } = require('./hub-archive.js');

const rootDir = resolve(__dirname, '..');
const cacheDir = join(rootDir, 'build', '.cache');

const DOTNET_CHANNEL = 'https://raw.githubusercontent.com/dotnet/core/main/release-notes/10.0/releases.json';
const NODE_DIST = 'https://nodejs.org/dist';

/**
 * The platforms a zip can be built for.
 *
 * `rid` is what `dotnet publish -r` and the .NET release manifest call it;
 * `nodeName` is what nodejs.org calls the same thing. They disagree about
 * macOS (`osx` vs `darwin`), which is the only reason this table exists.
 */
const PLATFORMS = {
    'linux-x64': { nodeName: 'linux-x64', nodeExt: 'tar.gz', dotnetExt: 'tar.gz', windows: false },
    'linux-arm64': { nodeName: 'linux-arm64', nodeExt: 'tar.gz', dotnetExt: 'tar.gz', windows: false },
    'win-x64': { nodeName: 'win-x64', nodeExt: 'zip', dotnetExt: 'zip', windows: true },
    'win-arm64': { nodeName: 'win-arm64', nodeExt: 'zip', dotnetExt: 'zip', windows: true },
    'osx-x64': { nodeName: 'darwin-x64', nodeExt: 'tar.gz', dotnetExt: 'tar.gz', windows: false },
    'osx-arm64': { nodeName: 'darwin-arm64', nodeExt: 'tar.gz', dotnetExt: 'tar.gz', windows: false }
};

const VARIANTS = ['full', 'slim'];

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    /** @param {string} name @param {string} fallback */
    const value = (name, fallback) =>
        argv
            .find((a) => a.startsWith(`--${name}=`))
            ?.split('=')
            .slice(1)
            .join('=') ?? fallback;

    const platforms = value('platforms', Object.keys(PLATFORMS).join(',')).split(',').filter(Boolean);
    const variants = value('variants', VARIANTS.join(',')).split(',').filter(Boolean);

    for (const platform of platforms) {
        if (!PLATFORMS[platform]) {
            throw new Error(`Unknown platform "${platform}". Known: ${Object.keys(PLATFORMS).join(', ')}`);
        }
    }
    for (const variant of variants) {
        if (!VARIANTS.includes(variant)) {
            throw new Error(`Unknown variant "${variant}". Known: ${VARIANTS.join(', ')}`);
        }
    }

    return {
        platforms,
        variants,
        outDir: resolve(rootDir, value('out', join('build', 'dist'))),
        nodeVersion: value('node-version', ''),
        dotnetVersion: value('dotnet-version', ''),
        skipBundle: argv.includes('--skip-bundle')
    };
}

/**
 * @param {string} url
 * @returns {Promise<any>}
 */
async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`GET ${url} -> ${response.status}`);
    }
    return response.json();
}

/**
 * Download to the cache, or reuse what is already there.
 *
 * The expected digest comes from the publisher's own manifest, so a cached file
 * that fails it is re-fetched once rather than trusted.
 *
 * @param {{ url: string, name: string, digest: string, algorithm: 'sha256' | 'sha512' }} spec
 * @returns {Promise<string>} path to the cached file
 */
async function download(spec) {
    const { url, name, digest, algorithm } = spec;
    mkdirSync(cacheDir, { recursive: true });
    const dest = join(cacheDir, name);

    if (existsSync(dest) && hashFile(dest, algorithm) === digest.toLowerCase()) {
        console.log(`  cached  ${name}`);
        return dest;
    }

    process.stdout.write(`  fetch   ${name} ... `);
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`GET ${url} -> ${response.status}`);
    }
    writeFileSync(dest, Buffer.from(await response.arrayBuffer()));

    const actual = hashFile(dest, algorithm);
    if (actual !== digest.toLowerCase()) {
        rmSync(dest, { force: true });
        throw new Error(`${name}: ${algorithm} mismatch (expected ${digest}, got ${actual})`);
    }
    console.log(`${(statSync(dest).size / 1048576).toFixed(1)} MB, ${algorithm} ok`);
    return dest;
}

/**
 * The .NET runtime archives for the requested version, with their digests.
 *
 * @param {string} requested - empty for "whatever is current"
 */
async function resolveDotnet(requested) {
    const channel = await fetchJson(DOTNET_CHANNEL);
    const version = requested || channel['latest-runtime'];
    const release = channel.releases.find((r) => r.runtime?.version === version);
    if (!release) {
        throw new Error(`.NET runtime ${version} is not in the 10.0 release manifest`);
    }

    /** @type {Record<string, { url: string, name: string, digest: string, algorithm: 'sha512' }>} */
    const files = {};
    for (const [platform, info] of Object.entries(PLATFORMS)) {
        const file = release.runtime.files.find(
            (f) => f.rid === platform && f.name.startsWith('dotnet-runtime-') && f.name.endsWith(info.dotnetExt)
        );
        if (!file) {
            throw new Error(`.NET runtime ${version} has no ${info.dotnetExt} build for ${platform}`);
        }
        files[platform] = {
            url: file.url,
            name: `dotnet-runtime-${version}-${platform}.${info.dotnetExt}`,
            digest: file.hash,
            algorithm: 'sha512'
        };
    }
    return { version, files };
}

/**
 * The Node archives for the requested version, with their digests.
 *
 * @param {string} requested - empty for "the newest v24"
 */
async function resolveNode(requested) {
    let version = requested;
    if (!version) {
        const index = await fetchJson(`${NODE_DIST}/index.json`);
        const latest = index.filter((r) => r.version.startsWith('v24.'))[0];
        if (!latest) {
            throw new Error('nodejs.org lists no v24 release');
        }
        version = latest.version.slice(1);
    }

    // SHASUMS256.txt is the only per-file integrity source nodejs.org offers.
    const response = await fetch(`${NODE_DIST}/v${version}/SHASUMS256.txt`);
    if (!response.ok) {
        throw new Error(`Node ${version}: SHASUMS256.txt -> ${response.status}`);
    }
    /** @type {Map<string, string>} */
    const sums = new Map();
    for (const line of (await response.text()).split('\n')) {
        const [digest, name] = line.trim().split(/\s+/);
        if (digest && name) {
            sums.set(name, digest);
        }
    }

    /** @type {Record<string, { url: string, name: string, digest: string, algorithm: 'sha256' }>} */
    const files = {};
    for (const [platform, info] of Object.entries(PLATFORMS)) {
        const name = `node-v${version}-${info.nodeName}.${info.nodeExt}`;
        const digest = sums.get(name);
        if (!digest) {
            throw new Error(`Node ${version} has no ${name}`);
        }
        files[platform] = { url: `${NODE_DIST}/v${version}/${name}`, name, digest, algorithm: 'sha256' };
    }
    return { version, files };
}

/**
 * Publish VRCX's .NET assemblies for one RID.
 *
 * Framework-dependent on purpose (see the file header).
 *
 * MSBuild's own paths are left alone. Redirecting BaseIntermediateOutputPath
 * under the project directory makes the SDK glob the NodeApi source
 * generator's output back in as ordinary sources, and the build fails on
 * duplicate definitions. Sharing the default obj/ across RIDs is fine -- it
 * keys on the RID, verified by publishing win-x64 and linux-arm64 back to back
 * and confirming each output carries only its own native SQLite.
 *
 * One side effect: `dotnet publish` also refreshes the csproj's own OutputPath,
 * `build/Electron/`, so after packaging that directory holds whichever RID was
 * built last.
 *
 * @param {string} platform
 * @param {string} destDir
 */
function publishDotnet(platform, destDir) {
    execFileSync(
        'dotnet',
        [
            'publish',
            join(rootDir, 'Dotnet', 'VRCX-Electron.csproj'),
            '-r',
            platform,
            // `--self-contained false` is parsed as a flag plus a stray project
            // argument by the CLI; the MSBuild property form is unambiguous.
            '-p:SelfContained=false',
            '-c',
            'Release',
            '-o',
            destDir,
            '--nologo',
            // Warnings and errors still reach stderr; this only drops the
            // per-project progress chatter.
            '-v',
            'quiet'
        ],
        { cwd: rootDir, stdio: ['ignore', 'ignore', 'inherit'] }
    );

    if (!existsSync(join(destDir, 'VRCX-Electron.cjs'))) {
        throw new Error(`${platform}: publish produced no VRCX-Electron.cjs`);
    }
}

/**
 * Install the Hub's runtime dependencies once, for every platform to share.
 *
 * They are safe to share because none of them build from source: `ws` and
 * `happy-dom` are pure JS, and `node-api-dotnet` ships prebuilt binaries for
 * all six platforms in the one package. Optional dependencies are omitted so
 * npm does not try to compile `ws`'s native accelerators for the build host.
 *
 * @param {string} bundleDir - build/hub, holding the generated package.json
 * @returns {string} directory containing node_modules
 */
function installDependencies(bundleDir) {
    const depsDir = join(rootDir, 'build', '.deps');
    const manifest = join(bundleDir, 'package.json');
    const stamp = join(depsDir, '.manifest.json');

    const wanted = readFileSync(manifest, 'utf8');
    if (existsSync(stamp) && readFileSync(stamp, 'utf8') === wanted) {
        console.log('  cached  node_modules');
        return depsDir;
    }

    rmSync(depsDir, { recursive: true, force: true });
    mkdirSync(depsDir, { recursive: true });
    writeFileSync(join(depsDir, 'package.json'), wanted, 'utf8');

    process.stdout.write('  install node_modules ... ');
    execFileSync('npm', ['install', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund', '--loglevel=error'], {
        cwd: depsDir,
        stdio: ['ignore', 'ignore', 'inherit'],
        shell: process.platform === 'win32'
    });
    writeFileSync(stamp, wanted, 'utf8');
    console.log('done');
    return depsDir;
}

/**
 * The Unix mode a file should carry inside the zip.
 *
 * Derived from the path rather than the filesystem, because the build host is
 * often Windows -- where there are no mode bits to read -- and the answer has
 * to be the same either way.
 *
 * @param {string} rel
 * @returns {number}
 */
function modeFor(rel) {
    const path = rel.split('\\').join('/');
    const executable =
        path === 'start-hub.sh' ||
        path.startsWith('node/bin/') ||
        path === 'dotnet-runtime/dotnet' ||
        basename(path) === 'createdump' ||
        /\.(so|dylib)(\.[0-9]+)*$/.test(path);
    // 0o100000 marks it a regular file; without that some extractors treat the
    // entry as having no type and fall back to their own default.
    return 0o100000 | (executable ? 0o755 : 0o644);
}

/**
 * @param {{ nodeVersion: string, dotnetVersion: string, bundled: boolean }} info
 */
function startShellScript(info) {
    const bundled = info.bundled
        ? `
# This build ships its own Node.
if [ -x "$here/node/bin/node" ]; then
    exec "$here/node/bin/node" main.js "$@"
fi
`
        : '';

    return `#!/bin/sh
# VRCX Hub launcher.
#
# The Hub resolves dotnet/ and dotnet-runtime/ relative to the working
# directory, so this cd's into its own directory before starting.
set -e
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$here"
${bundled}
if ! command -v node >/dev/null 2>&1; then
    echo "VRCX Hub: no 'node' on PATH." >&2
    echo "Install Node 24.15 or newer, or use the 'full' download, which bundles it." >&2
    exit 1
fi

# The bundle is built for node24 and uses APIs older releases do not have.
node -e 'const [a,b]=process.versions.node.split(".").map(Number);
if (a<24||(a===24&&b<15)) { console.error("VRCX Hub needs Node 24.15 or newer; this is "+process.versions.node); process.exit(1); }'

exec node main.js "$@"
`;
}

/**
 * @param {{ bundled: boolean }} info
 */
function startBatchScript(info) {
    const bundled = info.bundled
        ? `
rem This build ships its own Node.
if exist "%~dp0node\\node.exe" (
    "%~dp0node\\node.exe" main.js %*
    exit /b %errorlevel%
)
`
        : '';

    return `@echo off
rem VRCX Hub launcher.
rem
rem The Hub resolves dotnet\\ and dotnet-runtime\\ relative to the working
rem directory, so this cd's into its own directory before starting.
setlocal
cd /d "%~dp0"
${bundled}
where node >nul 2>nul
if errorlevel 1 (
    echo VRCX Hub: no 'node' on PATH.
    echo Install Node 24.15 or newer, or use the 'full' download, which bundles it.
    exit /b 1
)

node -e "const [a,b]=process.versions.node.split('.').map(Number); if (a<24||(a===24&&b<15)) { console.error('VRCX Hub needs Node 24.15 or newer; this is '+process.versions.node); process.exit(1); }"
if errorlevel 1 exit /b 1

node main.js %*
`;
}

/**
 * @param {{ version: string, platform: string, variant: string, nodeVersion: string, dotnetVersion: string }} info
 */
function readme(info) {
    const windows = PLATFORMS[info.platform].windows;
    const run = windows ? 'start-hub.cmd' : './start-hub.sh';
    const prereq =
        info.variant === 'full'
            ? 'Nothing needs to be installed: this build ships its own Node and .NET runtimes.'
            : `Needs Node 24.15 or newer on PATH. The .NET runtime is bundled, so that is the only\nprerequisite. (The "full" download bundles Node too.)`;

    return `VRCX Hub ${info.version} -- ${info.platform} (${info.variant})

${prereq}

Run it:

    ${run}

Common flags (${run} --help lists them all):

    --config=<dir>        where VRCX.sqlite3 and VRCX.json live
                          (default: the usual per-user application data directory)
    --port=<n>            client uplink port          (default 9001)
    --status-port=<n>     status page port            (default 9002, 0 disables)
    --host=<addr>         bind address                (default 0.0.0.0)
    --dry-run             boot against stubs; touches no real data

The status page answers on http://<host>:<status-port>/ and the same data as
JSON at /status.json.

On first start the Hub writes a "hub-token" file into the config directory.
Clients need its contents to connect, so treat it like a password.

What is in here:

    main.js, assets/      the Hub itself
    node_modules/         its JavaScript dependencies
    dotnet/               VRCX's .NET assemblies, built for ${info.platform}
    dotnet-runtime/       a private .NET ${info.dotnetVersion} runtime${
        info.variant === 'full' ? `\n    node/                 Node ${info.nodeVersion}` : ''
    }

The bundled runtimes are used in place of anything installed on the machine, so
this directory can be moved or deleted without touching the rest of the system.
`;
}

/**
 * What each platform's payload must contain, and what its Node binary must be.
 *
 * The magic numbers are the point: this packager cross-builds five platforms it
 * cannot execute, so "did we ship an arm64 binary in the arm64 zip" has to be
 * answered by reading the file header rather than by running it.
 */
const EXPECTED = {
    'linux-x64': { sqlite: 'libe_sqlite3.so', hostfxr: 'libhostfxr.so', format: 'elf', machine: 0x3e },
    'linux-arm64': { sqlite: 'libe_sqlite3.so', hostfxr: 'libhostfxr.so', format: 'elf', machine: 0xb7 },
    'win-x64': { sqlite: 'e_sqlite3.dll', hostfxr: 'hostfxr.dll', format: 'pe', machine: 0x8664 },
    'win-arm64': { sqlite: 'e_sqlite3.dll', hostfxr: 'hostfxr.dll', format: 'pe', machine: 0xaa64 },
    'osx-x64': { sqlite: 'libe_sqlite3.dylib', hostfxr: 'libhostfxr.dylib', format: 'macho', machine: 0x01000007 },
    'osx-arm64': { sqlite: 'libe_sqlite3.dylib', hostfxr: 'libhostfxr.dylib', format: 'macho', machine: 0x0100000c }
};

/**
 * Read an executable's header and say which architecture it is really for.
 *
 * @param {string} file
 * @param {'elf' | 'pe' | 'macho'} format
 * @returns {number} the format's machine/cputype field
 */
function machineOf(file, format) {
    const head = readFileSync(file).subarray(0, 4096);
    if (format === 'elf') {
        if (head.toString('latin1', 0, 4) !== 'ELF') {
            throw new Error(`${file}: not an ELF binary`);
        }
        return head.readUInt16LE(18);
    }
    if (format === 'macho') {
        // 64-bit Mach-O, little endian: cf fa ed fe, then the cputype.
        if (head.readUInt32LE(0) !== 0xfeedfacf) {
            throw new Error(`${file}: not a 64-bit Mach-O binary`);
        }
        return head.readUInt32LE(4);
    }
    if (head.toString('latin1', 0, 2) !== 'MZ') {
        throw new Error(`${file}: not a PE binary`);
    }
    const peOffset = head.readUInt32LE(0x3c);
    if (head.toString('latin1', peOffset, peOffset + 4) !== 'PE  ') {
        throw new Error(`${file}: no PE header`);
    }
    return head.readUInt16LE(peOffset + 4);
}

/**
 * Check a staged tree before it is zipped.
 *
 * @param {string} stage
 * @param {string} platform
 * @param {string} variant
 * @param {string} dotnetVersion
 */
function verifyStage(stage, platform, variant, dotnetVersion) {
    const info = PLATFORMS[platform];
    const expected = EXPECTED[platform];

    const required = [
        'main.js',
        'package.json',
        'README.txt',
        join('dotnet', 'VRCX-Electron.cjs'),
        join('dotnet', 'VRCX-Electron.dll'),
        join('dotnet', expected.sqlite),
        join('dotnet-runtime', 'host', 'fxr', dotnetVersion, expected.hostfxr),
        join('node_modules', 'node-api-dotnet', platform, 'Microsoft.JavaScript.NodeApi.node'),
        info.windows ? 'start-hub.cmd' : 'start-hub.sh'
    ];
    for (const rel of required) {
        if (!existsSync(join(stage, rel))) {
            throw new Error(`${platform}/${variant}: missing ${rel}`);
        }
    }

    // The other five platforms' native hosts must be gone, or the zip carries
    // 9 MB it cannot use.
    for (const other of Object.keys(PLATFORMS)) {
        if (other !== platform && existsSync(join(stage, 'node_modules', 'node-api-dotnet', other))) {
            throw new Error(`${platform}/${variant}: ${other} native host was not pruned`);
        }
    }

    if (variant === 'full') {
        const binary = join(stage, 'node', info.windows ? 'node.exe' : join('bin', 'node'));
        const machine = machineOf(binary, expected.format);
        if (machine !== expected.machine) {
            throw new Error(
                `${platform}/${variant}: bundled Node is machine 0x${machine.toString(16)}, ` +
                    `expected 0x${expected.machine.toString(16)}`
            );
        }
    }
}

/**
 * Assemble and zip one platform/variant.
 *
 * @param {object} options
 */
async function buildOne(options) {
    const { platform, variant, version, bundleDir, depsDir, dotnet, node, outDir } = options;
    const info = PLATFORMS[platform];
    const name = `vrcx-hub-${version}-${platform}-${variant}`;
    const stage = join(rootDir, 'build', '.stage', name);

    console.log(`\n${name}`);
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });

    // The bundle, minus the manifest npm would rewrite.
    cpSync(bundleDir, stage, { recursive: true });
    rmSync(join(stage, 'package-lock.json'), { force: true });

    cpSync(join(depsDir, 'node_modules'), join(stage, 'node_modules'), { recursive: true });
    // node-api-dotnet ships all six platforms' native hosts; keep this one.
    for (const other of Object.keys(PLATFORMS)) {
        if (other !== platform) {
            rmSync(join(stage, 'node_modules', 'node-api-dotnet', other), { recursive: true, force: true });
        }
    }

    process.stdout.write('  dotnet publish ... ');
    publishDotnet(platform, join(stage, 'dotnet'));
    console.log('done');

    process.stdout.write('  unpack .NET runtime ... ');
    const runtimeDir = join(stage, 'dotnet-runtime');
    const runtimeArchive = join(cacheDir, dotnet.files[platform].name);
    if (info.dotnetExt === 'zip') {
        unzip(runtimeArchive, runtimeDir);
    } else {
        untargz(runtimeArchive, runtimeDir);
    }
    console.log('done');

    if (variant === 'full') {
        process.stdout.write('  unpack Node ... ');
        const nodeArchive = join(cacheDir, node.files[platform].name);
        // Only the interpreter and its licence: the rest of the distribution is
        // npm, headers and docs, none of which the Hub uses.
        const keep = (entry) => {
            const path = entry.split('\\').join('/');
            const rest = path.split('/').slice(1).join('/');
            if (info.windows) {
                return rest === 'node.exe' || rest === 'LICENSE' ? rest : null;
            }
            return rest === 'bin/node' || rest === 'LICENSE' ? rest : null;
        };
        if (info.nodeExt === 'zip') {
            unzip(nodeArchive, join(stage, 'node'), keep);
        } else {
            untargz(nodeArchive, join(stage, 'node'), keep);
        }
        const binary = join(stage, 'node', info.windows ? 'node.exe' : 'bin/node');
        if (!existsSync(binary)) {
            throw new Error(`${platform}: the Node archive yielded no ${info.windows ? 'node.exe' : 'bin/node'}`);
        }
        console.log('done');
    }

    const scriptInfo = { nodeVersion: node.version, dotnetVersion: dotnet.version, bundled: variant === 'full' };
    // `start-hub` rather than plain `start`: an explicit name is easier to
    // pick out of the directory listing and cannot be misread as cmd.exe's
    // `start` built-in.
    if (info.windows) {
        writeFileSync(join(stage, 'start-hub.cmd'), startBatchScript(scriptInfo).split('\n').join('\r\n'), 'utf8');
    } else {
        writeFileSync(join(stage, 'start-hub.sh'), startShellScript(scriptInfo), 'utf8');
    }
    writeFileSync(
        join(stage, 'README.txt'),
        readme({ version, platform, variant, nodeVersion: node.version, dotnetVersion: dotnet.version }),
        'utf8'
    );

    verifyStage(stage, platform, variant, dotnet.version);

    // Everything sits under one top-level directory so unzipping into a
    // downloads folder does not scatter files across it.
    const wrapper = join(rootDir, 'build', '.stage', `${name}-wrapper`);
    rmSync(wrapper, { recursive: true, force: true });
    mkdirSync(wrapper, { recursive: true });
    cpSync(stage, join(wrapper, name), { recursive: true });

    process.stdout.write('  zip ... ');
    const zipPath = join(outDir, `${name}.zip`);
    const result = zipDirectory(wrapper, zipPath, (rel) =>
        modeFor(rel.split('\\').join('/').split('/').slice(1).join('/'))
    );
    rmSync(wrapper, { recursive: true, force: true });
    rmSync(stage, { recursive: true, force: true });

    // Read the archive back: the launcher's executable bit only exists inside
    // the zip, so nothing before this point can confirm it survived.
    if (!info.windows) {
        const launcher = `${name}/start-hub.sh`;
        const entry = listZip(zipPath).find((e) => e.name === launcher);
        if (!entry) {
            throw new Error(`${name}: ${launcher} is not in the archive`);
        }
        if ((entry.mode & 0o111) === 0) {
            throw new Error(`${name}: ${launcher} is not executable (mode ${entry.mode.toString(8)})`);
        }
    }

    const megabytes = (result.bytes / 1048576).toFixed(1);
    console.log(`${result.files} files, ${megabytes} MB`);
    return { name: `${name}.zip`, path: zipPath, bytes: result.bytes, files: result.files };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const version = readFileSync(join(rootDir, 'Version'), 'utf8').trim();
    const bundleDir = join(rootDir, 'build', 'hub');

    console.log(`Packaging VRCX Hub ${version}`);
    console.log(`  platforms: ${options.platforms.join(', ')}`);
    console.log(`  variants:  ${options.variants.join(', ')}\n`);

    if (!options.skipBundle) {
        process.stdout.write('  build bundle ... ');
        execFileSync(process.execPath, [join(__dirname, 'build-hub.js')], {
            cwd: rootDir,
            stdio: ['ignore', 'ignore', 'inherit']
        });
        console.log('done');
    }
    if (!existsSync(join(bundleDir, 'main.js'))) {
        throw new Error(`No Hub bundle at ${bundleDir}. Run without --skip-bundle.`);
    }

    const depsDir = installDependencies(bundleDir);

    const dotnet = await resolveDotnet(options.dotnetVersion);
    console.log(`  .NET runtime ${dotnet.version}`);
    const needsNode = options.variants.includes('full');
    const node = await resolveNode(options.nodeVersion);
    console.log(`  Node ${node.version}${needsNode ? '' : ' (metadata only; no full variant requested)'}`);

    for (const platform of options.platforms) {
        await download(dotnet.files[platform]);
        if (needsNode) {
            await download(node.files[platform]);
        }
    }

    mkdirSync(options.outDir, { recursive: true });
    const built = [];
    for (const platform of options.platforms) {
        for (const variant of options.variants) {
            built.push(
                await buildOne({ platform, variant, version, bundleDir, depsDir, dotnet, node, outDir: options.outDir })
            );
        }
    }

    // A checksum file, so a download can be verified the same way the inputs were.
    const sums = built.map((b) => `${hashFile(b.path, 'sha256')}  ${b.name}`).join('\n');
    writeFileSync(join(options.outDir, 'SHA256SUMS.txt'), `${sums}\n`, 'utf8');

    console.log(`\n${built.length} archive(s) in ${options.outDir}`);
    for (const b of built) {
        console.log(`  ${b.name}  ${(b.bytes / 1048576).toFixed(1)} MB`);
    }
    console.log('  SHA256SUMS.txt');
}

main().catch((error) => {
    console.error(`\npackage-hub: ${error.message}`);
    process.exit(1);
});
