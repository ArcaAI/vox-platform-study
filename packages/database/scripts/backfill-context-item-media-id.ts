/**
 * Backfill `ContextItem.mediaId` rows corrupted by the producer bug.
 *
 * WHY
 * ---
 * `ContextItem.mediaId` is documented and consumed as a `Media` table row
 * UUID. Two independent bugs (StorageController.uploadFile returning BOTH a
 * `key` and a `mediaId`, and three `apps/ui-playground` call sites sending
 * `key` instead of `mediaId`) meant every ATTACHMENT/AUDIO_RECORDING added
 * through `context-panel.tsx`, `consultation-recording-panel.tsx`, or
 * `use-dual-capture.ts` persisted a raw S3 OBJECT KEY into `mediaId`, not a
 * `Media.id`. `OcrEnrichmentProcessor` happened to also (wrongly) treat
 * `mediaId` as a literal key, so OCR worked by coincidence; every OTHER
 * consumer (`ContextService.resolveMediaUrls`, `TextProxyController.extractAttachmentText`)
 * does the CORRECT `mediaRepository.findById(mediaId)` lookup and therefore
 * silently found nothing for these rows. A later fix covers the producers (they
 * now send `mediaId`) and the one broken consumer (`OcrEnrichmentProcessor`);
 * this script repairs the ROWS THAT ALREADY EXIST with the bad value, because
 * fixing the processor without it would break OCR for every attachment
 * uploaded before the fix shipped.
 *
 * WHAT IT TOUCHES
 * ---------------
 * `ContextItem` rows of type `ATTACHMENT` or `AUDIO_RECORDING` whose `mediaId`
 * is NOT a valid UUID (i.e. it is a raw storage key). For each such row it:
 *   1. builds the canonical `uri = s3://<bucket>/<mediaId>` the row's `mediaId`
 *      (the raw key) must have pointed at — `--bucket` defaults to
 *      `attachments` (the frontend's `STORAGE_BUCKET` constant, and
 * `OcrEnrichmentProcessor`'s pre- default);
 *   2. finds an existing `Media` row with that exact `uri` (dedupes when
 *      multiple ContextItems reference the same key) or CREATES one —
 *      best-effort `name`/`extension`/`mimeType` derived from the key,
 *      `size: 0` and `hash: ''` (bytes are never read; this mirrors
 *      `StorageController.uploadFile`'s own best-effort `hash: ''`);
 *   3. rewrites `ContextItem.mediaId` to the resolved/created `Media.id`
 *      (plus the standard `_version` bump + `updatedBy` audit stamp).
 *
 * It NEVER deletes a row and never touches a `ContextItem` whose `mediaId` is
 * already a valid UUID (untouched, not re-verified against an actual `Media`
 * row — a dangling-but-UUID-shaped `mediaId` is a different problem than the
 * one this ticket fixes).
 *
 * SAFETY
 * ------
 *   - DRY RUN IS THE DEFAULT. Nothing is written unless `--apply` is passed.
 *   - All writes for one run happen inside a single interactive transaction;
 *     any error rolls the whole batch back.
 *   - Idempotent BY CONSTRUCTION: a rewritten `mediaId` is a valid UUID, so a
 *     second run's `SELECT` (type IN (...) AND mediaId NOT a UUID) simply
 *     finds zero rows for it and exits 0. No separate "already processed"
 *     marker is needed.
 *
 * USAGE
 * -----
 *   # 1. dry run (default) — prints the plan, writes nothing
 *   NODE_ENV=development pnpm --filter @arcaai/database exec \
 *     tsx scripts/backfill-context-item-media-id.ts
 *
 *   # 2. scope to one tenant while reviewing
 *   ... tsx scripts/backfill-context-item-media-id.ts --tenant 50000000-0000-0000-0000-000000000000
 *
 *   # 3. override the bucket name if a legacy deployment used a different one
 *   ... tsx scripts/backfill-context-item-media-id.ts --bucket attachments --apply
 *
 * Against a remote database, set DATABASE_URL explicitly.
 *
 * Exit codes: 0 success (or nothing to do) · 1 runtime error · 2 bad invocation.
 */
