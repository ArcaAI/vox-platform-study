/**
 * TASK-1050 W2b — tenant guardrail policy v2 on the gateway (README §9.3, §11.1).
 *
 * The frozen contract (`@arcaai/types` `guardrail-policy.ts`) owns the vocabulary and the field guard
 * (`forbiddenGuardrailPolicyChanges`). This module holds the gateway's three remaining jobs:
 *
 *  1. The STORED form. A row keeps only the fields its writer actually stated, exactly as
 *     `apps/guardrail/.../core/availability.py::_tier_fields` reads them. That is what lets the runtime
 *     cascade FIELD by field: a tenant row that only switches a check off must never pin the `action` a
 *     platform admin set on the SYSTEM row. A legacy flat row is rewritten as v2 on its first write.
 *  2. The EFFECTIVE view — a line-for-line mirror of `availability.py::_effective` (platform default →
 *     SYSTEM row → tenant row), because the console must show what the screener will actually do.
 *  3. Write validation (400) — unknown ids, wrong types and out-of-range values are REFUSED rather than
 *     dropped, the catalogue's own posture (`normalizeSelection`).
 *
 * Pure: no I/O, no Nest.
 */
import type { GuardrailPolicySetBy } from '@arcaai/types';
import {
  GUARDRAIL_POLICY_CATALOGUE,
  GuardrailPolicySelectionError,
  assertBothDirectionsCovered,
  guardrailPolicy,
  hasEnabledPolicy,
  type GuardrailPolicyDescriptor,
  type GuardrailPolicySelection,
  type GuardrailPolicySelectionSet,
  type GuardrailScreenDirection,
  type GuardrailViolationAction,
} from './policy-catalogue';

/**
 * The Redis channel apps/guardrail drops its tenant-config cache on (OD-11; subscriber in
 * `apps/guardrail/.../core/tenant_config.py`). Payload `{ tenantId }`; an absent field widens.
 */
export const GUARDRAIL_POLICY_INVALIDATION_CHANNEL = 'guardrail:config:invalidate';

/** 403: a write changed a field only a platform admin may set (`@arcaai/types` `GUARDRAIL_ERROR_CODES.fieldPlatformOnly`). */
export const GUARDRAIL_FIELD_PLATFORM_ONLY = 'GUARDRAIL_FIELD_PLATFORM_ONLY';
/** 403: a write changed a catalogue-locked check (medical validation) — editable by nobody. */
export const GUARDRAIL_CHECK_LOCKED = 'GUARDRAIL_CHECK_LOCKED';

export const GUARDRAIL_SCREEN_DIRECTIONS: readonly GuardrailScreenDirection[] = Object.freeze(['inbound', 'outbound']);
const ACTIONS: readonly GuardrailViolationAction[] = Object.freeze(['ignore', 'warn', 'block']);
const SET_BY: readonly GuardrailPolicySetBy[] = Object.freeze(['platform_admin', 'tenant_admin']);
const CHECK_FIELDS = Object.freeze(['enabled', 'action', 'locked', 'minScore', 'dataRegionAction', 'setBy']);

/** The fields one tier STATED for one check. `setBy` is server-stamped. */
export interface StatedGuardrailCheck {
  enabled?: boolean;
  action?: GuardrailViolationAction;
  locked?: boolean;
  minScore?: number;
  dataRegionAction?: GuardrailViolationAction;
  setBy?: GuardrailPolicySetBy;
}

/** A `TenantGuardrailPolicy.policies` blob as written by this gateway (v2, stated fields only). */
export interface StoredGuardrailPolicyV2 {
  directions: Partial<Record<GuardrailScreenDirection, { enabled: boolean }>>;
  checks: Record<string, StatedGuardrailCheck>;
}

export type GuardrailLockReason = 'catalogue' | 'platform';

/** One check as it is IN FORCE for a tenant. */
export interface EffectiveGuardrailCheck {
  checkId: string;
  label: string;
  description: string;
  directions: GuardrailScreenDirection[];
  enabled: boolean;
  action: GuardrailViolationAction;
  allowedActions: GuardrailViolationAction[];
  locked: boolean;
  lockReason: GuardrailLockReason | null;
  /** Whether the CALLER the view was built for may switch it on/off. */
  editable: boolean;
  dataRegionAction?: GuardrailViolationAction;
  minScore?: number;
  /** `true` when the tenant row states no `enabled` for it (it follows the platform). */
  inherited: boolean;
  /** Who last set the entry that decides `enabled`; `null` for an unattributed (legacy) tenant entry. */
  setBy: GuardrailPolicySetBy | null;
}

