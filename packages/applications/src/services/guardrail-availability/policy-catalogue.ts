/**
 * The guardrail POLICY CATALOGUE — which safety policies a platform admin may
 * select per tenant, and how each one may be tightened.
 *
 * ─── What "availability" means (owner decision #3, TASK-870 target model #5) ──
 *
 * Guardrail is built-in and platform-only, and it gates EVERY text-generation
 * request before send and EVERY response after receive. Availability selects
 * WHICH of the declared checks run for a tenant; it can never say "do not
 * screen". Concretely, and enforced in three places:
 *
 *   - an absent row inherits the SYSTEM set (`resolveAvailability` below);
 *   - a row whose selection enables NOTHING also inherits it — an empty
 *     selection is indistinguishable from absence, deliberately;
 *   - the gate itself always runs: a de-selected check is recorded as
 *     `skipped` on the decision, never silently dropped.
 *
 * ─── Membership rule ────────────────────────────────────────────────────────
 *
 * A policy is selectable if, and only if, a screening check READS the
 * selection. Every id below is a check name in
 * `apps/guardrail/src/guardrail/services/screening.py::_DECLARED_FAIL_MODES`.
 * Declaring an id with no reader would repeat exactly the defect this ticket
 * removed with `injectionScreeningCriteria` — a governed knob that cannot move
 * anything, which is worse than an absent one because an admin who sets it sees
 * neither an effect nor an error.
 *
 * TASK-1050 adds `medical_validation` (LOCKED: always on, always block, so
 * "not selected" can never arise for it) and the four safety judges (shipped
 * OFF). Their screening readers land in `apps/guardrail` in the same ticket
 * (lane W2a), which is what the membership rule requires. The groundedness
 * route stays absent: it is separately invoked, not part of the gate.
 *
 * ─── Cross-language contract ────────────────────────────────────────────────
 *
 * The id list and each threshold's direction are pinned against
 * `apps/guardrail/src/guardrail/tests/contracts/availability-catalogue.json`,
 * which `apps/guardrail/src/guardrail/core/availability.py` is pinned against
 * too. One artifact, two readers — the `ResolvedAsrSpec` precedent.
 */
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import type { SettingDescriptor } from '../settings-registry/registry.types';
import { assertTightenOnlyFloor } from '../settings-registry/tenant-clamp';

export type GuardrailScreenDirection = 'inbound' | 'outbound';

/**
 * What a violation of a check does (TASK-1050, README §9.2 / §11.1). Mirrors `@arcaai/types`
 * `GuardrailAction`; restated here because this module is read at runtime by the gateway and the types
 * package is pinned against the same contract JSON.
 */
export type GuardrailViolationAction = 'ignore' | 'warn' | 'block';

/** Inbound region trust (TASK-1047 FC-5b). */
export type GuardrailRegionTrust = 'instruction' | 'data';

export interface GuardrailPolicyThresholdSpec {
  /** Field name inside the per-policy object (e.g. `minScore`). */
  readonly field: string;
  /**
   * Which way this threshold TIGHTENS, in the settings-registry's own
   * vocabulary (`SettingDescriptor.floorDirection`). The write lane feeds it to
   * the registry's `assertTightenOnlyFloor` rather than reimplementing the
   * comparison, so one implementation governs every tighten-only key in the
   * monorepo.
   */
  readonly floorDirection: 'lower-is-stricter' | 'higher-is-stricter';
  readonly minimum: number;
  readonly maximum: number;
}

export interface GuardrailPolicyDescriptor {
  /** The check name in `screening.py::_DECLARED_FAIL_MODES`. */
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly directions: readonly GuardrailScreenDirection[];
  /** Absent ⇒ the check is on/off only; it has no strictness to tighten. */
  readonly threshold?: GuardrailPolicyThresholdSpec;
  // ── TASK-1050: violation handling (all pinned against the contract JSON) ──
  /** The actions a platform admin may set for this check. */
  readonly allowedActions: readonly GuardrailViolationAction[];
  /** The action when no tier says otherwise. `block` for the eight classifier checks = today's behaviour. */
  readonly platformDefaultAction: GuardrailViolationAction;
  /** Catalogue lock: always enabled at `platformDefaultAction`, editable by nobody (medical validation, OD-9). */
  readonly locked: boolean;
  /** The platform-default on/off (mirrors {@link PLATFORM_DEFAULT_GUARDRAIL_POLICIES}). */
  readonly defaultEnabled: boolean;
  /** Which inbound region trusts the check screens. Absent on an outbound-only check. */
  readonly inboundRegions?: readonly GuardrailRegionTrust[];
  /**
   * For a check that screens BOTH trusts inbound: what a flag on a DATA region does. `ignore` = today's
   * FC-5b record-only. A platform admin may raise it (OD-12 / §11.1). Absent where it does not apply.
   */
  readonly platformDefaultDataRegionAction?: GuardrailViolationAction;
}

