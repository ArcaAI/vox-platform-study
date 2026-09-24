import type { LanguageModeSource, LanguageResolution } from '../../../../common/language';
/**
 * TASK-992 FU-1 — the shape of `TranscriptionJob.dispatchEnvelope`.
 *
 * Everything a batch job's Dramatiq message needs that is NOT already on the
 * row, snapshotted at the moment it is published so a retry re-publishes the
 * same work instead of only flipping a status.
 *
 * Two deliberate omissions:
 *
 * - **`resolvedSpec`** is absent because the ROW already carries it (TASK-861),
 *   as the authoritative, reproducible snapshot. Copying a multi-KB spec into a
 *   second column per job would buy nothing and give the two copies a way to
 *   disagree.
 * - **`storage`** is absent because a {@link StorageDescriptor} carries
 *   `secret_access_key` / `account_key` / `connection_string`. Only the bucket
 *   NAME is kept; the descriptor is re-resolved live on every dispatch, which is
 *   also what makes a credential rotation between attempts a non-event.
 *   `hadStorageDescriptor` records whether one was in play, so a retry that
 *   cannot produce one refuses instead of silently dispatching a job that will
 *   look in the wrong backend.
 */
export interface BatchDispatchEnvelope {
  /**
   * The object the worker downloads. The reason this column exists: the upload
   * path builds it from the request filename plus the job's own id, so it is
   * gone when the request ends and is reconstructable from nothing else.
   */
  audioUri: string;
  /** The runtime key actually sent — the agent VERSION id, or the deprecated pipeline id. */
  pipelineId: string;
  consultationId?: string;
  mediaId?: string;
  language?: string;
  /**
   * The job's OWNER as resolved at dispatch, which is what seeds enrolled voice
   * profiles. Deliberately not read back from `createdBy`: for a machine caller
   * that column holds the system-user default (the TASK-991 W2-1 known gap)
   * while the dispatch owner is the named clinician.
   */
  userId?: string;
  audioBucketName?: string;
  /** @deprecated TASK-861 — removed in R4 with the legacy pipeline path. */
  fallbackPipelineId?: string;
  /** Whether a per-tenant `StorageDescriptor` was resolved for this dispatch. */
  hadStorageDescriptor: boolean;
  /**
   * TASK-1004 — the job's effective spoken-language mode and the tier that declared it, exactly as
   * sent (`language_mode` / `language_mode_source` kwargs), so a retry re-publishes the same mode.
   * Absent when no mode was sent (STT applied the agent's own).
   */
  languageMode?: string;
  languageModeSource?: LanguageModeSource;
  /**
   * TASK-1004 — the language RECEIPT the worker reported for the attempt this envelope dispatched
   * (camelCase), written by the completion callback. A re-dispatch rewrites the envelope and so
   * drops the previous attempt's receipt — a receipt belongs to one attempt. Kept here because the
   * `TranscriptionJob` entity surfaces no generic metadata column; `languageResolution` on every
   * job read is lifted from it.
   */
  languageResolution?: LanguageResolution;
}
