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
 * Two safety surfaces are therefore ABSENT and deliberately so:
 * `/api/medical/validate` and the groundedness route are separately-invoked
 * routes rather than the request/response gate, so "not selected" there would
 * have to mean "this route refuses", which is a caller-visible contract change
 * (`apps/text` is the caller). Recorded as a seam in the ticket README.
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
}

export const GUARDRAIL_POLICY_CATALOGUE: readonly GuardrailPolicyDescriptor[] = [
  {
    id: 'jailbreak_detection',
    label: 'Jailbreak / prompt injection',
    description:
      'Detects instructions that try to override the system prompt. Runs on BOTH directions: a response that echoes — or complies with — an injected instruction is exactly what a post-receive check exists to catch.',
    directions: ['inbound', 'outbound'],
  },
  {
    id: 'prompt_safety',
    label: 'Prompt safety',
    description: 'Content-safety moderation of untrusted inbound content before it reaches a model.',
    directions: ['inbound'],
  },
  {
    id: 'prompt_toxicity',
    label: 'Prompt toxicity',
    description: 'Toxicity moderation of untrusted inbound content.',
    directions: ['inbound'],
  },
  {
    id: 'response_safety',
    label: 'Response safety',
    description: 'Content-safety moderation of a generated response before it reaches a clinician.',
    directions: ['outbound'],
  },
  {
    id: 'response_toxicity',
    label: 'Response toxicity',
    description: 'Toxicity moderation of a generated response.',
    directions: ['outbound'],
  },
  {
    id: 'response_refusal',
    label: 'Response refusal',
    description: 'Detects a model refusal surfacing to a clinician as if it were clinical content.',
    directions: ['outbound'],
  },
  {
    id: 'pii_leak',
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
    label: 'Containment echo',
    description: 'Detects a response repeating the inbound containment nonce, meaning the instruction/data boundary failed.',
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
  jailbreak_detection: { enabled: false },
  prompt_safety: { enabled: true },
  prompt_toxicity: { enabled: true },
  response_safety: { enabled: false },
  // TASK-932 (owner decisions, 2026-09-09): the five judges that false-positive on clinical
  // text ship OFF at the platform tier until retuned — `response_toxicity` (the 300M classifier
  // flags SOAP content such as chest pain / aspirin), `pii_leak` (a finalized note re-states the
  // encounter's own identifiers, which the fragment check reads as a leak), `response_safety`
  // (blocked a SOAP note), `response_refusal` and `jailbreak_detection` (both blocked a DNA
  // redaction rewrite). `jailbreak_detection` is the one INBOUND check among them, so inbound
  // screening rests on `prompt_safety` + `prompt_toxicity`. Mirrors `seed/18-guardrail-availability.ts`.
  response_toxicity: { enabled: false },
  response_refusal: { enabled: false },
  pii_leak: { enabled: false, minScore: 0.5 },
  containment_echo: { enabled: true },
});

/** True when at least one declared policy is switched on. */
export function hasEnabledPolicy(policies: GuardrailPolicySelectionSet | null | undefined): boolean {
  if (!policies) return false;
  return GUARDRAIL_POLICY_CATALOGUE.some((policy) => policies[policy.id]?.enabled === true);
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
 */
export function assertBothDirectionsCovered(policies: GuardrailPolicySelectionSet): void {
  if (!hasEnabledPolicy(policies)) return;
  const covered = new Set<GuardrailScreenDirection>();
  for (const descriptor of GUARDRAIL_POLICY_CATALOGUE) {
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
