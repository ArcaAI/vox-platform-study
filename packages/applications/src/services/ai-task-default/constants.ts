import { ModelTaskType } from '@arcaai/domains';

/**
 * The AI tasks whose default model is selected through
 * `AiTaskDefault` rows (the Class-3 generalization of
 * `HarnessPolicy.textProvider/textModel` for non-pipeline tasks). Extensible:
 * new keys are added here + a compatibility mapping below + a
 * `models.<taskKey>` descriptor in the settings registry.
 */
// `text.live` / `text.finalize` route the two TEXT generation
// flows (live-documentation delta vs. final/comprehensive summary). They are the
// AiTaskDefault-first precedence source for `HarnessPolicyService.resolveTextSelection`.
// `text.live.fallback` / `text.finalize.fallback` are the per-tenant,
// opt-in fallback selections `resolveTextFallbackSelection` reads (fail-OPEN: no
// row ⇒ no fallback). TEXT selection is tenant-admin configurable (NOT in
// `SUPER_ADMIN_ONLY_TASK_PREFIXES`).
// `text.test` routes the tenant-admin prompt-template test bench when the
// caller does not supply an explicit provider/model pair. TASK-740 D-5: this
// comment used to describe a `text.test → text.finalize` fallback hop. There is
// no such hop — `PromptManagementService` resolves `text.test` DIRECTLY and
// fails CLOSED (BadRequestException naming the key) when it is unconfigured, so
// that testing a prompt never silently reads clinical-documentation routing.
// additive keys moving the last env-selected surfaces into the DB
// control plane: `guardrail.safety` (GLiNER content-safety detector),
// `guardrail.groundedness` (MiniCheck NLI fact-checker), `harness.judge`
// (LLM-as-judge), and `nlp.diagnosis` (the diagnosis suggester, split out of
// the mis-keyed `nlp.classification` doc-type classifier).
// TASK-729: `nlp.sentiment` / `nlp.toxicity` — two more FIXED-taxonomy
// classification tasks served by the SAME generic `/classify/text` endpoint
// (model-agnostic already; see apps/nlp/src/nlp/api/v1/rest/classify.py).
// No new Python endpoint — only these two AiTaskDefault keys. Super-admin-only,
// consistent with every other `nlp.*` key.
// `vlm.extract`  routes TEXT's vision capability (image → text
// extraction via a vision-language model). It lives in TEXT's own
// provider/adapter framework — same governance class as `text.*` — so it is
// tenant-admin configurable, NOT under `SUPER_ADMIN_ONLY_TASK_PREFIXES`.
export const AI_TASK_KEYS = [
  'guardrail.validate',
  'guardrail.safety',
  'guardrail.groundedness',
  // TASK-799 R6 — the PII redaction selections. Seeded and read at runtime by
  // guardrail's own SQL (`core/tenant_config.py`) since TASK-776, but never
  // declared here, so `assertKnownTaskKey` rejected them on every admin route
  // and no `models.*` descriptor was generated: the platform's PII model was
  // unmanageable through ANY surface. Both are SUPER_ADMIN-only — see
  // `SUPER_ADMIN_ONLY_TASK_KEYS`.
  'guardrail.pii',
  'guardrail.pii.spans',
  'nlp.ner',
  'nlp.classification',
  'nlp.diagnosis',
  'nlp.sentiment',
  'nlp.toxicity',
  'text.live',
  'text.finalize',
  'text.live.fallback',
  'text.finalize.fallback',
  'text.test',
  'harness.judge',
  'vlm.extract',
] as const;

export type AiTaskKey = (typeof AI_TASK_KEYS)[number];

/**
 * taskKey → the `AiModel.taskType` a bound slug must carry. Upserts reject a
 * slug whose registry row declares a different task type.
 */
