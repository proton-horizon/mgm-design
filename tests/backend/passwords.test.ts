import { pbkdf2Sync, scryptSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  DUMMY_PASSWORD_HASH,
  NativePasswordHasher,
  PasswordCompatibilityError,
  SCRYPT_MAXMEM,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  passwordHasher,
} from '../../worker/passwords';

const salt = '0123456789abcdef'.repeat(4);
const options = { N: 16384, r: 8, p: 5, maxmem: 24 * 1024 * 1024 };
const legacyRecord = (password: string, iterations: number) =>
  `pbkdf2-sha256:${iterations}:${salt}:${pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('hex')}`;

describe('native password hashing', () => {
  it('matches independent synchronous Node derivation with UTF-8 hexadecimal salt bytes', async () => {
    const password = 'independently verified password';
    const record = await passwordHasher.hash(password);
    expect(record).toMatch(/^scrypt:16384:8:5:[a-f0-9]{64}:[a-f0-9]{64}$/);
    const parts = record.split(':');
    expect(parts[5]).toBe(scryptSync(password, parts[4], 32, options).toString('hex'));
    expect(await passwordHasher.verify(password, record)).toEqual({
      valid: true,
      needsRehash: false,
    });
    expect(await passwordHasher.verify('a different password', record)).toEqual({
      valid: false,
      needsRehash: false,
    });
    expect({ N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM }).toEqual(options);
  });

  it('preserves Unicode, embedded NUL and suffix bytes and gives identical passwords unique salts', async () => {
    const password = 'pāsswörd 🦆\u0000suffix';
    const first = await passwordHasher.hash(password);
    const second = await passwordHasher.hash(password);
    expect(first.split(':')[4]).not.toBe(second.split(':')[4]);
    expect(await passwordHasher.verify(password, first)).toEqual({
      valid: true,
      needsRehash: false,
    });
    expect(await passwordHasher.verify(password.split('\u0000')[0], first)).toEqual({
      valid: false,
      needsRehash: false,
    });
    expect(first.split(':')[5]).toBe(
      scryptSync(password, first.split(':')[4], 32, options).toString('hex'),
    );
  });

  it.each([100000, 600000])(
    'verifies legacy PBKDF2 at %i iterations and requests migration only after a match',
    async (iterations) => {
      const password = 'legacy pāssword 🦆\u0000suffix';
      const record = legacyRecord(password, iterations);
      expect(await passwordHasher.verify(password, record)).toEqual({
        valid: true,
        needsRehash: true,
      });
      expect(await passwordHasher.verify('wrong legacy password', record)).toEqual({
        valid: false,
        needsRehash: false,
      });
    },
  );

  it('rejects malformed, oversized and unapproved records before invoking native derivation', async () => {
    const scrypt = vi.fn();
    const pbkdf2 = vi.fn();
    const hasher = new NativePasswordHasher({ scrypt, pbkdf2 });
    const records = [
      '',
      'x'.repeat(100000),
      DUMMY_PASSWORD_HASH.replace('16384', '1073741824'),
      DUMMY_PASSWORD_HASH.replace(':8:5:', ':8:999999:'),
      DUMMY_PASSWORD_HASH.replace(':8:5:', ':8:1:'),
      DUMMY_PASSWORD_HASH + ':trailing',
      DUMMY_PASSWORD_HASH.slice(0, -1),
      DUMMY_PASSWORD_HASH.replace('000000', 'INVALID'),
      `pbkdf2-sha256:999999999:${salt}:${'0'.repeat(64)}`,
      `pbkdf2-sha256:600000:${'f'.repeat(10000)}:${'0'.repeat(64)}`,
    ];
    for (const record of records)
      expect(await hasher.verify('password', record)).toEqual({ valid: false, needsRehash: false });
    expect(await hasher.verify('x'.repeat(257), DUMMY_PASSWORD_HASH)).toEqual({
      valid: false,
      needsRehash: false,
    });
    expect(scrypt).not.toHaveBeenCalled();
    expect(pbkdf2).not.toHaveBeenCalled();
  });

  it('reports unsupported native legacy derivation without logging or exposing credential material', async () => {
    const hasher = new NativePasswordHasher({
      scrypt: vi.fn(),
      pbkdf2: async () => {
        throw new DOMException('runtime details', 'NotSupportedError');
      },
    });
    const diagnostic = vi.spyOn(console, 'error');
    const warning = vi.spyOn(console, 'warn');
    try {
      await expect(
        hasher.verify('private-password', `pbkdf2-sha256:600000:${salt}:${'0'.repeat(64)}`),
      ).rejects.toBeInstanceOf(PasswordCompatibilityError);
      expect(diagnostic).not.toHaveBeenCalled();
      expect(warning).not.toHaveBeenCalled();
    } finally {
      diagnostic.mockRestore();
      warning.mockRestore();
    }
  });

  it('propagates unexpected native failures and rejects invalid new passwords without changing the KDF', async () => {
    const failure = new DOMException('native failure', 'OperationError');
    const hasher = new NativePasswordHasher({
      scrypt: async () => {
        throw failure;
      },
      pbkdf2: async () => {
        throw failure;
      },
    });
    await expect(hasher.hash('a sufficiently long password')).rejects.toBe(failure);
    await expect(
      hasher.verify('password', `pbkdf2-sha256:600000:${salt}:${'0'.repeat(64)}`),
    ).rejects.toBe(failure);
    await expect(passwordHasher.hash('too short')).rejects.toThrow('12–256');
  });

  it('uses the current expensive derivation for nonexistent-account dummy verification', async () => {
    const scrypt = vi.fn(async () => new Uint8Array(32).fill(1));
    const pbkdf2 = vi.fn();
    const hasher = new NativePasswordHasher({ scrypt, pbkdf2 });
    expect(await hasher.verify('unknown account password', DUMMY_PASSWORD_HASH)).toEqual({
      valid: false,
      needsRehash: false,
    });
    expect(scrypt).toHaveBeenCalledOnce();
    expect(pbkdf2).not.toHaveBeenCalled();
  });
});
