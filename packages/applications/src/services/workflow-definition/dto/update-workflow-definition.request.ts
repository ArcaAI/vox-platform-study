import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * PATCH is a versioned, OCC-enforced write on a DRAFT row only —
 * `WorkflowDefinitionService.assertMutable` rejects a PUBLISHED/DEPRECATED row before this DTO
 * is even consulted. `graph` re-runs shape + engine validation (never persists a broken graph);
 * `status`/`compiledConfig`/... stay off this DTO for the same reason they are off `create`'s.
 */
export class UpdateWorkflowDefinitionRequest {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({
    description: 'Replaces the canvas graph. Re-validated (shape + engine) before being written; rejected as 400 on failure.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  graph?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Optimistic-concurrency version; the `If-Match` header overrides it when both are present.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}
