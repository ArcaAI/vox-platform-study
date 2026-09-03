/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

// session state machine legality matrix. Source of truth:

// Every unlisted (from, to) pair is illegal and `transitionTo` throws.
// Self-pairs are handled separately (idempotent no-op) and are NOT listed
// here. Do not widen this map without updating the state-machine.md doc AND
// the `ConsultationEntity.transitions.test.ts` Cartesian-product suite —
// `consultationStatus.wired.test.ts` asserts every enum member is
// a `to` here at least once.
// (continued, 2026-08-16) — revised per the owner's Q1 decision:
// `CLOSED` is SUPERSEDED (never a `to` — see row 9)
// and split into `CLOSED_COMPLETE` (human signed before closing) and
// `CLOSED_INCOMPLETE` (timeout/manual close with no clinician sign-off,
// including the settings-registry sweep's five eligible source states).
// 22 legal, non-reflexive transitions — is the source.
const CONSULTATION_TRANSITIONS: ReadonlyMap<Enums.ConsultationStatus, ReadonlySet<Enums.ConsultationStatus>> = new Map<
  Enums.ConsultationStatus,
  ReadonlySet<Enums.ConsultationStatus>
>([
  [Enums.ConsultationStatus.OPEN, new Set([Enums.ConsultationStatus.PRIMED])],
  [
    Enums.ConsultationStatus.PRIMED,
    new Set([Enums.ConsultationStatus.RECORDING, Enums.ConsultationStatus.CLOSED_INCOMPLETE]),
  ],
  [Enums.ConsultationStatus.RECORDING, new Set([Enums.ConsultationStatus.DRAINING])],
  [
    Enums.ConsultationStatus.DRAINING,
    new Set([
      Enums.ConsultationStatus.RECORDING,
      Enums.ConsultationStatus.DRAFT_PENDING_SENSORS,
      Enums.ConsultationStatus.PENDING_REVIEW,
      Enums.ConsultationStatus.CLOSED_INCOMPLETE,
    ]),
  ],
  [
    Enums.ConsultationStatus.DRAFT_PENDING_SENSORS,
    new Set([
      Enums.ConsultationStatus.PENDING_REVIEW,
      Enums.ConsultationStatus.SIGNED,
      Enums.ConsultationStatus.CLOSED_INCOMPLETE,
    ]),
  ],
  [
    Enums.ConsultationStatus.PENDING_REVIEW,
    new Set([Enums.ConsultationStatus.SIGNED, Enums.ConsultationStatus.TIMED_OUT]),
  ],
  [
    Enums.ConsultationStatus.SIGNED,
    new Set([Enums.ConsultationStatus.REOPENED, Enums.ConsultationStatus.CLOSED_COMPLETE]),
  ],
  [
    Enums.ConsultationStatus.TIMED_OUT,
    new Set([
      Enums.ConsultationStatus.SIGNED,
      Enums.ConsultationStatus.REOPENED,
      Enums.ConsultationStatus.CLOSED_INCOMPLETE,
    ]),
  ],
  // CLOSED: deliberately no outgoing edges — superseded, never live, never a
  // `to` either. See row 9 and the wiring-gate note in
  // ("must allow-list CLOSED explicitly as the one intentional exception").
  [Enums.ConsultationStatus.CLOSED, new Set()],
  [Enums.ConsultationStatus.CLOSED_COMPLETE, new Set([Enums.ConsultationStatus.REOPENED])],
  [
    Enums.ConsultationStatus.CLOSED_INCOMPLETE,
    new Set([Enums.ConsultationStatus.REOPENED]),
  ],
  [
    Enums.ConsultationStatus.REOPENED,
    new Set([Enums.ConsultationStatus.PENDING_REVIEW, Enums.ConsultationStatus.CLOSED_INCOMPLETE]),
  ],
]);

// Reserved but DISABLED — the pair is a legitimate future edge (owned by
// another epic), so it must throw a distinct, named error rather than being
// silently treated as just another illegal pair.
const RESERVED_DISABLED_TRANSITIONS: ReadonlyMap<Enums.ConsultationStatus, ReadonlyMap<Enums.ConsultationStatus, string>> =
  new Map<Enums.ConsultationStatus, ReadonlyMap<Enums.ConsultationStatus, string>>([
    [
      Enums.ConsultationStatus.PENDING_REVIEW,
      new Map([[Enums.ConsultationStatus.DRAFT_PENDING_SENSORS, 'note-sections']]),
    ],
  ]);

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
  // Typed lifecycle state (defaults to OPEN)
  status?: Enums.ConsultationStatus;
  // Health-flag projection on the active phase; not a state of its own
  degradedReasons?: string[];
  Doctor?: Entities.UserEntity | null;
  Department?: Entities.DepartmentEntity | null;
  ParentConsultation?: Entities.ConsultationEntity | null;
  ChildConsultations?: Entities.ConsultationEntity[] | null;
  ContextItems?: Entities.ContextItemEntity[] | null;
}

