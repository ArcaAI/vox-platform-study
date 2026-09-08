// Which settings are NOT editable from any admin screen, and why — derived,
// never listed.
//
// ── THE OWNER RULE (TASK-932 R-6, D-6) ───────────────────────────────────────
// "Bootstrap, credential and data-plane settings must be un-editable for
// everyone, platform admin included."
//
// ── WHY THIS IS DERIVED FROM THE DESCRIPTOR AND NOT A KEY LIST ───────────────
// A hand-maintained table of locked keys is the failure mode this whole
// registry exists to remove: it drifts the moment someone registers a new
// bootstrap variable, and the drift is SILENT — the new key simply renders with
// an editor that 400s. The lock is therefore a pure function of metadata the
// descriptor already carries, so registering a descriptor stays the ONLY step
// needed to govern a key:
//
//   sensitivity 'secret'  → never read back, never written here
//   tier 'env'            → fixed for the process lifetime (rule 09 §9.2 L1)
//   tier 'vault-kv'       → a platform secret, set by an operator via Vault
//   tier 'db-secret'      → per-tenant ciphertext, written by its own surface
//   editableBy 'none'     → the descriptor itself declares there is no editor
//
// That set covers the owner's three families exactly, because the data-plane
// TRANSPORT keys are already classified where they belong: `DATABASE_URL`,
// `DIRECT_URL`, `REDIS_*`, `MINIO_ENDPOINT`, `QDRANT_*`, `TEMPORAL_*` and
// `VAULT_ADDR` are `env`-tier bootstrap descriptors, and the credentials behind
// them (`MINIO_ACCESS_KEY`, `VAULT_*`, `JWT_SECRET_KEY`, …) are `vault-kv` or
// `secret`-sensitivity. Nothing needed a bespoke list to catch them; a list
// would only have been a second, drifting definition of the same fact.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
// A lock is NOT the same statement as "this lane cannot write it". `db-config`
// and `entitlement` keys are also refused by the registry write lane, but they
// ARE editable — through their own screens (storage config, the plan matrix).
// Telling an admin "locked, managed by deployment" about a key they can change
// two clicks away would be a lie, so those tiers are deliberately absent here
// and keep the "dedicated service owns this" message the console already gives.
//
// ── ENFORCEMENT ─────────────────────────────────────────────────────────────
// The console renders the reason instead of an editor, and the write lane
// refuses the same set with `SETTING_TIER_LOCKED` — for EVERY caller including
// a super administrator, which is the half the owner asked for and the half a
// UI-only rule cannot deliver.

import { EDITABLE_BY_NONE, SettingDescriptor, StorageTier } from './registry.types';

/** Machine-readable marker in the refusal message, so a client can branch on it. */
export const SETTING_TIER_LOCKED = 'SETTING_TIER_LOCKED';

export interface SettingLock {
  /** Short badge text — what KIND of lock this is. */
  label: string;
  /** One sentence saying why, and where the value actually changes. */
  reason: string;
}

/**
 * Tiers whose values have no admin write path at all. Ordered most-specific
 * first only for readability; the lookup is a map, so order does not matter.
 */
const LOCKED_TIERS: Readonly<Record<string, SettingLock>> = {
  env: {
    label: 'Bootstrap',
    reason:
      'Bootstrap / data-plane transport value, read from the process environment and fixed for the process lifetime. It changes by redeploying with a new value — never from an admin screen, for anyone.',
  },
  'vault-kv': {
    label: 'Platform secret',
    reason:
      'Platform credential held in Vault kv-v2. It is set by an operator through the Vault seeding runbook and never travels an HTTP write, so no admin screen can change it.',
  },
  'db-secret': {
    label: 'Tenant secret',
    reason:
      'Per-tenant credential stored as Vault-Transit ciphertext. It is written through its own credential surface as a write-only value, never as a plain setting.',
  },
} satisfies Partial<Record<StorageTier, SettingLock>>;

/**
 * Why `descriptor` cannot be edited from any admin surface, or `null` when it
 * can be (subject to the ordinary privilege and scope rules, which are a
 * different question and live in the write lane).
 */
export function settingLockFor(descriptor: SettingDescriptor): SettingLock | null {
  // Secrets first: a secret is refused whatever tier carries it, and saying
  // "bootstrap" about a credential would name the wrong reason.
  if (descriptor.sensitivity === 'secret' || descriptor.dataType === 'secret') {
    return {
      label: 'Secret',
      reason: 'Secret values are never read back and never written through the settings lane. Manage this credential through its own surface.',
    };
  }

  const byTier = LOCKED_TIERS[descriptor.tier];
  if (byTier) return byTier;

  // The descriptor's own declaration. Today this is redundant with `env` (a
  // governance test binds the two in both directions), and it is kept because
  // the sentinel is the AUTHOR's statement that no editor exists — a future
  // tier that adopts it must lock too, without anyone remembering to edit the
  // table above.
  if (descriptor.editableBy === EDITABLE_BY_NONE) {
    return {
      label: 'Not editable',
      reason: 'This setting declares no editor: its value is supplied by the deployment, not by an administrator.',
    };
  }

  return null;
}

/** Convenience predicate for callers that only need the yes/no. */
export function isSettingLocked(descriptor: SettingDescriptor): boolean {
  return settingLockFor(descriptor) !== null;
}
