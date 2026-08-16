import { IsOptional, IsBoolean, IsInt, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SummaryApprovalRequest {
  @ApiPropertyOptional({
    description:
      'One-click clinician acknowledgement to sign past a safety FLAG. ' +
      'Recorded as a SAFETY_OVERRIDE WORM audit event; no free-text justification required.',
  })
  @IsOptional()
  @IsBoolean()
  overrideSafetyFlag?: boolean;

  /**
   * TASK-709 optimistic-concurrency token. Mirrors
   * `UpdateDepartmentRequest.expectedVersion` verbatim: required. Approval
   * writes the ContextItem row (and flips the parent Consultation to
   * SIGNED), so it needs the same Compare-And-Set predicate as the other
   * note-content write routes. On a `@RequiresIfMatch()` route the
   * controller folds the `If-Match` header value over this field when both
   * are present.
   */
  @ApiProperty({
    description: 'Current version of the summary row (from the prior GET). The approval fails with 412 if the version drifted.',
    example: 7,
  })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
