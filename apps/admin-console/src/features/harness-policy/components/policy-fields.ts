/**
 * The HarnessPolicy knobs (verified against HarnessPolicyResponse /
 * UpdateHarnessPolicyRequest in @arcaai/applications), grouped for the
 * settings grid and the OCC save form. One descriptor list keeps the grid,
 * the form and the sparse-patch builder in lockstep.
 */

import type { HarnessPolicy, UpdateHarnessPolicyRequest } from '../api';

// TASK-881: the `text` / `nullable-text` kinds went with the two text-generation
// controls; every surviving knob is a number, a switch or a list.
export type PolicyFieldKind = 'fraction' | 'integer' | 'switch' | 'list';

export interface PolicyField {
  key: keyof HarnessPolicy & keyof UpdateHarnessPolicyRequest;
  label: string;
  kind: PolicyFieldKind;
  hint?: string;
}

export interface PolicyFieldGroup {
  title: string;
  fields: PolicyField[];
}

/**
 * Knobs the TENANT editor renders read-only.
 *
 * The gateway rejects a tenant PATCH carrying any of these with 403 (they joined
 * `SUPER_ADMIN_ONLY_POLICY_KEYS`, which also overlays the SYSTEM value at read
 * time). Disabling them here is the console half of that contract: the server is
 * still the authority, this only stops the user aiming at a control that cannot
 * succeed. The GLOBAL editor passes no locked keys — it may write all of them.
 *
 * Keep in step with `SUPER_ADMIN_ONLY_POLICY_KEYS` in
 * `packages/applications/src/services/harness-policy/harness-policy.service.ts`.
 * This list is the INTERSECTION of that one with the fields the tenant tab
 * actually renders — the remaining locked keys (TEXT routing, agentic loop
 * knobs) have no tenant-tab control, so there is nothing to disable.
 *
 * `safetyProvider`/`safetyModel` (and, since TASK-881, `textProvider`/`textModel`)
 * are NOT in this list because their controls were removed outright with their
 * columns. Locking is the right answer for a key the tenant may not write
 * but a super admin may; those two backed dropped columns, so the GLOBAL tab — which passes
 * no locked keys — would have patched a column that no longer exists. A control nobody may
 * successfully use is deleted, not disabled.
 */
export const TENANT_LOCKED_POLICY_KEYS = [
  'safetyEnabled',
  'phiEnabled',
  'phiFailClosed',
] as const satisfies readonly PolicyField['key'][];

/** The copy shown under every locked control (rule 11 §5: visible reason). */
export const LOCKED_FIELD_HINT = 'Super Admins only';

export const POLICY_FIELD_GROUPS: PolicyFieldGroup[] = [
  {
    title: 'Sensor thresholds',
    fields: [
      { key: 'entityFaithfulnessThreshold', label: 'Entity faithfulness', kind: 'fraction' },
      { key: 'coverageThreshold', label: 'Coverage', kind: 'fraction' },
      { key: 'citationPresenceThreshold', label: 'Citation presence', kind: 'fraction' },
      { key: 'numericDoseThreshold', label: 'Numeric / dose', kind: 'fraction' },
      { key: 'groundednessThreshold', label: 'Groundedness', kind: 'fraction' },
    ],
  },
  {
    title: 'Safety & PHI',
    fields: [
      { key: 'safetyEnabled', label: 'Safety guardrail', kind: 'switch' },
      { key: 'phiEnabled', label: 'PHI detection', kind: 'switch' },
      { key: 'phiFailClosed', label: 'PHI fail-closed', kind: 'switch' },
    ],
  },
  {
    title: 'Generation',
    // TASK-881: the `textProvider` / `textModel` controls are gone with their
    // columns — text selection is the assigned TEXT_GENERATION agent
    // (`/agents`), and the summary card above shows the derived value.
    fields: [{ key: 'maxRegen', label: 'Max regen budget', kind: 'integer' }],
  },
  {
    title: 'Clinician gate',
    fields: [
      { key: 'gateSlaSeconds', label: 'Gate SLA (seconds)', kind: 'integer' },
      { key: 'gateEscalationSeconds', label: 'Gate escalation (seconds)', kind: 'integer' },
    ],
  },
  {
    title: 'Tools',
    fields: [{ key: 'toolAllowlist', label: 'Tool allowlist', kind: 'list', hint: 'comma-separated ids; empty = all tools allowed' }],
  },
];

export const POLICY_FIELDS: PolicyField[] = POLICY_FIELD_GROUPS.flatMap((group) => group.fields);

/** Canonical draft representation of a policy value (inputs edit strings/booleans). */
export function fieldDraftValue(field: PolicyField, policy: HarnessPolicy): string | boolean {
  const value = policy[field.key];
  switch (field.kind) {
    case 'switch':
      return Boolean(value);
    case 'list':
      return ((value as string[] | null) ?? []).join(', ');
    default:
      return value === null || value === undefined ? '' : String(value);
  }
}

/** Display form for the settings grid ("true" / "0.8" / "—"). */
export function fieldDisplayValue(field: PolicyField, policy: HarnessPolicy): string {
  const value = policy[field.key];
  if (field.kind === 'switch') return value ? 'true' : 'false';
  if (field.kind === 'list') {
    const list = value as string[] | null;
    return list && list.length > 0 ? list.join(', ') : '\u2014';
  }
  if (value === null || value === undefined) return '\u2014';
  return String(value);
}

/** Parse one edited draft back into its PATCH value; undefined = not sendable. */
function parseDraft(field: PolicyField, draft: string | boolean): UpdateHarnessPolicyRequest[PolicyField['key']] | undefined {
  switch (field.kind) {
    case 'switch':
      return Boolean(draft);
    case 'fraction':
    case 'integer': {
      const text = String(draft).trim();
      if (text === '') return undefined;
      const parsed = Number(text);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    case 'list': {
      const items = String(draft)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      return items.length === 0 ? null : items;
    }
  }
}

/**
 * Sparse patch: only fields whose draft differs from the loaded policy are
 * sent (the gateway's whitelist pipe accepts every declared knob; omitting a
 * field leaves it unchanged server-side).
 */
export function buildSparsePatch(policy: HarnessPolicy, drafts: Record<string, string | boolean>): UpdateHarnessPolicyRequest {
  const patch: Record<string, unknown> = {};
  for (const field of POLICY_FIELDS) {
    const draft = drafts[field.key];
    if (draft === undefined || draft === fieldDraftValue(field, policy)) continue;
    const parsed = parseDraft(field, draft);
    if (parsed === undefined) continue;
    patch[field.key] = parsed;
  }
  return patch as UpdateHarnessPolicyRequest;
}
