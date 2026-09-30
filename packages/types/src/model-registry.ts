/**
 * TASK-1023 — the model-registry contract shared by the gateway and the admin console.
 *
 * The bucket name and its mount point are declared ONCE here (OD-8): every serving pod mounts
 * `hope-models` read-only at `HOPE_MODELS_MOUNT` through its s3fs sidecar, and the gateway
 * derives each model's absolute `localPath` from it. A deployment manifest that mounts the
 * bucket anywhere else is caught by the deployment repo's CI check, not by a runtime knob.
 */

/** The platform bucket that holds every self-hosted model's weights. */
export const HOPE_MODELS_BUCKET = 'hope-models';

/** Where every serving pod mounts `HOPE_MODELS_BUCKET` (read-only). */
export const HOPE_MODELS_MOUNT = '/mnt/models-bucket';

/** The registration sources the console offers. `MLFLOW` is shown but not available yet. */
export const MODEL_REGISTRATION_SOURCES = ['HUGGINGFACE', 'MLFLOW', 'LOCAL'] as const;
export type ModelRegistrationSource = (typeof MODEL_REGISTRATION_SOURCES)[number];

/** `GET admin/ai-models/access` — what the caller may do on the registry. */
export interface ModelRegistryAccess {
  /** True only for a platform admin (SUPER_ADMIN, no working tenant). */
  canManage: boolean;
  /**
   * The effective `modelRegistry.tenantManagement.enabled` value for the caller's tenant.
   * Recorded for a later ticket: it does NOT grant a tenant admin any write today (TASK-1023 OD-1).
   */
  tenantManagementEnabled: boolean;
}

/** State of one model-publisher job as the Jobs view shows it. */
export const PUBLISHER_JOB_STATES = ['waiting', 'active', 'completed', 'failed', 'cancelled'] as const;
export type PublisherJobState = (typeof PUBLISHER_JOB_STATES)[number];

/** One row of `GET admin/ai-models/jobs`. */
export interface PublisherJobView {
  jobId: string;
  kind: 'download' | 'unregister';
  aiModelId: string;
  modelSlug: string;
  modelName: string;
  state: PublisherJobState;
  bytesDone: number | null;
  bytesTotal: number | null;
  /** ISO timestamps. */
  startedAt: string;
  finishedAt: string | null;
  /** User id that started the job, when known. */
  startedBy: string | null;
  error: { code: string; message: string } | null;
}

/** `POST admin/ai-models/:id/download/cancel` body. */
export interface CancelModelDownloadRequest {
  /** Also remove the registration (and any weights) once the download is cancelled. Default false. */
  removeRegistration?: boolean;
}

/** `POST admin/ai-models/:id/download/cancel` → 202. */
export interface CancelModelDownloadResponse {
  jobId: string;
  /** `removed` = the job was still queued and is gone; `cancelling` = the worker is stopping it. */
  outcome: 'removed' | 'cancelling';
  /** Present when `removeRegistration` was requested: the unregister job that follows. */
  unregisterJobId: string | null;
}

/** `GET admin/ai-models/local/preview?path=` — what a bucket path holds, derived, never typed. */
export interface LocalModelPreview {
  /** Bucket-relative prefix with a trailing slash (the normalised input). */
  bucketPrefix: string;
  /** `HOPE_MODELS_MOUNT` + `bucketPrefix` (+ `primaryObject`) — what the services load. */
  localPath: string;
  /** The single file a single-file loader opens (whisper.cpp / llama.cpp / onnxruntime), else null. */
  primaryObject: string | null;
  layout: 'hf-cache' | 'flat' | 'files';
  files: { key: string; size: number }[];
  totalBytes: number;
  /** HF snapshot sha when the path is an HF-cache snapshot. */
  revision: string | null;
  suggested: {
    slug: string;
    name: string;
    taskType: string | null;
    libraryName: string | null;
    format: string | null;
    servedBy: string | null;
    architecture: string | null;
    computeType: string | null;
  };
}

/** `POST admin/ai-models/register-from-path` body. Everything but `path` is an optional override. */
export interface RegisterFromPathRequest {
  path: string;
  slug?: string;
  name?: string;
  taskType?: string;
  libraryName?: string;
  format?: string;
  servedBy?: string;
}
