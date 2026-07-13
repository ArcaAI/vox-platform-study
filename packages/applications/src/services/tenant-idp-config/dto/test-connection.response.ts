import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IdpStatus } from '@arcaai/domains';

/**
 * TASK-498 D7 — result of a "Test connection" probe: OIDC discovery-document
 * resolution + client construction. Never drives a full browser login (no
 * user is present at config time) — a successful probe flips `providerStatus`
 * DRAFT → ENABLED so the provider becomes usable at `/auth/sso/start`.
 */
export class TestConnectionResponse {
  @ApiProperty({ description: 'Whether discovery + client construction succeeded' })
  ok!: boolean;

  @ApiProperty({ enum: IdpStatus, description: 'The row status after this probe' })
  providerStatus!: IdpStatus;

  @ApiPropertyOptional({ description: 'Failure reason when ok=false' })
  error?: string;
}
