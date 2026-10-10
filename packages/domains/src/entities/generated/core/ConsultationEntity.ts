/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

// Consultation lifecycle legality matrix — WHERE the consultation is. Seven
// states; every unlisted (from, to) pair is illegal and `transitionTo` throws
// `CONSULTATION_TRANSITION_ILLEGAL`. Self-pairs are idempotent no-ops and are
// NOT listed. What the platform is doing in the background is the separate
// `processing` axis, which has no matrix of its own and constrains exactly one
// edge: STOPPED → APPROVED is refused while the transcript is finalizing or the
// note is being generated. CLOSED_COMPLETE → OPEN additionally needs the
// tenant's reopen policy (`allowClosedCompleteReopen`). Do not widen this map
// without updating `ConsultationEntity.transitions.test.ts` (the independent
// copy of the matrix) and `consultationStatus.wired.test.ts`.
const CONSULTATION_TRANSITIONS: ReadonlyMap<Enums.ConsultationStatus, ReadonlySet<Enums.ConsultationStatus>> = new Map<
  Enums.ConsultationStatus,
  ReadonlySet<Enums.ConsultationStatus>
>([
  [Enums.ConsultationStatus.OPEN, new Set([Enums.ConsultationStatus.RECORDING, Enums.ConsultationStatus.CLOSED_INCOMPLETE])],
  [
    Enums.ConsultationStatus.RECORDING,
    new Set([Enums.ConsultationStatus.PAUSED, Enums.ConsultationStatus.STOPPED, Enums.ConsultationStatus.CLOSED_INCOMPLETE]),
  ],
  [
    Enums.ConsultationStatus.PAUSED,
    new Set([Enums.ConsultationStatus.RECORDING, Enums.ConsultationStatus.STOPPED, Enums.ConsultationStatus.CLOSED_INCOMPLETE]),
  ],
  [
    Enums.ConsultationStatus.STOPPED,
    new Set([
      Enums.ConsultationStatus.RECORDING,
      Enums.ConsultationStatus.OPEN,
      Enums.ConsultationStatus.APPROVED,
      Enums.ConsultationStatus.CLOSED_INCOMPLETE,
    ]),
  ],
  [Enums.ConsultationStatus.APPROVED, new Set([Enums.ConsultationStatus.CLOSED_COMPLETE])],
  [Enums.ConsultationStatus.CLOSED_COMPLETE, new Set([Enums.ConsultationStatus.OPEN])],
  [Enums.ConsultationStatus.CLOSED_INCOMPLETE, new Set([Enums.ConsultationStatus.OPEN])],
]);

/** Processing values during which a consultation cannot be approved. */
const APPROVAL_BLOCKING_PROCESSING: ReadonlySet<Enums.ConsultationProcessing> = new Set([
  Enums.ConsultationProcessing.FINALIZING_TRANSCRIPT,
  Enums.ConsultationProcessing.SUMMARIZING,
]);

/**
 * Processing values whose `processingReason` is kept (every other value clears it). IDLE keeps one
 * only when given — a written note marks itself `NOTE_READY`; every other IDLE writer passes none.
 */
const REASON_BEARING_PROCESSING: ReadonlySet<Enums.ConsultationProcessing> = new Set([
  Enums.ConsultationProcessing.FAILED,
  Enums.ConsultationProcessing.AWAITING_REVIEW,
  Enums.ConsultationProcessing.IDLE,
]);

/**
 * Processing an encounter append carries into the next encounter: background work still running (the
 * same rule `stop` applies, plus FINALIZING_TRANSCRIPT, which the stop flow owns and restores itself).
 * Every other value is the previous encounter's NOTE OUTCOME and is reset to IDLE (TASK-1059 RC-10).
 */
const ENCOUNTER_IN_FLIGHT_PROCESSING: ReadonlySet<Enums.ConsultationProcessing> = new Set([
  Enums.ConsultationProcessing.SUMMARIZING,
  Enums.ConsultationProcessing.PROCESSING_ATTACHMENT,
  Enums.ConsultationProcessing.FINALIZING_TRANSCRIPT,
]);

