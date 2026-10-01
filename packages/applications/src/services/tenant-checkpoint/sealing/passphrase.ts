/**
 * Passphrase wrap of a checkpoint data key — Argon2id → AES-256-GCM.
 *
 * Pure (no Nest, no Vault) on purpose: the offline opener imports this module and must run on a
 * laptop with no network. The parameters are format facts, not configuration: a wrap written with
 * other values is still opened (they travel in the wrap), within the bounds below.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { argon2id } from 'hash-wasm';

import { CheckpointError, type PassphraseWrap } from '../contracts';

export const ARGON2ID_MEMORY_KIB = 65536;
export const ARGON2ID_ITERATIONS = 3;
export const ARGON2ID_PARALLELISM = 1;

const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
/** Domain separation: a wrap is only ever a checkpoint data-key wrap. */
const WRAP_AAD = Buffer.from('hope-checkpoint/passphrase-wrap/v1', 'utf8');

/**
 * Upper bounds on what a wrap read from a FILE may ask for. The header is attacker-controllable
 * until the signature is checked (and the offline opener may have no public key at all), so an
 * unbounded `m`/`t` is a memory/CPU bomb.
 */
const MAX_MEMORY_KIB = 1024 * 1024;
const MAX_ITERATIONS = 16;
const MAX_PARALLELISM = 8;

async function deriveKey(passphrase: string, salt: Buffer, m: number, t: number, p: number): Promise<Buffer> {
  const out = await argon2id({
    password: passphrase,
    salt,
    parallelism: p,
    iterations: t,
    memorySize: m,
    hashLength: KEY_BYTES,
    outputType: 'binary',
  });
  return Buffer.from(out);
}

function assertPassphrase(passphrase: string): void {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new CheckpointError('PASSPHRASE_INVALID', 'A passphrase is required');
  }
}

export async function wrapDataKeyWithPassphrase(dataKey: Buffer, passphrase: string): Promise<PassphraseWrap> {
  assertPassphrase(passphrase);
  if (dataKey.length !== KEY_BYTES) throw new Error(`data key must be ${KEY_BYTES} bytes`);
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const kek = await deriveKey(passphrase, salt, ARGON2ID_MEMORY_KIB, ARGON2ID_ITERATIONS, ARGON2ID_PARALLELISM);
  try {
    const cipher = createCipheriv('aes-256-gcm', kek, nonce);
    cipher.setAAD(WRAP_AAD);
    const ct = Buffer.concat([cipher.update(dataKey), cipher.final(), cipher.getAuthTag()]);
    return {
      kdf: 'argon2id',
      salt: salt.toString('base64'),
      m: ARGON2ID_MEMORY_KIB,
      t: ARGON2ID_ITERATIONS,
      p: ARGON2ID_PARALLELISM,
      nonce: nonce.toString('base64'),
      wrapped: ct.toString('base64'),
    };
  } finally {
    kek.fill(0);
  }
}

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

export async function unwrapDataKeyWithPassphrase(wrap: PassphraseWrap, passphrase: string): Promise<Buffer> {
  assertPassphrase(passphrase);
  if (
    !wrap ||
    wrap.kdf !== 'argon2id' ||
    !isInt(wrap.p, 1, MAX_PARALLELISM) ||
    !isInt(wrap.t, 1, MAX_ITERATIONS) ||
    !isInt(wrap.m, 8 * wrap.p, MAX_MEMORY_KIB)
  ) {
    throw new CheckpointError('UNSUPPORTED_FORMAT', 'Unsupported passphrase wrap parameters');
  }
  const salt = Buffer.from(String(wrap.salt), 'base64');
  const nonce = Buffer.from(String(wrap.nonce), 'base64');
  const blob = Buffer.from(String(wrap.wrapped), 'base64');
  if (salt.length < 8 || nonce.length !== NONCE_BYTES || blob.length !== KEY_BYTES + TAG_BYTES) {
    throw new CheckpointError('UNSUPPORTED_FORMAT', 'Malformed passphrase wrap');
  }
  const kek = await deriveKey(passphrase, salt, wrap.m, wrap.t, wrap.p);
  try {
    const decipher = createDecipheriv('aes-256-gcm', kek, nonce);
    decipher.setAAD(WRAP_AAD);
    decipher.setAuthTag(blob.subarray(KEY_BYTES));
    return Buffer.concat([decipher.update(blob.subarray(0, KEY_BYTES)), decipher.final()]);
  } catch {
    throw new CheckpointError('PASSPHRASE_INVALID', 'The passphrase does not open this checkpoint');
  } finally {
    kek.fill(0);
  }
}
