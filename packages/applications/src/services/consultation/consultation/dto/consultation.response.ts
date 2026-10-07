import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ConsultationClosedReason, ConsultationProcessing, ConsultationStatus } from '@arcaai/domains';
import { ContextItemResponse } from '../../context/dto';
import type { GoverningRunSummary } from '../../governing-engine';
import { EncounterResponse } from './encounter.response';

/**
 * Doctor Info (embedded in consultation response)
 */
export class DoctorInfo {
  @ApiProperty({ description: 'Doctor user ID' })
  id: string;

  @ApiProperty({ description: 'Doctor username' })
  username: string;

  @ApiPropertyOptional({ description: 'Doctor first name' })
  firstName?: string;

  @ApiPropertyOptional({ description: 'Doctor last name' })
  lastName?: string;
}

/**
 * Department Info (embedded in consultation response)
 */
export class DepartmentInfo {
  @ApiProperty({ description: 'Department ID' })
  id: string;

  @ApiPropertyOptional({ description: 'Department code' })
  code?: string;

  @ApiPropertyOptional({ description: 'Department name' })
  name?: string;
}

/**
 * The approval a consultation carries while it is approved: who approved it, when, and the hash of
 * the snapshot of every item version it pinned.
 */
export class ConsultationApprovalResponse {
  @ApiProperty({ description: 'Approval ID' })
  id: string;

  @ApiProperty({ description: 'When the consultation was approved (ISO-8601).' })
  approvedAt: string;

  @ApiProperty({ description: 'The clinician the approval is attributed to.' })
  approvedBy: string;

  @ApiProperty({ description: 'Hash of the approved snapshot (every context item and the version it was approved at).' })
  snapshotHash: string;

  @ApiProperty({ description: 'How many context items the approval pinned.', example: 4 })
  itemCount: number;
}

/** TASK-1050 §9.8.3 — one guardrail notice the approve acknowledged (`GuardrailNoticeAcknowledgement`). */
export class GuardrailNoticeAcknowledgementResponse {
  @ApiProperty({ description: 'The acknowledged guardrail notice.' })
  noticeId: string;

  @ApiProperty({ description: 'The clinician the acknowledgement is attributed to (the approver).' })
  acknowledgedBy: string;

  @ApiProperty({ enum: ['ack', 'approve', 'resume'], description: 'How it was acknowledged.' })
  acknowledgedVia: 'ack' | 'approve' | 'resume';

  @ApiProperty({ description: 'When (ISO-8601).' })
  acknowledgedAt: string;
}

/** The lifecycle pair: where the consultation is, and what the platform is doing for it. */
export class ConsultationLifecycleState {
  @ApiProperty({ enum: ConsultationStatus, example: ConsultationStatus.OPEN })
  status: ConsultationStatus;

  @ApiProperty({ enum: ConsultationProcessing, example: ConsultationProcessing.IDLE })
  processing: ConsultationProcessing;
}

/**
 * Consultation Response
 *
 * Simplified response without status management complexity.
 */
export class ConsultationResponse {
  @ApiProperty({ description: 'Consultation ID' })
  id: string;

  @ApiProperty({ description: 'Patient identifier' })
  patientId: string;

  @ApiProperty({ description: 'Doctor identifier' })
  doctorId: string;

  @ApiPropertyOptional({ description: 'Doctor information', type: DoctorInfo })
  doctor?: DoctorInfo;

  @ApiPropertyOptional({ description: 'Department ID' })
  departmentId?: string;

  @ApiPropertyOptional({ description: 'Department information', type: DepartmentInfo })
  department?: DepartmentInfo;

  @ApiProperty({ description: 'Appointment date (YYYY-MM-DD)' })
  appointmentDate: string;

  @ApiPropertyOptional({ description: 'Parent consultation ID (for re-visits/referrals)' })
  parentConsultationId?: string;

