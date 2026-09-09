/**
 * [hub] Tests for the release packager's archive helpers.
 *
 * These exist because a rename during review silently broke both `unzip` and
 * `untargz` -- the code still linted, still parsed, and would only have failed
 * at the point where a release was being built. The functions are pure and
 * fast, so there is no excuse for not pinning them down.
 *
 * The tar cases build their archives here rather than checking in a fixture,
 * which keeps the NUL padding, the octal fields and the GNU long-name record
 * visible in the test itself -- those are the parts that are easy to get wrong.
 */

import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { zipDirectory, unzip, untargz, listZip, hashFile } = require('../../../build-scripts/hub-archive.js');

/** @type {string} */
let work;

beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'hub-archive-'));
});

afterAll(() => {
    rmSync(work, { recursive: true, force: true });
});

/**
 * One 512-byte ustar header.
 *
 * @param {{ name?: string, size?: number, mode?: number, type?: string, prefix?: string }} fields
 * @returns {Buffer}
 */
function tarHeader(fields) {
    const header = Buffer.alloc(512);
    const put = (text, start, length) => header.write(text.slice(0, length), start, 'utf8');

    put(fields.name ?? '', 0, 100);
    // Numeric fields are NUL-terminated octal, which is the padding the parser
    // has to see through.
    put(`${(fields.mode ?? 0o644).toString(8).padStart(7, '0')}\0`, 100, 8);
    put('0000000\0', 108, 8);
    put('0000000\0', 116, 8);
    put(`${(fields.size ?? 0).toString(8).padStart(11, '0')}\0`, 124, 12);
    put('00000000000\0', 136, 12);
    header.write(fields.type ?? '0', 156, 'utf8');
    put('ustar\0', 257, 6);
    put('00', 263, 2);
    put(fields.prefix ?? '', 345, 155);

    // Checksum is computed with the field itself read as spaces.
    header.write('        ', 148, 8, 'utf8');
    let sum = 0;
    for (const byte of header) {
        sum += byte;
    }
    put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    return header;
}

/**
 * @param {{ name?: string, body?: Buffer, mode?: number, type?: string, prefix?: string }[]} entries
 * @returns {Buffer} a gzipped tar
 */
function makeTarGz(entries) {
    /** @type {Buffer[]} */
    const parts = [];
    for (const entry of entries) {
        const body = entry.body ?? Buffer.alloc(0);
        parts.push(tarHeader({ ...entry, size: body.length }));
        parts.push(body);
        const padding = (512 - (body.length % 512)) % 512;
        if (padding) {
            parts.push(Buffer.alloc(padding));
        }
    }
    // Two zero blocks terminate the archive.
    parts.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(parts));
}

