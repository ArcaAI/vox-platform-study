/**
 * Image thumbnail backfill (idempotent / best-effort / non-destructive).
 *
 * Finds existing IMAGE `Media` whose `<key>.thumb.webp` derivative is missing
 * from object storage and generates + stores it by REUSING the production
 * `ImageThumbnailService` (no reimplementation) — the same code the upload path
 * runs. The read path (`ContextService.resolveThumbnailUrl`) then presigns the
 * real downscaled thumbnail instead of falling back to the full-size image.
 *
 * Guarantees:
 *   - Idempotent — media that already have a `.thumb.webp` are skipped.
 *   - Best-effort — a per-row failure (bad bytes, missing original, presign
 *     error) is logged and skipped; one bad row never aborts the run.
 *   - Non-destructive — only ADDS derivative objects; never deletes/overwrites
 *     originals and touches NO database rows.
 *
 * Usage (from repo root; loads .env.dev → dev MinIO + Postgres):
 *   NODE_ENV=development node_modules/.bin/tsx \
 *     packages/applications/scripts/thumbnail-backfill.ts
 */
import 'reflect-metadata';
// Importing @arcaai/database auto-loads `.env.dev` (DATABASE_URL + MINIO_*).
import { getExtendedPrismaClient } from '@arcaai/database';
import {
  ImageThumbnailService,
  deriveThumbnailKey,
  isThumbnailableImageMimeType,
} from '../src/services/baseServices/storage/image-thumbnail.service';
import { getObjectBytes, makeS3Client, objectExists, parseStorageUri, putObject } from './media-storage';

async function main(): Promise<void> {
  const prisma = getExtendedPrismaClient();
  const s3 = makeS3Client();
  const thumbnailer = new ImageThumbnailService();

  // All non-deleted image media (soft-delete filter is applied by the client).
  const images = await prisma.media.findMany({
    where: { mimeType: { startsWith: 'image/' } },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`[thumbnail-backfill] scanning ${images.length} image Media row(s)…`);

  let generated = 0;
  let alreadyHad = 0;
  let skipped = 0;
  let failed = 0;

  for (const media of images) {
    const location = parseStorageUri(media.uri);
    if (!location) {
      console.log(`[skip] ${media.id} — uri is not s3://bucket/key (${media.uri})`);
      skipped++;
      continue;
    }
    if (!isThumbnailableImageMimeType(media.mimeType)) {
      console.log(`[skip] ${media.id} — non-thumbnailable image type (${media.mimeType})`);
      skipped++;
      continue;
    }

    const thumbnailKey = deriveThumbnailKey(location.key);
    try {
      if (await objectExists(s3, location.bucket, thumbnailKey)) {
        console.log(`[ok]   ${media.id} — thumbnail already present (${location.bucket}/${thumbnailKey})`);
        alreadyHad++;
        continue;
      }
      if (!(await objectExists(s3, location.bucket, location.key))) {
        console.log(`[skip] ${media.id} — original object missing (${location.bucket}/${location.key})`);
        skipped++;
        continue;
      }

      const original = await getObjectBytes(s3, location.bucket, location.key);
      const thumbnail = await thumbnailer.generateWebpThumbnail(original);
      await putObject(s3, location.bucket, thumbnailKey, thumbnail, 'image/webp');
      console.log(
        `[gen]  ${media.id} — generated ${location.bucket}/${thumbnailKey} (${thumbnail.length}B from ${original.length}B)`,
      );
      generated++;
    } catch (error) {
      console.warn(`[fail] ${media.id} — ${error instanceof Error ? error.message : String(error)}`);
      failed++;
    }
  }

  await prisma.$disconnect();
  s3.destroy();

  console.log('\n===== THUMBNAIL BACKFILL RESULT =====');
  console.log(
    JSON.stringify({ scanned: images.length, generated, alreadyHad, skipped, failed }, null, 2),
  );
  console.log('====================================');
}

main().catch((err) => {
  console.error('[thumbnail-backfill] backfill FAILED:', err);
  process.exitCode = 1;
});
