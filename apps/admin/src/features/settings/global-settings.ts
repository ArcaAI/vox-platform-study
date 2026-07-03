/**
 * TASK-391 #24 (ST1) — pure helpers for the Global Settings surface.
 *
 * Backed by the real `GlobalSetting` model (`globalSetting.prisma` / seed
 * `11-global-setting.ts`): settings carry a `namespace` (general · feature-flags
 * · stt · smr · guardrail · ux-constants · admin · rate-limit) and a `locked`
 * write-guard (only super-admins may change locked rows — the server is the
 * source of truth; the console mirrors it by disabling the controls).
 */

import type { GlobalSetting } from '@arcaai/vox';

/** Canonical namespace order (design §5.6 section-nav order); unknowns follow, ungrouped last. */
const NAMESPACE_ORDER = ['general', 'feature-flags', 'stt', 'smr', 'guardrail', 'ux-constants', 'admin', 'rate-limit'];

/** Pretty labels for the known namespaces; unknown namespaces render verbatim. */
const NAMESPACE_LABELS: Record<string, string> = {
  general: 'General',
  'feature-flags': 'Feature flags',
  stt: 'STT',
  smr: 'SMR',
  guardrail: 'Guardrail',
  'ux-constants': 'UX constants',
  admin: 'Admin',
  'rate-limit': 'Rate limits',
};

export interface SettingGroup {
  /** Raw namespace key (`''` when the setting has no namespace). */
  key: string;
  /** Display label for the group subheader. */
  label: string;
  settings: GlobalSetting[];
}

/**
 * A setting is locked when the server flags `locked === true` (write-guarded).
 * Takes `unknown` (rather than `{ locked?: unknown }`) so a `GlobalSetting` — whose
 * `locked` lives under its `[key: string]: unknown` index signature, not a named
 * field — is accepted without tripping TS's weak-type "no common properties" check.
 */
export function isSettingLocked(setting: unknown): boolean {
  return typeof setting === 'object' && setting !== null && (setting as { locked?: unknown }).locked === true;
}

/** Human label for a namespace; `''`/nullish → "Other". */
export function namespaceLabel(namespace?: string | null): string {
  const ns = (namespace ?? '').trim();
  if (!ns) return 'Other';
  return NAMESPACE_LABELS[ns] ?? ns;
}

function namespaceRank(key: string): number {
  const i = NAMESPACE_ORDER.indexOf(key);
  if (i >= 0) return i;
  if (key === '') return Number.MAX_SAFE_INTEGER; // ungrouped ("Other") sorts last
  return NAMESPACE_ORDER.length; // unknown, non-empty namespaces sit between known + "Other"
}

/**
 * Group settings by namespace, ordered by the canonical section order (known
 * namespaces first, then unknown alphabetically, then ungrouped). Within a group
 * the original order is preserved. Pure — the UI renders a subheader per group.
 */
export function groupByNamespace(settings: GlobalSetting[]): SettingGroup[] {
  const map = new Map<string, GlobalSetting[]>();
  for (const s of settings) {
    const key = (typeof s.namespace === 'string' ? s.namespace.trim() : '') || '';
    const bucket = map.get(key);
    if (bucket) bucket.push(s);
    else map.set(key, [s]);
  }
  return [...map.entries()]
    .sort(([a], [b]) => {
      const ra = namespaceRank(a);
      const rb = namespaceRank(b);
      return ra !== rb ? ra - rb : a.localeCompare(b);
    })
    .map(([key, groupSettings]) => ({ key, label: namespaceLabel(key), settings: groupSettings }));
}

// ── TASK-395 P1-4 (§5.6) — sectioned-form helpers ────────────────────────────

/** The input control a setting renders with, derived from its `dataType`. */
export type SettingControlKind = 'boolean' | 'number' | 'json' | 'string';

/**
 * Map a setting's `dataType` (Prisma `ValueType`) to the sectioned-form control:
 * Boolean→toggle, Integer/Float/Double/Decimal→number, Json/Array→code, else text.
 * Case-insensitive; unknown/absent types fall back to a text input.
 */
export function settingControlKind(setting: Pick<GlobalSetting, 'dataType'> | null | undefined): SettingControlKind {
  const t = (typeof setting?.dataType === 'string' ? setting.dataType : '').trim().toLowerCase();
  if (t === 'boolean' || t === 'bool') return 'boolean';
  if (t === 'integer' || t === 'int' || t === 'float' || t === 'double' || t === 'decimal' || t === 'number') return 'number';
  if (t === 'json' || t === 'array' || t === 'object') return 'json';
  return 'string';
}

/**
 * A secret setting holds a value the server never returns in plaintext on
 * list/get. TASK-396: the server now marks these authoritatively via `isSecret`
 * (true when the row is Vault-encrypted OR matches the secret naming
 * convention) and masks their `value`. We prefer that marker and fall back to
 * the legacy `encryptedValue` presence check. The console masks the value and
 * enables the gated Reveal affordance (super-admin + step-up re-auth).
 */
export function isSecretSetting(setting: unknown): boolean {
  if (typeof setting !== 'object' || setting === null) return false;
  if ((setting as { isSecret?: unknown }).isSecret === true) return true;
  const ev = (setting as { encryptedValue?: unknown }).encryptedValue;
  if (typeof ev === 'string') return ev.trim().length > 0;
  return ev != null && ev !== false;
}

/** Whether the setting carries a server `defaultValue` (enables Reset-to-default). */
export function hasDefaultValue(setting: unknown): boolean {
  if (typeof setting !== 'object' || setting === null) return false;
  return (setting as { defaultValue?: unknown }).defaultValue != null;
}

/** Read the server `defaultValue` (via the `GlobalSetting` index signature). */
export function settingDefaultValue(setting: unknown): unknown {
  if (typeof setting !== 'object' || setting === null) return undefined;
  return (setting as { defaultValue?: unknown }).defaultValue;
}

/**
 * Stringify a setting value for a text/number `Input`. `null`/`undefined` → `''`;
 * strings pass through; everything else is JSON/`String()`-coerced so numbers
 * render as `"10"` and objects as compact JSON.
 */
export function stringifyForInput(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Pretty JSON for the read-only expandable code affordance (json/array settings). */
export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