export interface EffectiveGuardrailPolicy {
  directions: Record<GuardrailScreenDirection, { enabled: boolean }>;
  checks: EffectiveGuardrailCheck[];
}

export type GuardrailPolicyViewer = 'tenant_admin' | 'platform_admin';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAction(value: unknown): value is GuardrailViolationAction {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
}

function isScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** `checks` / `directions` are never check ids, so the shape tells v2 from the legacy flat blob. */
export function isGuardrailPolicyV2(raw: unknown): boolean {
  return isPlainObject(raw) && (Object.prototype.hasOwnProperty.call(raw, 'checks') || Object.prototype.hasOwnProperty.call(raw, 'directions'));
}

/** What a stored tier stated — lenient (invalid values dropped), the runtime's read posture. */
export function toStoredGuardrailPolicyV2(raw: unknown): StoredGuardrailPolicyV2 {
  const out: StoredGuardrailPolicyV2 = { directions: {}, checks: {} };
  if (!isPlainObject(raw)) return out;
  const v2 = isGuardrailPolicyV2(raw);
  if (v2 && isPlainObject(raw.directions)) {
    for (const direction of GUARDRAIL_SCREEN_DIRECTIONS) {
      const entry = raw.directions[direction];
      if (isPlainObject(entry) && typeof entry.enabled === 'boolean') out.directions[direction] = { enabled: entry.enabled };
    }
  }
  const source = v2 ? (isPlainObject(raw.checks) ? raw.checks : {}) : raw;
  for (const descriptor of GUARDRAIL_POLICY_CATALOGUE) {
    if (descriptor.locked) continue; // editable by nobody, so never stored
    const entry = source[descriptor.id];
    if (!isPlainObject(entry)) continue;
    if (!v2 && typeof entry.enabled !== 'boolean') continue;
    const stated: StatedGuardrailCheck = {};
    if (typeof entry.enabled === 'boolean') stated.enabled = entry.enabled;
    if (v2 && isAction(entry.action) && descriptor.allowedActions.includes(entry.action)) stated.action = entry.action;
    if (v2 && typeof entry.locked === 'boolean') stated.locked = entry.locked;
    if (isScore(entry.minScore) && descriptor.threshold) stated.minScore = entry.minScore;
    if (v2 && isAction(entry.dataRegionAction)) stated.dataRegionAction = entry.dataRegionAction;
    if (v2 && typeof entry.setBy === 'string' && (SET_BY as readonly string[]).includes(entry.setBy))
      stated.setBy = entry.setBy as GuardrailPolicySetBy;
    if (Object.keys(stated).length > 0) out.checks[descriptor.id] = stated;
  }
  // A LEGACY row that enables nothing is absence ("there is no off") — guardrail reads it the same way.
  if (!v2 && !Object.values(out.checks).some((entry) => entry.enabled === true)) return { directions: {}, checks: {} };
  return out;
}

export function isEmptyStoredGuardrailPolicy(policy: StoredGuardrailPolicyV2): boolean {
  return Object.keys(policy.directions).length === 0 && Object.keys(policy.checks).length === 0;
}

function pick<K extends keyof StatedGuardrailCheck>(
  tiers: readonly (StatedGuardrailCheck | undefined)[],
  key: K,
): StatedGuardrailCheck[K] | undefined {
  for (const tier of tiers) if (tier && tier[key] !== undefined) return tier[key];
  return undefined;
}

/**
 * The policy in force — `availability.py::_effective`, field by field. `viewer` decides `editable` only:
 * a tenant admin may switch a check that no lock holds; a platform admin any check the catalogue does not
 * lock.
 */