/**
 * The `processingReason`s of a resumable guardrail hold — mirrors `GUARDRAIL_HOLD_PROCESSING_REASONS`
 * in `@arcaai/types` (domains does not depend on it). An append never clears a real hold.
 */
const GUARDRAIL_HOLD_REASONS: ReadonlySet<string> = new Set(['GUARDRAIL_HOLD', 'EGRESS_REDACTION_UNAVAILABLE']);

const CLOSED_STATUSES: ReadonlySet<Enums.ConsultationStatus> = new Set([
  Enums.ConsultationStatus.CLOSED_COMPLETE,
  Enums.ConsultationStatus.CLOSED_INCOMPLETE,
]);

const RECORDABLE_STATUSES: ReadonlySet<Enums.ConsultationStatus> = new Set([
  Enums.ConsultationStatus.OPEN,
  Enums.ConsultationStatus.RECORDING,
  Enums.ConsultationStatus.PAUSED,
  Enums.ConsultationStatus.STOPPED,
]);

/**
 * Machine codes carried in `BusinessException.metadata.code` by the lifecycle
 * guards. Application services map them onto 409 responses.
 */
export const ConsultationLifecycleErrorCode = {
  TRANSITION_ILLEGAL: 'CONSULTATION_TRANSITION_ILLEGAL',
  PROCESSING_IN_FLIGHT: 'CONSULTATION_PROCESSING_IN_FLIGHT',
  REOPEN_NOT_ALLOWED: 'CONSULTATION_REOPEN_NOT_ALLOWED',
  ENCOUNTER_CAPTURE_ACTIVE: 'ENCOUNTER_CAPTURE_ACTIVE',
  CONSULTATION_APPROVED: 'CONSULTATION_APPROVED',
} as const;
export type ConsultationLifecycleErrorCode = (typeof ConsultationLifecycleErrorCode)[keyof typeof ConsultationLifecycleErrorCode];

export interface ConsultationTransitionOptions {
  /** Tenant policy `consultation.reopen.allowClosedComplete`; gates CLOSED_COMPLETE → OPEN. */
  allowClosedCompleteReopen?: boolean;
  /** Why a CLOSED_INCOMPLETE close happened (default MANUAL). A close from APPROVED is always APPROVED. */
  closedReason?: Enums.ConsultationClosedReason;
}

function lifecycleError(code: ConsultationLifecycleErrorCode, message: string, details: Record<string, unknown> = {}): BusinessException {
  return new BusinessException(message, undefined, { code, ...details });
}

export interface ConsultationTransitionRecord {
  from: Enums.ConsultationStatus;
  to: Enums.ConsultationStatus;
  actor: string;
  reason: string;
}

export interface IConsultationEntity extends IBaseTenantEntity {
  patientId: string;
  appointmentDate: Date;
  doctorId: string;
  departmentId?: string | null;
  parentConsultationId?: string | null;
  metadata?: JsonValue | null;
  // TASK-1020 D-2 — the caller's own id for this encounter (EMR event id), promoted from the
  // `metadata.externalRef` marker. The key `open` matches on when present; null = none sent.
  externalRef?: string | null;
  // Lifecycle state — where the consultation is (defaults to OPEN)
  status?: Enums.ConsultationStatus;
  // Background processing — what the platform is doing (defaults to IDLE).
  // These and the activity / cursor fields below are persisted by the
  // repository's no-version-bump writers as well as by `updateWithVersion`.
  processing?: Enums.ConsultationProcessing;
  processingReason?: string | null;
  processingRefs?: string[];
  processingPrior?: Enums.ConsultationProcessing | null;
  processingUpdatedAt?: Date | null;
  lastActivityAt?: Date;
  reopenCount?: number;
  currentEncounterSeq?: number;
  segmentSeqHead?: number;
  recordingCursorMs?: number;
  approvedAt?: Date | null;
  closedAt?: Date | null;
  closedReason?: Enums.ConsultationClosedReason | null;
  // Health-flag projection on the active phase; not a state of its own
  degradedReasons?: string[];
  // TASK-1004 D-3 — the declared SOURCE (spoken) language, a closed catalog
  // id (`en`, `ml`, `ml-en`, ...). Typed promotion of the legacy
  // `metadata.summaryLanguage` (see `summary-language.ts`); null means "no
  // declared default".
  spokenLanguageMode?: string | null;
  Doctor?: Entities.UserEntity | null;
  Department?: Entities.DepartmentEntity | null;
  ParentConsultation?: Entities.ConsultationEntity | null;
  ChildConsultations?: Entities.ConsultationEntity[] | null;
  ContextItems?: Entities.ContextItemEntity[] | null;
  Encounters?: Entities.ConsultationEncounterEntity[] | null;
  Approvals?: Entities.ConsultationApprovalEntity[] | null;
}