// eslint-disable-next-line no-restricted-imports -- scripts/** allow-list: maintenance task must see every tenant's rows
import { getPlatformAdminPrismaClient_Unscoped } from '../src/client';

/** System user — the audit actor for unattended maintenance writes (seed/00-constants.ts). */
const SYSTEM_USER_ID = '60000000-0000-0000-0000-000000000000';

/** ContextItem types that carry a `mediaId` soft-reference to `Media`. */
const MEDIA_CONTEXT_TYPES = ['ATTACHMENT', 'AUDIO_RECORDING'] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `value` is already a well-formed UUID — i.e. NOT the raw-key bug. */
export function isValidMediaId(value: string): boolean {
  return UUID_RE.test(value);
}

const EXTENSION_MIME_MAP: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  webm: 'audio/webm',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
};

/** Best-effort `{ name, extension, mimeType }` derived from a raw storage key. */
export function deriveMediaFields(key: string): { name: string; extension: string; mimeType: string } {
  const name = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key;
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  const mimeType = EXTENSION_MIME_MAP[extension] ?? 'application/octet-stream';
  return { name, extension, mimeType };
}

export interface TargetContextItem {
  id: string;
  tenantId: string;
  mediaId: string;
}

export interface BackfillClient {
  contextItem: {
    findMany(args: unknown): Promise<TargetContextItem[]>;
    update(args: unknown): Promise<unknown>;
  };
  media: {
    findFirst(args: unknown): Promise<{ id: string } | null>;
    create(args: unknown): Promise<{ id: string }>;
  };
  $transaction<T>(fn: (tx: BackfillClient) => Promise<T>): Promise<T>;
}

export interface BackfillOptions {
  apply: boolean;
  tenantId: string | null;
  bucket: string;
}

export interface BackfillPlanRow {
  contextItemId: string;
  tenantId: string;
  rawKey: string;
  uri: string;
  resolvedMediaId: string;
  mediaAction: 'reused' | 'created';
}

/**
 * Fetch every ATTACHMENT/AUDIO_RECORDING ContextItem with a non-null mediaId
 * in scope, then filter (in application code — Prisma has no portable
 * "is this a UUID" predicate) to the ones whose mediaId is NOT a valid UUID,
 * i.e. the ones carrying the pre- raw-key bug.
 */
async function findTargets(client: BackfillClient, tenantId: string | null): Promise<TargetContextItem[]> {
  const rows = await client.contextItem.findMany({
    where: {
      type: { in: MEDIA_CONTEXT_TYPES },
      mediaId: { not: null },
      ...(tenantId ? { tenantId } : {}),
    },
    select: { id: true, tenantId: true, mediaId: true },
  });
  return rows.filter((row) => row.mediaId && !isValidMediaId(row.mediaId));
}

/**
 * Resolve (find-or-create) the `Media` row for one `{ tenantId, bucket, key }`,
 * deduping repeat keys within a single run via `cache`.
 */
