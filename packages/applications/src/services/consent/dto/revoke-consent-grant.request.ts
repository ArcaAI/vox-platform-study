import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class RevokeConsentGrantRequest {
  @ApiPropertyOptional({ description: 'Why the grant was revoked' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  // Required CAS predicate (echoed from the prior GET) — same OCC pattern as
  // UpdateWebhookRequest.expectedVersion. The controller that would wire
  // `If-Match` for this route is out of scope for this phase (no HTTP
  // enforcement is wired) — see consent-design.md.
  @ApiProperty({
    description: 'Current version of the row (from the prior GET). The revoke fails with 412 Precondition Failed if the version drifted.',
    example: 1,
  })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
