/**
 * Puts back media bytes that are missing from their buckets — before the reconcile, so a restored
 * `Media` row never points at nothing. Put-if-absent everywhere: an object that exists is never
 * overwritten.
 *
 * Entry naming (the exporter's): `media/<seg>/<key>`, where `<seg>` is the `Media` row's
 * `TenantBucket` id, or — for a row with no `bucketId` — the physical bucket name from its
 * `s3://<bucket>/<key>` uri. Where the bytes may go:
 *   - a `TenantBucket` the TARGET tenant owns (by id, or by its name)  → its bucket;
 *   - a platform fallback bucket (`isPlatformBucket`)                   → that bucket, but only for an
 *     object a Media row of THIS tenant in the checkpoint references (platform buckets are shared
 *     across tenants), and never the checkpoint bucket itself;
 *   - anything else (unknown name, another tenant's bucket id)          → skipped, warning
 *     MEDIA_BUCKET_UNRESOLVED naming the Media ids — never the key, which may carry a user name.
 * The checkpoint's Media rows come from `db/Media.csv.gz`, which the exporter writes before every
 * media entry.
 */
import { Injectable } from '@nestjs/common';
import type { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { isPlatformBucket } from '@arcaai/domains';

import { parseStorageUri } from '../../../common/storage-uri';
import { BlobStorageProviderFactory } from '../../baseServices/storage/providers/blob-storage.provider.factory';
import { CHECKPOINT_BUCKET, type CheckpointArchiveReader, type CheckpointManifest, type RestoreWarning, type SqlQuery } from '../contracts';
import { tableEntryName } from '../archive';
import { parseCsvRecords } from './csv';

const MEDIA_ENTRY = /^media\/([^/]+)\/(.+)$/;

export interface MediaRestoreOutcome {
  uploaded: number;
  present: number;
  warnings: RestoreWarning[];
}

@Injectable()
export class CheckpointMediaRestorer {
  constructor(private readonly blobs: BlobStorageProviderFactory) {}

  async reupload(tenantId: string, manifest: CheckpointManifest, reader: CheckpointArchiveReader, query: SqlQuery): Promise<MediaRestoreOutcome> {
    const outcome: MediaRestoreOutcome = { uploaded: 0, present: 0, warnings: [] };
    if (!manifest.media?.length) return outcome;

    const owned = await query<{ id: string; name: string }>(
      `SELECT "id", "name" FROM core."TenantBucket" WHERE "tenantId" = $1 AND "resourceStatus" <> 'DELETED'`,
      [tenantId],
    );
    const byId = new Map(owned.map((b) => [b.id, b.name]));
    const ownedNames = new Set(owned.map((b) => b.name));
    /** entry name → ids of this tenant's checkpoint Media rows that reference it */
    const referencedBy = new Map<string, string[]>();
    const unresolved: string[] = [];

    for await (const entry of reader.entries()) {
      if (entry.name === tableEntryName('Media')) {
        for (const [name, ids] of await mediaReferences(entry.body, tenantId)) referencedBy.set(name, ids);
        continue;
      }
      const m = MEDIA_ENTRY.exec(entry.name);
      if (!m) continue;
      const [, seg, key] = m;
      const mediaIds = referencedBy.get(entry.name) ?? [];
      let bucket: string | undefined;
      if (byId.has(seg)) bucket = byId.get(seg);
      else if (ownedNames.has(seg) && !isPlatformBucket(seg)) bucket = seg;
      else if (isPlatformBucket(seg) && seg !== CHECKPOINT_BUCKET) {
        if (!mediaIds.length) continue; // not this tenant's object: never written into a shared bucket
        bucket = seg;
      }
      if (!bucket) {
        unresolved.push(...mediaIds);
        continue;
      }
      const provider = await this.blobs.getProviderForBucket(tenantId, bucket);
      const listed = await provider.listObjects({ bucket, prefix: key, maxKeys: 1 });
      if (listed.objects.some((o) => o.key === key)) {
        outcome.present++;
        continue;
      }
      await put(provider, bucket, key, entry.body);
      outcome.uploaded++;
    }
    if (unresolved.length) {
      outcome.warnings.push({
        code: 'MEDIA_BUCKET_UNRESOLVED',
        message: 'Some media bytes were not restored: their bucket does not belong to the tenant',
        detail: { mediaIds: [...new Set(unresolved)].sort() },
      });
    }
    return outcome;
  }
}

/** The checkpoint's Media rows of `tenantId`, keyed by the media entry name the exporter gives them. */
async function mediaReferences(body: Readable, tenantId: string): Promise<Map<string, string[]>> {
  const parts: Buffer[] = [];
  for await (const chunk of body.pipe(createGunzip())) parts.push(chunk as Buffer);
  const [header, ...rows] = parseCsvRecords(Buffer.concat(parts).toString('utf8'));
  const out = new Map<string, string[]>();
  if (!header) return out;
  const col = (name: string) => header.indexOf(name);
  const [iId, iTenant, iBucket, iUri] = [col('id'), col('tenantId'), col('bucketId'), col('uri')];
  if (iId < 0 || iTenant < 0 || iUri < 0) return out;
  for (const r of rows) {
    if (r[iTenant] !== tenantId) continue;
    const loc = parseStorageUri(r[iUri]);
    if (!loc || !r[iId]) continue;
    const seg = (iBucket >= 0 ? r[iBucket] : null) ?? loc.bucket;
    const name = `media/${seg}/${loc.key}`;
    out.set(name, [...(out.get(name) ?? []), r[iId] as string]);
  }
  return out;
}

async function put(
  provider: Awaited<ReturnType<BlobStorageProviderFactory['getProviderForBucket']>>,
  bucket: string,
  key: string,
  body: Readable,
): Promise<void> {
  if (provider.putObjectStream) {
    await provider.putObjectStream({ bucket, key, body });
    return;
  }
  const parts: Buffer[] = [];
  for await (const chunk of body) parts.push(chunk as Buffer);
  await provider.putObject({ bucket, key, body: Buffer.concat(parts) });
}
