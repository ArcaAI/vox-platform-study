import type { ConsultationEncounterEntity, ConsultationEntity } from '@arcaai/domains';
import type { EncounterResponse } from '../consultation/dto/encounter.response';
import type { ConsultationLifecycleView } from './lifecycle-view';

/** The encounter a new visit starts with. */
export interface EncounterStart {
  visitType: string;
  externalRef: string | null;
}

/**
 * The encounters (visits) of a consultation episode. Owns the writes that create or append an
 * encounter — each one atomic with the consultation write it belongs to — and the episode facts a
 * consultation response carries.
 */
export abstract class IConsultationEncounterService {
  /**
   * The encounter of this tenant carrying `externalRef` for the same patient and clinician
   * (`own`), and whether the ref already belongs to a DIFFERENT patient (`conflict`).
   */
  abstract matchExternalRef(
    tenantId: string,
    externalRef: string,
    owner: { patientId: string; doctorId: string },
  ): Promise<{ own: ConsultationEncounterEntity | null; conflict: boolean }>;

  /** Insert a new consultation together with its encounter 1, in one transaction. */
  abstract createConsultation(
    consultation: ConsultationEntity,
    first: EncounterStart,
  ): Promise<{ consultation: ConsultationEntity; encounter: ConsultationEncounterEntity }>;

  /**
   * Start the next encounter of an existing consultation: from OPEN / STOPPED only (409
   * `ENCOUNTER_CAPTURE_ACTIVE` while RECORDING / PAUSED, 409 `CONSULTATION_APPROVED` when
   * APPROVED). Ends the current encounter, bumps `currentEncounterSeq`, leaves the consultation
   * OPEN — CAS-guarded on the version the consultation was read at, in one transaction.
   */
  abstract appendEncounter(
    consultation: ConsultationEntity,
    next: EncounterStart & { actor: string },
  ): Promise<{ consultation: ConsultationEntity; encounter: ConsultationEncounterEntity }>;

  /** The consultation's current (open) encounter, or `null`. */
  abstract currentEncounter(consultation: ConsultationEntity): Promise<ConsultationEncounterEntity | null>;

  /** Every encounter of a consultation of the caller's tenant (404 otherwise), in order. */
  abstract listForConsultation(consultationId: string): Promise<EncounterResponse[]>;

  /** The episode facts a single-consultation response carries (encounters, approval, auto-close, reopen policy). */
  abstract lifecycleView(consultation: ConsultationEntity): Promise<ConsultationLifecycleView>;

  /**
   * The same facts for a page of consultations, keyed by consultation id: one encounter read and
   * one approval read for the whole page, the tenant settings resolved once per distinct tenant.
   */
  abstract lifecycleViews(consultations: ConsultationEntity[]): Promise<Map<string, ConsultationLifecycleView>>;
}

export const IConsultationEncounterServiceToken = Symbol('IConsultationEncounterService');
