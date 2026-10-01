import { randomBytes } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import type { CheckpointFailureReason, CheckpointManifest, ICheckpointSealing } from '../../contracts';
import { verifyArchive } from '../verify';
import { createArchiveWriter } from '../writer';
import { baseHeader, collect, fakeSealing, manifestFor, reseal, rewriteHeader, splitArchive, TENANT_A, TENANT_B } from './helpers';

const sealing = fakeSealing();

async function build(opts: { tamperManifest?: boolean; sourceDeploymentId?: string } = {}): Promise<Buffer> {
  const { plaintext, platformWrapped } = await sealing.generateDataKey();
  const sink = new PassThrough();
  const bytes = collect(sink);
  const w = createArchiveWriter({
    header: baseHeader({ keys: { platform: platformWrapped }, ...(opts.sourceDeploymentId ? { sourceDeploymentId: opts.sourceDeploymentId } : {}) }),
    dataKey: plaintext,
    sink,
    sealing,
  });
  const agent = await w.writeEntry('db/Agent.csv.gz', randomBytes(5 * 64 * 1024)); // ≥ 6 segments
  const media = await w.writeEntry('media/b1/k.wav', Buffer.from('wav'));
  const manifest: CheckpointManifest = manifestFor([{ model: 'Agent', sha256: opts.tamperManifest ? '0'.repeat(64) : agent.sha256 }], {
    media: [{ entry: 'media/b1/k.wav', size: media.bytes, sha256: media.sha256, bucketId: 'b1', key: 'k.wav' }],
  });
  await w.finish(manifest);
  return bytes;
}

function run(file: Buffer, args: { expectTenantId?: string; existing?: string[]; sealing?: ICheckpointSealing } = {}) {
  return verifyArchive({
    open: async () => Readable.from([file]),
    expectTenantId: args.expectTenantId ?? TENANT_A,
    sealing: args.sealing ?? sealing,
    existingCheckpointIds: args.existing ? new Set(args.existing) : undefined,
  });
}

async function expectReason(p: Promise<unknown>, reason: CheckpointFailureReason) {
  await expect(p).rejects.toMatchObject({ name: 'CheckpointError', reason });
}

function flip(buf: Buffer, at: number): Buffer {
  const out = Buffer.from(buf);
  out[at] ^= 0x01;
  return out;
}

describe('verifyArchive — the verification gate', () => {
  it('accepts a valid archive and returns header, manifest and size', async () => {
    const file = await build();
    const v = await run(file);
    expect(v.header.tenantId).toBe(TENANT_A);
    expect(v.manifest.tables[0].model).toBe('Agent');
    expect(v.sizeBytes).toBe(file.length);
  });

  it('first 8 bytes changed → UNSUPPORTED_FORMAT', async () => {
    const file = Buffer.from(await build());
    file.write('NOTACKPT', 0, 'ascii');
    await expectReason(run(file), 'UNSUPPORTED_FORMAT');
  });

  it('formatVersion 99 in header → UNSUPPORTED_FORMAT', async () => {
    const p = splitArchive(await build());
    const header = rewriteHeader(p.header, (h) => (h.formatVersion = 99));
    await expectReason(run(await reseal({ header, segments: p.segments }, sealing)), 'UNSUPPORTED_FORMAT');
  });

  it('one byte flipped in BODY → SIGNATURE_INVALID (digest differs)', async () => {
    const file = await build();
    const p = splitArchive(file);
    await expectReason(run(flip(file, p.header.length + p.segments[0].length + 100)), 'SIGNATURE_INVALID');
  });

  it('a signature by another key → SIGNATURE_INVALID', async () => {
    const p = splitArchive(await build());
    const forger = { sign: async () => `vault:v1:${randomBytes(64).toString('base64')}` };
    await expectReason(run(await reseal(p, forger)), 'SIGNATURE_INVALID');
  });

  it('a truncated file (trailer cut off) → SIGNATURE_INVALID', async () => {
    const file = await build();
    await expectReason(run(file.subarray(0, file.length - 10)), 'SIGNATURE_INVALID');
  });

  it('one byte flipped AND trailer re-signed (passphrase-holder forgery path) → CORRUPT_SEGMENT', async () => {
    const p = splitArchive(await build());
    const segments = [...p.segments];
    segments[1] = flip(segments[1], 50);
    await expectReason(run(await reseal({ header: p.header, segments }, sealing)), 'CORRUPT_SEGMENT');
  });

  it('last segment dropped, re-signed → CORRUPT_SEGMENT (no last-flag segment)', async () => {
    const p = splitArchive(await build());
    await expectReason(run(await reseal({ header: p.header, segments: p.segments.slice(0, -1) }, sealing)), 'CORRUPT_SEGMENT');
  });

  it('segments 2 and 3 swapped, re-signed → CORRUPT_SEGMENT', async () => {
    const p = splitArchive(await build());
    expect(p.segments.length).toBeGreaterThanOrEqual(5);
    const segments = [...p.segments];
    [segments[2], segments[3]] = [segments[3], segments[2]];
    await expectReason(run(await reseal({ header: p.header, segments }, sealing)), 'CORRUPT_SEGMENT');
  });

  it('header tenantId swapped to tenant B, re-signed, verified as B → CORRUPT_SEGMENT (segment-0 AAD binds the header)', async () => {
    const p = splitArchive(await build());
    const header = rewriteHeader(p.header, (h) => (h.tenantId = TENANT_B));
    await expectReason(run(await reseal({ header, segments: p.segments }, sealing), { expectTenantId: TENANT_B }), 'CORRUPT_SEGMENT');
  });

  it('valid archive, expectTenantId = other tenant → WRONG_TENANT', async () => {
    await expectReason(run(await build(), { expectTenantId: TENANT_B }), 'WRONG_TENANT');
  });

  it('header sourceDeploymentId ≠ sealing.deploymentId() → FOREIGN_DEPLOYMENT', async () => {
    await expectReason(run(await build({ sourceDeploymentId: 'some-other-deployment' })), 'FOREIGN_DEPLOYMENT');
  });

  it('FOREIGN_DEPLOYMENT fires before the signature check (a foreign file never verifies)', async () => {
    const file = await build({ sourceDeploymentId: 'some-other-deployment' });
    const p = splitArchive(file);
    await expectReason(run(flip(file, p.header.length + 30)), 'FOREIGN_DEPLOYMENT');
  });

  it('manifest sha256 for an entry altered before sealing → MANIFEST_MISMATCH', async () => {
    await expectReason(run(await build({ tamperManifest: true })), 'MANIFEST_MISMATCH');
  });

  it('existingCheckpointIds contains the header id → DUPLICATE', async () => {
    await expectReason(run(await build(), { existing: [baseHeader().checkpointId] }), 'DUPLICATE');
  });

  it('a file whose bytes change between the two passes → SIGNATURE_INVALID', async () => {
    const good = await build();
    const p = splitArchive(good);
    const segments = [...p.segments];
    segments[1] = flip(segments[1], 50);
    const other = await reseal({ header: p.header, segments }, sealing);
    let calls = 0;
    const v = verifyArchive({
      open: async () => Readable.from([calls++ === 0 ? good : other]),
      expectTenantId: TENANT_A,
      sealing,
    });
    const err = (await v.catch((e: unknown) => e)) as { reason?: string };
    expect(['CORRUPT_SEGMENT', 'SIGNATURE_INVALID']).toContain(err.reason);
  });
});
