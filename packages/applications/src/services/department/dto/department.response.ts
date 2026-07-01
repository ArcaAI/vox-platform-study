import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ResourceStatusType } from '@arcaai/domains';

export class DepartmentResponse {
  @ApiProperty({ description: 'Department ID' })
  id: string;

  @ApiPropertyOptional({ description: 'Department code', example: 'CARD' })
  code?: string;

  @ApiPropertyOptional({ description: 'Department name', example: 'Cardiology' })
  name?: string;

  @ApiPropertyOptional({ description: 'Department description' })
  description?: string;

  @ApiPropertyOptional({ description: 'Parent department ID (for hierarchy)' })
  parentDepartmentId?: string;

  @ApiProperty({ description: 'Whether this is a root department (no parent)' })
  isRootDepartment: boolean;

  @ApiProperty({ description: 'Creation timestamp' })
  createdAt: string;

  @ApiProperty({ description: 'Last update timestamp' })
  updatedAt: string;

  @ApiPropertyOptional({ description: 'Default summary template for this department' })
  defaultSummaryTemplate?: string;

  @ApiPropertyOptional({ description: 'Prompt template ID for pre-summary generation' })
  preSummaryPromptId?: string;

  @ApiPropertyOptional({ description: 'Prompt template ID for new/referral patients' })
  newPatientPromptId?: string;

  @ApiPropertyOptional({ description: 'Prompt template ID for revisit patients' })
  revisitPromptId?: string;

  @ApiPropertyOptional({ description: 'Default DNA writing-style prompt template ID for this department (TASK-387 #7)' })
  dnaWritingStylePromptId?: string;

  @ApiPropertyOptional({ description: 'Department prompt configuration' })
  promptConfig?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Resource status', enum: ['ENABLED', 'DISABLED'] })
  resourceStatus?: ResourceStatusType;

  /**
   * Row version for optimistic concurrency control (TASK-302 Stream D
   * Phase E.2). Clients echo this back via `If-Match: "<version>"` (or
   * `expectedVersion` in the body for service-to-service callers) on
   * the next PATCH. The server's compare-and-set
   * (`departmentRepository.updateWithVersion`) fails with `412
   * Precondition Failed` if `_version` has drifted under the client
   * between read and write.
   *
   * The `ETagInterceptor` (Phase D.1) also stamps `ETag: "<version>"`
   * on the response so SDK clients can use the canonical RFC 7232
   * `If-Match` mechanism without parsing the body.
   */
  @ApiProperty({
    description: 'Row version for optimistic concurrency control. Echo back as `If-Match: "<version>"` or `expectedVersion` on PATCH.',
    example: 7,
  })
  version!: number;
}
