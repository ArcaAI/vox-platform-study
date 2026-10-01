/**
 * Puts back media bytes that are missing from the tenant's buckets — before the reconcile, so a
 * restored `Media` row never points at nothing. Idempotent: an object that exists is left alone.
 *
 * Entry naming (the exporter's): `media/<bucketId>/<key>`, where `<bucketId>` is the `Media` row's
 * `TenantBucket` id, or — for a row with no `bucketId` — the physical bucket name from its
 * `s3://<bucket>/<key>` uri. Either form must resolve to a bucket the TARGET tenant owns: a
 * `TenantBucket` of the tenant (by id, or by name), never a platform bucket. Anything else fails
 * the restore before a single byte is written anywhere.
 */
import { Injectable } from '@nestjs/common';
import type { Readable } from 'node:stream';
import { isPlatformBucket } from '@arcaai/domains';

import { BlobStorageProviderFactory } from '../../baseServices/storage/providers/blob-storage.provider.factory';
import { CheckpointError, type CheckpointArchiveReader, type CheckpointManifest, type SqlQuery } from '../contracts';

const MEDIA_ENTRY = /^media\/([^/]+)\/(.+)$/;

export interface MediaRestoreOutcome {
  uploaded: number;
  present: number;
}

@Injectable()
export class CheckpointMediaRestorer {
  constructor(private readonly blobs: BlobStorageProviderFactory) {}

  /** `manifest` is the VERIFIED manifest: every bucket is resolved and owned before anything is written. */
  async reupload(tenantId: string, manifest: CheckpointManifest, reader: CheckpointArchiveReader, query: SqlQuery): Promise<MediaRestoreOutcome> {
    const owned = await query<{ id: string; name: string }>(`SELECT "id", "name" FROM core."TenantBucket" WHERE "tenantId" = $1 AND "resourceStatus" <> 'DELETED'`, [
      tenantId,
    ]);
    const byId = new Map(owned.map((b) => [b.id, b.name]));
    const names = new Set(owned.map((b) => b.name));
    const outcome: MediaRestoreOutcome = { uploaded: 0, present: 0 };
    const resolve = (entryName: string): { bucket: string; key: string } => {
      const m = MEDIA_ENTRY.exec(entryName);
      const bucket = m ? (byId.get(m[1]) ?? (names.has(m[1]) ? m[1] : undefined)) : undefined;
      if (!m || !bucket || isPlatformBucket(bucket)) {
        throw new CheckpointError('RESTORE_FAILED', 'The checkpoint names a media bucket the tenant does not own', { entry: entryName });
      }
      return { bucket, key: m[2] };
    };
    for (const m of manifest.media ?? []) resolve(m.entry);
    if (!manifest.media?.length) return outcome;

    for await (const entry of reader.entries()) {
      if (!entry.name.startsWith('media/')) continue;
      const { bucket, key } = resolve(entry.name);
      const provider = await this.blobs.getProviderForBucket(tenantId, bucket);
      const listed = await provider.listObjects({ bucket, prefix: key, maxKeys: 1 });
      if (listed.objects.some((o) => o.key === key)) {
        outcome.present++;
        continue;
      }
      await put(provider, bucket, key, entry.body);
      outcome.uploaded++;
    }
    return outcome;
  }
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
