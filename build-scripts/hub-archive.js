/**
 * [hub] Archive helpers for the release packager.
 *
 * Deliberately dependency-free. The packager runs on whatever host happens to
 * be building -- a maintainer's Windows box, a Linux CI runner -- and has to
 * read archives meant for *other* platforms, so relying on whichever `unzip`
 * or `tar` the host provides makes the output depend on the build machine.
 *
 * The one thing that genuinely matters here is the Unix permission bits. A zip
 * carries them in the central directory's external-attributes field, and if
 * they are lost the extracted `node` binary and `start.sh` come out
 * non-executable -- which is precisely the "unzip and run" promise the release
 * is making. `Compress-Archive` on Windows drops them, so we write the
 * container ourselves.
 *
 * Reading is only needed for the Windows artifacts (the .NET runtime and Node
 * both ship Windows builds as .zip and nothing else). Everything else is
 * .tar.gz, which is handled here too so the whole pipeline stays in-process.
 */

const { createHash } = require('node:crypto');
const { mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } = require('node:fs');
const { dirname, join, relative, sep } = require('node:path');
const zlib = require('node:zlib');

/** Fixed DOS timestamp (1980-01-01) so repeated builds produce identical zips. */
const DOS_TIME = 0;
const DOS_DATE = 33;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** Central-directory "version made by": UNIX (3) << 8, so the mode bits are honoured. */
const MADE_BY_UNIX = 0x031e;

let crcTable = null;

/**
 * @param {Buffer} buf
 * @returns {number}
 */
function crc32(buf) {
    if (!crcTable) {
        crcTable = new Int32Array(256);
        for (let i = 0; i < 256; i += 1) {
            let c = i;
            for (let k = 0; k < 8; k += 1) {
                c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            }
            crcTable[i] = c;
        }
    }
    let crc = -1;
    for (let i = 0; i < buf.length; i += 1) {
        crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
    }
    return (crc ^ -1) >>> 0;
}

/**
 * Every file under `dir`, as paths relative to it, depth first and sorted so
 * the archive order is stable.
 *
 * @param {string} dir
 * @param {string} [base]
 * @returns {string[]}
 */
function walk(dir, base = dir) {
    /** @type {string[]} */
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...walk(full, base));
        } else if (entry.isFile()) {
            out.push(relative(base, full));
        }
        // Symlinks are skipped: nothing we ship uses them, and storing them
        // correctly would mean a second entry type for no benefit.
    }
    return out;
}

/**
 * Write `dir` to a zip, asking `modeFor` what Unix mode each entry should carry.
 *
 * @param {string} dir
 * @param {string} outFile
 * @param {(relPath: string) => number} modeFor
 * @returns {{ files: number, bytes: number }}
 */
function zipDirectory(dir, outFile, modeFor) {
    const files = walk(dir);
    if (files.length > 0xffff) {
        // Past this the End Of Central Directory record needs zip64. Nothing
        // we ship comes close, so fail loudly rather than emit a broken zip.
        throw new Error(`${outFile}: ${files.length} entries needs zip64, which this writer does not implement`);
    }

    /** @type {Buffer[]} */
    const parts = [];
    /** @type {Buffer[]} */
    const central = [];
    let offset = 0;

    for (const rel of files) {
        const data = readFileSync(join(dir, rel));
        const deflated = zlib.deflateRawSync(data, { level: 9 });
        // Incompressible files (most of the .NET runtime is already packed)
        // get stored, which is both smaller and faster to unpack.
        const store = deflated.length >= data.length;
        const payload = store ? data : deflated;
        const method = store ? 0 : 8;
        const crc = crc32(data);
        const nameBytes = Buffer.from(rel.split(sep).join('/'), 'utf8');

        const local = Buffer.alloc(30);
        local.writeUInt32LE(SIG_LOCAL, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x800, 6); // UTF-8 names
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(DOS_TIME, 10);
        local.writeUInt16LE(DOS_DATE, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(payload.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        parts.push(local, nameBytes, payload);

        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(SIG_CENTRAL, 0);
        entry.writeUInt16LE(MADE_BY_UNIX, 4);
        entry.writeUInt16LE(20, 6);
        entry.writeUInt16LE(0x800, 8);
        entry.writeUInt16LE(method, 10);
        entry.writeUInt16LE(DOS_TIME, 12);
        entry.writeUInt16LE(DOS_DATE, 14);
        entry.writeUInt32LE(crc, 16);
        entry.writeUInt32LE(payload.length, 20);
        entry.writeUInt32LE(data.length, 24);
        entry.writeUInt16LE(nameBytes.length, 28);
        // The high half of the external attributes is the Unix mode. This is
        // the whole reason this writer exists.
        entry.writeUInt32LE(((modeFor(rel) & 0xffff) >>> 0) * 0x10000, 38);
        entry.writeUInt32LE(offset, 42);
        central.push(entry, nameBytes);

        offset += local.length + nameBytes.length + payload.length;
    }

    const centralBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);

    const out = Buffer.concat([...parts, centralBuf, eocd]);
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, out);
    return { files: files.length, bytes: out.length };
}

/**
 * Extract a zip, creating directories as needed. Modes in the archive are
 * ignored: the only zips we read are Microsoft's and Node's Windows builds.
 *
 * @param {string} archive
 * @param {string} destDir
 * @param {(relPath: string) => (string | null)} [rename] - return null to skip an entry
 */
