import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';

export const PASSWORD_ITERATIONS = 600000;
const encoder = new TextEncoder();

/** Computes standard PBKDF2-HMAC-SHA256 with a 32-byte result, preserving UTF-8 input bytes. */
export type NativePbkdf2 = (
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
) => Promise<Uint8Array>;

const nativePbkdf2: NativePbkdf2 = async (password, salt, iterations) => {
  const key = await crypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256),
  );
};

/**
 * Hashes new credentials at 600,000 iterations and verifies the initial 100,000-iteration format.
 * Native and portable derivation produce identical bytes. Only native NotSupportedError selects
 * the portable implementation; unexpected runtime failures propagate without weakening the hash.
 */
export async function passwordHash(
  password: string,
  salt: string,
  iterations = PASSWORD_ITERATIONS,
  native: NativePbkdf2 = nativePbkdf2,
): Promise<string> {
  if (![100000, PASSWORD_ITERATIONS].includes(iterations)) {
    throw new RangeError('Unsupported stored password work factor.');
  }
  const passwordBytes = encoder.encode(password);
  const saltBytes = encoder.encode(salt);
  let bits: Uint8Array;
  try {
    bits = await native(passwordBytes, saltBytes, iterations);
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    if (name !== 'NotSupportedError') {
      console.error('Native password derivation failed', { name });
      throw error;
    }
    // Runtime iteration ceilings differ between local workerd and deployed Cloudflare Workers.
    const limit =
      error instanceof Error
        ? error.message.match(/iteration counts above (\d+) are not supported/i)?.[1]
        : undefined;
    console.warn('Native PBKDF2 unsupported; using portable PBKDF2 with unchanged work factor', {
      name,
      iterations,
      ...(limit ? { nativeIterationLimit: Number(limit) } : {}),
    });
    bits = await pbkdf2Async(sha256, passwordBytes, saltBytes, { c: iterations, dkLen: 32 });
  }
  const hex = Array.from(bits, (value) => value.toString(16).padStart(2, '0')).join('');
  return `pbkdf2-sha256:${iterations}:${salt}:${hex}`;
}