export class ConsultationEntity extends BaseTenantEntity {
  private _patientId: IConsultationEntity['patientId'];
  private _appointmentDate: IConsultationEntity['appointmentDate'];
  private _doctorId: IConsultationEntity['doctorId'];
  private _departmentId?: IConsultationEntity['departmentId'];
  private _parentConsultationId?: IConsultationEntity['parentConsultationId'];
  private _metadata?: IConsultationEntity['metadata'];
  private _externalRef?: IConsultationEntity['externalRef'];
  private _status: Enums.ConsultationStatus;
  private _processing: Enums.ConsultationProcessing;
  private _processingReason?: IConsultationEntity['processingReason'];
  private _processingRefs: string[];
  private _processingPrior?: IConsultationEntity['processingPrior'];
  private _processingUpdatedAt?: IConsultationEntity['processingUpdatedAt'];
  private _lastActivityAt: Date;
  private _reopenCount: number;
  private _currentEncounterSeq: number;
  private _segmentSeqHead: number;
  private _recordingCursorMs: number;
  private _approvedAt?: IConsultationEntity['approvedAt'];
  private _closedAt?: IConsultationEntity['closedAt'];
  private _closedReason?: IConsultationEntity['closedReason'];
  private _degradedReasons: string[];
  private _spokenLanguageMode?: IConsultationEntity['spokenLanguageMode'];
  // not persisted — the last transition applied by `transitionTo`,
  // held only so the calling service can read `actor`/`reason` to build the
  // sys-event / WORM append without threading them through a second
  // parameter list.
  private _lastTransition?: ConsultationTransitionRecord;
  private _Doctor?: IConsultationEntity['Doctor'];
  private _Department?: IConsultationEntity['Department'];
  private _ParentConsultation?: IConsultationEntity['ParentConsultation'];
  private _ChildConsultations?: IConsultationEntity['ChildConsultations'];
  private _ContextItems?: IConsultationEntity['ContextItems'];
  private _Encounters?: IConsultationEntity['Encounters'];
  private _Approvals?: IConsultationEntity['Approvals'];

  constructor(init: IConsultationEntity) {
    super(init);
    this._patientId = init.patientId;
    this._appointmentDate = init.appointmentDate;
    this._doctorId = init.doctorId;
    this._departmentId = init.departmentId;
    this._parentConsultationId = init.parentConsultationId;
    this._metadata = init.metadata;
    this._externalRef = init.externalRef;
    this._status = init.status ?? Enums.ConsultationStatus.OPEN;
    this._processing = init.processing ?? Enums.ConsultationProcessing.IDLE;
    this._processingReason = init.processingReason;
    this._processingRefs = init.processingRefs ?? [];
    this._processingPrior = init.processingPrior;
    this._processingUpdatedAt = init.processingUpdatedAt;
    this._lastActivityAt = init.lastActivityAt ?? init.createdAt ?? new Date();
    this._reopenCount = init.reopenCount ?? 0;
    this._currentEncounterSeq = init.currentEncounterSeq ?? 1;
    this._segmentSeqHead = init.segmentSeqHead ?? 0;
    this._recordingCursorMs = init.recordingCursorMs ?? 0;
    this._approvedAt = init.approvedAt;
    this._closedAt = init.closedAt;
    this._closedReason = init.closedReason;
    this._degradedReasons = init.degradedReasons ?? [];
    this._spokenLanguageMode = init.spokenLanguageMode;
    this._Doctor = init.Doctor;
    this._Department = init.Department;
    this._ParentConsultation = init.ParentConsultation;
    this._ChildConsultations = init.ChildConsultations;
    this._ContextItems = init.ContextItems;
    this._Encounters = init.Encounters;
    this._Approvals = init.Approvals;
  }

