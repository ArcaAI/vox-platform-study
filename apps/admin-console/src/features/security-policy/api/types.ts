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

// ── Guardrail availability (TASK-886) ────────────────────────────────────────
//
// WHICH safety policies apply to a tenant. Platform-managed and SUPER_ADMIN-only
// (`GET`/`PUT admin/guardrail/availability/:tenantId`): availability SELECTS
// policies, it never disables the gate. An empty selection inherits the SYSTEM
// set — it is not an off switch — and the gateway refuses a selection that would
// leave a screening direction ungated.

export const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

export type GuardrailScreenDirection = 'inbound' | 'outbound';

export interface GuardrailPolicyThreshold {
  field: string;
  /** Which way this value TIGHTENS. The gateway refuses a loosening write (403). */
  floorDirection: 'lower-is-stricter' | 'higher-is-stricter';
  minimum: number;
  maximum: number;
}

export interface GuardrailPolicyCatalogueEntry {
  id: string;
  label: string;
  description: string;
  directions: GuardrailScreenDirection[];
  /** `null` ⇒ the policy is on/off only; it has no strictness to tighten. */
  threshold: GuardrailPolicyThreshold | null;
}

export interface GuardrailPolicySelection {
  enabled: boolean;
  [field: string]: boolean | number | undefined;
}

export interface GuardrailAvailability {
  tenantId: string;
  /** `0` ⇒ no row yet; `If-Match: "0"` creates one. */
  version: number;
  /** This tenant's OWN selection (`{}` when it has none). */
  policies: Record<string, GuardrailPolicySelection>;
  /** What actually applies after the `request tenant → SYSTEM` cascade. */
  effective: Record<string, GuardrailPolicySelection>;
  effectiveSourceTenantId: string;
  reason: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface UpdateGuardrailAvailabilityRequest {
  policies: Record<string, GuardrailPolicySelection>;
  reason?: string;
  expectedVersion?: number;
}
