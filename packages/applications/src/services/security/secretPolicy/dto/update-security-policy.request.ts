import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_SECRET_BYTES, MIN_SECRET_BYTES } from '../secret-policy';

/**
 * PARTIAL update — only the fields present are written, each through
 * `SettingsRegistryWriteService` (the single descriptor-driven enforcement
 * point, which is what makes this route super-admin-only).
 *
 * The bounds below are the same floors the readers clamp to, declared here so
 * an operator gets a 400 naming the offending field instead of a silent
 * coercion. The global pipe runs `forbidNonWhitelisted`, so an unknown field
 * rejects the request.
 */
export class UpdateSecurityPolicyRequest {
  @ApiPropertyOptional({
    minimum: 8,
    maximum: 128,
    description:
      'Minimum password length. Floor of 8 is the NIST SP 800-63B minimum for a user-chosen secret; the platform default is 12. The MAXIMUM (128) is deliberately not settable — it is a hashing-DoS bound.',
  })
  @IsOptional()
  @IsInt()
  @Min(8)
  @Max(128)
  passwordMinLength?: number;

  @ApiPropertyOptional({ description: 'Require at least one uppercase letter (A-Z) in a password.' })
  @IsOptional()
  @IsBoolean()
  passwordRequireUppercase?: boolean;

  @ApiPropertyOptional({ description: 'Require at least one lowercase letter (a-z) in a password.' })
  @IsOptional()
  @IsBoolean()
  passwordRequireLowercase?: boolean;

  @ApiPropertyOptional({ description: 'Require at least one digit (0-9) in a password.' })
  @IsOptional()
  @IsBoolean()
  passwordRequireDigit?: boolean;

  @ApiPropertyOptional({ description: 'Require at least one special character in a password.' })
  @IsOptional()
  @IsBoolean()
  passwordRequireSpecial?: boolean;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 3650,
    description: 'Password rotation window in days; 0 disables rotation. Raising it warns at login and never blocks.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  passwordMaxAgeDays?: number;

  @ApiPropertyOptional({
    minimum: MIN_SECRET_BYTES,
    maximum: MAX_SECRET_BYTES,
    description:
      'CSPRNG bytes behind every machine credential the platform issues (service-account client secret, API key, webhook signing secret, storage access key). Applies to the NEXT issuance only.',
  })
  @IsOptional()
  @IsInt()
  @Min(MIN_SECRET_BYTES)
  @Max(MAX_SECRET_BYTES)
  secretByteLength?: number;

  @ApiPropertyOptional({
    enum: ['hex', 'base64url'],
    description:
      'Alphabet for issued secrets. Honoured by service-account client secrets and webhook signing secrets; IGNORED by API keys (hex-pinned by their format regex) and storage access keys (base64url-pinned S3 shape).',
  })
  @IsOptional()
  @IsIn(['hex', 'base64url'])
  secretEncoding?: 'hex' | 'base64url';
}