  get patientId(): IConsultationEntity['patientId'] {
    return this._patientId;
  }

  set patientId(value: IConsultationEntity['patientId']) {
    this.setProperty('patientId', value);
  }

  get appointmentDate(): IConsultationEntity['appointmentDate'] {
    return this._appointmentDate;
  }

  set appointmentDate(value: IConsultationEntity['appointmentDate']) {
    this.setProperty('appointmentDate', value);
  }

  get doctorId(): IConsultationEntity['doctorId'] {
    return this._doctorId;
  }

  set doctorId(value: IConsultationEntity['doctorId']) {
    this.setProperty('doctorId', value);
  }

  get departmentId(): IConsultationEntity['departmentId'] {
    return this._departmentId;
  }

  set departmentId(value: IConsultationEntity['departmentId']) {
    this.setProperty('departmentId', value);
  }

  get parentConsultationId(): IConsultationEntity['parentConsultationId'] {
    return this._parentConsultationId;
  }

  set parentConsultationId(value: IConsultationEntity['parentConsultationId']) {
    this.setProperty('parentConsultationId', value);
  }

  get metadata(): IConsultationEntity['metadata'] {
    return this._metadata;
  }

  set metadata(value: IConsultationEntity['metadata']) {
    this.setProperty('metadata', value);
  }

  get externalRef(): IConsultationEntity['externalRef'] {
    return this._externalRef;
  }

  set externalRef(value: IConsultationEntity['externalRef']) {
    this.setProperty('externalRef', value);
  }

  get status(): Enums.ConsultationStatus {
    return this._status;
  }

  /**
   * @deprecated bypasses the legality matrix — use `transitionTo`, the only
   * guarded write path. Kept for reconstitution and legacy call sites.
   */
  set status(value: Enums.ConsultationStatus) {
    this.setProperty('status', value);
  }

  get processing(): Enums.ConsultationProcessing {
    return this._processing;
  }

  set processing(value: Enums.ConsultationProcessing) {
    this.setProperty('processing', value);
  }

  get processingReason(): IConsultationEntity['processingReason'] {
    return this._processingReason;
  }

  set processingReason(value: IConsultationEntity['processingReason']) {
    this.setProperty('processingReason', value);
  }

  get processingRefs(): string[] {
    return this._processingRefs;
  }

  set processingRefs(value: string[]) {
    this.setProperty('processingRefs', value);
  }

  get processingPrior(): IConsultationEntity['processingPrior'] {
    return this._processingPrior;
  }

  set processingPrior(value: IConsultationEntity['processingPrior']) {
    this.setProperty('processingPrior', value);
  }

  get processingUpdatedAt(): IConsultationEntity['processingUpdatedAt'] {
    return this._processingUpdatedAt;
  }

  set processingUpdatedAt(value: IConsultationEntity['processingUpdatedAt']) {
    this.setProperty('processingUpdatedAt', value);
  }

  get lastActivityAt(): Date {
    return this._lastActivityAt;
  }

  set lastActivityAt(value: Date) {
    this.setProperty('lastActivityAt', value);
  }

  get reopenCount(): number {
    return this._reopenCount;
  }

  set reopenCount(value: number) {
    this.setProperty('reopenCount', value);
  }

  get currentEncounterSeq(): number {
    return this._currentEncounterSeq;
  }

  set currentEncounterSeq(value: number) {
    this.setProperty('currentEncounterSeq', value);
  }

  get segmentSeqHead(): number {
    return this._segmentSeqHead;
  }

  set segmentSeqHead(value: number) {
    this.setProperty('segmentSeqHead', value);
  }

  get recordingCursorMs(): number {
    return this._recordingCursorMs;
  }

  set recordingCursorMs(value: number) {
    this.setProperty('recordingCursorMs', value);
  }

  get approvedAt(): IConsultationEntity['approvedAt'] {
    return this._approvedAt;
  }

