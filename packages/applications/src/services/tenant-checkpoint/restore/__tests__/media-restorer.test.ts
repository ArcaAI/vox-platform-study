import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { createArchiveWriter, openArchive } from '../../archive';
import { baseHeader, collect, fakeSealing, manifestFor, TENANT_A } from '../../archive/__tests__/helpers';
import type { CheckpointManifest } from '../../contracts';
import { CheckpointMediaRestorer } from '../media-restorer';

const BUCKET_ID = '01900000-0000-7000-8000-00000000b001';

async function archive(entries: { name: string; bytes: string }[]) {
  const sealing = fakeSealing();
  const { plaintext, platformWrapped } = await sealing.generateDataKey();
  const sink = new PassThrough();
  const done = collect(sink);
  const writer = createArchiveWriter({ header: baseHeader({ keys: { platform: platformWrapped } }), dataKey: plaintext, sink, sealing });
  const media: CheckpointManifest['media'] = [];
  for (const e of entries) {
    const r = await writer.writeEntry(e.name, Buffer.from(e.bytes));
    const [, bucketId, ...key] = e.name.split('/');
    media.push({ entry: e.name, size: r.bytes, sha256: r.sha256, bucketId, key: key.join('/') });
  }
  const manifest = manifestFor([], { media });
  await writer.finish(manifest);
  const file = await done;
  return { manifest, reader: () => openArchive(Readable.from([file]), Buffer.from(plaintext)) };
}

function provider(existing: string[]) {
  const puts: { bucket: string; key: string; body: string }[] = [];
  return {
    puts,
    listObjects: vi.fn(async ({ prefix }: { prefix: string }) => ({ objects: existing.filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: 1 })), isTruncated: false })),
    putObject: vi.fn(async ({ bucket, key, body }: { bucket: string; key: string; body: Buffer }) => void puts.push({ bucket, key, body: body.toString() })),
  };
}

const owned = vi.fn(async () => [{ id: BUCKET_ID, name: 'hope-files-acme' }]);

describe('CheckpointMediaRestorer', () => {
  it('uploads only the objects missing from a bucket the tenant owns, by TenantBucket id or by bucket name', async () => {
    const a = await archive([
      { name: `media/${BUCKET_ID}/audio/a.wav`, bytes: 'AAA' },
      { name: `media/${BUCKET_ID}/audio/b.wav`, bytes: 'BBB' },
      { name: 'media/hope-files-acme/legacy/c.wav', bytes: 'CCC' },
    ]);
    const p = provider(['audio/b.wav']);
    const restorer = new CheckpointMediaRestorer({ getProviderForBucket: vi.fn(async () => p) } as never);

    const out = await restorer.reupload(TENANT_A, a.manifest, await a.reader(), owned as never);

    expect(out).toEqual({ uploaded: 2, present: 1 });
    expect(p.puts).toEqual([
      { bucket: 'hope-files-acme', key: 'audio/a.wav', body: 'AAA' },
      { bucket: 'hope-files-acme', key: 'legacy/c.wav', body: 'CCC' },
    ]);
  });

  it('refuses a bucket the tenant does not own before writing anything', async () => {
    const a = await archive([
      { name: `media/${BUCKET_ID}/audio/a.wav`, bytes: 'AAA' },
      { name: 'media/someone-elses-bucket/x.wav', bytes: 'X' },
    ]);
    const p = provider([]);
    const restorer = new CheckpointMediaRestorer({ getProviderForBucket: vi.fn(async () => p) } as never);

    await expect(restorer.reupload(TENANT_A, a.manifest, await a.reader(), owned as never)).rejects.toMatchObject({ reason: 'RESTORE_FAILED' });
    expect(p.putObject).not.toHaveBeenCalled();
  });
});
