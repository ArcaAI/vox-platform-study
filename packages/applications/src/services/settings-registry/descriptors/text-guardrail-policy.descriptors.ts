// A TENANT's own input-moderation policy for `apps/text` (TASK-799 A.2).
//
// This is the storage half of the PUSH contract whose receiving half already
// exists: `GenerateRequest.guardrail_policy`
// (`apps/text/src/text/models/requests.py`) folded over the platform posture by
// `core/guardrail_posture.resolve_posture`. Until these keys existed there was
// nowhere for a tenant to record the opinion the request field was built to
// carry, so every tenant silently ran the platform default.
//
// ── Why these are SEPARATE keys from `text.externalGuardrail.*` ─────────────
//
// They are the same two CONCEPTS at a different SCOPE, and the scope is what
// makes them different settings:
//
//   text.externalGuardrail.requireMedical   maxScope 'system', consumedBy text
//     The PLATFORM DEFAULT. Resolved at the SYSTEM tenant and served on the
//     PULL route as part of the `externalGuardrail` view — one cached snapshot
//     per text process. It is what a tenant INHERITS when it has no opinion.
//
//   text.guardrailPolicy.requireMedical     maxScope 'tenant', NO consumedBy
//     The TENANT'S OWN opinion. Resolved per request by
//     `TextRequestEnrichmentService` and PUSHED onto the body.
//
// Collapsing them into one key would force a choice between two wrong things:
// declare `consumedBy` on a tenant-varying key (turning one cached pull
// snapshot into one per tenant — the exact bug D-1's split prevents), or drop
// `consumedBy` and lose the platform default the PULL channel has to carry.
// The registry states the rule outright: "a `maxScope: 'tenant'` descriptor
// must NOT declare `consumedBy`" (`registry.types.ts`). Hence two keys, one per
// channel, each honest about its scope.
//
// ── Absence is NOT `false` ──────────────────────────────────────────────────
//
// The push is emitted ONLY when the cascade reports `source: 'tenant'` — i.e.
// a row actually exists under this tenant. A `system` or `code-default`
// resolution is NO OPINION and pushes nothing, so the platform posture stands.
// This matters because the receiving field is `bool | None` and its docstring
// is explicit: "`None` on a field means NO OPINION — the platform default
// stands. It is not the same as `False` and must never be flattened into it."
// Pushing `descriptor.default` on every request would flatten exactly that
// distinction and make the platform default unreachable for every tenant.
//
// The `default` values below are therefore never what a tenant is served —
// they are the floor the key documents, transcribed verbatim from
// `apps/text/src/text/core/runtime_defaults.py` so the two halves of the
// posture can never disagree about what "no opinion anywhere" means.
//
// ── What is deliberately NOT here ───────────────────────────────────────────
//
// The other four posture fields (`enabled`, `timeoutS`, `maxRetries`,
// `retryBackoffMs`) are platform capacity/switch decisions and stay
// platform-only. And there is no `failOpen` key at either scope: a key that
// could be set to make an errored guardrail allow a prompt is not a
// configuration surface, it is a way to ship unmoderated PHI.

import { SettingDescriptor } from '../registry.types';

/**
 * Registry key → the floor the platform half documents for the same concept.
 * Transcribed from `apps/text/src/text/core/runtime_defaults.py`.
 *
 * NOT the value a tenant with no opinion receives — see the header: absence
 * pushes nothing, and the platform posture governs.
 */
export const TEXT_GUARDRAIL_POLICY_DEFAULTS = {
  'text.guardrailPolicy.requireMedical': true,
  'text.guardrailPolicy.includeReasoning': false,
} as const;

export type TextGuardrailPolicyKey = keyof typeof TEXT_GUARDRAIL_POLICY_DEFAULTS;

/**
 * The dotted key ↔ `GenerateRequest.guardrail_policy` field mapping.
 *
 * Exported because it IS the push contract: the enrichment service iterates it
 * rather than repeating two key strings, so a rename cannot silently desync the
 * producer from the field the service reads.
 */
export const TEXT_GUARDRAIL_POLICY_PUSH_FIELDS: ReadonlyArray<readonly [TextGuardrailPolicyKey, string]> = [
  ['text.guardrailPolicy.requireMedical', 'require_medical'],
  ['text.guardrailPolicy.includeReasoning', 'include_reasoning'],
];

const META: Record<TextGuardrailPolicyKey, { label: string; description: string }> = {
  'text.guardrailPolicy.requireMedical': {
    label: 'Require medical content (this tenant)',
    description:
      'This tenant’s own clinical-enforcement stance: whether a reachable guardrail must classify the prompt as ' +
      'medical for it to be allowed. Set it only if this tenant differs from the platform default — leaving it ' +
      'unset is not "off", it inherits whatever the platform currently enforces. A non-clinical tenant turns it ' +
      'off here rather than by weakening the platform floor for everyone else.',
  },
  'text.guardrailPolicy.includeReasoning': {
    label: 'Include guardrail reasoning (this tenant)',
    description:
      'Whether this tenant’s moderation calls ask guardrail to return its reasoning. Off at the platform floor ' +
      'because the reasoning quotes the prompt, so it widens what a verdict carries back across a service boundary; ' +
      'turn it on for a tenant that wants the explanation and accepts that. Unset inherits the platform value.',
  },
};

export const TEXT_GUARDRAIL_POLICY_SETTINGS: SettingDescriptor[] = (
  Object.keys(TEXT_GUARDRAIL_POLICY_DEFAULTS) as TextGuardrailPolicyKey[]
).map<SettingDescriptor>((key) => ({
  key,
  // D-2: `global-kv` is the tier with a complete read + write + tenant cascade
  // + invalidate loop. Two booleans do not earn a table.
  tier: 'global-kv',
  dataType: 'boolean',
  sensitivity: 'internal',
  // The whole point of the family: a TENANT may set it.
  maxScope: 'tenant',
  editableBy: 'all',
  // NO `consumedBy` — see the header. A tenant-varying value never travels the
  // platform-scope pull snapshot.
  failMode: 'open-to-default',
  category: 'Guardrail Policy',
  label: META[key].label,
  description: META[key].description,
  default: TEXT_GUARDRAIL_POLICY_DEFAULTS[key],
}));