  set approvedAt(value: IConsultationEntity['approvedAt']) {
    this.setProperty('approvedAt', value);
  }

  get closedAt(): IConsultationEntity['closedAt'] {
    return this._closedAt;
  }

  set closedAt(value: IConsultationEntity['closedAt']) {
    this.setProperty('closedAt', value);
  }

  get closedReason(): IConsultationEntity['closedReason'] {
    return this._closedReason;
  }

  set closedReason(value: IConsultationEntity['closedReason']) {
    this.setProperty('closedReason', value);
  }

  get degradedReasons(): string[] {
    return this._degradedReasons;
  }

  set degradedReasons(value: string[]) {
    this.setProperty('degradedReasons', value);
  }

  get spokenLanguageMode(): IConsultationEntity['spokenLanguageMode'] {
    return this._spokenLanguageMode;
  }

  set spokenLanguageMode(value: IConsultationEntity['spokenLanguageMode']) {
    this.setProperty('spokenLanguageMode', value);
  }

  get Doctor(): IConsultationEntity['Doctor'] {
    return this._Doctor;
  }

  set Doctor(value: IConsultationEntity['Doctor']) {
    this.setProperty('Doctor', value);
  }

  get Department(): IConsultationEntity['Department'] {
    return this._Department;
  }

  set Department(value: IConsultationEntity['Department']) {
    this.setProperty('Department', value);
  }

  get ParentConsultation(): IConsultationEntity['ParentConsultation'] {
    return this._ParentConsultation;
  }

  set ParentConsultation(value: IConsultationEntity['ParentConsultation']) {
    this.setProperty('ParentConsultation', value);
  }

  get ChildConsultations(): IConsultationEntity['ChildConsultations'] {
    return this._ChildConsultations;
  }

  set ChildConsultations(value: IConsultationEntity['ChildConsultations']) {
    this.setProperty('ChildConsultations', value);
  }

  get ContextItems(): IConsultationEntity['ContextItems'] {
    return this._ContextItems;
  }

  set ContextItems(value: IConsultationEntity['ContextItems']) {
    this.setProperty('ContextItems', value);
  }

  get Encounters(): IConsultationEntity['Encounters'] {
    return this._Encounters;
  }

  set Encounters(value: IConsultationEntity['Encounters']) {
    this.setProperty('Encounters', value);
  }

  get Approvals(): IConsultationEntity['Approvals'] {
    return this._Approvals;
  }

  set Approvals(value: IConsultationEntity['Approvals']) {
    this.setProperty('Approvals', value);
  }

  // ============================================
  // Custom Domain Methods
  // ============================================

  /**
   * Check if this is a new-visit (first consultation of the day)
   */
  get isNewVisit(): boolean {
    return !this._parentConsultationId;
  }

  /**
   * Check if this is a re-visit (follow-up consultation)
   */
  get isRevisit(): boolean {
    return !!this._parentConsultationId;
  }

  /** True once a clinician approved the record (APPROVED, or closed after approval). */
  get isApproved(): boolean {
    return this._status === Enums.ConsultationStatus.APPROVED || this._status === Enums.ConsultationStatus.CLOSED_COMPLETE;
  }

  /** True for CLOSED_COMPLETE and CLOSED_INCOMPLETE. */
  get isClosed(): boolean {
    return CLOSED_STATUSES.has(this._status);
  }

  /** True while audio may still be captured into the record (OPEN / RECORDING / PAUSED / STOPPED). */
  get isRecordable(): boolean {
    return RECORDABLE_STATUSES.has(this._status);
  }

  /**
   * Whether a reopen is offered: always from CLOSED_INCOMPLETE, from
   * CLOSED_COMPLETE only under the tenant policy, never from any other state.
   */
  public reopenAllowed(allowClosedCompleteReopen: boolean): boolean {
    if (this._status === Enums.ConsultationStatus.CLOSED_INCOMPLETE) return true;
    if (this._status === Enums.ConsultationStatus.CLOSED_COMPLETE) return allowClosedCompleteReopen;
    return false;
  }

