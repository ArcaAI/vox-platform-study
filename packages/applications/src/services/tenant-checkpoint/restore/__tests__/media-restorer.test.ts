import { PassThrough, Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

import { createArchiveWriter, openArchive, tableEntryName } from '../../archive';
import { baseHeader, collect, fakeSealing, manifestFor, TENANT_A, TENANT_B } from '../../archive/__tests__/helpers';
import type { CheckpointManifest } from '../../contracts';
import { CheckpointMediaRestorer } from '../media-restorer';

const OWN_BUCKET = '01900000-0000-7000-8000-00000000b001';
const FOREIGN_BUCKET = '01900000-0000-7000-8000-00000000b002';
const PLATFORM = 'hope-audio';

interface MediaRow {
  id: string;
  tenantId?: string;
  bucketId: string | null;
  uri: string;
}

/** An archive the way the exporter writes it: db/Media.csv.gz first, then media/<bucketId | bucket name>/<key>. */
async function archive(rows: MediaRow[], objects: { entry: string; bytes: string }[]) {
  const sealing = fakeSealing();
  const { plaintext, platformWrapped } = await sealing.generateDataKey();
  const sink = new PassThrough();
  const done = collect(sink);
  const writer = createArchiveWriter({ header: baseHeader({ keys: { platform: platformWrapped } }), dataKey: plaintext, sink, sealing });
  const csv = ['id,tenantId,bucketId,uri', ...rows.map((r) => `${r.id},${r.tenantId ?? TENANT_A},${r.bucketId ?? ''},"${r.uri}"`)].join('\n') + '\n';
  const t = await writer.writeEntry(tableEntryName('Media'), gzipSync(Buffer.from(csv)));
  const media: CheckpointManifest['media'] = [];
  for (const o of objects) {
    const r = await writer.writeEntry(o.entry, Buffer.from(o.bytes));
    const [, bucketId, ...key] = o.entry.split('/');
    media.push({ entry: o.entry, size: r.bytes, sha256: r.sha256, bucketId, key: key.join('/') });
  }
  const manifest = manifestFor([{ model: 'Media', sha256: t.sha256, rowCount: rows.length, columns: ['id', 'tenantId', 'bucketId', 'uri'] }], { media });
  await writer.finish(manifest);
  const file = await done;
  return { manifest, reader: () => openArchive(Readable.from([file]), Buffer.from(plaintext)) };
}

function provider(existing: string[]) {
  const puts: { bucket: string; key: string; body: string }[] = [];
  return {
    puts,
    listObjects: vi.fn(async ({ bucket, prefix }: { bucket: string; prefix: string }) => ({
      objects: existing.filter((k) => k.startsWith(`${bucket}/${prefix}`)).map((k) => ({ key: k.slice(bucket.length + 1), size: 1 })),
      isTruncated: false,
    })),
    putObject: vi.fn(async ({ bucket, key, body }: { bucket: string; key: string; body: Buffer }) => void puts.push({ bucket, key, body: body.toString() })),
  };
}

/** TenantBucket rows visible to the restorer: the target tenant owns OWN_BUCKET only. */
const buckets = vi.fn(async (_sql: string, params?: readonly unknown[]) =>
  params?.[0] === TENANT_A ? [{ id: OWN_BUCKET, name: 'hope-files-acme' }] : [],
);

async function run(rows: MediaRow[], objects: { entry: string; bytes: string }[], existing: string[] = []) {
  const a = await archive(rows, objects);
  const p = provider(existing);
  const restorer = new CheckpointMediaRestorer({ getProviderForBucket: vi.fn(async () => p) } as never);
  const out = await restorer.reupload(TENANT_A, a.manifest, await a.reader(), buckets as never);
  return { out, p };
}

describe('CheckpointMediaRestorer', () => {
  it('uploads a missing object into a TenantBucket the tenant owns', async () => {
    const { out, p } = await run([{ id: 'm1', bucketId: OWN_BUCKET, uri: 's3://hope-files-acme/audio/a.wav' }], [{ entry: `media/${OWN_BUCKET}/audio/a.wav`, bytes: 'AAA' }]);
    expect(p.puts).toEqual([{ bucket: 'hope-files-acme', key: 'audio/a.wav', body: 'AAA' }]);
    expect(out).toMatchObject({ uploaded: 1, present: 0, warnings: [] });
  });

  it('platform fallback bucket: a missing object referenced by a restored Media row is uploaded', async () => {
    const { out, p } = await run([{ id: 'm2', bucketId: null, uri: `s3://${PLATFORM}/t/a/rec.wav` }], [{ entry: `media/${PLATFORM}/t/a/rec.wav`, bytes: 'REC' }]);
    expect(p.puts).toEqual([{ bucket: PLATFORM, key: 't/a/rec.wav', body: 'REC' }]);
    expect(out).toMatchObject({ uploaded: 1, warnings: [] });
  });

  it('platform fallback bucket: an existing object is never overwritten', async () => {
    const { out, p } = await run(
      [{ id: 'm3', bucketId: null, uri: `s3://${PLATFORM}/t/a/rec.wav` }],
      [{ entry: `media/${PLATFORM}/t/a/rec.wav`, bytes: 'REC' }],
      [`${PLATFORM}/t/a/rec.wav`],
    );
    expect(p.putObject).not.toHaveBeenCalled();
    expect(out).toMatchObject({ uploaded: 0, present: 1, warnings: [] });
  });

  it('platform fallback bucket: an object no restored Media row references is not written', async () => {
    const { out, p } = await run([], [{ entry: `media/${PLATFORM}/someone/else.wav`, bytes: 'X' }]);
    expect(p.putObject).not.toHaveBeenCalled();
    expect(out.uploaded).toBe(0);
  });

  it('an unknown bucket is skipped with MEDIA_BUCKET_UNRESOLVED naming the Media id (never the key); the rest continues', async () => {
    const { out, p } = await run(
      [
        { id: 'm4', bucketId: null, uri: 's3://some-random-bucket/dr.jones/x.wav' },
        { id: 'm5', bucketId: OWN_BUCKET, uri: 's3://hope-files-acme/y.wav' },
      ],
      [
        { entry: 'media/some-random-bucket/dr.jones/x.wav', bytes: 'X' },
        { entry: `media/${OWN_BUCKET}/y.wav`, bytes: 'Y' },
      ],
    );
    expect(out.warnings).toEqual([expect.objectContaining({ code: 'MEDIA_BUCKET_UNRESOLVED', detail: { mediaIds: ['m4'] } })]);
    expect(JSON.stringify(out.warnings)).not.toContain('dr.jones');
    expect(p.puts.map((x) => x.key)).toEqual(['y.wav']);
  });

  it("another tenant's TenantBucket id is a warning and is never written", async () => {
    const { out, p } = await run([{ id: 'm6', bucketId: FOREIGN_BUCKET, uri: 's3://hope-files-other/z.wav' }], [{ entry: `media/${FOREIGN_BUCKET}/z.wav`, bytes: 'Z' }]);
    expect(p.putObject).not.toHaveBeenCalled();
    expect(out.warnings).toEqual([expect.objectContaining({ code: 'MEDIA_BUCKET_UNRESOLVED', detail: { mediaIds: ['m6'] } })]);
  });

  it("ignores a staged Media row of another tenant when deciding what a platform object belongs to", async () => {
    const { p } = await run([{ id: 'm7', tenantId: TENANT_B, bucketId: null, uri: `s3://${PLATFORM}/b/rec.wav` }], [{ entry: `media/${PLATFORM}/b/rec.wav`, bytes: 'B' }]);
    expect(p.putObject).not.toHaveBeenCalled();
  });
});
