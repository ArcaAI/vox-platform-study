import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ConsultationStatus } from '@arcaai/domains';
import { ContextItemResponse } from '../../context/dto';

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
   * TASK-932 §3.7 — the language the generated notes are written in, as DECLARED at open.
   *
   * A first-class field rather than a `metadata` reach-through, so the API contract does not move
   * when the storage does: the marker currently lives under `metadata.summaryLanguage` because
   * `Consultation.language` is not surfaced by the domain entity, and promoting it is a
   * domain-layer change. Every reader goes through `readSummaryLanguage`; this is the only shape
   * a client ever sees.
   *
   * `undefined` = undeclared, which is not English — the agent's own body decides.
   */
  @ApiPropertyOptional({
    description: 'BCP-47 language tag the generated notes are written in, as declared at open. Absent = undeclared (the agent decides).',
    example: 'ml',
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
}