  @ApiPropertyOptional({
    description:
      'Lifecycle status (OPEN, RECORDING, PAUSED, STOPPED, APPROVED, CLOSED_COMPLETE, CLOSED_INCOMPLETE). An older client is answered in the previous vocabulary; `lifecycle.status` always carries the current value.',
    enum: ConsultationStatus,
    example: ConsultationStatus.OPEN,
  })
  status?: ConsultationStatus;

  /**
   * Whether audio can still be captured into this consultation: true for OPEN, RECORDING, PAUSED
   * and STOPPED; false once it is APPROVED or closed. An `open` that lands on a closed
   * consultation RETURNS it with `recordable: false`.
   */
  @ApiProperty({
    description:
      'Whether audio can still be captured into this consultation: true for OPEN, RECORDING, PAUSED and STOPPED, false for APPROVED, CLOSED_COMPLETE and CLOSED_INCOMPLETE. Starting capture on a non-recordable consultation answers 409 `CONSULTATION_NOT_RECORDABLE`; reopen it, or open without the old visit id to start a new consultation.',
    example: true,
  })
  recordable: boolean;

  @ApiProperty({
    description: 'What the platform is doing in the background for this consultation.',
    enum: ConsultationProcessing,
    example: ConsultationProcessing.IDLE,
  })
  processing: ConsultationProcessing;

  @ApiProperty({
    description: 'Why processing is FAILED or AWAITING_REVIEW (a note that needs a human), or NOTE_READY when a written note is waiting (processing IDLE); otherwise null.',
    type: String,
    nullable: true,
  })
  processingReason: string | null;

  @ApiProperty({ description: 'When the consultation last saw activity (ISO-8601) — the auto-close clock reads this.' })
  lastActivityAt: string;

  @ApiProperty({
    description:
      "When the tenant's auto-close policy will close this consultation if nothing else happens (ISO-8601), or null when it is closed or no policy resolves.",
    type: String,
    nullable: true,
  })
  autoCloseAt: string | null;

  @ApiProperty({ description: 'How many times this consultation was reopened.', example: 0 })
  reopenCount: number;

  @ApiProperty({
    description: 'Why the consultation was closed (AUTO, MANUAL, APPROVED), or null while it is not closed.',
    enum: ConsultationClosedReason,
    nullable: true,
  })
  closedReason: ConsultationClosedReason | null;

  @ApiProperty({ description: 'When the consultation was closed (ISO-8601), or null.', type: String, nullable: true })
  closedAt: string | null;

  @ApiProperty({
    description:
      "Whether `reopen` is offered: always for CLOSED_INCOMPLETE, for CLOSED_COMPLETE only when the tenant's policy allows it, never otherwise.",
    example: false,
  })
  reopenAllowed: boolean;

  @ApiProperty({ description: 'The open encounter of this consultation (starts at 1).', example: 1 })
  currentEncounterSeq: number;

  @ApiProperty({ description: 'Every encounter (visit) of this consultation, in order.', type: [EncounterResponse] })
  encounters: EncounterResponse[];

  @ApiProperty({
    description: 'The latest approval of this consultation while it is approved, or null.',
    type: () => ConsultationApprovalResponse,
    nullable: true,
  })
  approval: ConsultationApprovalResponse | null;

  /**
   * The real lifecycle pair, whatever vocabulary `status` is projected to for an older client.
   */
  @ApiProperty({
    description: 'The lifecycle status and processing value. Always the current vocabulary, even when `status` is projected for an older client.',
    type: () => ConsultationLifecycleState,
  })
  lifecycle: ConsultationLifecycleState;

  @ApiPropertyOptional({
    description:
      'On `approve` (TASK-1050): every outstanding guardrail warning the approve acknowledged, in the same transaction. Approve is never refused because of warnings.',
    type: () => [GuardrailNoticeAcknowledgementResponse],
  })
  acknowledgedNotices?: GuardrailNoticeAcknowledgementResponse[];

  @ApiPropertyOptional({
    description: 'On `open`: whether this call appended a new encounter to an existing consultation.',
    example: false,
  })
  encounterAppended?: boolean;