const ALL_ACTIONS: readonly GuardrailViolationAction[] = Object.freeze(['ignore', 'warn', 'block']);
/** The eight TASK-886 classifier checks: block on violation (today), record-only on inbound DATA regions (FC-5b). */
const CLASSIFIER = { allowedActions: ALL_ACTIONS, platformDefaultAction: 'block', locked: false } as const;
const CLASSIFIER_INBOUND = { inboundRegions: ['instruction', 'data'], platformDefaultDataRegionAction: 'ignore' } as const;

export const GUARDRAIL_POLICY_CATALOGUE: readonly GuardrailPolicyDescriptor[] = [
  {
    id: 'jailbreak_detection',
    ...CLASSIFIER,
    defaultEnabled: true,
    ...CLASSIFIER_INBOUND,
    label: 'Jailbreak / prompt injection',
    description:
      'Detects instructions that try to override the system prompt. Runs on BOTH directions: a response that echoes — or complies with — an injected instruction is exactly what a post-receive check exists to catch.',
    directions: ['inbound', 'outbound'],
  },
  {
    id: 'prompt_safety',
    ...CLASSIFIER,
    // Owner 2026-10-09 (TASK-1053): warn by default — the classifier false-flags clinical notes; a hit must not block one.
    platformDefaultAction: 'warn',
    defaultEnabled: true,
    ...CLASSIFIER_INBOUND,
    label: 'Prompt safety',
    description: 'Content-safety moderation of untrusted inbound content before it reaches a model.',
    directions: ['inbound'],
  },
  {
    id: 'prompt_toxicity',
    ...CLASSIFIER,
    // Owner 2026-10-09 (TASK-1053): warn by default — the classifier false-flags clinical notes; a hit must not block one.
    platformDefaultAction: 'warn',
    defaultEnabled: true,
    ...CLASSIFIER_INBOUND,
    label: 'Prompt toxicity',
    description: 'Toxicity moderation of untrusted inbound content.',
    directions: ['inbound'],
  },
  {
    id: 'response_safety',
    ...CLASSIFIER,
    // Owner 2026-10-08: warn by default — the classifier false-flags clinical notes; a hit must not withhold one.
    platformDefaultAction: 'warn',
    defaultEnabled: true,
    label: 'Response safety',
    description: 'Content-safety moderation of a generated response before it reaches a clinician.',
    directions: ['outbound'],
  },
  {
    id: 'response_toxicity',
    ...CLASSIFIER,
    // Owner 2026-10-08: warn by default — the classifier false-flags clinical notes; a hit must not withhold one.
    platformDefaultAction: 'warn',
    defaultEnabled: true,
    label: 'Response toxicity',
    description: 'Toxicity moderation of a generated response.',
    directions: ['outbound'],
  },
  {
    id: 'response_refusal',
    ...CLASSIFIER,
    defaultEnabled: false,
    label: 'Response refusal',
    description: 'Detects a model refusal surfacing to a clinician as if it were clinical content.',
    directions: ['outbound'],
  },
  {
    id: 'pii_leak',
    ...CLASSIFIER,
    defaultEnabled: true,
    label: 'PHI / PII leakage',
    description:
      'Flags an identifier present in the response but ABSENT from the declared source — a hallucinated identifier, or one surfaced from outside this consultation.',
    directions: ['outbound'],
    threshold: {
      // A span scoring BELOW this floor is ignored, so a LOWER value inspects
      // more spans and is therefore stricter.
      field: 'minScore',
      floorDirection: 'lower-is-stricter',
      minimum: 0,
      maximum: 1,
    },
  },
  {
    id: 'containment_echo',
    ...CLASSIFIER,
    defaultEnabled: true,
    label: 'Containment echo',
    description: 'Detects a response repeating the inbound containment nonce, meaning the instruction/data boundary failed.',
    directions: ['outbound'],
  },
  // ── TASK-1050: the locked medical judge and the four safety judges. Their screening readers land in
  // apps/guardrail (W2a); the judges ship OFF (OD-6) so a deploy is behaviour-neutral.
  {
    id: 'medical_validation',
    allowedActions: ['block'],
    platformDefaultAction: 'block',
    locked: true,
    defaultEnabled: true,
    inboundRegions: ['instruction', 'data'],
    label: 'Medical-domain validation',
    description:
      'Keeps the platform to clinical documentation: content that directs the assistant to non-medical work is blocked. Always on, always block (the platform is for medical use only).',
    directions: ['inbound'],
  },
  {
    id: 'injection_judge',
    allowedActions: ALL_ACTIONS,
    platformDefaultAction: 'ignore',
    locked: false,
    defaultEnabled: false,
    // README §10.2 A3: instruction text is governed at authoring time; the judge screens DATA regions only.
    inboundRegions: ['data'],
    label: 'Prompt-injection judge',
    description:
      'An LLM judge second opinion on transcripts, notes and attachments the injection classifier scores as borderline: does the content try to steer the assistant?',
    directions: ['inbound'],
  },
  {
    id: 'unsafe_content_judge',
    allowedActions: ALL_ACTIONS,
    platformDefaultAction: 'warn',
    locked: false,
    defaultEnabled: false,
    inboundRegions: ['data'],
    label: 'Unsafe-content judge',
    description:
      'An LLM judge second opinion when the safety or toxicity classifier is borderline: is the content directed at the assistant to obtain harmful output? Clinical description of harm is safe.',
    directions: ['inbound'],
  },
  {
    id: 'clinical_safety_judge',
    allowedActions: ALL_ACTIONS,
    platformDefaultAction: 'warn',
    locked: false,
    defaultEnabled: false,
    label: 'Clinical-safety judge',
    description:
      'An LLM judge on generated clinical output: dangerous dosing, unsupported assertions, direct patient instructions or a missed emergency escalation.',
    directions: ['outbound'],
  },
  {
    id: 'leakage_judge',
    allowedActions: ALL_ACTIONS,
    platformDefaultAction: 'block',
    locked: false,
    defaultEnabled: false,
    label: 'Leakage judge',
    description:
      "An LLM judge on generated output: the assistant's instructions, credentials, internal identifiers, or a third party's identifying details.",
    directions: ['outbound'],
  },
];

