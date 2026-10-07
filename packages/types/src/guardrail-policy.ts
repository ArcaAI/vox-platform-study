/**
 * Tenant guardrail policy v2 (TASK-1050 W1; README §9.3, superseded where §11.1 says so) and the platform
 * policy-key catalogue entry (§11.3 A).
 *
 * Stored in `TenantGuardrailPolicy.policies` (Json) — no migration. The legacy flat shape
 * `{ <checkId>: { enabled, minScore? } }` is read through {@link normalizeTenantGuardrailPolicy}; the first
 * write rewrites the row as v2.
 *
 * Authority (§11.1): a TENANT ADMIN may change only `directions.<dir>.enabled` ("off" = monitor only, OD-7)
 * and `checks.<id>.enabled` of a check that is neither catalogue-locked (medical validation, OD-9) nor locked
 * for that tenant by a platform admin (`locked: true`). Everything else — `action`, `locked`, `minScore`,
 * `dataRegionAction` — is PLATFORM ADMIN only; any other field a tenant write touches is
 * 403 `GUARDRAIL_FIELD_PLATFORM_ONLY` ({@link forbiddenGuardrailPolicyChanges}). A catalogue-locked check is
 * editable by nobody. `setBy` is stamped by the server and never compared.
 *
 * The functions here are PURE and catalogue-agnostic: they take the per-check platform defaults as an
 * argument ({@link GuardrailCheckDefaults} — `GUARDRAIL_CHECK_DEFAULTS` from
 * `packages/applications/.../guardrail-availability/policy-catalogue.ts`, equal to the `defaults` of
 * `tests/contracts/guardrail-policy.fixture.json`). Rules that need the SYSTEM row or the stored row's
 * neighbours (at least one check per direction, OD-8) stay in the gateway service.
 */
import {
  GUARDRAIL_ACTIONS,
  GUARDRAIL_CHECK_IDS,
  GUARDRAIL_DIRECTIONS,
  type GuardrailAction,
  type GuardrailCheckId,
  type GuardrailDirection,
} from './guardrail-vocabulary.js';

export const GUARDRAIL_POLICY_SET_BY = ['platform_admin', 'tenant_admin'] as const;
export type GuardrailPolicySetBy = (typeof GUARDRAIL_POLICY_SET_BY)[number];

/** Which write plane is asking (the field-level split gate). */
export const GUARDRAIL_POLICY_CALLER_CLASSES = ['tenant_admin', 'platform_admin'] as const;
export type GuardrailPolicyCallerClass = (typeof GUARDRAIL_POLICY_CALLER_CLASSES)[number];

export interface GuardrailDirectionPolicy {
  /** `false` = monitor only: every check of that direction runs at `ignore` (OD-7 (a)), never skipped. */
  readonly enabled: boolean;
}

export interface GuardrailCheckPolicy {
  readonly enabled: boolean;
  /** What a violation does. Platform admin only. */
  readonly action: GuardrailAction;
  /** Platform admin locked this check's `enabled` for this tenant. */
  readonly locked?: boolean;
  /** Who last set this entry; server-stamped. */
  readonly setBy?: GuardrailPolicySetBy;
  /** Span floor in [0,1] (`pii_leak` today). Platform admin only. */
  readonly minScore?: number;
  /** Inbound only: what a flag on a DATA region does (OD-12, platform admin only). Absent ⇒ the catalogue default. */
  readonly dataRegionAction?: GuardrailAction;
}

export interface TenantGuardrailPolicyV2 {
  readonly directions: Readonly<Record<GuardrailDirection, GuardrailDirectionPolicy>>;
  /** An absent entry = no opinion (the platform default applies). */
  readonly checks: Readonly<Partial<Record<GuardrailCheckId, GuardrailCheckPolicy>>>;
}

/** The pre-TASK-1050 stored shape. */
export type LegacyTenantGuardrailPolicy = Readonly<Record<string, { readonly enabled: boolean; readonly minScore?: number }>>;

/** One check's platform default, as the catalogue declares it. */
export interface GuardrailCheckDefault {
  readonly enabled: boolean;
  readonly action: GuardrailAction;
  /** Catalogue lock: always `enabled` at `action`, editable by nobody. */
  readonly locked: boolean;
  readonly allowedActions: readonly GuardrailAction[];
}

/** Per-check defaults. A check id missing here is treated as unknown (dropped). */
export type GuardrailCheckDefaults = Readonly<Partial<Record<GuardrailCheckId, GuardrailCheckDefault>>>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isAction(value: unknown): value is GuardrailAction {
  return typeof value === 'string' && (GUARDRAIL_ACTIONS as readonly string[]).includes(value);
}