  /**
   * The visit type of the CURRENT encounter when it is in the vocabulary; otherwise the
   * consultation's canonical key (the recorded visit type, else `revisit` when a parent is linked,
   * else `new-visit`) — the same resolution every prompt/workflow reader uses.
   */
  @ApiProperty({
    description:
      "The visit type of the current encounter. Falls back to the consultation's recorded visit type, otherwise `revisit` when a parent consultation is linked, otherwise `new-visit`.",
    enum: ['new-visit', 'revisit'],
    example: 'new-visit',
  })
  visitType: 'new-visit' | 'revisit';

  /**
   * The caller's own id (EMR event id) of the CURRENT encounter, or `null`. The same id on a later
   * `open` returns this consultation; a new id appends an encounter to the open consultation.
   */
  @ApiProperty({
    description:
      "The caller's own id of the current encounter, or null. A later `open` with the same id (same patient and clinician) returns this consultation; a new id appends a new encounter to the open consultation of the same patient, clinician and department.",
    type: String,
    nullable: true,
    example: 'EVT-88213',
  })
  externalRef: string | null;

  /**
   * TASK-932 §3.7 / TASK-1001 / TASK-1004 — the consultation's declared SOURCE (spoken) language:
   * the normalized spoken-language mode stored in `Consultation.spokenLanguageMode` (`en`, `ml`,
   * `ml-en`, `auto`, …), or — for one release, on a row the backfill could not normalize — the
   * legacy `metadata.summaryLanguage` tag. Every reader goes through `readSpokenLanguageMode`.
   *
   * It is NOT the language the notes are written in (owner decision 2026-09-23): that is the
   * tenant's output-language policy, else the platform default (English). `undefined` = undeclared.
   */
  @ApiPropertyOptional({
    description:
      "The consultation's declared SOURCE (spoken) language mode (`en`, `ml`, `ml-en`, `vi`, `vi-en`, `auto`), inherited by every live and batch transcription of this consultation that declares none. Not the language the notes are written in — that is the tenant's output-language policy, otherwise the platform default (English). Absent = undeclared.",
    example: 'ml-en',
  })
  language?: string;

  @ApiPropertyOptional({ description: 'Additional metadata' })
  metadata?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'Optimistic-concurrency row version (`_version`). Read this to build the `If-Match` header ' +
      '(`"<version>"`) required by the lifecycle routes (POST :id/approve|close|reopen — ' +
      '). `ETagInterceptor` also mirrors this value onto the response `ETag` header.',
  })
  version?: number;

  @ApiPropertyOptional({
    description: 'Context items (included when fetching single consultation)',
    type: [ContextItemResponse],
  })
  contextItems?: ContextItemResponse[];

  @ApiProperty({ description: 'Creation timestamp' })
  createdAt: string;

  @ApiProperty({ description: 'Last update timestamp' })
  updatedAt: string;

  @ApiProperty({
    description: 'Whether this consultation was just created (true) or already existed (false)',
    example: true,
  })
  isNew?: boolean;

  /**
   * The tenant-authored workflow run that GOVERNS this consultation, or `null` when the default
   * consultation loop does.
   *
   * ALWAYS present — `null` is the answer for an ungoverned consultation, never an omitted key.
   * A client that has to distinguish "not governed" from "this build does not report it" cannot
   * do so from an absent field, and the whole reason this exists is that a governed run could
   * fail with nothing on any surface saying so.
   *
   * Derived from the persisted `metadata.governingEngine` marker (`governingRunOf`), never from a
   * live harness call: a consultation read must not cost a round trip to the interpreter, and one
   * harness outage must not make every consultation unreadable. The marker's terminal fields are
   * stamped by the gateway's run-completion watcher, so `status` is `RUNNING` until that watcher
   * observes the run end.
   */
  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description:
      "The tenant-authored workflow run governing this consultation, or null when the default loop does. Always present. `status` is the PERSISTED vocabulary (RUNNING | COMPLETED | FAILED | CANCELED | TIMED_OUT) — never the interpreter's SUCCEEDED/DEGRADED; `degraded` is a flag on a COMPLETED run.",
  })
  governingRun: GoverningRunSummary | null;
}
