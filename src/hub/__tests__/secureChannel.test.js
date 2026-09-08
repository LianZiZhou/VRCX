/**
 * [hub] Tests for the pre-shared-key AEAD channel.
 *
 * These are the tests that matter most in the whole Hub: a mistake here is a
 * silent loss of confidentiality rather than a visible failure, so each
 * property the design relies on is asserted explicitly.
 */

import {
    buildAuthProof,
    ChannelSecurityError,
    createOpener,
    createSealer,
    deriveChannelKeys,
    isValidAuthProof,
    randomNonce
} from '../shared/secureChannel.js';

const TOKEN = 'a-shared-hub-token-with-plenty-of-entropy';

async function keyPair(token = TOKEN, clientNonce = randomNonce(), serverNonce = randomNonce()) {
    const keys = await deriveChannelKeys(token, clientNonce, serverNonce);
    return { keys, clientNonce, serverNonce };
}

describe('nonces', () => {
    it('are random and hex-encoded', () => {
        const a = randomNonce();
        const b = randomNonce();
        expect(a).toMatch(/^[0-9a-f]{32}$/);
        expect(a).not.toBe(b);
    });
});

describe('key derivation', () => {
    it('produces different keys for each direction', async () => {
        const { keys } = await keyPair();
        const sealer = createSealer(keys.clientToServer);
        const wrongOpener = createOpener(
            keys.clientToServer === keys.serverToClient ? keys.clientToServer : keys.serverToClient
        );

        const sealed = await sealer.seal({ hello: 'world' });
        // Sealed with the c2s key, opened with the s2c key: must fail.
        await expect(wrongOpener.open(sealed)).rejects.toBeInstanceOf(ChannelSecurityError);
    });

    it('produces the same keys on both sides from the same inputs', async () => {
        const clientNonce = randomNonce();
        const serverNonce = randomNonce();
        const client = await deriveChannelKeys(TOKEN, clientNonce, serverNonce);
        const server = await deriveChannelKeys(TOKEN, clientNonce, serverNonce);

        const sealed = await createSealer(client.clientToServer).seal({ n: 1 });
        await expect(createOpener(server.clientToServer).open(sealed)).resolves.toEqual({ n: 1 });
    });

    it('produces unrelated keys for a different token', async () => {
        const clientNonce = randomNonce();
        const serverNonce = randomNonce();
        const right = await deriveChannelKeys(TOKEN, clientNonce, serverNonce);
        const wrong = await deriveChannelKeys('a-different-token', clientNonce, serverNonce);

        const sealed = await createSealer(wrong.clientToServer).seal({ n: 1 });
        await expect(createOpener(right.clientToServer).open(sealed)).rejects.toBeInstanceOf(ChannelSecurityError);
    });

    it('produces unrelated keys for a different handshake, so frames cannot cross connections', async () => {
        const first = await deriveChannelKeys(TOKEN, randomNonce(), randomNonce());
        const second = await deriveChannelKeys(TOKEN, randomNonce(), randomNonce());

        const sealed = await createSealer(first.clientToServer).seal({ n: 1 });
        await expect(createOpener(second.clientToServer).open(sealed)).rejects.toBeInstanceOf(ChannelSecurityError);
    });

    it('refuses to derive without a token or nonces', async () => {
        await expect(deriveChannelKeys('', 'a', 'b')).rejects.toThrow(/token is required/i);
        await expect(deriveChannelKeys(TOKEN, '', 'b')).rejects.toThrow(/nonces are required/i);
    });
});

