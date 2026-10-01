/**
 * Test helpers for the checkpoint archive — shared with the export/verify-upload lane's tests.
 *
 * `fakeSealing()` behaves like the Vault-backed sealing without Vault: the platform wrap is
 * AES-256-GCM under a fixed test key, signatures are REAL Ed25519 (a fixed-seed key, exported as
 * `FAKE_SIGN_PUBLIC_KEY_PEM` so the offline opener can verify them), and the passphrase wrap is the
 * production Argon2id code.
 */
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import type { Readable } from 'node:stream';

import type { CheckpointHeader, CheckpointManifest, ICheckpointSealing, ManifestTable } from '../../contracts';
import { unwrapDataKeyWithPassphrase, wrapDataKeyWithPassphrase } from '../../sealing/passphrase';
import { DIGEST_BYTES, MAGIC_BYTES, TRAILER_MAGIC, u16 } from '../format';

const PLATFORM_TEST_KEY = createHash('sha256').update('hope-checkpoint test platform key').digest();
const SIGN_SEED = createHash('sha256').update('hope-checkpoint test signing seed').digest();

function ed25519FromSeed(seed: Buffer) {
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

export const FAKE_SIGN_KEYS = ed25519FromSeed(SIGN_SEED);
export const FAKE_SIGN_PUBLIC_KEY_PEM = FAKE_SIGN_KEYS.publicKey.export({ type: 'spki', format: 'pem' }).toString();
export const OTHER_SIGN_PUBLIC_KEY_PEM = ed25519FromSeed(createHash('sha256').update('another deployment').digest())
  .publicKey.export({ type: 'spki', format: 'pem' })
  .toString();

export const TENANT_A = '01900000-0000-7000-8000-00000000000a';
export const TENANT_B = '01900000-0000-7000-8000-00000000000b';

export function fakeSealing(opts: { deploymentId?: string } = {}): ICheckpointSealing {
  return {
    async generateDataKey() {
      const plaintext = randomBytes(32);
      const nonce = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', PLATFORM_TEST_KEY, nonce);
      const ct = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
      return { plaintext, platformWrapped: `fake:${Buffer.concat([nonce, ct]).toString('base64')}` };
    },
    async unwrapPlatform(wrapped: string) {
      const blob = Buffer.from(wrapped.replace(/^fake:/, ''), 'base64');
      const d = createDecipheriv('aes-256-gcm', PLATFORM_TEST_KEY, blob.subarray(0, 12));
      d.setAuthTag(blob.subarray(blob.length - 16));
      return Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]);
    },
    wrapWithPassphrase: wrapDataKeyWithPassphrase,
    unwrapWithPassphrase: unwrapDataKeyWithPassphrase,
    async sign(digest: Buffer) {
      return `vault:v1:${sign(null, digest, FAKE_SIGN_KEYS.privateKey).toString('base64')}`;
    },
    async verify(digest: Buffer, signature: string) {
      const m = /^vault:v\d+:(.+)$/.exec(signature);
      if (!m) return false;
      return verify(null, digest, FAKE_SIGN_KEYS.publicKey, Buffer.from(m[1], 'base64'));
    },
    async deploymentId() {
      return opts.deploymentId ?? 'test-deployment';
    },
  };
}

/** Resolves with every byte the stream emits. Attach BEFORE writing so backpressure never stalls. */
export function collect(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    stream.on('data', (c: Buffer) => parts.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(parts)));
    stream.on('error', reject);
  });
}

export function baseHeader(overrides: Partial<CheckpointHeader> = {}): Omit<CheckpointHeader, 'magic' | 'formatVersion' | 'noncePrefix'> {
  return {
    checkpointId: '01900000-0000-7000-8000-0000000000c1',
    tenantId: TENANT_A,
    tenantKey: 'acme',
    sourceDeploymentId: 'test-deployment',
    createdAt: '2026-10-01T00:00:00.000Z',
    schemaFingerprint: 'fp-test',
    includesMedia: true,
    keys: { platform: 'fake:unused' },
    ...overrides,
  };
}

export function manifestFor(
  tables: (Partial<ManifestTable> & { model: string; sha256: string })[],
  overrides: Partial<CheckpointManifest> = {},
): CheckpointManifest {
  return {
    formatVersion: 1,
    schemaFingerprint: 'fp-test',
    tables: tables.map((t) => ({ columns: ['id'], rowCount: 1, ...t })),
    media: [],
    claimChecks: [],
    transitKeyVersions: {},
    notCaptured: [],
    ...overrides,
  };
}

/** Byte offsets of a serialized archive: HEADER, each SEGMENT frame, TRAILER. */
export interface ArchiveLayout {
  header: Buffer;
  segments: Buffer[];
  trailer: Buffer;
}

export function splitArchive(file: Buffer): ArchiveLayout {
  if (!file.subarray(0, 8).equals(MAGIC_BYTES)) throw new Error('not an archive');
  const headerEnd = 12 + file.readUInt32BE(8);
  const segments: Buffer[] = [];
  let off = headerEnd;
  while (!file.subarray(off, off + 8).equals(TRAILER_MAGIC)) {
    const len = file.readUInt32BE(off);
    segments.push(file.subarray(off, off + 4 + len));
    off += 4 + len;
  }
  return { header: file.subarray(0, headerEnd), segments, trailer: file.subarray(off) };
}

/** Re-assemble with a recomputed digest and a fresh signature — the forger-with-the-signing-key path. */
export async function reseal(parts: { header: Buffer; segments: Buffer[] }, sealing: Pick<ICheckpointSealing, 'sign'>): Promise<Buffer> {
  const body = Buffer.concat([parts.header, ...parts.segments]);
  const digest = createHash('sha256').update(body).digest();
  if (digest.length !== DIGEST_BYTES) throw new Error('digest');
  const sig = Buffer.from(await sealing.sign(digest), 'utf8');
  return Buffer.concat([body, TRAILER_MAGIC, digest, u16(sig.length), sig]);
}

/** Replace the header JSON (re-encoding magic + length). */
export function rewriteHeader(header: Buffer, edit: (h: Record<string, unknown>) => void): Buffer {
  const json = JSON.parse(header.subarray(12).toString('utf8')) as Record<string, unknown>;
  edit(json);
  const out = Buffer.from(JSON.stringify(json), 'utf8');
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(out.length, 0);
  return Buffer.concat([MAGIC_BYTES, len, out]);
}
