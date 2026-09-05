import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpdateGuardrailAvailabilityRequest {
  /**
   * The selection, keyed by policy id. Declared as a plain object rather than a
   * nested DTO array because the KEY SET is the catalogue, and the catalogue is
   * the thing that must govern it — `GuardrailAvailabilityService` validates
   * every key and value against `GUARDRAIL_POLICY_CATALOGUE` and REFUSES an
   * unknown id (400) rather than dropping it. A class-validator shape check
   * here would duplicate half of that and could not do the other half.
   */
  @ApiProperty({
    description:
      'Selected policies, keyed by policy id: `{ "pii_leak": { "enabled": true, "minScore": 0.2 } }`. Unknown ids are REFUSED (400). An empty object means "no opinion" and inherits the SYSTEM set — it is not an off switch.',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  policies!: Record<string, unknown>;

  @ApiPropertyOptional({ description: "Why this tenant's set differs from the platform default." })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  @ApiPropertyOptional({
    description: 'Version read from the prior GET. Normally supplied by `If-Match` (`"0"` creates the row); the header wins when both are present.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}