export function effectiveGuardrailPolicy(
  systemRaw: unknown,
  tenantRaw: unknown,
  viewer: GuardrailPolicyViewer = 'tenant_admin',
  options: { readonly emptyDirectionFallback?: boolean } = {},
): EffectiveGuardrailPolicy {
  const system = toStoredGuardrailPolicyV2(systemRaw);
  const tenant = toStoredGuardrailPolicyV2(tenantRaw);
  const directions = Object.fromEntries(
    GUARDRAIL_SCREEN_DIRECTIONS.map((direction) => [
      direction,
      { enabled: tenant.directions[direction]?.enabled ?? system.directions[direction]?.enabled ?? true },
    ]),
  ) as Record<GuardrailScreenDirection, { enabled: boolean }>;

  const checks = GUARDRAIL_POLICY_CATALOGUE.map((descriptor): EffectiveGuardrailCheck => {
    const own = tenant.checks[descriptor.id];
    const platform = system.checks[descriptor.id];
    const tiers = [own, platform];
    const action = pick(tiers, 'action') ?? descriptor.platformDefaultAction;
    const platformLocked = pick(tiers, 'locked') === true;
    const entry: EffectiveGuardrailCheck = {
      checkId: descriptor.id,
      label: descriptor.label,
      description: descriptor.description,
      directions: [...descriptor.directions],
      enabled: pick(tiers, 'enabled') ?? descriptor.defaultEnabled,
      action: descriptor.allowedActions.includes(action) ? action : descriptor.platformDefaultAction,
      allowedActions: [...descriptor.allowedActions],
      locked: descriptor.locked || platformLocked,
      lockReason: descriptor.locked ? 'catalogue' : platformLocked ? 'platform' : null,
      editable: false,
      inherited: own?.enabled === undefined,
      setBy: own?.enabled !== undefined ? (own.setBy ?? null) : 'platform_admin',
    };
    const dataRegionAction = pick(tiers, 'dataRegionAction') ?? descriptor.platformDefaultDataRegionAction;
    if (dataRegionAction !== undefined) entry.dataRegionAction = dataRegionAction;
    const minScore = pick(tiers, 'minScore');
    if (minScore !== undefined) entry.minScore = minScore;
    if (descriptor.locked) {
      entry.enabled = descriptor.defaultEnabled;
      entry.action = descriptor.platformDefaultAction;
    }
    entry.editable = viewer === 'platform_admin' ? !descriptor.locked : !entry.locked;
    return entry;
  });

  // There is no "off" (availability.py): a direction no unlocked check covers is screened with the
  // platform defaults instead. Writes through this gateway refuse that state (OD-8); this mirrors how a
  // stored row that predates the rule is READ.
  if (options.emptyDirectionFallback === false) return { directions, checks };
  for (const direction of GUARDRAIL_SCREEN_DIRECTIONS) {
    const unlocked = checks.filter(
      (entry) => !GUARDRAIL_POLICY_CATALOGUE.find((d) => d.id === entry.checkId)?.locked && entry.directions.includes(direction),
    );
    if (!unlocked.some((entry) => entry.enabled)) {
      for (const entry of unlocked) entry.enabled = guardrailPolicy(entry.checkId)?.defaultEnabled ?? entry.enabled;
    }
  }
  return { directions, checks };
}

/** The effective on/off (and thresholds) in the catalogue's legacy selection shape. */
export function guardrailFlatSelection(view: EffectiveGuardrailPolicy): GuardrailPolicySelectionSet {
  const out: Record<string, GuardrailPolicySelection> = {};
  for (const entry of view.checks) {
    const selection: Record<string, boolean | number> = { enabled: entry.enabled };
    if (entry.minScore !== undefined) selection.minScore = entry.minScore;
    out[entry.checkId] = selection as GuardrailPolicySelection;
  }
  return out;
}

/**
 * OD-8 on the policy a write WOULD put in force: at least one unlocked check per direction stays on
 * (a direction switched OFF is monitor only, not ungated, so it does not count against this). Read
 * WITHOUT the runtime's empty-direction fallback, which exists for stored rows that predate the rule.
 */
export function assertGuardrailPolicyCoversBothDirections(systemRaw: unknown, tenantRaw: unknown): void {
  const flat = guardrailFlatSelection(effectiveGuardrailPolicy(systemRaw, tenantRaw, 'platform_admin', { emptyDirectionFallback: false }));
  if (!hasEnabledPolicy(flat)) {
    refuse('A policy must leave both screening directions gated; no check would run. Enable at least one check per direction.');
  }
  assertBothDirectionsCovered(flat);
}

/** A submitted check entry: every field optional, each one validated. */
export type SubmittedGuardrailCheck = Omit<StatedGuardrailCheck, 'setBy'>;

export interface SubmittedGuardrailPolicy {
  directions: Partial<Record<GuardrailScreenDirection, { enabled: boolean }>>;
  checks: Record<string, SubmittedGuardrailCheck>;
}

function refuse(message: string): never {
  throw new GuardrailPolicySelectionError(message);
}

