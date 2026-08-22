// Credential policy — the knobs a SUPER_ADMIN turns to set how strong a
// platform credential must be, for both classes of credential:
//
//  • `security.password.*`  — what a HUMAN may choose. The readers already
//    existed (`resolvePasswordPolicy`, live since the password-reset work) and
//    already preferred the stored row over the code default, but the keys were
//    never CATALOGED — and registering a descriptor is the only step that makes
//    a key governed and writable, so the policy was configurable in principle
//    and unreachable in practice. Registering them changes no behaviour; it
//    changes who can reach them.
//
//  • `security.secret.*`    — what the PLATFORM issues to a machine
//    (service-account client secrets, API keys). These had no policy at all:
//    both services drew `randomBytes(32).toString('hex')` from a literal.
//
// TIER: `global-kv`, and genuinely so — `AppSettingsService` resolves both
// families from `GlobalSetting` today, and a tightened credential policy must
// take effect on the next issuance without a redeploy.
//
// SCOPE: platform-only (`maxScope: 'system'`, `globalOnly: true`). A credential
// policy is a floor the PLATFORM owes every tenant; letting a tenant admin
// write it would let one tenant weaken the material the platform issues. The
// per-tenant credential dial that DOES exist is `apiKey.maxLifetimeDays`
// (lower-is-stricter, tighten-only) in `platform-knobs.descriptors.ts` — that
// is the shape a tenant-scoped credential knob takes.
//
// FAIL MODE: `open-to-default` throughout. These are policy BOUNDS, not
// secrets and not a provider selection: an unreadable row must degrade to
// today's healthcare-posture defaults, never take down every login and every
// credential issuance. The values themselves are `internal`, not `secret` —
// "secrets are 32 bytes" is not itself a secret.
//
// FLOORS ARE IN CODE, NOT IN THE ROW: `secret-policy.ts` clamps `byteLength`
// into [16, 64] bytes after reading it, so no GlobalSetting write — typo,
// fat-finger or malice — can drive an issued credential below 128 bits.

import { SettingDescriptor } from '../registry.types';

const CATEGORY = 'Security';

export const SECURITY_POLICY_SETTINGS: SettingDescriptor[] = [
  // ── Human credentials: password complexity + rotation ─────────────────────
  {
    key: 'security.password.minLength',
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: CATEGORY,
    label: 'Password minimum length',
    description:
      'Minimum characters for any password set through any path (admin temporary password, self-service reset, registration). Enforced by `validatePasswordComplexity`; a violation is a 400 listing every unmet rule. The 128-character MAXIMUM is deliberately NOT configurable — it is a hashing-DoS bound, and bcrypt reads only the first 72 bytes anyway.',
    default: 12,
  },
  {
    key: 'security.password.requireUppercase',
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: CATEGORY,
    label: 'Password requires an uppercase letter',
    description: 'Requires at least one A-Z. Part of the four-character-class complexity rule.',
    default: true,
  },
  {
    key: 'security.password.requireLowercase',
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: CATEGORY,
    label: 'Password requires a lowercase letter',
    description: 'Requires at least one a-z. Part of the four-character-class complexity rule.',
    default: true,
  },
  {
    key: 'security.password.requireDigit',
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: CATEGORY,
    label: 'Password requires a digit',
    description: 'Requires at least one 0-9. Part of the four-character-class complexity rule.',
    default: true,
  },
  {
    key: 'security.password.requireSpecial',
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: CATEGORY,
    label: 'Password requires a special character',
    description: 'Requires at least one non-alphanumeric character. Part of the four-character-class complexity rule.',
    default: true,
  },
  {
    key: 'security.password.maxAgeDays',
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: CATEGORY,
    label: 'Password rotation window (days)',
    description:
      'Rotation window; 0 disables rotation, which is the shipped default. When raised, login SURFACES `passwordExpired` as a warning and never blocks, and a NULL `passwordChangedAt` (a user who predates the tracking column) never counts as expired — so raising this locks nobody out.',
    default: 0,
  },

  // ── Machine credentials: issued-secret strength ───────────────────────────
  {
    key: 'security.secret.byteLength',
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: CATEGORY,
    label: 'Issued-secret entropy (bytes)',
    description:
      'CSPRNG bytes drawn for every secret the platform ISSUES to a machine principal — service-account client secrets (`ServiceAccountService.create`/`rotate`) and the random part of an API key. Bytes of ENTROPY, not characters: the default 32 renders as 64 hex characters. Clamped in code to [16, 64] bytes (128–512 bits) after it is read, so a bad row degrades to the nearest legal value instead of issuing a weak credential. Applies to the NEXT issuance only — credentials already handed out are unaffected, so tightening this is a rotation prompt, not a retroactive change.',
    default: 32,
  },
  {
    key: 'security.secret.encoding',
    tier: 'global-kv',
    dataType: 'enum',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: CATEGORY,
    label: 'Issued-secret alphabet',
    description:
      "Alphabet for an issued service-account client secret: `hex` (4 bits/char, the default and the shape every existing secret has) or `base64url` (6 bits/char — same entropy, ~33% shorter). API KEYS IGNORE THIS and are always hex: `ApiKeyService`'s format regex parses the raw key structurally as `{service}_{type}_[a-f0-9]{32,}_{checksum}`, so a base64url random part would produce keys the platform's own validator rejects. An unrecognised value falls back to `hex`.",
    default: 'hex',
  },
];
