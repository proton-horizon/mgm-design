import { scrypt, timingSafeEqual } from 'node:crypto';

export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 5;
export const SCRYPT_MAXMEM = 24 * 1024 * 1024;
export const PASSWORD_KEY_BYTES = 32;
export const DUMMY_PASSWORD_HASH = `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${'0'.repeat(64)}:${'0'.repeat(64)}`;

export interface PasswordVerification {
  valid: boolean;
  needsRehash: boolean;
}

/**
 * Creates randomly salted credentials and verifies bounded, recognized stored formats.
 * Verification never modifies persistence; a valid legacy record requests an atomic replacement.
 * Unsupported native legacy derivation throws PasswordCompatibilityError, preserving the record.
 */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, record: string): Promise<PasswordVerification>;
}

/** Native derivation boundary. Inputs are UTF-8 password and UTF-8 hexadecimal salt bytes. */
export interface PasswordKdf {
  scrypt(password: Uint8Array, salt: Uint8Array): Promise<Uint8Array>;
  pbkdf2(password: Uint8Array, salt: Uint8Array, iterations: 100000 | 600000): Promise<Uint8Array>;
}

export class PasswordCompatibilityError extends Error {
  constructor() {
    super('The stored password format is not supported by this runtime.');
    this.name = 'PasswordCompatibilityError';
  }
}

const encoder = new TextEncoder();
const invalid: PasswordVerification = Object.freeze({ valid: false, needsRehash: false });
const nativeKdf: PasswordKdf = {
  scrypt(password, salt) {
    return new Promise((resolve, reject) => {
      scrypt(
        password,
        salt,
        PASSWORD_KEY_BYTES,
        {
          N: SCRYPT_N,
          r: SCRYPT_R,
          p: SCRYPT_P,
          maxmem: SCRYPT_MAXMEM,
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(new Uint8Array(result));
        },
      );
    });
  },
  async pbkdf2(password, salt, iterations) {
    const key = await crypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
        key,
        256,
      ),
    );
  },
};

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function compare(result: Uint8Array, expected: string) {
  if (result.length !== PASSWORD_KEY_BYTES)
    throw new Error('Unexpected password derivation length.');
  const bytes = new Uint8Array(PASSWORD_KEY_BYTES);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(expected.slice(i * 2, i * 2 + 2), 16);
  return timingSafeEqual(result, bytes);
}

export class NativePasswordHasher implements PasswordHasher {
  constructor(private readonly kdf: PasswordKdf = nativeKdf) {}

  async hash(password: string): Promise<string> {
    if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
      throw new RangeError('Password must contain 12–256 characters.');
    }
    const salt = hex(crypto.getRandomValues(new Uint8Array(32)));
    const result = await this.kdf.scrypt(encoder.encode(password), encoder.encode(salt));
    if (result.length !== PASSWORD_KEY_BYTES)
      throw new Error('Unexpected password derivation length.');
    return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt}:${hex(result)}`;
  }

  async verify(password: string, record: string): Promise<PasswordVerification> {
    if (
      typeof password !== 'string' ||
      password.length > 256 ||
      typeof record !== 'string' ||
      record.length > 160
    )
      return invalid;
    // Exact whitelists bound cost and allocation before entering either native derivation.
    const current = /^scrypt:16384:8:5:([a-f0-9]{64}):([a-f0-9]{64})$/.exec(record);
    if (current) {
      const result = await this.kdf.scrypt(encoder.encode(password), encoder.encode(current[1]));
      return { valid: compare(result, current[2]), needsRehash: false };
    }
    const legacy = /^pbkdf2-sha256:(100000|600000):([a-f0-9]{64}):([a-f0-9]{64})$/.exec(record);
    if (!legacy) return invalid;
    let result: Uint8Array;
    try {
      result = await this.kdf.pbkdf2(
        encoder.encode(password),
        encoder.encode(legacy[2]),
        Number(legacy[1]) as 100000 | 600000,
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'NotSupportedError')
        throw new PasswordCompatibilityError();
      throw error;
    }
    const valid = compare(result, legacy[3]);
    return { valid, needsRehash: valid };
  }
}

export const passwordHasher: PasswordHasher = new NativePasswordHasher();
