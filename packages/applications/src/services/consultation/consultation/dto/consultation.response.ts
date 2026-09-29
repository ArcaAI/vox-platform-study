import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ConsultationStatus } from '@arcaai/domains';
import { ContextItemResponse } from '../../context/dto';
import type { GoverningRunSummary } from '../../governing-engine';

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
    description: 'Clinical lifecycle status — the single-sourced ConsultationStatus column (session state machine).',
    enum: ConsultationStatus,
    example: ConsultationStatus.OPEN,
  })
  status?: ConsultationStatus;

  /**
   * TASK-1020 D-7 — whether `recording/start` can still record this consultation. `false` for
   * SIGNED, CLOSED_COMPLETE, TIMED_OUT, REOPENED and CLOSED: signed documentation is never
   * recorded over (409 `CONSULTATION_NOT_RECORDABLE`). An `open` that lands on such a row RETURNS
   * it with `recordable: false`; a client starting a new visit opens with a new `externalRef` (or a
   * `parentConsultationId` naming this row) instead.
   */
  @ApiProperty({
    description:
      'Whether this consultation can still be recorded. false for SIGNED, CLOSED_COMPLETE, TIMED_OUT, REOPENED and CLOSED — `recording/start` answers 409 `CONSULTATION_NOT_RECORDABLE` for them. To start a new visit, open with a new `externalRef` or with `parentConsultationId` naming this consultation.',
    example: true,
  })
  recordable: boolean;

  /**
   * TASK-1020 D-7 — the CANONICAL visit type key: the recorded (schema-stated) visit type when it
   * matches the vocabulary, else `revisit` when a parent is linked, else `new-visit`. The same
   * resolution every prompt/workflow reader uses.
   */
  @ApiProperty({
    description:
      "The consultation's visit type: the recorded (schema-stated) value when it matches the platform vocabulary, otherwise `revisit` when a parent consultation is linked, otherwise `new-visit`.",
    enum: ['new-visit', 'revisit'],
    example: 'new-visit',
  })
  visitType: 'new-visit' | 'revisit';

  /**
   * TASK-1020 D-2 — the caller's own encounter id (EMR event id) this consultation is keyed on, or
   * `null`. Same ref on a later `open` returns this consultation; a new ref opens a new one.
   */
  @ApiProperty({
    description:
      "The caller's own encounter id this consultation is keyed on, or null. A later `open` with the same ref (same patient and clinician) returns this consultation; a new ref opens a new one.",
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
      '(`"<version>"`) required by the state-machine transition routes (POST :id/prime|close|reopen — ' +
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