export const AI_TASK_MODEL_TASK_TYPES: Record<AiTaskKey, ModelTaskType> = {
  'guardrail.validate': ModelTaskType.GUARDRAIL,
  // GLiNER content-safety detector (token-level PII/label spans).
  'guardrail.safety': ModelTaskType.TOKEN_CLASSIFICATION,
  // MiniCheck is an NLI/entailment fact-checker; TEXT_CLASSIFICATION
  // is the closest existing ModelTaskType (no dedicated NLI type exists).
  'guardrail.groundedness': ModelTaskType.TEXT_CLASSIFICATION,
  // Both PII selections are span extractors (GLiNER2), so TOKEN_CLASSIFICATION —
  // matching `seed/ai-models/nlp.ts` for `gliner2-privacy-filter-pii-multi` and
  // `gliner2-guardrails-pii-multi`. An upsert rejects a slug whose registry row
  // declares a different task type, so a mismatch here is a runtime refusal.
  'guardrail.pii': ModelTaskType.TOKEN_CLASSIFICATION,
  'guardrail.pii.spans': ModelTaskType.TOKEN_CLASSIFICATION,
  'nlp.ner': ModelTaskType.TOKEN_CLASSIFICATION,
  'nlp.classification': ModelTaskType.TEXT_CLASSIFICATION,
  // diagnosis suggester (symptom→disease text classification).
  'nlp.diagnosis': ModelTaskType.TEXT_CLASSIFICATION,
  // TASK-729: sentiment / toxicity classifiers reuse the SAME generic
  // /classify/text path as nlp.classification/nlp.diagnosis — same task type.
  'nlp.sentiment': ModelTaskType.TEXT_CLASSIFICATION,
  'nlp.toxicity': ModelTaskType.TEXT_CLASSIFICATION,
  // TEXT generation models are text-generation models in the registry.
  'text.live': ModelTaskType.TEXT_GENERATION,
  'text.finalize': ModelTaskType.TEXT_GENERATION,
  // per-tenant TEXT fallback selections — same task type.
  'text.live.fallback': ModelTaskType.TEXT_GENERATION,
  'text.finalize.fallback': ModelTaskType.TEXT_GENERATION,
  // prompt-template test-bench routing — same task type.
  'text.test': ModelTaskType.TEXT_GENERATION,
  // the harness LLM-as-judge is a text-generation model.
  'harness.judge': ModelTaskType.TEXT_GENERATION,
  // vision extraction — image + text in, text out.
  'vlm.extract': ModelTaskType.IMAGE_TEXT_TO_TEXT,
};

/**
 * Task-key prefixes whose writes AND effective resolution are SUPER_ADMIN-ONLY
 * (a privilege boundary → 403 on write, NOT the 404-over-403 cross-tenant posture).
 * Runtime reads ignore per-tenant override rows and use the SYSTEM row only
 * (tenants may only *use* platform defaults for these surfaces).
 * - `nlp.`
 * - `harness.`
 *
 * NOTE: `text.` is intentionally NOT here. TEXT summarization model
 * selection — primary (`text.live` / `text.finalize`) AND per-tenant fallback
 * (`text.<task>.fallback`) — is tenant-admin configurable: `getEffective`
 * honours per-tenant override rows and `upsertRow` permits tenant writes.
 *
 * `guardrail.` was REMOVED here by owner decision 2026-08-16 (TASK-735 Phase
 * 0), reversing the 2026-07-17 super-admin-only directive: guardrail
 * selection is now tenant-admin configurable via the SAME cascade as `text.*`
 * (`getEffective` honours the tenant row; `upsertRow` accepts tenant writes).
 * It is NOT unconditional, though — `AiTaskDefaultService.upsertRow` layers a
 * separate, guardrail-specific platform floor (D2, tighten-only) on top of
 * this list: a tenant write to a `guardrail.*` key must resolve its
 * `modelSlug` to a SYSTEM-tenant `AiModel` row (the platform-approved list),
 * checked via {@link isGuardrailTaskKey}, regardless of the caller's role.
 * The full floor also calls for a `featureGuardrailModelSelection`
 * entitlement ceiling (catalogued in
 * `settings-registry/descriptors/entitlements.descriptors.ts`) that is NOT
 * yet wired to enforcement here — it requires a `PlanEntitlement`/
 * `TenantEntitlement` column (a `packages/database` migration) outside this
 * ticket's file scope. See the TASK-735 ticket README §7 for the gap.
 */
