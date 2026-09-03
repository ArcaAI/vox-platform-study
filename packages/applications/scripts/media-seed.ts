/**
 * Media seed (additive / idempotent).
 *
 * Creates ONE Global-tenant consultation whose context items cover every media
 * shape the admin timeline renders — an image, a PDF, an audio clip, a
 * "mixed" item (image + attached file + text), and a
 * RECORDING-shaped fixture (AUDIO_RECORDING container + AudioRecording row +
 * linked WAV media) — backed by REAL small sample
 * files uploaded into MinIO at the canonical `s3://<bucket>/<key>` convention
 * `StorageController` uses. `ContextService.resolveMediaUrls` then presigns a
 * download `url` (+ `mimeType`, + a real `.thumb.webp` `thumbnailUrl` for the
 * image) for each, so `GET /consultations/:id/context` is verifiable end-to-end.
 *
 * Idempotent: every row is upsert-by-id with ids OUTSIDE all existing seed
 * ranges; objects are PUT-by-key (overwrite). Re-running changes nothing.
 *
 * CI-safe / storage best-effort: this script is folded into the test-DB seed
 * step (root `test:db:seed` and the CI `prepare-test-db` job, after the main
 * `@arcaai/database` seed) so the media E2E fixture exists after every seed.
 * The DB rows (consultation + media + context items) are ALWAYS upserted; the
 * MinIO objects (and the image thumbnail) are uploaded only when blob storage
 * is reachable. When it is NOT (e.g. CI runs no MinIO service), the script logs
 * a clear warning and seeds DB rows only — it never fails the seed because
 * storage is absent. The media E2E falls back gracefully too: `presignGet` is
 * an offline signature, so `url`/`mimeType` still resolve; `thumbnailUrl` falls
 * back to the full-size URL when the derivative object is missing.
 *
 * The PRIMARY image's `.thumb.webp` is generated inline here (mirroring the
 * upload path, satisfying "the image gets a real thumbnail"). The MIXED item's
 * image is uploaded WITHOUT a derivative ON PURPOSE, so the companion backfill
 * (`thumbnail-backfill.ts`) has a real image to generate one for —
 * demonstrating the backfill end-to-end. After both scripts run, every image
 * has a real downscaled thumbnail.
 *
 * Usage:
 *   # Standalone, dev stack (loads .env.dev → dev MinIO + Postgres):
 *   NODE_ENV=development node_modules/.bin/tsx \
 *     packages/applications/scripts/media-seed.ts
 *
 *   # Test DB (loads .env.test); also runs automatically as part of:
 *   pnpm test:db:seed:media        # or, transitively, pnpm test:db:reset
 */
import 'reflect-metadata';
import type { S3Client } from '@aws-sdk/client-s3';
// Importing @arcaai/database auto-loads `.env.dev` (DATABASE_URL + MINIO_*).
import { getExtendedPrismaClient } from '@arcaai/database';
import { ImageThumbnailService, deriveThumbnailKey } from '../src/services/baseServices/storage/image-thumbnail.service';
import { ensureBucket, makeS3Client, putObject } from './media-storage';

// --- Stable FKs (proven Global-tenant rows; see seed/00-constants.ts) --------
const TENANT_ID = '50000000-0000-0000-0000-000000000000'; // SEED_TENANT_ID (Global customer tenant)
const DOCTOR_ID = '70000000-0000-0000-0000-000000000010'; // SEED_USER_IDS.DOCTOR
const DEPARTMENT_ID = '70000000-0000-0000-0003-000000000001'; // SEED_DEPARTMENT_IDS.OPD

// --- Stable ids for the seeded rows (outside every existing seed range) ------
const CONSULTATION_ID = '90000000-0000-0000-0000-000000000376';
const MEDIA_IDS = {
  image: '96000000-0000-0000-0000-000000000376',
  pdf: '96000000-0000-0000-0000-000000000377',
  audio: '96000000-0000-0000-0000-000000000378',
  mixedImage: '96000000-0000-0000-0000-000000000379',
  mixedFile: '96000000-0000-0000-0000-000000000380',
  // The media behind the RECORDING-shaped fixture.
  recordingWav: '96000000-0000-0000-0000-000000000381',
} as const;
const CTX_IDS = {
  image: '91000000-0000-0000-0000-000000000376',
  pdf: '91000000-0000-0000-0000-000000000377',
  audio: '91000000-0000-0000-0000-000000000378',
  mixed: '91000000-0000-0000-0000-000000000379',
  // AUDIO_RECORDING container (production shape: the container itself
  // carries no media; the AudioRecording row references it).
  recording: '91000000-0000-0000-0000-000000000380',
} as const;
/**
 * The AudioRecording row id: an AUDIO_RECORDING context-item container + an
 * AudioRecording row with duration/format/sampleRate/channels metadata pointing
 * at a real uploaded WAV — exactly what `ContextService.addAudioRecording`
 * produces and `GET /consultations/:id/recordings` returns.
 */