function parseEntry(descriptor: GuardrailPolicyDescriptor, raw: unknown, legacy: boolean): SubmittedGuardrailCheck {
  const id = descriptor.id;
  if (!isPlainObject(raw)) refuse(`Policy '${id}' must be an object, e.g. { "enabled": true }`);
  if (legacy && typeof raw.enabled !== 'boolean') refuse(`Policy '${id}' requires a boolean 'enabled'`);
  const entry: SubmittedGuardrailCheck = {};
  for (const [field, value] of Object.entries(raw)) {
    if (field === 'setBy') continue; // server-stamped: a client's value is ignored, never trusted
    if (!(CHECK_FIELDS as readonly string[]).includes(field)) refuse(`Policy '${id}' has no field '${field}'`);
    switch (field) {
      case 'enabled':
        if (typeof value !== 'boolean') refuse(`Policy '${id}'.enabled must be a boolean`);
        entry.enabled = value;
        break;
      case 'locked':
        if (typeof value !== 'boolean') refuse(`Policy '${id}'.locked must be a boolean`);
        entry.locked = value;
        break;
      case 'action':
        // A catalogue-locked check is judged by the field guard (403 GUARDRAIL_CHECK_LOCKED), not here.
        if (!isAction(value) || (!descriptor.locked && !descriptor.allowedActions.includes(value))) {
          refuse(`Policy '${id}'.action must be one of ${descriptor.allowedActions.join(', ')}`);
        }
        entry.action = value;
        break;
      case 'dataRegionAction':
        if (descriptor.platformDefaultDataRegionAction === undefined)
          refuse(`Policy '${id}' screens no inbound data region, so it takes no dataRegionAction`);
        if (!isAction(value) || !descriptor.allowedActions.includes(value)) {
          refuse(`Policy '${id}'.dataRegionAction must be one of ${descriptor.allowedActions.join(', ')}`);
        }
        entry.dataRegionAction = value;
        break;
      case 'minScore': {
        const spec = descriptor.threshold;
        if (!spec || spec.field !== 'minScore') refuse(`Policy '${id}' has no strictness to set; remove 'minScore'`);
        if (typeof value !== 'number' || Number.isNaN(value)) refuse(`Policy '${id}'.minScore must be a number`);
        if (value < spec.minimum || value > spec.maximum) refuse(`Policy '${id}'.minScore must be within [${spec.minimum}, ${spec.maximum}]`);
        entry.minScore = value;
        break;
      }
    }
  }
  return entry;
}

function parseGuardrailPolicyWrite(raw: unknown): SubmittedGuardrailPolicy {
  if (!isPlainObject(raw)) refuse('`policies` must be a JSON object');
  const v2 = isGuardrailPolicyV2(raw);
  const out: SubmittedGuardrailPolicy = { directions: {}, checks: {} };
  if (v2) {
    for (const key of Object.keys(raw))
      if (key !== 'checks' && key !== 'directions') refuse(`Unknown policy section '${key}'; expected 'checks' and 'directions'`);
    if (raw.directions !== undefined) {
      if (!isPlainObject(raw.directions)) refuse('`directions` must be an object keyed by direction');
      for (const [direction, value] of Object.entries(raw.directions)) {
        if (!(GUARDRAIL_SCREEN_DIRECTIONS as readonly string[]).includes(direction))
          refuse(`Unknown screening direction '${direction}'; expected inbound or outbound`);
        if (!isPlainObject(value) || typeof value.enabled !== 'boolean' || Object.keys(value).some((field) => field !== 'enabled')) {
          refuse(`Direction '${direction}' must be { "enabled": boolean }`);
        }
        out.directions[direction as GuardrailScreenDirection] = { enabled: value.enabled };
      }
    }
    if (raw.checks !== undefined && !isPlainObject(raw.checks)) refuse('`checks` must be an object keyed by policy id');
  }
  const source = v2 ? ((raw.checks as Record<string, unknown> | undefined) ?? {}) : raw;
  for (const [id, value] of Object.entries(source)) {
    const descriptor = guardrailPolicy(id);
    if (!descriptor) refuse(`Unknown guardrail policy '${id}'. Legal ids: ${GUARDRAIL_POLICY_CATALOGUE.map((p) => p.id).join(', ')}.`);
    out.checks[id] = parseEntry(descriptor, value, !v2);
  }
  return out;
}

/**
 * A PLATFORM write (`PUT admin/guardrail/availability/:tenantId`): the whole row to store, v2 or the
 * legacy flat shape (rewritten as v2). Entries for a catalogue-locked check are validated here and
 * judged by the field guard — the service refuses a CHANGE to one (403) and stores none.
 */
export function parsePlatformGuardrailPolicyWrite(raw: unknown): StoredGuardrailPolicyV2 {
  const parsed = parseGuardrailPolicyWrite(raw);
  return { directions: parsed.directions, checks: parsed.checks };
}