function unzip(archive, destDir, rename = (p) => p) {
    const buf = readFileSync(archive);

    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i > buf.length - 0x10000; i -= 1) {
        if (buf.readUInt32LE(i) === SIG_EOCD) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) {
        throw new Error(`${archive}: no end-of-central-directory record`);
    }

    const count = buf.readUInt16LE(eocd + 10);
    let pos = buf.readUInt32LE(eocd + 16);

    for (let i = 0; i < count; i += 1) {
        if (buf.readUInt32LE(pos) !== SIG_CENTRAL) {
            throw new Error(`${archive}: corrupt central directory at entry ${i}`);
        }
        const method = buf.readUInt16LE(pos + 10);
        const compressedSize = buf.readUInt32LE(pos + 20);
        const nameLen = buf.readUInt16LE(pos + 28);
        const extraLen = buf.readUInt16LE(pos + 30);
        const commentLen = buf.readUInt16LE(pos + 32);
        const localOffset = buf.readUInt32LE(pos + 42);
        const entryName = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
        pos += 46 + nameLen + extraLen + commentLen;

        if (entryName.endsWith('/')) {
            continue;
        }
        const target = rename(entryName);
        if (target === null) {
            continue;
        }

        // The local header's name/extra lengths are the authoritative ones for
        // locating the payload; they can differ from the central copy.
        const localNameLen = buf.readUInt16LE(localOffset + 26);
        const localExtraLen = buf.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + localNameLen + localExtraLen;
        const raw = buf.subarray(start, start + compressedSize);
        const data = method === 0 ? raw : zlib.inflateRawSync(raw);

        const outPath = join(destDir, target);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, data);
    }
}

/**
 * Read one NUL-padded field out of a tar header.
 *
 * Written against the buffer rather than a decoded string so the source needs
 * no NUL literal of its own: a real one in here makes git classify the file as
 * binary, which silently turns off end-of-line normalisation.
 *
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} end
 * @returns {string}
 */
function tarField(buf, start, end) {
    const slice = buf.subarray(start, end);
    const terminator = slice.indexOf(0);
    return slice.toString('utf8', 0, terminator === -1 ? slice.length : terminator);
}

/**
 * Extract a .tar.gz.
 *
 * Only the entry types the Microsoft and Node tarballs actually use are
 * handled: files, directories, and the GNU long-name extension. Symlinks are
 * skipped -- Node's tarball has a couple in its share/ tree, none of which we
 * ship.
 *
 * @param {string} archive
 * @param {string} destDir
 * @param {(relPath: string) => (string | null)} [rename] - return null to skip an entry
 */
function untargz(archive, destDir, rename = (p) => p) {
    const tar = zlib.gunzipSync(readFileSync(archive));
    let pos = 0;
    /** @type {string | null} */
    let longName = null;

    while (pos + 512 <= tar.length) {
        const header = tar.subarray(pos, pos + 512);
        // Two zero blocks mark the end of the archive.
        if (header.every((b) => b === 0)) {
            break;
        }

        const rawName = tarField(header, 0, 100);
        const prefix = tarField(header, 345, 500);
        const sizeField = tarField(header, 124, 136).trim();
        const size = parseInt(sizeField, 8) || 0;
        const mode = parseInt(tarField(header, 100, 108).trim(), 8) || 0o644;
        // 0x30 is '0', a regular file; a zero byte means the same in older
        // archives. Compared numerically so the check reads off the byte.
        const typeByte = header[156];
        const type = String.fromCharCode(typeByte);
        const blocks = Math.ceil(size / 512);
        const body = tar.subarray(pos + 512, pos + 512 + size);
        pos += 512 + blocks * 512;

        if (type === 'L') {
            // GNU long name: the next header's name comes from this body.
            longName = tarField(body, 0, body.length);
            continue;
        }

        const entryName = longName ?? (prefix ? `${prefix}/${rawName}` : rawName);
        longName = null;

        if (type === '5' || entryName.endsWith('/')) {
            continue;
        }
        if (typeByte !== 0x30 && typeByte !== 0) {
            // Symlinks (2), hard links (1), and anything exotic.
            continue;
        }

        const target = rename(entryName);
        if (target === null) {
            continue;
        }

        const outPath = join(destDir, target);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, body);
        if (process.platform !== 'win32') {
            chmodSync(outPath, mode & 0o777);
        }
    }
}

/**
 * The entries of a zip, with the Unix mode each one carries.
 *
 * Used to check a finished archive rather than trusting that what was staged
 * is what got written -- in particular that the launcher is still executable,
 * which is the one property a Windows build host cannot observe any other way.
 *
 * @param {string} archive
 * @returns {{ name: string, mode: number }[]}
 */
function listZip(archive) {
    const buf = readFileSync(archive);

    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i > buf.length - 0x10000; i -= 1) {
        if (buf.readUInt32LE(i) === SIG_EOCD) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) {
        throw new Error(`${archive}: no end-of-central-directory record`);
    }

    const count = buf.readUInt16LE(eocd + 10);
    let pos = buf.readUInt32LE(eocd + 16);
    /** @type {{ name: string, mode: number }[]} */
    const entries = [];

    for (let i = 0; i < count; i += 1) {
        const nameLen = buf.readUInt16LE(pos + 28);
        const extraLen = buf.readUInt16LE(pos + 30);
        const commentLen = buf.readUInt16LE(pos + 32);
        entries.push({
            name: buf.toString('utf8', pos + 46, pos + 46 + nameLen),
            mode: buf.readUInt32LE(pos + 38) >>> 16
        });
        pos += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

/**
 * @param {string} file
 * @param {'sha256' | 'sha512'} algorithm
 * @returns {string} lowercase hex digest
 */
function hashFile(file, algorithm) {
    return createHash(algorithm).update(readFileSync(file)).digest('hex');
}

module.exports = { zipDirectory, unzip, untargz, listZip, hashFile, walk };
