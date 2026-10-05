import type { ConsultationEntity, ContextItemEntity, ContextItemVersionEntity } from '@arcaai/domains';

/** The credential that submitted an approval, in the attribution form (`summary/clinician-attribution.ts`). */
export interface SessionSignerCaller {
  credentialClass: 'jwt' | 'api-key' | 'service-account';
  principalId: string;
  boundUserId?: string | null;
}

/**
 * The consultation's final note, readied for signing but NOT yet persisted: the approval service
 * writes `version` and the note's compare-and-set inside its own transaction.
 */
export interface PreparedNoteSignature {
  /** The note, mutated for the write (`currentVersionNumber`, `updatedBy`, encrypted content). */
  contextItem: ContextItemEntity;
  /** The SIGNED_NOTE version row to insert; `null` when the note's current version is already signed. */
  version: ContextItemVersionEntity | null;
  versionId: string;
  versionNumber: number;
  attestationHash: string;
  attestedAt: Date;
  /** The draft was signed before assurance completed (annotate SIGNED_BEFORE_ASSURANCE). */
  signedBeforeAssurance: boolean;
  /** A safety FLAG was explicitly overridden (record SAFETY_OVERRIDE). */
  safetyOverride: boolean;
}

export interface PreparedSessionSignature {
  /** The clinician the approval is attributed to. */
  approvedBy: string;
  /** The credential that submitted it. */
  actor: SessionSignerCaller;
  /** `null` when the consultation has no final note. */
  note: PreparedNoteSignature | null;
}

/**
 * The note-signing core the session approval uses. Implemented by `SummaryService`, which owns
 * the note's attestation rules (clinician attribution, the safety-flag stop, the draft→signed
 * delta) and the post-sign hand-offs (harness approval signal, governing-run review release,
 * gate-edit mining, DNA capture).
 */
export interface SessionNoteSigner {
  /**
   * Resolve who signs and ready the final note (`legacyContextItemId`, else the latest final
   * summary). Refuses a safety-flagged draft without `overrideSafetyFlag` (409). Writes nothing.
   */
  prepareSessionSignature(input: {
    tenantId: string;
    consultationId: string;
    legacyContextItemId?: string;
    clinicianUserId?: string;
    caller?: SessionSignerCaller;
    overrideSafetyFlag?: boolean;
  }): Promise<PreparedSessionSignature>;

  /** Post-commit hand-offs. Never throws. */
  afterSessionSigned(input: {
    tenantId: string;
    consultation: ConsultationEntity;
    note: PreparedNoteSignature | null;
    approvedBy: string;
    actor: SessionSignerCaller;
  }): Promise<void>;
}

/** DI token for the {@link SessionNoteSigner} (provided by the lifecycle module as `SummaryService`). */
export const SESSION_NOTE_SIGNER = Symbol('SessionNoteSigner');
