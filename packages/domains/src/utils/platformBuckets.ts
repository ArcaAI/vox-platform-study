/**
 * PLATFORM buckets — physical MinIO/S3 buckets that belong to the platform
 * itself and can never be owned by a tenant.
 *
 * Every name here is created by the MinIO bootstrap in
 * `infrastructure/docker/docker-compose.yml` (and its cluster equivalent),
 * NOT by tenant provisioning. Tenant buckets are always named
 * `hope-<slug>-<tenantKey>` by `TenantBucketFactory` — a three-segment shape
 * these names deliberately do not share, which is why this is an explicit
 * list rather than a name-prefix heuristic (`hope-models` would match a
 * naive `hope-` prefix test).
 *
 * Why this matters beyond labelling: a `TenantBucket` row adopted for one of
 * these names is stamped `CUSTOM` by `TenantBucketFactory.CreateNamedBucket`,
 * so it sails past the `isSystemBucket` guard on
 * `TenantBucketService.deleteBucket` — which then calls
 * `blobStorage.deleteBucket()` against the platform bucket. For `hope-models`
 * (object-locked weights) the provider refuses, the row is soft-deleted
 * anyway, and the registry silently diverges from reality. Blocking adoption
 * is what makes that unreachable.
 */
export const PLATFORM_BUCKET_NAMES = [
  /** Published model weights — object-locked, versioned, read via `hope-models-reader`. */
  'hope-models',
  /** MLflow's proxied artifact store — deliberately unversioned so `mlflow gc` stays a hard delete. */
  'mlflow',
  /** Legacy/global media buckets predating per-tenant provisioning (public read policy). */
  'recordings',
  'generated-audio',
  /** Legacy/global document store predating per-tenant `hope-attachments-<tenantKey>`. */
  'documents',
  /** Database and object backups. */
  'backups',
  /** Compiled-config claim check minted on every workflow dispatch (`CLAIM_CHECK_BUCKET`). */
  'harness-claim-check',
  /**
   * STT's GLOBAL audio + streaming-chunk buckets — the fallback a
   * transcription job uses when the tenant has no AUDIO-purpose bucket
   * (`transcription-job.controller.ts`: "the global 'hope-audio'"), and the
   * seeded `stt.config/storage` defaults (`audio_bucket` / `chunk_bucket`).
   * Created at runtime rather than by the compose bootstrap, which is exactly
   * why they are easy to miss — both were sitting in dev MinIO unlisted here
   * on the first pass.
   */
  'hope-audio',
  'hope-audio-chunks',
] as const;

export type PlatformBucketName = (typeof PLATFORM_BUCKET_NAMES)[number];

const PLATFORM_BUCKET_SET: ReadonlySet<string> = new Set<string>(PLATFORM_BUCKET_NAMES);

/**
 * True when `name` is a platform bucket and therefore never tenant-ownable.
 * Compared case-insensitively against the trimmed name: S3 bucket names are
 * lowercase by convention, and a caller that sends `Hope-Models` must not
 * slip past the guard.
 */
export function isPlatformBucket(name: string | null | undefined): boolean {
  if (!name) return false;
  return PLATFORM_BUCKET_SET.has(name.trim().toLowerCase());
}