function knownCheckIds(defaults: GuardrailCheckDefaults): GuardrailCheckId[] {
  return GUARDRAIL_CHECK_IDS.filter((id) => defaults[id] !== undefined);
}

/** v2 is told from the legacy flat shape structurally: `checks` / `directions` are never check ids. */
export function isTenantGuardrailPolicyV2(raw: unknown): boolean {
  return isPlainObject(raw) && (hasOwn(raw, 'checks') || hasOwn(raw, 'directions'));
}

function normalizeEntry(
  raw: unknown,
  fallback: GuardrailCheckDefault,
  legacy: boolean,
  enforce: boolean,
): GuardrailCheckPolicy | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (legacy && typeof raw.enabled !== 'boolean') return undefined;
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled;
  let action: GuardrailAction = !legacy && isAction(raw.action) ? raw.action : fallback.action;
  if (enforce) {
    if (!fallback.allowedActions.includes(action)) action = fallback.action;
    if (fallback.locked) return { enabled: fallback.enabled, action: fallback.action };
  }
  const entry: { -readonly [K in keyof GuardrailCheckPolicy]: GuardrailCheckPolicy[K] } = { enabled, action };
  if (typeof raw.minScore === 'number' && Number.isFinite(raw.minScore) && raw.minScore >= 0 && raw.minScore <= 1) entry.minScore = raw.minScore;
  if (!legacy) {
    if (typeof raw.locked === 'boolean') entry.locked = raw.locked;
    if (typeof raw.setBy === 'string' && (GUARDRAIL_POLICY_SET_BY as readonly string[]).includes(raw.setBy)) {
      entry.setBy = raw.setBy as GuardrailPolicySetBy;
    }
    if (isAction(raw.dataRegionAction)) entry.dataRegionAction = raw.dataRegionAction;
  }
  return entry;
}

function normalize(raw: unknown, defaults: GuardrailCheckDefaults, enforce: boolean): TenantGuardrailPolicyV2 {
  const directions: Record<GuardrailDirection, GuardrailDirectionPolicy> = { inbound: { enabled: true }, outbound: { enabled: true } };
  const checks: Partial<Record<GuardrailCheckId, GuardrailCheckPolicy>> = {};
  if (!isPlainObject(raw)) return { directions, checks };
  const v2 = isTenantGuardrailPolicyV2(raw);
  if (v2 && isPlainObject(raw.directions)) {
    for (const direction of GUARDRAIL_DIRECTIONS) {
      const entry = raw.directions[direction];
      if (isPlainObject(entry) && typeof entry.enabled === 'boolean') directions[direction] = { enabled: entry.enabled };
    }
  }
  const source = v2 ? (isPlainObject(raw.checks) ? raw.checks : {}) : raw;
  for (const id of knownCheckIds(defaults)) {
    if (!hasOwn(source, id)) continue;
    const entry = normalizeEntry(source[id], defaults[id] as GuardrailCheckDefault, !v2, enforce);
    if (entry) checks[id] = entry;
  }
  return { directions, checks };
}

/**
 * Read any stored `policies` blob as v2. Legacy flat entries take the check's platform-default `action` and
 * keep `minScore`; a legacy entry without a boolean `enabled` is no opinion. Unknown ids, invalid optional
 * fields and an action outside `allowedActions` are dropped / fall back to the default — never guessed. A
 * catalogue-locked check always reads as its locked value. Missing directions are on. Pure and idempotent.
 */
export function normalizeTenantGuardrailPolicy(raw: unknown, defaults: GuardrailCheckDefaults): TenantGuardrailPolicyV2 {
  return normalize(raw, defaults, true);
}

/** Per-check fields, in path order. `setBy` is server-stamped and deliberately absent. */
const CHECK_FIELDS = ['enabled', 'action', 'locked', 'minScore', 'dataRegionAction'] as const;
type CheckField = (typeof CHECK_FIELDS)[number];

/** The dotted field paths `caller` may change on a policy currently stored as `current`. */
export function guardrailPolicyEditableFields(
  caller: GuardrailPolicyCallerClass,
  current: unknown,
  defaults: GuardrailCheckDefaults,
): string[] {
  const policy = normalize(current, defaults, true);
  const fields = GUARDRAIL_DIRECTIONS.map((direction) => `directions.${direction}.enabled`);
  for (const id of knownCheckIds(defaults)) {
    if ((defaults[id] as GuardrailCheckDefault).locked) continue;
    if (caller === 'platform_admin') fields.push(...CHECK_FIELDS.map((field) => `checks.${id}.${field}`));
    else if (policy.checks[id]?.locked !== true) fields.push(`checks.${id}.enabled`);
  }
  return fields;
}