const BY_ID = new Map(GUARDRAIL_POLICY_CATALOGUE.map((policy) => [policy.id, policy]));

export function guardrailPolicy(id: string): GuardrailPolicyDescriptor | undefined {
  return BY_ID.get(id);
}

/** One policy's selection: on/off, plus its threshold when it has one. */
export interface GuardrailPolicySelection {
  readonly enabled: boolean;
  readonly [field: string]: boolean | number | undefined;
}

export type GuardrailPolicySelectionSet = Readonly<Record<string, GuardrailPolicySelection>>;

/**
 * The PLATFORM DEFAULT set seeded onto the SYSTEM tenant: every declared check
 * on.
 *
 * `pii_leak.minScore` is transcribed VERBATIM from
 * `apps/guardrail/src/guardrail/core/policy.py::_SPECS['piiLeakMinScore']`
 * (0.5), so seeding it changes no behaviour — the same discipline the judge
 * hyperparameters were moved under. It is stated here rather than left absent
 * because a tighten-only floor with nothing to compare against cannot refuse
 * anything, and the runtime composes the two in the STRICT direction so the two
 * agreeing is a no-op and any future drift resolves toward more screening.
 */
export const PLATFORM_DEFAULT_GUARDRAIL_POLICIES: GuardrailPolicySelectionSet = Object.freeze({
  // Every declared check is ON — request AND response (owner decisions OD-1..OD-5, reversing the
  // earlier clinical-text calibration). `response_refusal` alone is off: a refusal is not unsafe content.
  // Mirrors `seed/18-guardrail-availability.ts`.
  jailbreak_detection: { enabled: true },
  prompt_safety: { enabled: true },
  prompt_toxicity: { enabled: true },
  response_safety: { enabled: true },
  response_toxicity: { enabled: true },
  // A refusal is not unsafe content, so it is the one check that ships off.
  response_refusal: { enabled: false },
  pii_leak: { enabled: true, minScore: 0.5 },
  containment_echo: { enabled: true },
  // TASK-1050: medical validation is locked on; the four judges ship OFF (OD-6).
  medical_validation: { enabled: true },
  injection_judge: { enabled: false },
  unsafe_content_judge: { enabled: false },
  clinical_safety_judge: { enabled: false },
  leakage_judge: { enabled: false },
});