export const SUPER_ADMIN_ONLY_TASK_PREFIXES = ['nlp.', 'harness.'] as const;

/**
 * SUPER_ADMIN-only task keys that do NOT follow a locked PREFIX.
 *
 * `guardrail.` is deliberately tenant-configurable (TASK-735 Phase 0), so a
 * prefix cannot express these two — and widening the prefix would silently
 * re-lock `guardrail.validate` / `.safety` / `.groundedness`, reversing that
 * owner decision as a side effect. Hence a KEY-level list.
 *
 * WHY THESE TWO (owner decision, 2026-08-24): `guardrail.pii` and
 * `guardrail.pii.spans` select TOKEN_CLASSIFICATION models that run in
 * `apps/nlp` (`guardrail/core/tenant_config.py`: "The models themselves run in
 * apps/nlp"), and D-4 rules that nlp-hosted models — naming token
 * classification and guardrail tasks explicitly — are PLATFORM-SHARED with no
 * tenant BYO. PII redaction is also a PHI-protection control: one vetted model
 * for every tenant is the point, not a per-tenant choice.
 *
 * A tenant row for these keys may still be WRITTEN, and will never WIN —
 * `getEffective` short-circuits the tenant read for a super-admin-only key.
 * That is the same shape as every `nlp.*` key.
 */
export const SUPER_ADMIN_ONLY_TASK_KEYS = ['guardrail.pii', 'guardrail.pii.spans'] as const;

/**
 * @deprecated Use {@link SUPER_ADMIN_ONLY_TASK_PREFIXES}. Retained for
 * back-compat with zero production callers (verified 2026-08-16, TASK-735).
 * Historically pinned to `'guardrail.'`; guardrail left the super-admin-only
 * set in TASK-735 Phase 0, so that value would now be actively wrong. Aliased
 * to the first remaining locked prefix instead of a stale literal.
 */
export const SUPER_ADMIN_ONLY_TASK_PREFIX = SUPER_ADMIN_ONLY_TASK_PREFIXES[0];

/**
 * True when `taskKey` is SUPER_ADMIN-only — by locked PREFIX, or by explicit
 * KEY for the exceptions a prefix cannot express.
 *
 * This is the single predicate every consumer reads (the service's tenant-read
 * short-circuit, the `globalOnly` descriptor flag, the admin authz checks), so
 * folding the key list in here is what makes one edit reach all of them.
 */
export function isSuperAdminOnlyTaskKey(taskKey: string): boolean {
  return (
    SUPER_ADMIN_ONLY_TASK_PREFIXES.some((p) => taskKey.startsWith(p)) ||
    (SUPER_ADMIN_ONLY_TASK_KEYS as readonly string[]).includes(taskKey)
  );
}

/**
 * Task-key prefix for the guardrail safety-engine keys
 * (`guardrail.validate` / `guardrail.safety` / `guardrail.groundedness`).
 * `guardrail.` is tenant-configurable (see {@link SUPER_ADMIN_ONLY_TASK_PREFIXES}
 * doc), but `AiTaskDefaultService.upsertRow` still layers the D2 tighten-only
 * platform floor on it via {@link isGuardrailTaskKey}.
 */
export const GUARDRAIL_TASK_PREFIX = 'guardrail.';

/** True when `taskKey` is a `guardrail.*` key (the D2 platform-floor gate applies). */
export function isGuardrailTaskKey(taskKey: string): boolean {
  return taskKey.startsWith(GUARDRAIL_TASK_PREFIX);
}