  /**
   * The last transition applied by `transitionTo` in this in-memory
   * lifetime (not persisted). Callers read `actor`/`reason` off this to
   * build the `ResourceUpdated` sys-event and the WORM audit row. Undefined
   * until the first successful (non-self) transition.
   */
  get lastTransition(): ConsultationTransitionRecord | undefined {
    return this._lastTransition;
  }

  /**
   * The single guarded write path for `status`.
   *
   * - Self-transition: idempotent no-op (`false`, nothing tracked).
   * - Unlisted pair: `CONSULTATION_TRANSITION_ILLEGAL`.
   * - STOPPED → APPROVED while `processing` is FINALIZING_TRANSCRIPT or
   *   SUMMARIZING: `CONSULTATION_PROCESSING_IN_FLIGHT`.
   * - CLOSED_COMPLETE → OPEN without `allowClosedCompleteReopen`:
   *   `CONSULTATION_REOPEN_NOT_ALLOWED`.
   * - Legal pair: writes `status` (change-tracked) plus its stamps — APPROVED
   *   stamps `approvedAt` and clears `degradedReasons`; a close stamps
   *   `closedAt` + `closedReason`; a reopen bumps `reopenCount` and clears
   *   the close stamps.
   *
   * @returns `true` if a transition was applied, `false` for a self-transition.
   */
  public transitionTo(next: Enums.ConsultationStatus, actor: string, reason: string, options: ConsultationTransitionOptions = {}): boolean {
    const from = this._status;

    if (next === from) {
      return false;
    }

    this.assertTransitionAllowed(next, options);

    this.setProperty('status', next);
    this._lastTransition = { from, to: next, actor, reason };

    const now = new Date();
    if (next === Enums.ConsultationStatus.APPROVED) {
      this.setProperty('approvedAt', now);
      this.clearDegradedReasons();
    } else if (CLOSED_STATUSES.has(next)) {
      const closedReason =
        from === Enums.ConsultationStatus.APPROVED
          ? Enums.ConsultationClosedReason.APPROVED
          : (options.closedReason ?? Enums.ConsultationClosedReason.MANUAL);
      this.setProperty('closedAt', now);
      this.setProperty('closedReason', closedReason);
    } else if (next === Enums.ConsultationStatus.OPEN && CLOSED_STATUSES.has(from)) {
      this.setProperty('reopenCount', this._reopenCount + 1);
      this.setProperty('closedAt', null);
      this.setProperty('closedReason', null);
    }

    return true;
  }

  /**
   * Non-throwing legality check — `true` for a self-transition, `false` for
   * every pair `transitionTo` would refuse (including the processing and
   * reopen-policy guards).
   */
  public canTransitionTo(next: Enums.ConsultationStatus, options: ConsultationTransitionOptions = {}): boolean {
    if (next === this._status) {
      return true;
    }
    try {
      this.assertTransitionAllowed(next, options);
      return true;
    } catch (error) {
      if (error instanceof BusinessException) return false;
      throw error;
    }
  }

  /**
   * Start the next encounter (visit) of this consultation: allowed from OPEN
   * and STOPPED; bumps `currentEncounterSeq` and leaves the consultation OPEN.
   * The caller persists the matching `ConsultationEncounter` row (and ends the
   * previous one).
   *
   * @returns the new encounter seq.
   */
  public beginNextEncounter(actor: string): number {
    const from = this._status;
    if (from === Enums.ConsultationStatus.RECORDING || from === Enums.ConsultationStatus.PAUSED) {
      throw lifecycleError(ConsultationLifecycleErrorCode.ENCOUNTER_CAPTURE_ACTIVE, 'A new encounter cannot start while audio is being captured.', {
        status: from,
      });
    }
    if (from === Enums.ConsultationStatus.APPROVED) {
      throw lifecycleError(ConsultationLifecycleErrorCode.CONSULTATION_APPROVED, 'The consultation is approved; a new encounter cannot start.', {
        status: from,
      });
    }
    if (from !== Enums.ConsultationStatus.OPEN && from !== Enums.ConsultationStatus.STOPPED) {
      throw lifecycleError(ConsultationLifecycleErrorCode.TRANSITION_ILLEGAL, `A new encounter cannot start from ${from}.`, { from });
    }
    this.transitionTo(Enums.ConsultationStatus.OPEN, actor, 'encounter_appended');
    const seq = this._currentEncounterSeq + 1;
    this.setProperty('currentEncounterSeq', seq);
    this.resetNoteOutcomeForNewEncounter();
    return seq;
  }