const RECORDING_ID = '93000000-0000-0000-0000-000000000376';
const RECORDING_META = {
  durationMs: 2000,
  format: 'wav',
  sampleRate: 16000,
  channels: 1,
  language: 'en',
  recordedAt: new Date('2026-06-01T10:00:00.000Z'),
} as const;

// --- Canonical Global-tenant buckets (seed/05a-tenant-bucket.ts) -------------
const ATTACH_BUCKET = 'hope-attachments-global';
// The audio-purpose system bucket slug is `recordings`.
const AUDIO_BUCKET = 'hope-recordings-global';

const KEY_PREFIX = 'task-376';
const KEYS = {
  image: `${KEY_PREFIX}/sample-image.png`,
  pdf: `${KEY_PREFIX}/sample-document.pdf`,
  audio: `${KEY_PREFIX}/sample-audio.wav`,
  mixedImage: `${KEY_PREFIX}/mixed-photo.png`,
  mixedFile: `${KEY_PREFIX}/mixed-note.txt`,
  recordingWav: `${KEY_PREFIX}/sample-recording.wav`,
} as const;

/**
 * `Media.size` (bytes) used when blob storage is unavailable and the real sample
 * files are therefore not built/uploaded (e.g. CI without MinIO). These are the
 * approximate sizes of the generated samples;
 * `size` is metadata only — the media E2E asserts on the presigned url/mimeType,
 * not byte length — so a nominal value keeps the row valid and deterministic.
 */
const NOMINAL_SIZES = {
  image: 64917,
  pdf: 784,
  audio: 32044,
  mixedImage: 63798,
  mixedFile: 116,
  // 2 s × 16 kHz × 16-bit mono + 44-byte header (see buildSampleWav).
  recordingWav: 64044,
} as const;

/** Max wall-clock for the storage-reachability probe before treating MinIO as absent. */
const STORAGE_PROBE_TIMEOUT_MS = 5000;

/** Reject after `ms` so an unreachable/black-hole MinIO endpoint can't hang the seed. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))]);
}

// =============================================================================
// Sample-file generators — small, real, self-contained (no committed binaries).
// =============================================================================

/**
 * Rasterize a labelled gradient SVG to a real ≥320px PNG via `sharp`, so the
 * derived `.thumb.webp` (max 320px) is a genuine downscale.
 */
async function buildSamplePng(label: string): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="768">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#0ea5e9"/><stop offset="1" stop-color="#7c3aed"/>
  </linearGradient></defs>
  <rect width="1024" height="768" fill="url(#g)"/>
  <text x="512" y="384" font-family="Helvetica, Arial, sans-serif" font-size="56"
        fill="#ffffff" text-anchor="middle" dominant-baseline="middle">${label}</text>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Escape a string for a PDF literal `(...)`. */
function escapePdfText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Build a minimal, VALID single-page PDF (correct byte-offset xref table) that
 * renders the given lines — a genuine `application/pdf` blob.
 */
