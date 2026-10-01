/**
 * Tenant checkpoints — the contracts every part of the feature codes against:
 * the model registry, the archive format, sealing, the checkpoint store, the
 * tenant lock and the worker runners. Changing a name here is a cross-lane change.
 */
import type { Readable, Writable } from 'node:stream';

// ---- format facts -------------------------------------------------------------------------
export const CHECKPOINT_FORMAT_VERSION = 1 as const;
export const CHECKPOINT_MAGIC = 'HOPECKPT' as const;
export const CHECKPOINT_BUCKET = 'hope-tenant-checkpoints' as const;
export const CHECKPOINT_WRAP_KEY = 'hope-checkpoint' as const;
export const CHECKPOINT_SIGN_KEY = 'hope-checkpoint-sign' as const;
export const CHECKPOINT_SEGMENT_BYTES = 64 * 1024;
export const CHECKPOINT_UPLOAD_PART_BYTES = 64 * 1024 * 1024;
export const TENANT_LOCK_CHANNEL = 'tenant-lock:invalidate' as const;
export { SYSTEM_TENANT_ID } from '../workflow-invariant-rule/system-tenant';

// ---- categories & registry ------------------------------------------------------------------
export type CheckpointCategory = 'CONFIG_CONTENT' | 'USERS_ACCESS' | 'CLINICAL' | 'LOGS' | 'EXCLUDED';
export type RestorableCategory = 'CONFIG_CONTENT' | 'USERS_ACCESS' | 'CLINICAL';
export const RESTORABLE_CATEGORIES: readonly RestorableCategory[] = ['CONFIG_CONTENT', 'USERS_ACCESS', 'CLINICAL'];

export type CheckpointPolicy = 'RECONCILE' | 'INSERT_ONLY' | 'RETIRE_ONLY' | 'CAPTURE_ONLY' | 'EXCLUDED';

export type CheckpointScope =
  | { kind: 'tenantColumn'; column?: string }          // WHERE "<column ?? tenantId>" = $tenantId
  | { kind: 'parent'; fk: string; parent: string }     // WHERE "<fk>" IN (SELECT "id" FROM <parent> WHERE <parent scope>)
  | { kind: 'tenantMembers' }                          // User: id IN (role assignments ∪ user departments of the tenant)
  | { kind: 'none' };                                  // EXCLUDED

export type CheckpointRetire =
  | { kind: 'softDelete' }                             // resourceStatus='DELETED', stamps, _version+1
  | { kind: 'hardDelete' }                             // only for models without soft delete and without triggers
  | { kind: 'revoke'; setSql: string }                 // e.g. `"resourceStatus" = 'DELETED', "revokedAt" = now()`
  | { kind: 'never' };

export interface CheckpointModelDescriptor {
  model: string;                      // Prisma model name
  table?: string;                     // only when @@map differs (Fedl*)
  category: CheckpointCategory;
  policy: CheckpointPolicy;
  scope: CheckpointScope;
  softDelete: boolean;                // false ⇔ in MODELS_WITHOUT_SOFT_DELETE
  retire: CheckpointRetire;
  immutableColumns?: readonly string[];   // equals the trigger's guarded columns
  immutableWhen?: string;                 // SQL over the LIVE row alias "l", e.g. `l."status" IN ('PUBLISHED','DEPRECATED')`
  derivedFrom?: string;                   // KnowledgeChunk → 'KnowledgeDocument'
  notes?: string;
}

/** Run SQL with positional params ($1…). Implemented over `pg` (worker) or Prisma $queryRawUnsafe (API). */
export type SqlQuery = <T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => Promise<T[]>;

// ---- archive --------------------------------------------------------------------------------
export interface PassphraseWrap {
  kdf: 'argon2id';
  salt: string;       // base64, 16 bytes
  m: number;          // KiB
  t: number;
  p: number;
  nonce: string;      // base64, 12 bytes
  wrapped: string;    // base64, AES-256-GCM(dataKey) ‖ tag
}
export interface KeyEnvelope { platform: string; passphrase?: PassphraseWrap }

export interface CheckpointHeader {
  magic: typeof CHECKPOINT_MAGIC;
  formatVersion: number;
  checkpointId: string;
  tenantId: string;
  tenantKey: string;
  sourceDeploymentId: string;
  createdAt: string;           // ISO
  schemaFingerprint: string;
  includesMedia: boolean;
  noncePrefix: string;         // base64, 7 bytes
  keys: KeyEnvelope;
}

export interface ManifestTable { model: string; columns: string[]; rowCount: number; sha256: string }
export interface ManifestObject { entry: string; size: number; sha256: string }
export interface CheckpointManifest {
  formatVersion: number;
  schemaFingerprint: string;
  tables: ManifestTable[];
  media: (ManifestObject & { bucketId: string; key: string })[];
  claimChecks: (ManifestObject & { contentKey: string })[];
  transitKeyVersions: Record<string, number>;   // "<Model>.<column>" → max vN seen
  notCaptured: string[];
}
export type ManifestSummary = { tables: { model: string; columns: string[]; rowCount: number }[] };