  /**
   * TASK-1059 RC-10 — the new encounter starts IDLE: the previous encounter's note outcome (FAILED,
   * AWAITING_REVIEW, IDLE + NOTE_READY) does not describe it. Work still in flight survives, and a
   * real guardrail hold is kept — only a resume or an approve resolves it, never an append.
   */
  private resetNoteOutcomeForNewEncounter(): void {
    const processing = this._processing;
    if (ENCOUNTER_IN_FLIGHT_PROCESSING.has(processing)) return;
    if (processing === Enums.ConsultationProcessing.AWAITING_REVIEW && GUARDRAIL_HOLD_REASONS.has(this._processingReason ?? '')) return;
    if (processing === Enums.ConsultationProcessing.IDLE && !this._processingReason) return;
    this.setProcessing(Enums.ConsultationProcessing.IDLE);
  }

  /**
   * The `processingReason` rule shared with the repository's no-version-bump
   * writer: a reason survives only on FAILED / AWAITING_REVIEW.
   */
  public static processingReasonFor(processing: Enums.ConsultationProcessing, reason?: string | null): string | null {
    return REASON_BEARING_PROCESSING.has(processing) ? (reason ?? null) : null;
  }

  /** Set the processing axis (change-tracked); stamps `processingUpdatedAt`. */
  public setProcessing(processing: Enums.ConsultationProcessing, reason?: string | null): void {
    this.setProperty('processing', processing);
    this.setProperty('processingReason', ConsultationEntity.processingReasonFor(processing, reason));
    this.setProperty('processingUpdatedAt', new Date());
  }

  private assertTransitionAllowed(next: Enums.ConsultationStatus, options: ConsultationTransitionOptions): void {
    const from = this._status;
    if (!CONSULTATION_TRANSITIONS.get(from)?.has(next)) {
      throw lifecycleError(ConsultationLifecycleErrorCode.TRANSITION_ILLEGAL, `Illegal consultation state transition: ${from} → ${next}`, {
        from,
        to: next,
      });
    }
    if (next === Enums.ConsultationStatus.APPROVED && APPROVAL_BLOCKING_PROCESSING.has(this._processing)) {
      throw lifecycleError(
        ConsultationLifecycleErrorCode.PROCESSING_IN_FLIGHT,
        `The consultation cannot be approved while processing is ${this._processing}.`,
        { processing: this._processing },
      );
    }
    if (from === Enums.ConsultationStatus.CLOSED_COMPLETE && next === Enums.ConsultationStatus.OPEN && !options.allowClosedCompleteReopen) {
      throw lifecycleError(
        ConsultationLifecycleErrorCode.REOPEN_NOT_ALLOWED,
        'Reopening an approved, closed consultation is not allowed for this tenant.',
        {
          from,
        },
      );
    }
  }

  /**
   * Appends a health-flag reason to the active phase
   * Append-only within a session; deduplicated — adding an already-present
   * reason is a no-op against `changes` tracking beyond the first add.
   */
  public addDegradedReason(reason: string): void {
    if (this._degradedReasons.includes(reason)) {
      return;
    }
    this.setProperty('degradedReasons', [...this._degradedReasons, reason]);
  }

  /**
   * Clears every degraded-reason flag. Called automatically by `transitionTo`
   * when the destination is `APPROVED`; also callable directly.
   */
  public clearDegradedReasons(): void {
    if (this._degradedReasons.length === 0) {
      return;
    }
    this.setProperty('degradedReasons', []);
  }

  public override validate(): void {
    super.validate();
    if (!this._patientId) {
      throw new BusinessException('Patient ID is required');
    }
    if (!this._doctorId) {
      throw new BusinessException('Doctor ID is required');
    }
    if (!this._appointmentDate) {
      throw new BusinessException('Appointment date is required');
    }
  }
}
