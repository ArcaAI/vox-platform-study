import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsInt, Min } from 'class-validator';
import { BaseRequest } from '../../../common';

/**
 * Rotate ONE secret setting: an atomic, step-up-gated,
 * distinctly-audited replace-with-new-value under optimistic concurrency.
 *
 * A GlobalSetting secret is operator-supplied — the server has no material to
 * regenerate (unlike an API key token) — so rotation accepts the NEW secret in
 * the request and replaces the stored value in ONE versioned write (the old
 * value is invalidated by that same write; no window where both are valid).
 * Rotation additionally re-wraps `encryptedValue` under a fresh `keyVersion`
 * via `encryptValueIntoEntity` for encryption-at-rest.
 *
 * Gating mirrors `reveal`: SUPER_ADMIN only (CASL `manage:all`) + step-up
 * re-auth with the caller's current password. The password and the new secret
 * are never logged and never appear in the audit event.
 */
export class RotateGlobalSettingRequest extends BaseRequest {
  @ApiProperty({
    description:
      "The caller's current account password (step-up re-authentication). Verified server-side against the stored hash; never logged, never persisted.",
    example: 'my-current-password',
  })
  @IsString()
  @IsNotEmpty()
  password!: string;

  @ApiProperty({
    description: 'The replacement secret value. Stored atomically in place of the old value; never returned, never logged, never audited.',
    example: 'new-secret-value',
  })
  @IsString()
  @IsNotEmpty()
  newValue!: string;

  /**
   * Optimistic-concurrency token — same two-shapes contract as the update
   * PATCH: optional in the body because the `If-Match` header (required by
   * `@RequiresIfMatch()` on the route) overrides it; direct service-to-service
   * callers pass it in the body.
   */
  @ApiPropertyOptional({
    description:
      'Current row version (from the prior GET). The rotation fails with 412 if the version drifted. Optional in the body when the `If-Match` header is supplied.',
    example: 7,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}
