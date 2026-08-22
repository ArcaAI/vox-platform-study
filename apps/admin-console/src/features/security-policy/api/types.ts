/** GET/PUT /admin/security/policy — the platform credential policy. */

export type SecretEncoding = 'hex' | 'base64url';

export interface PasswordPolicy {
  minLength: number;
  /** NOT settable — a hashing-DoS bound (bcrypt reads 72 bytes). Displayed read-only. */
  maxLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireDigit: boolean;
  requireSpecial: boolean;
  /** 0 = rotation disabled. Warns at login, never blocks. */
  maxAgeDays: number;
}

export interface GeneratedSecretPolicy {
  /** CSPRNG bytes per issued machine credential — entropy, not characters. */
  byteLength: number;
  encoding: SecretEncoding;
}

export interface SecretPolicyBounds {
  minByteLength: number;
  maxByteLength: number;
  /** Surfaces whose alphabet is pinned and therefore ignore `encoding`. */
  pinnedEncodings: Record<string, string>;
  /** Credential surfaces the secret policy governs, on their NEXT issuance. */
  governedSurfaces: string[];
}

export interface SecurityPolicy {
  password: PasswordPolicy;
  secret: GeneratedSecretPolicy;
  bounds: SecretPolicyBounds;
}

/** PUT body — PARTIAL; only the fields present are written. */
export interface UpdateSecurityPolicyRequest {
  passwordMinLength?: number;
  passwordRequireUppercase?: boolean;
  passwordRequireLowercase?: boolean;
  passwordRequireDigit?: boolean;
  passwordRequireSpecial?: boolean;
  passwordMaxAgeDays?: number;
  secretByteLength?: number;
  secretEncoding?: SecretEncoding;
}