/**
 * TASK-1050: the per-check platform defaults the `@arcaai/types` policy v2 functions
 * (`normalizeTenantGuardrailPolicy`, `forbiddenGuardrailPolicyChanges`, …) take as their `defaults`
 * argument — structurally `GuardrailCheckDefaults`. Derived from the catalogue, never restated; equal to
 * the `defaults` of `tests/contracts/guardrail-policy.fixture.json`.
 */
export const GUARDRAIL_CHECK_DEFAULTS: Readonly<
  Record<
    string,
    {
      readonly enabled: boolean;
      readonly action: GuardrailViolationAction;
      readonly locked: boolean;
      readonly allowedActions: readonly GuardrailViolationAction[];
    }
  >
> = Object.freeze(
  Object.fromEntries(
    GUARDRAIL_POLICY_CATALOGUE.map((policy) => [
      policy.id,
      { enabled: policy.defaultEnabled, action: policy.platformDefaultAction, locked: policy.locked, allowedActions: policy.allowedActions },
    ]),
  ),
);

/**
 * True when at least one declared, UNLOCKED policy is switched on. A catalogue-locked check (medical
 * validation) runs regardless, so naming it expresses no opinion about the screens (TASK-1050).
 */
export function hasEnabledPolicy(policies: GuardrailPolicySelectionSet | null | undefined): boolean {
  if (!policies) return false;
  return GUARDRAIL_POLICY_CATALOGUE.some((policy) => !policy.locked && policies[policy.id]?.enabled === true);
}

export interface ResolvedGuardrailAvailability {
  readonly policies: GuardrailPolicySelectionSet;
  /** WHICH tier answered — part of every attributable verdict. */
  readonly sourceTenantId: string;
}

/**
 * The two-tier cascade, request tenant → SYSTEM, widening on ABSENCE ONLY.
 *
 * An empty (or all-disabled) tenant selection counts as absence: there is no
 * "off", so the only thing such a row can mean is "no opinion". `50000000-…`
 * ("Global") is a CUSTOMER tenant and never appears here.
 */
export function resolveAvailability(
  tenantPolicies: GuardrailPolicySelectionSet | null | undefined,
  systemPolicies: GuardrailPolicySelectionSet | null | undefined,
  tenantId: string,
): ResolvedGuardrailAvailability {
  if (tenantId !== SYSTEM_TENANT_ID && hasEnabledPolicy(tenantPolicies)) {
    return { policies: tenantPolicies as GuardrailPolicySelectionSet, sourceTenantId: tenantId };
  }
  return {
    policies: hasEnabledPolicy(systemPolicies) ? (systemPolicies as GuardrailPolicySelectionSet) : PLATFORM_DEFAULT_GUARDRAIL_POLICIES,
    sourceTenantId: SYSTEM_TENANT_ID,
  };
}

/** Raised as 400 by the write lane: the selection is not a legal catalogue set. */
export class GuardrailPolicySelectionError extends Error {}

/**
 * Validate a submitted selection against the catalogue, returning the
 * normalized set. Unknown ids, wrong types and out-of-range thresholds are
 * REFUSED (400) rather than dropped: silently ignoring an unknown check name is
 * how an admin ends up believing they configured something.
 */
export function normalizeSelection(raw: unknown): GuardrailPolicySelectionSet {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new GuardrailPolicySelectionError('`policies` must be a JSON object keyed by policy id');
  }
  const out: Record<string, GuardrailPolicySelection> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const descriptor = guardrailPolicy(id);
    if (!descriptor) {
      throw new GuardrailPolicySelectionError(
        `Unknown guardrail policy '${id}'. Legal ids: ${GUARDRAIL_POLICY_CATALOGUE.map((p) => p.id).join(', ')}.`,
      );
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new GuardrailPolicySelectionError(`Policy '${id}' must be an object, e.g. { "enabled": true }`);
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.enabled !== 'boolean') {
      throw new GuardrailPolicySelectionError(`Policy '${id}' requires a boolean 'enabled'`);
    }
    if (descriptor.locked && entry.enabled !== descriptor.defaultEnabled) {
      throw new GuardrailPolicySelectionError(`Policy '${id}' is locked by the platform and cannot be switched ${entry.enabled ? 'on' : 'off'}`);
    }
    const selection: Record<string, boolean | number> = { enabled: entry.enabled };

    for (const field of Object.keys(entry)) {
      if (field === 'enabled') continue;
      if (!descriptor.threshold || descriptor.threshold.field !== field) {
        throw new GuardrailPolicySelectionError(
          descriptor.threshold
            ? `Policy '${id}' accepts only '${descriptor.threshold.field}' beside 'enabled', not '${field}'`
            : `Policy '${id}' has no strictness to set; remove '${field}'`,
        );
      }
      const candidate = entry[field];
      if (typeof candidate !== 'number' || Number.isNaN(candidate)) {
        throw new GuardrailPolicySelectionError(`Policy '${id}'.${field} must be a number`);
      }
      const { minimum, maximum } = descriptor.threshold;
      if (candidate < minimum || candidate > maximum) {
        throw new GuardrailPolicySelectionError(`Policy '${id}'.${field} must be within [${minimum}, ${maximum}]`);
      }
      selection[field] = candidate;
    }
    out[id] = selection as GuardrailPolicySelection;
  }
  return out;
}