/** A TENANT write (`PUT admin/guardrail/policy`): the fields to change. Always v2. */
export function parseTenantGuardrailPolicyWrite(raw: unknown): SubmittedGuardrailPolicy {
  if (isPlainObject(raw) && !isGuardrailPolicyV2(raw) && Object.keys(raw).length > 0) {
    refuse('Send `{ "directions": { … }, "checks": { "<id>": { "enabled": boolean } } }`');
  }
  return parseGuardrailPolicyWrite(isPlainObject(raw) && Object.keys(raw).length === 0 ? { checks: {} } : raw);
}

/** The dotted paths whose submitted value differs from the value IN FORCE. */
export function diffGuardrailPolicyAgainstEffective(submitted: SubmittedGuardrailPolicy, effective: EffectiveGuardrailPolicy): string[] {
  const changed: string[] = [];
  for (const [direction, value] of Object.entries(submitted.directions) as [GuardrailScreenDirection, { enabled: boolean }][]) {
    if (effective.directions[direction].enabled !== value.enabled) changed.push(`directions.${direction}.enabled`);
  }
  for (const [id, entry] of Object.entries(submitted.checks)) {
    const current = effective.checks.find((check) => check.checkId === id);
    if (!current) continue;
    for (const [field, value] of Object.entries(entry)) {
      const now = (current as unknown as Record<string, unknown>)[field];
      if (now !== value) changed.push(`checks.${id}.${field}`);
    }
  }
  return changed;
}

// ── Write helpers shared by the tenant and platform planes ───────────────────────────────────────────

/**
 * The tenant row as the field guard must judge it: a check the platform locked on the SYSTEM row is
 * locked for every tenant that does not state its own `locked`, so it is folded in as `locked: true`.
 * (The frozen `guardrailPolicyEditableFields` reads locks off the row it is given.)
 */
export function withGuardrailPlatformLocks(tenant: StoredGuardrailPolicyV2, system: StoredGuardrailPolicyV2): StoredGuardrailPolicyV2 {
  const checks: Record<string, StatedGuardrailCheck> = {};
  for (const [id, entry] of Object.entries(tenant.checks)) checks[id] = { ...entry };
  for (const [id, entry] of Object.entries(system.checks)) {
    if (entry.locked === true && checks[id]?.locked === undefined) checks[id] = { ...(checks[id] ?? {}), locked: true };
  }
  return { directions: { ...tenant.directions }, checks };
}

/** `stored` with the CHANGED submitted fields applied; each touched check entry is stamped `setBy`. */
export function applyGuardrailPolicyChanges(
  stored: StoredGuardrailPolicyV2,
  submitted: SubmittedGuardrailPolicy,
  changed: readonly string[],
  setBy: GuardrailPolicySetBy,
): StoredGuardrailPolicyV2 {
  const next: StoredGuardrailPolicyV2 = { directions: { ...stored.directions }, checks: {} };
  for (const [id, entry] of Object.entries(stored.checks)) next.checks[id] = { ...entry };
  for (const path of changed) {
    const [section, key, field] = path.split('.') as [string, string, string];
    if (section === 'directions') {
      const value = submitted.directions[key as GuardrailScreenDirection];
      if (value) next.directions[key as GuardrailScreenDirection] = { enabled: value.enabled };
      continue;
    }
    const value = (submitted.checks[key] as unknown as Record<string, unknown> | undefined)?.[field];
    if (value === undefined) continue;
    next.checks[key] = { ...(next.checks[key] ?? {}), [field]: value, setBy } as StatedGuardrailCheck;
  }
  return next;
}

/** A platform REPLACE: every entry that differs from what was stored (or carries no author) is stamped `platform_admin`. */
export function stampPlatformGuardrailPolicyWrite(stored: StoredGuardrailPolicyV2, next: StoredGuardrailPolicyV2): StoredGuardrailPolicyV2 {
  const out: StoredGuardrailPolicyV2 = { directions: { ...next.directions }, checks: {} };
  for (const [id, entry] of Object.entries(next.checks)) {
    if (guardrailPolicy(id)?.locked) continue; // a catalogue-locked check is never stored
    const before = stored.checks[id];
    const fields: StatedGuardrailCheck = { ...entry };
    delete fields.setBy;
    const unchanged =
      before !== undefined &&
      Object.keys(fields).length === Object.keys(before).filter((key) => key !== 'setBy').length &&
      Object.entries(fields).every(([key, value]) => (before as unknown as Record<string, unknown>)[key] === value);
    // An unchanged entry keeps its author; an unattributed (legacy) one is re-asserted by this platform write.
    out.checks[id] = { ...fields, setBy: unchanged && before.setBy ? before.setBy : 'platform_admin' };
  }
  return out;
}
