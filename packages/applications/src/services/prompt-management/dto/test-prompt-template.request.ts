import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsInt } from 'class-validator';

/**
 * Request body for `POST /admin/prompt-templates/:id/test`.
 *
 * Runs the template against the SMR/text-generation service and persists the
 * resulting score/output via an optimistic-concurrency write, so it carries
 * the same `expectedVersion` predicate as the PATCH route (folded from the
 * `If-Match` header at the controller).
 */
export class TestPromptTemplateRequest {
  @ApiPropertyOptional({
    description: 'Sample values to interpolate into the template `{{variables}}` for the test run',
  })
  @IsOptional()
  variables?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Optional extra sample input appended to the prompt' })
  @IsOptional()
  @IsString()
  sampleInput?: string;

  @ApiPropertyOptional({
    description: 'Row version for optimistic concurrency control. Echoed from `If-Match: "<version>"` (header wins when both are present).',
    example: 7,
  })
  @IsOptional()
  @IsInt()
  expectedVersion?: number;
}