/**
 * A NON-EMPTY selection must leave BOTH directions gated.
 *
 * The owner's decision is literal: guardrail "must check ALL requests before
 * send and ALL responses after receive". A selection that enables only outbound
 * checks leaves every request ungated, which is not a narrowing — it is a
 * direction switched off, the one thing availability may not express. An EMPTY
 * selection is exempt because it is not a selection at all: it inherits the
 * SYSTEM set, which covers both.
 *
 * The minimal legal narrowing is therefore one policy that runs on both —
 * `jailbreak_detection` — so this rule constrains the surface without closing
 * the use case it exists for.
 *
 * CONFIRMED BY THE OWNER 2026-09-10 (TASK-941 R2 / OD-2). This rule was DERIVED
 * from the decision's wording rather than stated, and TASK-886 flagged it as H6 for
 * exactly that reason: a derived rule carries the force of a 400 while resting on an
 * inference. It is now a decision, so it is no longer provisional and the handoff is
 * closed. "A tenant may not switch a screening direction off" is a deliberate limit
 * on what availability can express, not an oversight — reversing it means deleting
 * this function and its call in `guardrail-availability.service.ts`, which stays a
 * one-line change if the decision ever changes.
 */
export function assertBothDirectionsCovered(policies: GuardrailPolicySelectionSet): void {
  if (!hasEnabledPolicy(policies)) return;
  const covered = new Set<GuardrailScreenDirection>();
  for (const descriptor of GUARDRAIL_POLICY_CATALOGUE) {
    // A catalogue-locked check runs regardless of the selection, so it never stands in for a screen.
    if (descriptor.locked) continue;
    if (policies[descriptor.id]?.enabled === true) for (const direction of descriptor.directions) covered.add(direction);
  }
  const missing = (['inbound', 'outbound'] as const).filter((direction) => !covered.has(direction));
  if (missing.length > 0) {
    throw new GuardrailPolicySelectionError(
      `A selection must leave both screening directions gated; ${missing.join(' and ')} would have no check. ` +
        'Enable at least one policy per direction, or send `{}` to inherit the platform set.',
    );
  }
}

/**
 * Enforce the tighten-only rule for every threshold in a submitted selection,
 * against the SYSTEM row's set.
 *
 * DELEGATED to the settings registry's `assertTightenOnlyFloor` rather than
 * reimplemented: it already reads the direction off a descriptor, throws
 * `SettingFloorViolation` (a 403 that NAMES the requested value and the floor),
 * and never clamps. Reusing it keeps one refusal message and one comparison for
 * every tighten-only key in the monorepo.
 *
 * The ENABLED SET is deliberately not floor-checked. Only a platform admin can
 * write here, and narrowing which policies apply to a tenant is the surface's
 * purpose (owner decision #3); what may never loosen is a policy's strictness.
 */
export function assertSelectionTightensOnly(requested: GuardrailPolicySelectionSet, systemPolicies: GuardrailPolicySelectionSet): void {
  for (const descriptor of GUARDRAIL_POLICY_CATALOGUE) {
    const spec = descriptor.threshold;
    if (!spec) continue;
    const candidate = requested[descriptor.id]?.[spec.field];
    if (typeof candidate !== 'number') continue;
    const floor = systemPolicies[descriptor.id]?.[spec.field];
    // A synthetic descriptor: `assertTightenOnlyFloor` reads exactly `key` (for
    // the message) and `floorDirection` (for the comparison).
    const synthetic = { key: `guardrail.availability.${descriptor.id}.${spec.field}`, floorDirection: spec.floorDirection } as SettingDescriptor;
    assertTightenOnlyFloor(synthetic, candidate, typeof floor === 'number' ? floor : null);
  }
}