async function resolveOrCreateMedia(
  client: BackfillClient,
  tenantId: string,
  bucket: string,
  key: string,
  cache: Map<string, { id: string; action: 'reused' | 'created' }>,
): Promise<{ id: string; uri: string; action: 'reused' | 'created' }> {
  const uri = `s3://${bucket}/${key}`;
  const cacheKey = `${tenantId}::${uri}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    // A cache hit means THIS row is reusing a Media row a prior row in the same
    // run already resolved — always 'reused' here, regardless of whether that
    // prior row itself created or reused it (spreading `cached.action` would
    // wrongly propagate 'created' to every subsequent duplicate).
    return { id: cached.id, uri, action: 'reused' };
  }

  const existing = await client.media.findFirst({ where: { tenantId, uri } });
  if (existing) {
    cache.set(cacheKey, { id: existing.id, action: 'reused' });
    return { id: existing.id, uri, action: 'reused' };
  }

  const { name, extension, mimeType } = deriveMediaFields(key);
  const created = await client.media.create({
    data: {
      tenantId,
      name,
      uri,
      extension,
      mimeType,
      size: 0, // bytes are never read by this script — best-effort placeholder
      hash: '', // mirrors StorageController.uploadFile's own best-effort empty hash
      createdBy: SYSTEM_USER_ID,
    },
  });
  cache.set(cacheKey, { id: created.id, action: 'created' });
  return { id: created.id, uri, action: 'created' };
}

/**
 * Build the backfill plan (read-only) for every target row. Pure with respect
 * to persistence — callers decide whether/how to apply it.
 */
export async function planBackfill(client: BackfillClient, opts: BackfillOptions): Promise<BackfillPlanRow[]> {
  const targets = await findTargets(client, opts.tenantId);
  const cache = new Map<string, { id: string; action: 'reused' | 'created' }>();
  const plan: BackfillPlanRow[] = [];
  // Sequential (not Promise.all) so the in-run dedupe cache is race-free.
  for (const target of targets) {
    const resolved = await resolveOrCreateMedia(client, target.tenantId, opts.bucket, target.mediaId, cache);
    plan.push({
      contextItemId: target.id,
      tenantId: target.tenantId,
      rawKey: target.mediaId,
      uri: resolved.uri,
      resolvedMediaId: resolved.id,
      mediaAction: resolved.action,
    });
  }
  return plan;
}

/** Apply a previously-built plan: rewrite each ContextItem.mediaId, in one transaction. */
export async function applyBackfill(client: BackfillClient, plan: BackfillPlanRow[]): Promise<number> {
  return client.$transaction(async (tx) => {
    let count = 0;
    for (const row of plan) {
      await tx.contextItem.update({
        where: { id: row.contextItemId },
        data: { mediaId: row.resolvedMediaId, version: { increment: 1 }, updatedBy: SYSTEM_USER_ID },
      });
      count += 1;
    }
    return count;
  });
}

export function parseArgs(argv: string[]): Options {
  const opts: Options = { apply: false, tenantId: null, bucket: 'attachments' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      opts.apply = true;
    } else if (arg === '--tenant') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        console.error('--tenant requires a tenant id');
        process.exit(2);
      }
      opts.tenantId = value;
      i += 1;
    } else if (arg === '--bucket') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        console.error('--bucket requires a bucket name');
        process.exit(2);
      }
      opts.bucket = value;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: backfill-context-item-media-id.ts [--tenant <tenantId>] [--bucket <name>] [--apply]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

interface Options {
  apply: boolean;
  tenantId: string | null;
  bucket: string;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CorePrismaClient structurally satisfies BackfillClient for the fields used
  const prisma = getPlatformAdminPrismaClient_Unscoped() as any as BackfillClient;

  const mode = opts.apply ? 'APPLY' : 'DRY RUN (default — no writes)';
  console.log('===== backfill ContextItem.mediaId (raw-key → Media UUID) =====');
  console.log(`mode   : ${mode}`);
  console.log(`tenant : ${opts.tenantId ?? 'ALL'}`);
  console.log(`bucket : ${opts.bucket}`);

  const plan = await planBackfill(prisma, opts);

  console.log(`\n----- ContextItem rows carrying a raw-key mediaId: ${plan.length} -----`);
  for (const row of plan) {
    console.log(`  ${row.tenantId}  ctx=${row.contextItemId}  "${row.rawKey}" → ${row.resolvedMediaId} (media ${row.mediaAction}, ${row.uri})`);
  }

  if (plan.length === 0) {
    console.log('\nNothing to do — already clean.');
    return;
  }

  if (!opts.apply) {
    console.log(`\nDRY RUN — no rows were modified. Re-run with --apply to fix these ${plan.length} row(s).`);
    return;
  }

  const applied = await applyBackfill(prisma, plan);
  console.log(`\nAPPLIED — rewrote mediaId on ${applied} ContextItem row(s).`);
}

// Main-module guard so unit tests can import the pure helpers without running
// (mirrors decrypt-row.ts — `require.main === module` is unreliable under tsx).
const invokedDirectly = typeof process.argv[1] === 'string' && /backfill-context-item-media-id/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('BACKFILL CONTEXT ITEM MEDIA ID FAILED:', err);
    process.exit(1);
  });
}