describe('hub archive helpers', () => {
    describe('zip', () => {
        it('round-trips content through a zip it wrote itself', () => {
            const src = join(work, 'rt-src');
            mkdirSync(join(src, 'nested'), { recursive: true });
            // Highly compressible, so this entry takes the deflate path.
            writeFileSync(join(src, 'text.txt'), 'a'.repeat(4096));
            // Incompressible, so this one is stored instead.
            const random = Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 2654435761) % 256));
            writeFileSync(join(src, 'nested', 'blob.bin'), random);

            const zip = join(work, 'rt.zip');
            const result = zipDirectory(src, zip, () => 0o100644);
            expect(result.files).toBe(2);

            const out = join(work, 'rt-out');
            unzip(zip, out);

            expect(hashFile(join(out, 'text.txt'), 'sha256')).toBe(hashFile(join(src, 'text.txt'), 'sha256'));
            expect(hashFile(join(out, 'nested', 'blob.bin'), 'sha256')).toBe(
                hashFile(join(src, 'nested', 'blob.bin'), 'sha256')
            );
        });

        it('keeps the executable bit, which is the whole point of writing zips by hand', () => {
            const src = join(work, 'mode-src');
            mkdirSync(src, { recursive: true });
            writeFileSync(join(src, 'start-hub.sh'), '#!/bin/sh\n');
            writeFileSync(join(src, 'README.txt'), 'hello\n');

            const zip = join(work, 'mode.zip');
            zipDirectory(src, zip, (rel) => (rel.endsWith('start-hub.sh') ? 0o100755 : 0o100644));

            const entries = listZip(zip);
            const launcher = entries.find((e) => e.name === 'start-hub.sh');
            const readme = entries.find((e) => e.name === 'README.txt');

            expect(launcher?.mode & 0o777).toBe(0o755);
            expect(readme?.mode & 0o777).toBe(0o644);
        });

        it('honours a rename callback and skips what it returns null for', () => {
            const src = join(work, 'sel-src');
            mkdirSync(src, { recursive: true });
            writeFileSync(join(src, 'keep.txt'), 'keep');
            writeFileSync(join(src, 'drop.txt'), 'drop');

            const zip = join(work, 'sel.zip');
            zipDirectory(src, zip, () => 0o100644);

            const out = join(work, 'sel-out');
            unzip(zip, out, (name) => (name === 'keep.txt' ? 'renamed.txt' : null));

            expect(readFileSync(join(out, 'renamed.txt'), 'utf8')).toBe('keep');
            expect(() => readFileSync(join(out, 'drop.txt'))).toThrow();
        });

        it('uses forward slashes in entry names regardless of the build host', () => {
            const src = join(work, 'sep-src');
            mkdirSync(join(src, 'a', 'b'), { recursive: true });
            writeFileSync(join(src, 'a', 'b', 'c.txt'), 'x');

            const zip = join(work, 'sep.zip');
            zipDirectory(src, zip, () => 0o100644);

            expect(listZip(zip).map((e) => e.name)).toEqual(['a/b/c.txt']);
        });
    });

    describe('tar.gz', () => {
        it('reads names, bodies and modes out of NUL-padded headers', () => {
            const archive = join(work, 'basic.tar.gz');
            writeFileSync(
                archive,
                makeTarGz([
                    { name: 'bin/node', body: Buffer.from('binary'), mode: 0o755 },
                    { name: 'LICENSE', body: Buffer.from('license text'), mode: 0o644 }
                ])
            );

            const out = join(work, 'basic-out');
            untargz(archive, out);

            expect(readFileSync(join(out, 'bin', 'node'), 'utf8')).toBe('binary');
            expect(readFileSync(join(out, 'LICENSE'), 'utf8')).toBe('license text');
        });

        it('joins the prefix field, which is how long paths are stored', () => {
            const archive = join(work, 'prefix.tar.gz');
            writeFileSync(
                archive,
                makeTarGz([
                    { prefix: 'shared/Microsoft.NETCore.App/10.0.12', name: 'System.dll', body: Buffer.from('dll') }
                ])
            );

            const out = join(work, 'prefix-out');
            untargz(archive, out);

            expect(readFileSync(join(out, 'shared', 'Microsoft.NETCore.App', '10.0.12', 'System.dll'), 'utf8')).toBe(
                'dll'
            );
        });

        it('follows a GNU long-name record to the entry it describes', () => {
            const longPath = `deeply/${'nested/'.repeat(20)}file.txt`;
            expect(longPath.length).toBeGreaterThan(100);

            const archive = join(work, 'longname.tar.gz');
            writeFileSync(
                archive,
                makeTarGz([
                    { name: '././@LongLink', type: 'L', body: Buffer.from(`${longPath}\0`) },
                    { name: longPath.slice(0, 99), body: Buffer.from('deep') }
                ])
            );

            const out = join(work, 'longname-out');
            untargz(archive, out);

            expect(readFileSync(join(out, longPath), 'utf8')).toBe('deep');
        });

        it('skips directories and symlinks but keeps regular files', () => {
            const archive = join(work, 'types.tar.gz');
            writeFileSync(
                archive,
                makeTarGz([
                    { name: 'dir/', type: '5' },
                    { name: 'link', type: '2' },
                    { name: 'real.txt', type: '0', body: Buffer.from('real') }
                ])
            );

            const out = join(work, 'types-out');
            untargz(archive, out);

            expect(readFileSync(join(out, 'real.txt'), 'utf8')).toBe('real');
            expect(() => readFileSync(join(out, 'link'))).toThrow();
        });

        it('treats a zero type byte as a regular file, the way older tars write it', () => {
            const archive = join(work, 'zerotype.tar.gz');
            writeFileSync(archive, makeTarGz([{ name: 'old.txt', type: '\0', body: Buffer.from('old') }]));

            const out = join(work, 'zerotype-out');
            untargz(archive, out);

            expect(readFileSync(join(out, 'old.txt'), 'utf8')).toBe('old');
        });
    });

    it('has no NUL bytes in its own source, which would make git treat it as binary', () => {
        const source = readFileSync(new URL('../../../build-scripts/hub-archive.js', import.meta.url));
        expect(source.includes(0)).toBe(false);
    });
});
