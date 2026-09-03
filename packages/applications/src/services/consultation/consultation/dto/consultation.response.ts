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
    description:
      'Clinical lifecycle status — the single-sourced ConsultationStatus column (session state machine).',
    enum: ConsultationStatus,
    example: ConsultationStatus.OPEN,
  })
  status?: ConsultationStatus;

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
