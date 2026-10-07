import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsObject, IsOptional, Min } from 'class-validator';

/**
 * TASK-1050 — `PUT admin/guardrail/policy`: the on/off changes a tenant admin makes.
 *
 * Only the fields that DIFFER from the policy in force count as changes, so a client may send back the
 * whole view it read. A tenant admin may change `directions.<dir>.enabled` and `checks.<id>.enabled` of
 * a check no lock holds; any other changed field is 403 `GUARDRAIL_FIELD_PLATFORM_ONLY`. The two maps are
 * plain objects (not nested DTOs) because the KEY SET is the catalogue, which the service validates —
 * an unknown id is refused (400), never dropped.
 */
export class UpdateTenantGuardrailPolicyRequest {
  @ApiPropertyOptional({
    description: 'Per direction on/off: `{ "inbound": { "enabled": false } }`. Off = monitor only (still screened and recorded).',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  directions?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Per check on/off: `{ "unsafe_content_judge": { "enabled": true } }`. Keyed by catalogue id.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  checks?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Version read from the prior GET. Normally supplied by `If-Match` (`"0"` creates the row); the header wins.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}
