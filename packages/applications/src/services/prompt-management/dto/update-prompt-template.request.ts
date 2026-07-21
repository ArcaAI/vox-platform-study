import { IsString, IsOptional, IsArray, IsInt, MaxLength, Min, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ResourceStatusType } from '@arcaai/domains';

export class UpdatePromptTemplateRequest {
  @ApiPropertyOptional({ description: 'Template name' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ description: 'Template description' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ description: 'Prompt content text' })
  @IsOptional()
  @IsString()
  content?: string;

  // Publication status; a status change is a mutating edit.
  @ApiPropertyOptional({ description: 'Publication status', enum: ['DRAFT', 'PUBLISHED'] })
  @IsOptional()
  @IsIn(['DRAFT', 'PUBLISHED'])
  status?: 'DRAFT' | 'PUBLISHED';

  @ApiPropertyOptional({ description: 'Template variable definitions (JSON)' })
  @IsOptional()
  variables?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Tags for search/filtering', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ description: 'Reason for the change (stored in version history)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  changeReason?: string;

  @ApiPropertyOptional({ description: 'Resource status', enum: ['ENABLED', 'DISABLED'] })
  @IsOptional()
  @IsIn([ResourceStatusType.ENABLED, ResourceStatusType.DISABLED])
  resourceStatus?: ResourceStatusType;

  /**
   * Optimistic-concurrency token.
   *
   * The client reads the row first, then echoes back the `version` it observed.
   * The service issues a Compare-And-Set (`promptTemplateRepository.
   * updateWithVersion`) and fails with `OptimisticConcurrencyException` →
   * HTTP 412 Precondition Failed if `_version` has drifted under the client
   * between read and write.
   *
   * OPTIONAL, mirroring `UpdateDnaReportRequest`. The PATCH
   * route is `@RequiresIfMatch()`: the controller folds the RFC 7232 `If-Match`
   * header over this field, so the canonical request carries the version in the
   * header and omits it from the body. Keeping it required here 400'd that
   * header-first request at body validation before the controller could fold
   * the header in. Service-to-service callers may still pass it in the body
   * (the documented fallback when no header is present).
   *
   * **Important**: this `expectedVersion` is the OCC token for the
   * `PromptTemplate` row's `_version` column — it is NOT the
   * human-meaningful version number tracked in the `PromptVersion`
   * sibling table. Do not conflate.
   */
  @ApiPropertyOptional({
    description: 'Current row version of the PromptTemplate row (from the prior GET). The PATCH fails with 412 if the version drifted.',
    example: 7,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}
