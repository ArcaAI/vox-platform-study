/**
 * Descriptor governance, computed in ONE place.
 *
 * The gateway's write lane refuses a bad write in a documented order — unknown
 * key → 400, secret → 400, `globalOnly` without super admin → 403, scope deeper
 * than `maxScope` → 400, non-`global-kv` tier → 400, type mismatch → 400,
 * loosening a floored key → 403. This module mirrors that order so the console
 * can say WHICH of those applies and WHY *before* the admin clicks, instead of
 * translating a status code afterwards.
 *
 * The gateway remains the authority in every case. Nothing here grants a write
 * the server would refuse; it only declines to offer one, with the reason.
 */

import type { SettingCatalogItem, SettingScope } from '../api/types';

/** Why a key cannot be written here, or `null` when it can. */
export interface WriteBlock {
  /** Short badge text. */
  label: string;
  /** Sentence shown next to the disabled control. */
  reason: string;
}

/**
 * Only `global-kv` is writable through this lane; every other tier is refused
 * with a 400 that names its dedicated owner. Stating the owner is the useful
 * half — "not writable here" without "go there instead" is a dead end.
 *
 * TASK-932 R-6 / D-6 — `env`, `vault-kv` and `db-secret` are no longer described
 * here. They are LOCKED, and the gateway now says so on the catalog item
 * (`locked` / `lockLabel` / `lockReason`, derived from tier + sensitivity). The
 * console renders that reason verbatim rather than keeping a parallel copy: a
 * second definition of the same rule is what lets a newly-registered bootstrap
 * variable ship with an editor nobody remembered to disable. What stays below is
 * the set of tiers this LANE cannot write although they ARE editable elsewhere —
 * a different sentence, and the only one the console is entitled to author.
 */
const TIER_BLOCK: Record<string, WriteBlock> = {
  'db-config': {
    label: 'Dedicated service',
    reason:
      'This key has its own table and its own semantics (provider connections, task defaults, models, runtime profiles, storage config). Its dedicated screen owns the write.',
  },
  'redis-flag': {
    label: 'Kill-switch service',
    reason: 'This is a Redis-backed instant-fan-out flag, written through its own kill-switch surface rather than the registry lane.',
  },
  entitlement: {
    label: 'Entitlement',
    reason: 'This is a plan ceiling from the entitlements matrix. It bounds what a tenant MAY set; it never supplies a value, so it is not set here.',
  },
};

/**
 * Whether this lane can write the key, and if not, why.
 *
 * Order matches the gateway's own guard order so the reported reason is the one
 * the server would actually give.
 */
export function writeBlockFor(item: SettingCatalogItem, isElevated: boolean): WriteBlock | null {
  // The server's derived LOCK comes first, and it is authoritative: it is the
  // one refusal that applies to EVERY caller, a platform admin included, so a
  // rule that ran after the privilege checks below could report "super admin
  // only" about a key no super admin can edit either.
  if (item.locked) {
    return {
      label: item.lockLabel ?? 'Locked',
      reason: item.lockReason ?? 'This setting is not editable from an admin surface.',
    };
  }

  // Older catalog payloads (or a locally-stubbed one) may not carry the lock.
  // Secrets are never served by the read surface and never accepted by the write
  // lane, so this stays as the client-side floor under it.
  if (item.sensitivity === 'secret' || item.dataType === 'secret') {
    return {
      label: 'Secret',
      reason: 'Secret values are never read back and never written through this lane. Manage this credential through its own surface.',
    };
  }

  if (item.globalOnly && !isElevated) {
    return {
      label: 'Super admin only',
      reason: 'This key is platform-wide configuration. Only a super administrator may change it.',
    };
  }

  if (item.tier !== 'global-kv') {
    return TIER_BLOCK[item.tier] ?? { label: 'Not writable here', reason: `Tier '${item.tier}' is not writable through the registry lane.` };
  }

  return null;
}

/**
 * The scopes this caller may write this key at.
 *
 * Two independent gates, and conflating them is the bug this function exists to
 * avoid: `globalOnly` gates the KEY, `scope` gates WHICH ROW. A key a tenant
 * admin may set for itself is still a platform-wide change at `system` scope —
 * which the gateway restricts to super administrators with a 403.
 *
 * `department` / `doctor` are never offered: the gateway refuses them outright
 * (no descriptor declares a `maxScope` deeper than `tenant` in this tier).
 */
