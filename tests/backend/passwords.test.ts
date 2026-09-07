import { pbkdf2Sync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { passwordHash } from '../../worker/passwords';

const unsupported = async (): Promise<Uint8Array> => {
  throw new DOMException(
    'Pbkdf2 failed: iteration counts above 100000 are not supported',
    'NotSupportedError',
  );
};

describe('portable password derivation', () => {
  it('matches Node crypto and native WebCrypto at the complete 600,000-iteration cost', async () => {
    const password = 'a long independently checked password';
    const salt = '65a739dcdb08c047ac81215471c662836b84e8fd3258ec5049761ac4d3d01bee7';
    const expected = `pbkdf2-sha256:600000:${salt}:${pbkdf2Sync(password, salt, 600000, 32, 'sha256').toString('hex')}`;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await passwordHash(password, salt)).toBe(expected);
      expect(await passwordHash(password, salt, 600000, unsupported)).toBe(expected);
      expect(warning).toHaveBeenCalledWith(expect.any(String), {
        name: 'NotSupportedError',
        iterations: 600000,
        nativeIterationLimit: 100000,
      });
    } finally {
      warning.mockRestore();
    }
  });

  it('preserves UTF-8 and legacy 100,000-iteration hashes across implementations', async () => {
    const password = 'pāsswörd 🦆\u0000with suffix';
    const salt = '100e2a0f14ccb442ac7fc632997c79c5c68db9be7185041c991005982abfe92f';
    const expected = `pbkdf2-sha256:100000:${salt}:${pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex')}`;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await passwordHash(password, salt, 100000)).toBe(expected);
      expect(await passwordHash(password, salt, 100000, unsupported)).toBe(expected);
    } finally {
      warning.mockRestore();
    }
  });

  it('propagates unexpected native errors without falling back or logging input values', async () => {
    const failure = new DOMException('sensitive-looking runtime payload', 'OperationError');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        passwordHash('secret-password', 'private-salt', 600000, async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(warning).not.toHaveBeenCalled();
      expect(diagnostic).toHaveBeenCalledExactlyOnceWith('Native password derivation failed', {
        name: 'OperationError',
      });
    } finally {
      warning.mockRestore();
      diagnostic.mockRestore();
    }
  });

  it('rejects unrecognized work factors instead of silently lowering the cost', async () => {
    await expect(passwordHash('password', 'salt', 1)).rejects.toThrow('work factor');
  });
});