export interface CheckpointArchiveWriter {
  /** Streams one entry, sequentially; resolves with plaintext sha256 (hex) and length. */
  writeEntry(name: string, body: Readable | Buffer): Promise<{ sha256: string; bytes: number }>;
  /** Writes `manifest.json` as the final entry, the end marker and the trailer; ends the sink. */
  finish(manifest: CheckpointManifest): Promise<{ sizeBytes: number; digestHex: string; manifestDigestHex: string }>;
  abort(error: Error): Promise<void>;
}
export interface CheckpointArchiveReader {
  readonly header: CheckpointHeader;
  /** Entries in archive order, `manifest.json` excluded; consume each body fully before the next. */
  entries(): AsyncIterable<{ name: string; body: Readable }>;
  /** Available once entries() has completed. */
  manifest(): CheckpointManifest;
}
export interface VerifiedArchive { header: CheckpointHeader; manifest: CheckpointManifest; sizeBytes: number }

// ---- sealing --------------------------------------------------------------------------------
export interface ICheckpointSealing {
  generateDataKey(): Promise<{ plaintext: Buffer; platformWrapped: string }>;
  unwrapPlatform(wrapped: string): Promise<Buffer>;
  wrapWithPassphrase(dataKey: Buffer, passphrase: string): Promise<PassphraseWrap>;
  unwrapWithPassphrase(wrap: PassphraseWrap, passphrase: string): Promise<Buffer>;
  sign(digest: Buffer): Promise<string>;
  verify(digest: Buffer, signature: string): Promise<boolean>;
  deploymentId(): Promise<string>;
}
export const ICheckpointSealing = Symbol('ICheckpointSealing');

// ---- store ----------------------------------------------------------------------------------
export interface ICheckpointStore {
  ensureBucket(): Promise<void>;
  objectKey(tenantId: string, checkpointId: string): string;              // `${tenantId}/${checkpointId}.hcp`
  openWriteStream(key: string): { stream: Writable; done: Promise<{ sizeBytes: number }>; abort(): Promise<void> };
  openReadStream(key: string): Promise<Readable>;
  presignDownload(key: string, filename: string, ttlSeconds: number): Promise<string>;
  createUpload(key: string): Promise<{ uploadId: string }>;
  presignUploadParts(key: string, uploadId: string, partCount: number, ttlSeconds: number): Promise<{ partNumber: number; url: string }[]>;
  completeUpload(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<{ sizeBytes: number }>;
  abortUpload(key: string, uploadId: string): Promise<void>;
  delete(key: string): Promise<void>;
}
export const ICheckpointStore = Symbol('ICheckpointStore');

// ---- lock -----------------------------------------------------------------------------------
export interface TenantLockState { locked: boolean; restoreId?: string }
export interface ITenantLockService {
  state(tenantId: string): Promise<TenantLockState>;
  /** Drop every node's cached state for the tenant (publishes on TENANT_LOCK_CHANNEL). */
  publishChange(tenantId: string): Promise<void>;
}
export const ITenantLockService = Symbol('ITenantLockService');
export const TENANT_LOCKING_STATUSES = ['LOCKING', 'SAFETY_CHECKPOINT', 'VERIFYING', 'RECONCILING', 'POST_COMMIT'] as const;

// ---- runners (worker side) -----------------------------------------------------------------
export interface ICheckpointExportRunner { run(checkpointId: string): Promise<void> }
export const ICheckpointExportRunner = Symbol('ICheckpointExportRunner');
export interface ICheckpointVerifyRunner { run(checkpointId: string): Promise<void> }
export const ICheckpointVerifyRunner = Symbol('ICheckpointVerifyRunner');
export interface CheckpointExportJob { kind: 'create' | 'verify-upload'; checkpointId: string; tenantId: string }
export interface CheckpointRestoreJob { restoreId: string; tenantId: string }

export interface ReconcileCount { model: string; inserted: number; updated: number; retired: number }
export interface RestoreWarning { code: string; message: string; detail?: Record<string, unknown> }

// ---- errors ---------------------------------------------------------------------------------
export type CheckpointFailureReason =
  | 'UNSUPPORTED_FORMAT' | 'SIGNATURE_INVALID' | 'WRONG_TENANT' | 'FOREIGN_DEPLOYMENT'
  | 'CORRUPT_SEGMENT' | 'MANIFEST_MISMATCH' | 'DUPLICATE' | 'PASSPHRASE_INVALID'
  | 'SEALING_UNAVAILABLE' | 'UPLOAD_PARTS_INVALID' | 'SCHEMA_INCOMPATIBLE'
  | 'EXPORT_FAILED' | 'RESTORE_FAILED' | 'LOCK_TIMEOUT' | 'WORKER_LOST' | 'CANCELLED';

export class CheckpointError extends Error {
  constructor(
    readonly reason: CheckpointFailureReason,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CheckpointError';
  }
}