export function writableScopes(item: SettingCatalogItem, isElevated: boolean, hasWorkingTenant = true): SettingScope[] {
  const scopes: SettingScope[] = [];
  // `system` is the platform row — SUPER_ADMIN only, always. It needs NO
  // working tenant: the row lives on the reserved SYSTEM tenant by definition,
  // which is exactly what the read side had wrong (TASK-932 R-6).
  if (isElevated) scopes.push('system');
  // `tenant` needs a maxScope that reaches it AND a tenant to write to. An
  // elevated caller with nothing selected has no tenant row to address, so
  // offering the option would produce a 400 on save; a tenant-bound caller
  // always has one.
  if (item.maxScope !== 'system' && (!isElevated || hasWorkingTenant)) scopes.push('tenant');
  return scopes;
}

/**
 * Which scope the drawer opens on.
 *
 * Defaults to the TENANT override whenever one is addressable, and the reason is
 * the failure this ticket fixes rather than a preference: a platform admin who
 * has deliberately selected a working tenant and then edits a key is almost
 * never asking to move the platform default for every other tenant, but that is
 * where an unconditional `system` default lands the write. Falling back to
 * `system` covers the unscoped platform admin and the `maxScope: 'system'` keys,
 * where the platform row is the only row there is.
 */
export function defaultScopeFor(scopes: readonly SettingScope[]): SettingScope {
  return scopes.includes('tenant') ? 'tenant' : (scopes[0] ?? 'system');
}

/**
 * True when writing at this scope changes the platform for EVERY tenant.
 *
 * Drives the pre-click warning. The brief for this screen puts it plainly: a
 * system-scope write must be obvious before the click, not discovered in a 403.
 */
export function isPlatformWideWrite(scope: SettingScope): boolean {
  return scope === 'system';
}

/**
 * The direction that makes a floored key SAFER, as a sentence.
 *
 * Present only when the descriptor declares `floorDirection`; a tenant override
 * on such a key may only tighten, and the gateway REJECTS a loosening write
 * (403) rather than silently clamping it. Saying so up front is the difference
 * between a rule and an ambush.
 */
export function floorHint(item: SettingCatalogItem): string | null {
  switch (item.floorDirection) {
    case 'lower-is-stricter':
      return 'Tighten-only: a tenant override may only LOWER this value relative to the platform floor. A higher value is refused, not clamped.';
    case 'higher-is-stricter':
      return 'Tighten-only: a tenant override may only RAISE this value relative to the platform floor. A lower value is refused, not clamped.';
    case 'superset-is-stricter':
      return 'Tighten-only: a tenant override may only ADD to the platform list. Dropping an entry the platform mandates is refused, not clamped.';
    default:
      return null;
  }
}

/**
 * The consequence of leaving a `failMode: 'closed'` key unset.
 *
 * `closed` means an absent value RAISES — it is an outage, not a fallback. A
 * key in that state must not look like one merely sitting on its default, which
 * is why this is surfaced as a warning rather than a neutral badge.
 */
export function isUnsetAndFailClosed(item: SettingCatalogItem, sourceScope: string | undefined): boolean {
  return item.failMode === 'closed' && sourceScope === 'code-default';
}

/**
 * A kill-switch's UNSAFE position.
 *
 * Governance rule: a kill-switch MUST default OFF (fail-safe rollout), and the
 * registry asserts that at assembly. So turning one ON is the deliberate,
 * consequential direction and the UI marks it as such rather than rendering an
 * unlabelled toggle.
 */
export function killSwitchWarning(item: SettingCatalogItem, nextValue: unknown): string | null {
  if (!item.killSwitch) return null;
  if (nextValue !== true) return null;
  return 'This is a kill-switch. Its safe position is OFF; switching it ON enables enforcement platform-wide. Confirm this is intended.';
}

/** Human label for a cascade source. `code-default` means no row is stored anywhere. */
export function sourceScopeLabel(sourceScope: string | undefined): string {
  switch (sourceScope) {
    case 'code-default':
      return 'code default';
    case 'system':
    case 'global-kv':
      return 'platform (SYSTEM)';
    case 'tenant':
      return 'this tenant';
    default:
      return sourceScope ?? 'unknown';
  }
}
