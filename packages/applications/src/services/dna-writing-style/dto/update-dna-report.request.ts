import { IsString, IsOptional, IsIn, IsInt, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ResourceStatusType } from '@arcaai/domains';

export class UpdateDnaReportRequest {
  @ApiPropertyOptional({ description: 'Updated report data (JSON)' })
  @IsOptional()
  reportData?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Updated style text' })
  @IsOptional()
  @IsString()
  styleText?: string;

  @ApiPropertyOptional({ description: 'Reason for the change' })
  @IsOptional()
  @IsString()
  changeReason?: string;

  @ApiPropertyOptional({ description: 'Resource status', enum: ['ENABLED', 'DISABLED'] })
  @IsOptional()
  @IsIn([ResourceStatusType.ENABLED, ResourceStatusType.DISABLED])
  resourceStatus?: ResourceStatusType;

  /**
   * Optimistic-concurrency token (TASK-326 X7 / D-2).
   *
   * The admin PATCH route (`DnaWritingStyleAdminController`) REQUIRES the
   * `If-Match` header (RFC 7232) and folds it onto this field at the
   * controller; the service then runs a Compare-And-Set
   * (`dnaReportRepository.updateWithVersion`) against the report row's
   * `_version` column and fails with `OptimisticConcurrencyException` →
   * HTTP 412 Precondition Failed if the version drifted between read and write.
   *
   * Optional because the same DTO is shared by the non-OCC doctor route
   * (`DnaWritingStyleController`). **Important**: this `_version` OCC token is
   * DISTINCT from `currentVersionNumber` / the `DnaVersion` history — do not
   * conflate the two.
   */
  @ApiPropertyOptional({
    description: 'Current row version of the DNA report (from the prior GET). The admin PATCH fails with 412 if the version drifted.',
    example: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}
