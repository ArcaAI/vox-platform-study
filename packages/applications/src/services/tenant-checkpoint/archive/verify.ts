/**
 * The verification gate — run at upload completion and again before every restore. Nothing is
 * written anywhere; a refusal is a `CheckpointError` whose `reason` is the gate that failed.
 *
 * Order (normative):
 *   1. magic + formatVersion                           → UNSUPPORTED_FORMAT
 *   2. header sourceDeploymentId = own deploymentId()  → FOREIGN_DEPLOYMENT
 *   3. sha256(HEADER ‖ BODY) = trailer digest, and the
 *      Vault signature over it verifies                → SIGNATURE_INVALID
 *   4. header tenantId = target tenant                 → WRONG_TENANT
 *   5. every segment authenticates under the data key  → CORRUPT_SEGMENT
 *   6. every manifest sha256 matches its entry         → MANIFEST_MISMATCH
 *   7. (upload only) checkpointId not already present  → DUPLICATE
 *
 * Gate 2 precedes gate 3 because a file from another deployment is signed by another key and
 * would otherwise always fail as SIGNATURE_INVALID. Gates 1–2 read only unauthenticated header
 * fields, so they can only REFUSE — nothing past them trusts the header until gate 3 has passed.
 *
 * The source is opened twice: pass 1 hashes the raw bytes (no key needed), pass 2 decrypts. Pass 2
 * re-derives the digest and must reproduce pass 1's exactly, so a file that changes between the
 * two opens is refused rather than half-trusted.
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { CheckpointError, type CheckpointHeader, type CheckpointManifest, type ICheckpointSealing, type VerifiedArchive } from '../contracts';
import { ByteReader } from './byte-reader';
import { MAX_CIPHER_BYTES, MIN_CIPHER_BYTES, tableEntryName, TRAILER_MAGIC } from './format';
import { openArchiveInternal, readHeaderFrom, readTrailerFrom } from './reader';

export interface VerifyArchiveArgs {
  open: () => Promise<Readable>;
  expectTenantId: string;
  sealing: ICheckpointSealing;
  /** Upload only → DUPLICATE. */
  existingCheckpointIds?: ReadonlySet<string>;
}

const sigInvalid = (msg: string) => new CheckpointError('SIGNATURE_INVALID', msg);

interface PassOne {
  header: CheckpointHeader;
  headerBytes: Buffer;
  digest: Buffer;
  sizeBytes: number;
}

async function passOne(source: Readable, sealing: ICheckpointSealing): Promise<PassOne> {
  const src = new ByteReader(source);
  try {
    const { header, headerBytes } = await readHeaderFrom(src); // gate 1
    const own = await sealing.deploymentId();
    if (header.sourceDeploymentId !== own) {
      throw new CheckpointError('FOREIGN_DEPLOYMENT', 'The checkpoint was created by another deployment', {
        sourceDeploymentId: header.sourceDeploymentId,
      });
    }
    // gate 3: walk the frames, hashing exactly what the writer hashed.
    const hash = createHash('sha256').update(headerBytes);
    for (;;) {
      const next = await src.peek(TRAILER_MAGIC.length);
      if (next.equals(TRAILER_MAGIC)) break;
      const lenBuf = await src.read(4);
      if (!lenBuf) throw sigInvalid('Checkpoint is truncated: no trailer');
      const len = lenBuf.readUInt32BE(0);
      if (len < MIN_CIPHER_BYTES || len > MAX_CIPHER_BYTES) throw sigInvalid('Checkpoint body framing is broken; the digest cannot be verified');
      const ct = await src.read(len);
      if (!ct) throw sigInvalid('Checkpoint is truncated: no trailer');
      hash.update(lenBuf).update(ct);
    }
    const trailer = await readTrailerFrom(src, sigInvalid);
    const digest = hash.digest();
    if (!digest.equals(trailer.digest)) throw sigInvalid('Checkpoint digest does not match its trailer');
    if (!(await sealing.verify(digest, trailer.signature))) throw sigInvalid('Checkpoint signature does not verify');
    return { header, headerBytes, digest, sizeBytes: src.consumed };
  } finally {
    src.destroy();
  }
}

function checkManifest(manifest: CheckpointManifest, header: CheckpointHeader, entries: Map<string, { sha256: string; size: number }>, dupes: string[]): void {
  const mismatch = (message: string, detail?: Record<string, unknown>) => new CheckpointError('MANIFEST_MISMATCH', message, detail);
  if (dupes.length) throw mismatch('The archive holds the same entry more than once', { entries: dupes });
  if (manifest.formatVersion !== header.formatVersion) throw mismatch('Manifest format version differs from the header');
  if (manifest.schemaFingerprint !== header.schemaFingerprint) throw mismatch('Manifest schema fingerprint differs from the header');
  if (!Array.isArray(manifest.tables) || !Array.isArray(manifest.media ?? []) || !Array.isArray(manifest.claimChecks ?? [])) {
    throw mismatch('Manifest is malformed');
  }
  const expect = (entry: string, sha256: string, size?: number) => {
    const got = entries.get(entry);
    if (!got) throw mismatch(`Manifest names an entry the archive does not contain: ${entry}`, { entry });
    if (got.sha256 !== sha256) throw mismatch(`Entry ${entry} does not match its manifest sha256`, { entry });
    if (size !== undefined && got.size !== size) throw mismatch(`Entry ${entry} does not match its manifest size`, { entry });
  };
  for (const t of manifest.tables) expect(tableEntryName(t.model), t.sha256);
  for (const m of manifest.media ?? []) expect(m.entry, m.sha256, m.size);
  for (const c of manifest.claimChecks ?? []) expect(c.entry, c.sha256, c.size);
}

export async function verifyArchive(args: VerifyArchiveArgs): Promise<VerifiedArchive> {
  const { sealing } = args;
  const one = await passOne(await args.open(), sealing); // gates 1–3

  if (one.header.tenantId !== args.expectTenantId) {
    throw new CheckpointError('WRONG_TENANT', 'The checkpoint belongs to another tenant'); // gate 4
  }

  // gate 5 — every segment authenticates, and the bytes are the ones pass 1 vouched for.
  const dataKey = await sealing.unwrapPlatform(one.header.keys.platform);
  const entries = new Map<string, { sha256: string; size: number }>();
  const dupes: string[] = [];
  let manifest: CheckpointManifest;
  try {
    const reader = await openArchiveInternal(await args.open(), dataKey);
    if (!reader.headerBytes.equals(one.headerBytes)) throw sigInvalid('The checkpoint changed while it was being verified');
    for await (const e of reader.entries()) {
      const h = createHash('sha256');
      let size = 0;
      for await (const c of e.body) {
        h.update(c as Buffer);
        size += (c as Buffer).length;
      }
      if (entries.has(e.name)) dupes.push(e.name);
      entries.set(e.name, { sha256: h.digest('hex'), size });
    }
    if (!reader.digest().equals(one.digest)) throw sigInvalid('The checkpoint changed while it was being verified');
    manifest = reader.manifest();
  } finally {
    dataKey.fill(0);
  }

  checkManifest(manifest, one.header, entries, dupes); // gate 6

  if (args.existingCheckpointIds?.has(one.header.checkpointId)) {
    throw new CheckpointError('DUPLICATE', 'This checkpoint is already present for the tenant', { checkpointId: one.header.checkpointId }); // gate 7
  }

  return { header: one.header, manifest, sizeBytes: one.sizeBytes };
}
