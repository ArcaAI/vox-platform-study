/** Tenant checkpoints — wire types for `admin/tenants/:tenantId/checkpoints`. */

export type CheckpointStatus = 'PENDING' | 'UPLOADING' | 'RUNNING' | 'READY' | 'FAILED' | 'CANCELLED';

export interface TenantCheckpoint {
  id: string;
  tenantId: string;
  label: string;
  kind: 'MANUAL' | 'SAFETY';
  origin: 'CREATED' | 'UPLOADED';
  status: CheckpointStatus;
  includesMedia: boolean;
  passphraseProtected: boolean;
  sizeBytes: number | null;
  progress: { phase: string; tablesDone: number; tablesTotal: number; bytesWritten: number } | null;
  createdAt: string;
  createdBy: string | null;
  expiresAt: string | null;
  heartbeatAt: string | null;
  failureReason: string | null;
  failureDetail: string | null;
  version: number;
}

export type RestoreStatus =
  | 'PENDING'
  | 'LOCKING'
  | 'SAFETY_CHECKPOINT'
  | 'VERIFYING'
  | 'RECONCILING'
  | 'POST_COMMIT'
  | 'COMPLETED'
  | 'COMPLETED_WITH_WARNINGS'
  | 'FAILED';

export type RestoreCategory = 'CONFIG_CONTENT' | 'USERS_ACCESS' | 'CLINICAL';

export interface TenantCheckpointRestore {
  id: string;
  checkpointId: string;
  categories: RestoreCategory[];
  reason: string;
  status: RestoreStatus;
  safetyCheckpointId: string | null;
  counts: { model: string; inserted: number; updated: number; retired: number }[] | null;
  warnings: { code: string; message: string; detail?: Record<string, unknown> }[];
  requestedBy: string;
  createdAt: string;
  lockAcquiredAt: string | null;
  lockReleasedAt: string | null;
  failureReason: string | null;
  failureDetail: string | null;
  version: number;
}

export interface CreateCheckpointRequest {
  label: string;
  includesMedia: boolean;
  passphrase?: string;
}

export interface DownloadUrl {
  url: string;
  expiresAt: string;
  filename: string;
}

export interface UploadPartTarget {
  partNumber: number;
  url: string;
}

export interface InitUploadResult {
  checkpoint: TenantCheckpoint;
  uploadId: string;
  partSizeBytes: number;
  parts: UploadPartTarget[];
  expiresAt: string;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface RestoreRequest {
  categories: RestoreCategory[];
  reason?: string;
  password: string;
  confirmationName: string;
}

export const RESTORE_CATEGORY_LABELS: Record<RestoreCategory, { label: string; description: string }> = {
  CONFIG_CONTENT: { label: 'Configuration and content', description: 'Agents, prompts, workflows, schemas, settings and other tenant configuration.' },
  USERS_ACCESS: { label: 'Users and access', description: 'Users, roles, assignments and API keys.' },
  CLINICAL: { label: 'Clinical data', description: 'Consultations, transcripts, summaries and reports.' },
};

const TERMINAL_CHECKPOINT: readonly CheckpointStatus[] = ['READY', 'FAILED', 'CANCELLED'];
const TERMINAL_RESTORE: readonly RestoreStatus[] = ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED'];

export const isCheckpointActive = (status: CheckpointStatus): boolean => !TERMINAL_CHECKPOINT.includes(status);
export const isRestoreActive = (status: RestoreStatus): boolean => !TERMINAL_RESTORE.includes(status);
