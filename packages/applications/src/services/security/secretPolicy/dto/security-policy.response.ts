import { ApiProperty } from '@nestjs/swagger';

export class PasswordPolicyResponse {
  @ApiProperty({ description: 'Minimum characters for any password set through any path.' })
  minLength!: number;

  @ApiProperty({ description: 'Maximum characters. NOT configurable — a hashing-DoS bound (bcrypt reads 72 bytes).' })
  maxLength!: number;

  @ApiProperty({ description: 'Require at least one A-Z.' })
  requireUppercase!: boolean;

  @ApiProperty({ description: 'Require at least one a-z.' })
  requireLowercase!: boolean;

  @ApiProperty({ description: 'Require at least one 0-9.' })
  requireDigit!: boolean;

  @ApiProperty({ description: 'Require at least one non-alphanumeric character.' })
  requireSpecial!: boolean;

  @ApiProperty({ description: 'Rotation window in days; 0 = rotation disabled. Warns at login, never blocks.' })
  maxAgeDays!: number;
}

export class GeneratedSecretPolicyResponse {
  @ApiProperty({ description: 'CSPRNG bytes drawn per issued machine secret (entropy, not characters).' })
  byteLength!: number;

  @ApiProperty({ enum: ['hex', 'base64url'], description: 'Alphabet of an issued secret, where the surface does not pin one.' })
  encoding!: 'hex' | 'base64url';
}

export class SecretPolicyBoundsResponse {
  @ApiProperty({ description: 'Hard floor on issued-secret entropy, enforced in code after the row is read.' })
  minByteLength!: number;

  @ApiProperty({ description: 'Hard ceiling on issued-secret entropy.' })
  maxByteLength!: number;

  @ApiProperty({
    description:
      'Surfaces whose alphabet is PINNED and therefore ignore `encoding`: API keys are hex (their format regex parses the key structurally) and storage access keys are base64url (the shipped S3-style shape). `byteLength` applies everywhere.',
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { apiKey: 'hex', storageAccessKey: 'base64url' },
  })
  pinnedEncodings!: Record<string, string>;

  @ApiProperty({
    description: 'Credential surfaces governed by `secret`, i.e. what a change here will affect on the NEXT issuance.',
    example: ['serviceAccountClientSecret', 'apiKey', 'webhookSigningSecret', 'storageAccessKey'],
  })
  governedSurfaces!: string[];
}

export class SecurityPolicyResponse {
  @ApiProperty({ type: PasswordPolicyResponse })
  password!: PasswordPolicyResponse;

  @ApiProperty({ type: GeneratedSecretPolicyResponse })
  secret!: GeneratedSecretPolicyResponse;

  @ApiProperty({ type: SecretPolicyBoundsResponse })
  bounds!: SecretPolicyBoundsResponse;
}
