import type { CaptureState, ConsultationProcessing, GuardrailHoldResolution, StopResult } from '@arcaai/types';
import type { ConsultationResponse } from '../consultation/dto/consultation.response';

/** Who is acting, as resolved by the controller (human JWT, API key, or service account). */
export interface ClinicalCaller {
  userId?: string;
  serviceAccountId?: string;
  apiKeyId?: string;
  isMachine: boolean;
}

/**
 * The consultation lifecycle commands. Every method resolves the consultation inside the
 * caller's tenant (404 otherwise) and refuses an illegal transition with
 * 409 `CONSULTATION_TRANSITION_ILLEGAL`.
 */
export abstract class IConsultationLifecycleService {
  abstract start(consultationId: string, options?: { sttSessionId?: string; supersedeByDurableBinding?: boolean }): Promise<CaptureState>;
  /** `guardrail_hold`: capture stopped by a guardrail block (TASK-1050 §9.7.5) — recorded as the transition reason. */
  abstract pause(consultationId: string, options?: { reason?: 'user' | 'stale_recording' | 'guardrail_hold' }): Promise<CaptureState>;
  /** Idempotent on STOPPED: returns the current `finalTranscript` state. */
  abstract stop(consultationId: string, options?: { waitForFinal?: boolean }): Promise<StopResult>;
  /**
   * Approve the whole consultation (snapshot of every item's current version; locks content).
   * On CLOSED_INCOMPLETE (a late sign-off) it reopens, approves and closes atomically.
   * On CLOSED_COMPLETE it is an idempotent no-op.
   */
  abstract approve(
    consultationId: string,
    options: {
      expectedVersion: number;
      clinicianUserId?: string;
      overrideSafetyFlag?: boolean;
      caller: ClinicalCaller;
      legacyContextItemId?: string;
      /** TASK-1050 §9.8.3 — every open warning is acknowledged in the approve transaction either way. */
      acknowledgeGuardrailNotices?: boolean;
      /** TASK-1050 §9.8.3 / OD-24 — resolve an inbound guardrail hold and approve in one transaction. */
      resolveHold?: GuardrailHoldResolution;
    },
  ): Promise<ConsultationResponse>;
  /** CLOSED_COMPLETE when APPROVED, else CLOSED_INCOMPLETE. Idempotent on a closed row. */
  abstract close(
    consultationId: string,
    options?: { expectedVersion?: number; clinicianUserId?: string; caller?: ClinicalCaller; auto?: boolean },
  ): Promise<ConsultationResponse>;
  /**
   * CLOSED → OPEN. Attributed like `close` when a clinician is named; a service account that names
   * nobody reopens for the clinician the row names, a human for themselves.
   */
  abstract reopen(
    consultationId: string,
    options: { expectedVersion: number; reason?: string; clinicianUserId?: string; caller?: ClinicalCaller },
  ): Promise<ConsultationResponse>;
}

export const IConsultationLifecycleServiceToken = Symbol('IConsultationLifecycleService');

/**
 * Narrow gate other services use to respect the lifecycle without depending on the full
 * service. None of these methods bumps the consultation `_version`.
 */
export abstract class IConsultationLifecycleGate {
  /** 409 `CONSULTATION_APPROVED` (APPROVED / CLOSED_COMPLETE) or `CONSULTATION_CLOSED` (CLOSED_INCOMPLETE). */
  abstract assertContentWritable(consultationId: string): Promise<void>;
  abstract touchActivity(consultationId: string): Promise<void>;
  abstract beginProcessing(consultationId: string, processing: ConsultationProcessing, refId: string): Promise<void>;
  abstract endProcessing(consultationId: string, refId: string, outcome?: { failed?: boolean; reason?: string }): Promise<void>;
  abstract setProcessing(consultationId: string, processing: ConsultationProcessing, reason?: string): Promise<void>;
  abstract currentEncounterSeq(consultationId: string): Promise<number>;
}

export const IConsultationLifecycleGateToken = Symbol('IConsultationLifecycleGate');