function buildSamplePdf(lines: string[]): Buffer {
  const text = lines.map((line, i) => `BT /F1 16 Tf 72 ${740 - i * 24} Td (${escapePdfText(line)}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(text, 'binary')} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, idx) => {
    offsets.push(Buffer.byteLength(body, 'binary'));
    body += `${idx + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefStart = Buffer.byteLength(body, 'binary');
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${off.toString().padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(body + xref + trailer, 'binary');
}

/** Build a real, playable PCM16 mono WAV of a short sine tone. */
function buildSampleWav(seconds = 1, sampleRate = 16000, freq = 440): Buffer {
  const numSamples = seconds * sampleRate;
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // audio format = PCM
  buf.writeUInt16LE(1, 22); // channels = mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    const amplitude = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.3 * 32767;
    buf.writeInt16LE(Math.round(amplitude), 44 + i * 2);
  }
  return buf;
}

// =============================================================================
// Seed
// =============================================================================

async function main(): Promise<void> {
  const prisma = getExtendedPrismaClient();

  console.log('[media-seed] seeding media for consultation', CONSULTATION_ID);

  // ── Object storage (BEST-EFFORT / CI-safe) ────────────────────────────────
  // Upload the sample blobs + the primary image's thumbnail ONLY when MinIO is
  // reachable. When it is absent (e.g. a CI seed with no storage service) the
  // whole block is skipped — bucket-ensure, sample-file build (incl. the native
  // `sharp` dep), and uploads — and the DB rows below are seeded with NOMINAL
  // sizes. The seed therefore NEVER fails just because storage is unavailable.
  const sizes: Record<keyof typeof KEYS, number> = { ...NOMINAL_SIZES };
  let storageAvailable = false;
  let s3: S3Client | null = null;
  try {
    s3 = makeS3Client({ maxAttempts: 1 });

    // 1) Physical buckets (DB rows are seeded; physical buckets are lazy). The
    //    first call doubles as the reachability probe: a connection error /
    //    timeout here drops us into the catch and seeds DB rows only.
    for (const bucket of [ATTACH_BUCKET, AUDIO_BUCKET]) {
      const created = await withTimeout(ensureBucket(s3, bucket), STORAGE_PROBE_TIMEOUT_MS, `ensureBucket(${bucket})`);
      console.log(`[bucket] ${bucket} ${created ? 'created' : 'already exists'}`);
    }

    // 2) Build the sample files.
    const imageBuf = await buildSamplePng('HOPE sample image');
    const mixedImageBuf = await buildSamplePng('HOPE mixed photo');
    const pdfBuf = buildSamplePdf([
      'HOPE sample clinical document',
      'This is a real, minimal PDF used to verify presigned',
      'attachment download + admin PDF rendering end-to-end.',
    ]);
    const wavBuf = buildSampleWav();
    // A second, distinct tone so the recording fixture is a different real
    // playable file than the plain audio attachment.
    const recordingWavBuf = buildSampleWav(2, RECORDING_META.sampleRate, 330);
    const noteBuf = Buffer.from(
      'HOPE mixed attachment note.\nAttached alongside a clinical photo to exercise the image+file+text shape.\n',
      'utf-8',
    );

    // 3) Upload objects. Primary image gets its `.thumb.webp` inline (mirrors the
    //    upload path); the mixed image is left for the backfill (see header).
    const thumbnailer = new ImageThumbnailService();
    await putObject(s3, ATTACH_BUCKET, KEYS.image, imageBuf, 'image/png');
    const thumbBuf = await thumbnailer.generateWebpThumbnail(imageBuf);
    await putObject(s3, ATTACH_BUCKET, deriveThumbnailKey(KEYS.image), thumbBuf, 'image/webp');
    console.log(
      `[object] ${ATTACH_BUCKET}/${KEYS.image} (${imageBuf.length}B) + ${deriveThumbnailKey(KEYS.image)} (${thumbBuf.length}B, real downscale)`,
    );

    await putObject(s3, ATTACH_BUCKET, KEYS.pdf, pdfBuf, 'application/pdf');
    console.log(`[object] ${ATTACH_BUCKET}/${KEYS.pdf} (${pdfBuf.length}B)`);

    await putObject(s3, AUDIO_BUCKET, KEYS.audio, wavBuf, 'audio/wav');
    console.log(`[object] ${AUDIO_BUCKET}/${KEYS.audio} (${wavBuf.length}B)`);

    await putObject(s3, AUDIO_BUCKET, KEYS.recordingWav, recordingWavBuf, 'audio/wav');
    console.log(`[object] ${AUDIO_BUCKET}/${KEYS.recordingWav} (${recordingWavBuf.length}B, recording fixture)`);

    await putObject(s3, ATTACH_BUCKET, KEYS.mixedImage, mixedImageBuf, 'image/png');
    console.log(`[object] ${ATTACH_BUCKET}/${KEYS.mixedImage} (${mixedImageBuf.length}B, NO thumb — left for backfill)`);

    await putObject(s3, ATTACH_BUCKET, KEYS.mixedFile, noteBuf, 'text/plain');
    console.log(`[object] ${ATTACH_BUCKET}/${KEYS.mixedFile} (${noteBuf.length}B)`);

    // Real byte sizes now that the objects exist.
    sizes.image = imageBuf.length;
    sizes.pdf = pdfBuf.length;
    sizes.audio = wavBuf.length;
    sizes.mixedImage = mixedImageBuf.length;
    sizes.mixedFile = noteBuf.length;
    sizes.recordingWav = recordingWavBuf.length;
    storageAvailable = true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      '[media-seed] ⚠️  object storage unavailable — seeding DB rows ONLY (no MinIO objects / thumbnail). ' +
        'Presigned urls still resolve offline; the media E2E thumbnailUrl falls back to the full-size url. ' +
        `Reason: ${reason}`,
    );
    if (s3) {
      try {
        s3.destroy();
      } catch {
        /* noop */
      }
      s3 = null;
    }
  }

  // 4) Resolve the canonical bucket DB rows so Media.bucketId is populated.
  const [attachBucketRow, audioBucketRow] = await Promise.all([
    prisma.tenantBucket.findFirst({ where: { name: ATTACH_BUCKET } }),
    prisma.tenantBucket.findFirst({ where: { name: AUDIO_BUCKET } }),
  ]);

  // 5) Consultation (Global / GEN / DOCTOR), CLOSED = a finished past visit.
  const consultation = {
    id: CONSULTATION_ID,
    tenantId: TENANT_ID,
    patientId: 'PAT-TASK376',
    appointmentDate: new Date('2026-06-01T00:00:00.000Z'),
    doctorId: DOCTOR_ID,
    departmentId: DEPARTMENT_ID,
    status: 'CLOSED' as const,
    metadata: { visitType: 'NEW_PATIENT', chiefComplaint: ' media verification fixture', language: 'en' },
    createdBy: DOCTOR_ID,
  };
  await prisma.consultation.upsert({ where: { id: CONSULTATION_ID }, create: consultation, update: consultation });
  console.log(`[consultation] upserted ${CONSULTATION_ID}`);

  // 6) Media rows. uri = s3://<bucket>/<key> (parsed by ContextService). Sizes
  //    are real when uploaded above, else NOMINAL (storage-absent path).
  const mediaRows = [
    { id: MEDIA_IDS.image, bucket: ATTACH_BUCKET, key: KEYS.image, ext: 'png', mimeType: 'image/png', size: sizes.image, kind: 'image' },
    { id: MEDIA_IDS.pdf, bucket: ATTACH_BUCKET, key: KEYS.pdf, ext: 'pdf', mimeType: 'application/pdf', size: sizes.pdf, kind: 'pdf' },
    { id: MEDIA_IDS.audio, bucket: AUDIO_BUCKET, key: KEYS.audio, ext: 'wav', mimeType: 'audio/wav', size: sizes.audio, kind: 'audio' },
    {
      id: MEDIA_IDS.mixedImage,
      bucket: ATTACH_BUCKET,
      key: KEYS.mixedImage,
      ext: 'png',
      mimeType: 'image/png',
      size: sizes.mixedImage,
      kind: 'mixed-image',
    },
    {
      id: MEDIA_IDS.mixedFile,
      bucket: ATTACH_BUCKET,
      key: KEYS.mixedFile,
      ext: 'txt',
      mimeType: 'text/plain',
      size: sizes.mixedFile,
      kind: 'mixed-file',
    },
    {
      id: MEDIA_IDS.recordingWav,
      bucket: AUDIO_BUCKET,
      key: KEYS.recordingWav,
      ext: 'wav',
      mimeType: 'audio/wav',
      size: sizes.recordingWav,
      kind: 'recording-audio',
    },
  ];
  for (const m of mediaRows) {
    const bucketId = m.bucket === ATTACH_BUCKET ? attachBucketRow?.id : audioBucketRow?.id;
    const row = {
      id: m.id,
      tenantId: TENANT_ID,
      name: m.key.split('/').pop() ?? m.key,
      uri: `s3://${m.bucket}/${m.key}`,
      extension: m.ext,
      mimeType: m.mimeType,
      size: m.size,
      hash: '',
      bucketId: bucketId ?? null,
      tags: ['task-376', 'seed', m.kind],
      createdBy: DOCTOR_ID,
    };
    await prisma.media.upsert({ where: { id: m.id }, create: row, update: row });
    console.log(`[media] upserted ${m.id} (${m.kind}) → ${row.uri}`);
  }

  // 7) Context items — all ATTACHMENT, each media-bearing (so the contract test's
  //    `i.mediaId` filter catches them). The mixed item carries the narrative
  //    text + the attached file in plaintext `_metadata` (the encrypted `content`
  //    column is owned by the service write-path, not this storage seed).
  const contextItems = [
    {
      id: CTX_IDS.image,
      mediaId: MEDIA_IDS.image,
      metaData: { subType: 'image', fileName: 'sample-image.png', caption: 'Sample clinical image .' },
    },
    {
      id: CTX_IDS.pdf,
      mediaId: MEDIA_IDS.pdf,
      metaData: { subType: 'pdf', fileName: 'sample-document.pdf', caption: 'Sample clinical PDF .' },
    },
    {
      id: CTX_IDS.audio,
      mediaId: MEDIA_IDS.audio,
      metaData: { subType: 'audio', fileName: 'sample-audio.wav', caption: 'Sample audio clip .' },
    },
    {
      id: CTX_IDS.mixed,
      mediaId: MEDIA_IDS.mixedImage,
      metaData: {
        subType: 'mixed',
        text: 'Mixed attachment: a clinical photo with an attached note (sample).',
        attachments: [
          { mediaId: MEDIA_IDS.mixedFile, name: 'mixed-note.txt', mimeType: 'text/plain', uri: `s3://${ATTACH_BUCKET}/${KEYS.mixedFile}` },
        ],
      },
    },
  ];
  for (const c of contextItems) {
    const row = {
      id: c.id,
      tenantId: TENANT_ID,
      consultationId: CONSULTATION_ID,
      type: 'ATTACHMENT' as const,
      source: 'USER' as const,
      currentVersionNumber: 1,
      mediaId: c.mediaId,
      metaData: c.metaData,
      createdBy: DOCTOR_ID,
    };
    await prisma.contextItem.upsert({ where: { id: c.id }, create: row, update: row });
    console.log(`[contextItem] upserted ${c.id} (ATTACHMENT) → media ${c.mediaId}`);
  }

  // 8) The RECORDING-shaped fixture. Mirrors what
  //    `ContextService.addAudioRecording` writes in production:
  //    an AUDIO_RECORDING container (SYSTEM-sourced, NO mediaId — the container
  //    only groups recordings) + an AudioRecording row that references the
  //    container and the uploaded WAV media, with the audio metadata populated.
  //    `GET /consultations/:id/recordings` returns exactly this shape.
  const recordingContainer = {
    id: CTX_IDS.recording,
    tenantId: TENANT_ID,
    consultationId: CONSULTATION_ID,
    type: 'AUDIO_RECORDING' as const,
    source: 'SYSTEM' as const,
    currentVersionNumber: 1,
    mediaId: null,
    metaData: { subType: 'recording', caption: 'Recording-shaped audio fixture (residual).' },
    createdBy: DOCTOR_ID,
  };
  await prisma.contextItem.upsert({
    where: { id: CTX_IDS.recording },
    create: recordingContainer,
    update: recordingContainer,
  });
  console.log(`[contextItem] upserted ${CTX_IDS.recording} (AUDIO_RECORDING container)`);

  const recordingRow = {
    id: RECORDING_ID,
    tenantId: TENANT_ID,
    contextItemId: CTX_IDS.recording,
    mediaId: MEDIA_IDS.recordingWav,
    duration: RECORDING_META.durationMs,
    format: RECORDING_META.format,
    sampleRate: RECORDING_META.sampleRate,
    channels: RECORDING_META.channels,
    language: RECORDING_META.language,
    sequenceNumber: 1,
    recordedAt: RECORDING_META.recordedAt,
    metaData: { seed: 'task-376', kind: 'recording-fixture' },
  };
  await prisma.audioRecording.upsert({ where: { id: RECORDING_ID }, create: recordingRow, update: recordingRow });
  console.log(
    `[audioRecording] upserted ${RECORDING_ID} → media ${MEDIA_IDS.recordingWav} ` +
      `(${RECORDING_META.durationMs}ms ${RECORDING_META.format}/${RECORDING_META.sampleRate}Hz/mono, seq 1)`,
  );

  await prisma.$disconnect();
  if (s3) {
    s3.destroy();
  }

  console.log('\n===== MEDIA SEED RESULT =====');
  console.log(
    JSON.stringify(
      {
        consultationId: CONSULTATION_ID,
        tenantId: TENANT_ID,
        doctorId: DOCTOR_ID,
        storageAvailable,
        objectsUploaded: storageAvailable,
        contextItems: CTX_IDS,
        media: MEDIA_IDS,
        audioRecording: { id: RECORDING_ID, containerContextItemId: CTX_IDS.recording, mediaId: MEDIA_IDS.recordingWav },
        buckets: { attachments: ATTACH_BUCKET, audio: AUDIO_BUCKET },
      },
      null,
      2,
    ),
  );
  console.log(`\nE2E_CONSULTATION_ID=${CONSULTATION_ID}`);
  console.log('================================');
}

main().catch((err) => {
  console.error('[media-seed] seed FAILED:', err);
  process.exitCode = 1;
});