function effectiveFields(entry: GuardrailCheckPolicy | undefined, fallback: GuardrailCheckDefault): Record<CheckField, unknown> {
  return {
    enabled: entry?.enabled ?? fallback.enabled,
    action: entry?.action ?? fallback.action,
    locked: entry?.locked ?? false,
    minScore: entry?.minScore,
    dataRegionAction: entry?.dataRegionAction,
  };
}

/**
 * The dotted paths whose EFFECTIVE value differs between `before` and `after` (an absent entry equals the
 * platform default). Compared without lock enforcement, so an attempt to move a locked check is visible.
 * Assumes `after` already passed the DTO validation (an invalid value reads as its default here).
 */
export function guardrailPolicyChangedFields(before: unknown, after: unknown, defaults: GuardrailCheckDefaults): string[] {
  const from = normalize(before, defaults, false);
  const to = normalize(after, defaults, false);
  const changed: string[] = [];
  for (const direction of GUARDRAIL_DIRECTIONS) {
    if (from.directions[direction].enabled !== to.directions[direction].enabled) changed.push(`directions.${direction}.enabled`);
  }
  for (const id of knownCheckIds(defaults)) {
    const fallback = defaults[id] as GuardrailCheckDefault;
    const a = effectiveFields(from.checks[id], fallback);
    const b = effectiveFields(to.checks[id], fallback);
    for (const field of CHECK_FIELDS) if (a[field] !== b[field]) changed.push(`checks.${id}.${field}`);
  }
  return changed;
}

/**
 * The changed paths `caller` may NOT change — empty means the write is allowed. The gateway answers a
 * non-empty result with 403 `GUARDRAIL_FIELD_PLATFORM_ONLY` naming these paths. `before` is the stored row
 * (its `locked` flags decide), `after` the row the write would store.
 */
export function forbiddenGuardrailPolicyChanges(
  caller: GuardrailPolicyCallerClass,
  before: unknown,
  after: unknown,
  defaults: GuardrailCheckDefaults,
): string[] {
  const editable = new Set(guardrailPolicyEditableFields(caller, before, defaults));
  return guardrailPolicyChangedFields(before, after, defaults).filter((field) => !editable.has(field));
}

// ── Platform policy-key catalogue (README §11.3 A) ─────────────────────────────────────────────────────

/** What a governed guardrail policy key controls. */
export const GUARDRAIL_POLICY_KEY_KINDS = ['criteria', 'hyperparameter', 'threshold', 'geometry', 'operational'] as const;
export type GuardrailPolicyKeyKind = (typeof GUARDRAIL_POLICY_KEY_KINDS)[number];

export const GUARDRAIL_POLICY_KEY_VALUE_TYPES = ['string', 'number', 'integer', 'boolean', 'string[]', 'object'] as const;
export type GuardrailPolicyKeyValueType = (typeof GUARDRAIL_POLICY_KEY_VALUE_TYPES)[number];

/** `core/policy.py` FAIL_CLOSED / FAIL_OPEN_TO_DEFAULT. */
export type GuardrailPolicyKeyFailMode = 'closed' | 'open-to-default';

/**
 * ONE entry of `apps/guardrail/src/guardrail/tests/contracts/policy-keys.json`, generated from Python `_SPECS`
 * by lane W2a. The gateway validates platform writes against it and never restates it.
 */
export interface GuardrailPolicyKeySpec {
  /** The `_metadata.policy` key, e.g. `injectionJudgeCriteria`. */
  readonly key: string;
  readonly kind: GuardrailPolicyKeyKind;
  readonly type: GuardrailPolicyKeyValueType;
  /** Inclusive bounds for a numeric key; `null` when unbounded or not numeric. */
  readonly min: number | null;
  readonly max: number | null;
  readonly failMode: GuardrailPolicyKeyFailMode;
  /** The `AiRoutingPolicy` task key of the model row the key lives on (`guardrail.validate`, `guardrail.safety`, …). */
  readonly taskKey: string;
  /** Part of the policy version hash (a change re-screens). */
  readonly inPolicyVersion: boolean;
  /** Writable through `PUT admin/guardrail/policy-keys/:key`. */
  readonly editable: boolean;
}

/** The whole `policy-keys.json` artifact. */
export interface GuardrailPolicyKeyCatalogue {
  readonly $comment?: string | readonly string[];
  readonly schemaVersion: 1;
  readonly keys: readonly GuardrailPolicyKeySpec[];
}