export class ConsultationEntity extends BaseTenantEntity {
  private _patientId: IConsultationEntity['patientId'];
  private _appointmentDate: IConsultationEntity['appointmentDate'];
  private _doctorId: IConsultationEntity['doctorId'];
  private _departmentId?: IConsultationEntity['departmentId'];
  private _parentConsultationId?: IConsultationEntity['parentConsultationId'];
  private _metadata?: IConsultationEntity['metadata'];
  private _status: Enums.ConsultationStatus;
  private _degradedReasons: string[];
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

  constructor(init: IConsultationEntity) {
    super(init);
    this._patientId = init.patientId;
    this._appointmentDate = init.appointmentDate;
    this._doctorId = init.doctorId;
    this._departmentId = init.departmentId;
    this._parentConsultationId = init.parentConsultationId;
    this._metadata = init.metadata;
    this._status = init.status ?? Enums.ConsultationStatus.OPEN;
    this._degradedReasons = init.degradedReasons ?? [];
    this._Doctor = init.Doctor;
    this._Department = init.Department;
    this._ParentConsultation = init.ParentConsultation;
    this._ChildConsultations = init.ChildConsultations;
    this._ContextItems = init.ContextItems;
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

  get status(): Enums.ConsultationStatus {
    return this._status;
  }

  /**
   * @deprecated: bypasses the legality matrix. Use `transitionTo`
   * instead — it is the only guarded write path. Kept public (not `private`)
   * because `packages/applications` call sites (`consultation.service.ts`,
   * `harness-internal.service.ts`, `summary.service.ts`, `summary.processor.ts`)
   * still assign this setter directly; Task 6-8 migrate them,
   * and Task 11 adds the source-scanning gate that makes a direct assignment
   * outside `transitionTo` a hard failure. Making the setter `private` now
   * would break `pnpm --filter @arcaai/applications build`, which is out of
   * this ticket's database/domain-layer scope for this execution pass — see
   * the ticket's own documented fallback (README.md Task 5).
 */
  set status(value: Enums.ConsultationStatus) {
    this.setProperty('status', value);
  }

  get degradedReasons(): string[] {
    return this._degradedReasons;
  }

  set degradedReasons(value: string[]) {
    this.setProperty('degradedReasons', value);
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

  /**
   * True when the consultation has been clinician-attested
   * (the documentation is committed/immutable).
   */
  get isSigned(): boolean {
    return this._status === Enums.ConsultationStatus.SIGNED;
  }

  /**
   * The last transition applied by `transitionTo` in this in-memory
   * lifetime (not persisted). Callers read `actor`/`reason` off this to
   * build the `ResourceUpdated` sys-event and, for clinically-significant
   * transitions, the `HarnessAuditEvent` WORM row. Undefined until the first
   * successful (non-self) transition; unchanged by a self-transition no-op.
   */
  get lastTransition(): ConsultationTransitionRecord | undefined {
    return this._lastTransition;
  }

  /**
   * the single guarded write path for `status`. Every other
   * writer (the bare `status` setter above) is `@deprecated` and migrating
   * off; this is the only place the legality matrix is consulted.
   *
   * - Self-transition (`next === current`): idempotent no-op — no write, no
   *   `lastTransition` update, `hasChanges` unaffected. Mirrors the
   *   pre-existing `transitionStatus` short-circuit behaviour this ticket
   *   replaces (`consultation.service.ts:682-685`).
   * - Reserved-but-disabled pair: throws `BusinessException` naming the epic
   *   that will enable it.
   * - Any other unlisted pair: throws `BusinessException` naming both states.
   * - Legal pair: writes through `setProperty` (change-tracked), records
   * `lastTransition`, and — per — clears
   *   `degradedReasons` when the destination is `SIGNED`.
   *
   * @returns `true` if a transition was applied, `false` for a self-transition no-op.
 */
  public transitionTo(next: Enums.ConsultationStatus, actor: string, reason: string): boolean {
    const from = this._status;

    if (next === from) {
      return false;
    }

    const disabledEpic = RESERVED_DISABLED_TRANSITIONS.get(from)?.get(next);
    if (disabledEpic) {
      throw new BusinessException(
        `Consultation state transition ${from} → ${next} is reserved but disabled — enabled by the '${disabledEpic}' epic.`,
      );
    }

    if (!CONSULTATION_TRANSITIONS.get(from)?.has(next)) {
      throw new BusinessException(`Illegal consultation state transition: ${from} → ${next}`);
    }

    this.setProperty('status', next);
    this._lastTransition = { from, to: next, actor, reason };

    if (next === Enums.ConsultationStatus.SIGNED) {
      this.clearDegradedReasons();
    }

    return true;
  }

  /**
   * Non-throwing legality check — for callers that need to branch (e.g.
   * `finalizeAssurance`'s idempotent-no-op guard) rather than catch. Returns
   * `true` for a self-transition (matches `transitionTo`'s no-op treatment)
   * and `false` for both illegal and reserved-but-disabled pairs.
   */
  public canTransitionTo(next: Enums.ConsultationStatus): boolean {
    if (next === this._status) {
      return true;
    }
    return CONSULTATION_TRANSITIONS.get(this._status)?.has(next) ?? false;
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
   * when the destination is `SIGNED`; also callable directly.
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
