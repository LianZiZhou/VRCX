/**
 * [hub] Keeps the upstream diff small.
 *
 * The whole maintenance argument for this fork is that rebasing onto upstream
 * stays cheap, which only holds while the changes to upstream files remain a
 * handful of small guarded blocks. Two things erode that quietly:
 *
 *   - reaching for an upstream file instead of adding a new one, and
 *   - running the formatter over an upstream file. The committed source is not
 *     formatted at the width `.oxfmtrc.json` configures, so `oxfmt` rewrites
 *     whole files and turns a three-line change into a two-hundred-line one.
 *     That has already happened once during this work.
 *
 * This test fails when either does. If a change genuinely needs more room, move
 * the threshold deliberately rather than by accident.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../../..');

/**
 * Upstream files the Hub is allowed to touch, and how many changed lines each
 * may carry. Anything not listed here should be a new file under `src/hub/`.
 */
const ALLOWANCE = {
    // Four lines: `workflow_call` plus a comment, so the Hub's release
    // pipeline can reuse the client build instead of duplicating it.
    '.github/workflows/github_actions.yml': 6,
    'package.json': 12,
    'vitest.config.js': 6,
    'src/plugins/interopApi.js': 30,
    // The entry points both platforms' game log and game state converge on;
    // a mirror client sends from here rather than processing locally.
    'src/coordinators/gameLogCoordinator.js': 12,
    'src/coordinators/gameCoordinator.js': 12,
    'src/services/database/index.js': 15,
    // Three lines: a failed request's Error was JSON.stringified into "{}",
    // which is what every network failure on a headless box would report.
    'src/services/request.js': 8,
    'src/services/websocket.js': 25,
    'src/stores/updateLoop.js': 60,
    'src/stores/vrcx.js': 40
};

/** Total across every upstream file. */
const TOTAL_ALLOWANCE = 160;

/**
 * @returns {string | null} a base commit to diff against, or null if we cannot
 *   determine one (a shallow clone, or no upstream ref present)
 */
function findBaseRef() {
    for (const ref of ['upstream/master', 'origin/master', 'master']) {
        try {
            execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
                cwd: repoRoot,
                stdio: ['ignore', 'pipe', 'ignore']
            });
            return ref;
        } catch {
            // Try the next candidate.
        }
    }
    return null;
}

/**
 * @param {string} baseRef
 * @returns {Map<string, number>} path -> changed lines
 */
function changedLinesByFile(baseRef) {
    const output = execFileSync('git', ['diff', '--numstat', baseRef, '--', '.'], {
        cwd: repoRoot,
        encoding: 'utf8'
    });
    const result = new Map();
    for (const line of output.split('\n')) {
        if (!line.trim()) {
            continue;
        }
        const [added, removed, path] = line.split('\t');
        if (added === '-' || removed === '-') {
            continue; // binary
        }
        result.set(path, Number(added) + Number(removed));
    }
    return result;
}

/**
 * @param {string} path
 * @returns {boolean} whether this file belongs to the Hub rather than upstream
 */
function isHubOwned(path) {
    return (
        path.startsWith('src/hub/') ||
        path === 'vitest.hub.config.js' ||
        path === 'src/vite.hub.config.js' ||
        path === 'build-scripts/build-hub.js' ||
        path === 'build-scripts/hub-merge-offline.js' ||
        path === 'build-scripts/hub-archive.js' ||
        path === 'build-scripts/package-hub.js' ||
        // A new workflow file cannot conflict with upstream, so it counts as
        // ours even though it lives in an upstream directory.
        path === '.github/workflows/hub.yml' ||
        path === '.github/workflows/hub-release.yml' ||
        path.startsWith('docker/') ||
        path === 'package-lock.json'
    );
}

describe('upstream footprint', () => {
    const baseRef = findBaseRef();

    it.skipIf(!baseRef)('touches only the upstream files it is meant to', () => {
        const changed = changedLinesByFile(baseRef);
        const unexpected = [...changed.keys()].filter((path) => !isHubOwned(path) && !(path in ALLOWANCE));

        expect(
            unexpected,
            'The Hub changed upstream files that are not on its allow list. ' +
                'Prefer a new file under src/hub/; if the change is genuinely ' +
                'necessary, add it to ALLOWANCE with a reason.'
        ).toEqual([]);
    });

    it.skipIf(!baseRef)('keeps each upstream change small', () => {
        const changed = changedLinesByFile(baseRef);
        const oversized = [];
        for (const [path, allowed] of Object.entries(ALLOWANCE)) {
            const actual = changed.get(path) ?? 0;
            if (actual > allowed) {
                oversized.push(`${path}: ${actual} changed lines, allowed ${allowed}`);
            }
        }

        expect(
            oversized,
            'An upstream file grew past its allowance. If this was the ' +
                'formatter, revert it: `git checkout ' +
                `${baseRef}` +
                ' -- <file>` and re-apply only the semantic edit. Never run ' +
                'oxfmt on an upstream file.'
        ).toEqual([]);
    });

    it.skipIf(!baseRef)('keeps the total footprint reviewable', () => {
        const changed = changedLinesByFile(baseRef);
        const total = [...changed.entries()]
            .filter(([path]) => !isHubOwned(path))
            .reduce((sum, [, lines]) => sum + lines, 0);

        expect(total).toBeLessThanOrEqual(TOTAL_ALLOWANCE);
    });
});