describe('sealing and opening', () => {
    it('round-trips a frame', async () => {
        const { keys } = await keyPair();
        const sealer = createSealer(keys.clientToServer);
        const opener = createOpener(keys.clientToServer);

        const frame = { i: 7, t: 'call', p: { c: 'SQLite', m: 'Execute', a: ['SELECT 1', null] } };
        await expect(opener.open(await sealer.seal(frame))).resolves.toEqual(frame);
    });

    it('does not leave plaintext on the wire', async () => {
        const { keys } = await keyPair();
        const sealed = await createSealer(keys.clientToServer).seal({
            secret: 'auth_cookie_value_12345'
        });
        const asText = new TextDecoder().decode(sealed);
        expect(asText).not.toContain('auth_cookie_value_12345');
        expect(asText).not.toContain('secret');
    });

    it('preserves order under concurrent seals', async () => {
        const { keys } = await keyPair();
        const sealer = createSealer(keys.clientToServer);
        const opener = createOpener(keys.clientToServer);

        // Fire them all off at once; encryption is async, so without the send
        // chain these could resolve out of order and break the counter.
        const sealedAll = await Promise.all(Array.from({ length: 25 }, (_, n) => sealer.seal({ n })));

        const opened = [];
        for (const sealed of sealedAll) {
            opened.push(await opener.open(sealed));
        }
        expect(opened.map((frame) => frame.n)).toEqual(Array.from({ length: 25 }, (_, n) => n));
    });

    it('uses a fresh counter for every frame', async () => {
        const { keys } = await keyPair();
        const sealer = createSealer(keys.clientToServer);
        const a = await sealer.seal({ n: 1 });
        const b = await sealer.seal({ n: 1 });

        const counterOf = (bytes) =>
            new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, false);
        expect(counterOf(a)).toBe(0n);
        expect(counterOf(b)).toBe(1n);
        // Identical plaintext, different ciphertext: the IV really is unique.
        expect(a.subarray(8)).not.toEqual(b.subarray(8));
    });
});

describe('tamper and replay resistance', () => {
    it('rejects a modified ciphertext', async () => {
        const { keys } = await keyPair();
        const sealed = await createSealer(keys.clientToServer).seal({ amount: 1 });
        sealed[sealed.length - 3] ^= 0xff;

        await expect(createOpener(keys.clientToServer).open(sealed)).rejects.toThrow(/failed authentication/i);
    });

    it('rejects a replayed frame', async () => {
        const { keys } = await keyPair();
        const sealer = createSealer(keys.clientToServer);
        const opener = createOpener(keys.clientToServer);

        const first = await sealer.seal({ n: 0 });
        await opener.open(first);

        await expect(opener.open(first)).rejects.toThrow(/replayed or reordered/i);
    });

    it('rejects a dropped or reordered frame', async () => {
        const { keys } = await keyPair();
        const sealer = createSealer(keys.clientToServer);
        const opener = createOpener(keys.clientToServer);

        await sealer.seal({ n: 0 });
        const second = await sealer.seal({ n: 1 });

        // Frame 0 was never delivered.
        await expect(opener.open(second)).rejects.toThrow(/dropped hub frame/i);
    });

    it('rejects a truncated frame', async () => {
        const { keys } = await keyPair();
        const opener = createOpener(keys.clientToServer);
        await expect(opener.open(new Uint8Array(4))).rejects.toThrow(/truncated/i);
    });
});

describe('proof of possession', () => {
    it('binds the proof to both handshake nonces', async () => {
        const clientNonce = randomNonce();
        const serverNonce = randomNonce();
        const proof = buildAuthProof(clientNonce, serverNonce);

        expect(isValidAuthProof(proof, clientNonce, serverNonce)).toBe(true);
        expect(isValidAuthProof(proof, randomNonce(), serverNonce)).toBe(false);
        expect(isValidAuthProof(proof, clientNonce, randomNonce())).toBe(false);
        expect(isValidAuthProof({ proof: 'nope' }, clientNonce, serverNonce)).toBe(false);
        expect(isValidAuthProof(null, clientNonce, serverNonce)).toBe(false);
    });

    it('cannot be forged without the token', async () => {
        const clientNonce = randomNonce();
        const serverNonce = randomNonce();
        const server = await deriveChannelKeys(TOKEN, clientNonce, serverNonce);
        const attacker = await deriveChannelKeys('guessed-token', clientNonce, serverNonce);

        const forged = await createSealer(attacker.clientToServer).seal(buildAuthProof(clientNonce, serverNonce));

        await expect(createOpener(server.clientToServer).open(forged)).rejects.toBeInstanceOf(ChannelSecurityError);
    });
});
