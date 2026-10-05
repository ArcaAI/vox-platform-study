import type { ClinicalCaller } from '../lifecycle/IConsultationLifecycleService';
import type { CreateFeedbackRequest, FeedbackPageResponse, FeedbackReasonCodesResponse, FeedbackResponse } from './dto';
import type { FeedbackTargetKindValue } from './feedback-policy';

/** `GET consultations/:id/feedback` filters. */
export interface FeedbackListFilters {
  targetKind?: FeedbackTargetKindValue;
  contextItemId?: string;
  /** Include superseded ratings too (default: the latest per actor + target only). */
  includeHistory?: boolean;
  /** The opaque `nextCursor` of the previous page. */
  cursor?: string;
  limit?: number;
}

/**
 * The signal queued to the gate-edit mining loop for a thumbs-down or a correction.
 * The miner loads the feedback row by id; nothing PHI-bearing travels on the queue.
 */
export interface FeedbackMiningSignal {
  source: 'feedback';
  feedbackId: string;
}

/**
 * Clinician feedback on a consultation: ratings, reasons, comments, feedback media and
 * corrections. Every method resolves the consultation inside the caller's tenant (404 otherwise).
 */
export abstract class IConsultationFeedbackService {
  /**
   * Record one feedback entry. Ratings and comments are accepted in every status; a correction
   * needs writable content (409 `CONSULTATION_APPROVED` / `CONSULTATION_CLOSED`). The same
   * `Idempotency-Key` with the same body answers the same row; with a different body 409
   * `IDEMPOTENCY_KEY_REUSED`.
   */
  abstract create(
    consultationId: string,
    body: CreateFeedbackRequest,
    idempotencyKey: string | undefined,
    caller: ClinicalCaller,
  ): Promise<FeedbackResponse>;

  /** Newest first; the latest entry per actor + target unless `includeHistory`. */
  abstract list(consultationId: string, filters: FeedbackListFilters): Promise<FeedbackPageResponse>;

  /** Every entry (history included), comments decrypted — the console activity view, behind its own gate. */
  abstract listForActivity(consultationId: string, page: { cursor?: string; limit?: number }): Promise<FeedbackPageResponse>;

  /** The effective reason list for the tenant (tenant value, else the platform one). */
  abstract reasonCodes(tenantId?: string): Promise<FeedbackReasonCodesResponse>;
}

export const IConsultationFeedbackServiceToken = Symbol('IConsultationFeedbackService');
