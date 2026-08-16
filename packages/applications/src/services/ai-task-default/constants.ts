import { ModelTaskType } from '@arcaai/domains';

/**
 * The AI tasks whose default model is selected through
 * `AiTaskDefault` rows (the Class-3 generalization of
 * `HarnessPolicy.smrProvider/smrModel` for non-pipeline tasks). Extensible:
 * new keys are added here + a compatibility mapping below + a
 * `models.<taskKey>` descriptor in the settings registry.
 */
// `smr.live` / `smr.finalize` route the two SMR generation
// flows (live-documentation delta vs. final/comprehensive summary). They are the
// AiTaskDefault-first precedence source for `HarnessPolicyService.resolveSmrSelection`.
// `smr.live.fallback` / `smr.finalize.fallback` are the per-tenant,
// opt-in fallback selections `resolveSmrFallbackSelection` reads (fail-OPEN: no
// row ⇒ no fallback). SMR selection is tenant-admin configurable (NOT in
// `GLOBAL_ADMIN_ONLY_TASK_PREFIXES`).
// `smr.test` routes the tenant-admin prompt-template test
// bench when the caller does not supply an explicit provider/model pair;
// `PromptManagementService.callSmrGenerate` falls back to `smr.finalize` when
// `smr.test` is unconfigured for the tenant.
// additive keys moving the last env-selected surfaces into the DB
// control plane: `guardrail.safety` (GLiNER content-safety detector),
// `guardrail.groundedness` (MiniCheck NLI fact-checker), `harness.judge`
// (LLM-as-judge), and `nlp.diagnosis` (the diagnosis suggester, split out of
// the mis-keyed `nlp.classification` doc-type classifier).
// TASK-729: `nlp.sentiment` / `nlp.toxicity` — two more FIXED-taxonomy
// classification tasks served by the SAME generic `/classify/text` endpoint
// (model-agnostic already; see apps/nlp/src/nlp/api/v1/rest/classify.py).
// No new Python endpoint — only these two AiTaskDefault keys. Global-admin-only,
// consistent with every other `nlp.*` key.
// `vlm.extract`  routes SMR's vision capability (image → text
// extraction via a vision-language model). It lives in SMR's own
// provider/adapter framework — same governance class as `smr.*` — so it is
// tenant-admin configurable, NOT under `GLOBAL_ADMIN_ONLY_TASK_PREFIXES`.
export const AI_TASK_KEYS = [
  'guardrail.validate',
  'guardrail.safety',
  'guardrail.groundedness',
  'nlp.ner',
  'nlp.classification',
  'nlp.diagnosis',
  'nlp.sentiment',
  'nlp.toxicity',
  'smr.live',
  'smr.finalize',
  'smr.live.fallback',
  'smr.finalize.fallback',
  'smr.test',
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
  'nlp.ner': ModelTaskType.TOKEN_CLASSIFICATION,
  'nlp.classification': ModelTaskType.TEXT_CLASSIFICATION,
  // diagnosis suggester (symptom→disease text classification).
  'nlp.diagnosis': ModelTaskType.TEXT_CLASSIFICATION,
  // TASK-729: sentiment / toxicity classifiers reuse the SAME generic
  // /classify/text path as nlp.classification/nlp.diagnosis — same task type.
  'nlp.sentiment': ModelTaskType.TEXT_CLASSIFICATION,
  'nlp.toxicity': ModelTaskType.TEXT_CLASSIFICATION,
  // SMR generation models are text-generation models in the registry.
  'smr.live': ModelTaskType.TEXT_GENERATION,
  'smr.finalize': ModelTaskType.TEXT_GENERATION,
  // per-tenant SMR fallback selections — same task type.
  'smr.live.fallback': ModelTaskType.TEXT_GENERATION,
  'smr.finalize.fallback': ModelTaskType.TEXT_GENERATION,
  // prompt-template test-bench routing — same task type.
  'smr.test': ModelTaskType.TEXT_GENERATION,
  // the harness LLM-as-judge is a text-generation model.
  'harness.judge': ModelTaskType.TEXT_GENERATION,
  // vision extraction — image + text in, text out.
  'vlm.extract': ModelTaskType.IMAGE_TEXT_TO_TEXT,
};

/**
 * Task-key prefixes whose writes AND effective resolution are GLOBAL-ADMIN-ONLY
 * (a privilege boundary → 403 on write, NOT the 404-over-403 cross-tenant posture).
 * Runtime reads ignore per-tenant override rows and use the SYSTEM row only
 * (tenants may only *use* platform defaults for these surfaces).
 * - `nlp.`
 * - `harness.`
 *
 * NOTE: `smr.` is intentionally NOT here. SMR summarization model
 * selection — primary (`smr.live` / `smr.finalize`) AND per-tenant fallback
 * (`smr.<task>.fallback`) — is tenant-admin configurable: `getEffective`
 * honours per-tenant override rows and `upsertRow` permits tenant writes.
 *
 * `guardrail.` was REMOVED here by owner decision 2026-08-16 (TASK-735 Phase
 * 0), reversing the 2026-07-17 global-admin-only directive: guardrail
 * selection is now tenant-admin configurable via the SAME cascade as `smr.*`
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
export const GLOBAL_ADMIN_ONLY_TASK_PREFIXES = ['nlp.', 'harness.'] as const;

/**
 * @deprecated Use {@link GLOBAL_ADMIN_ONLY_TASK_PREFIXES}. Retained for
 * back-compat with zero production callers (verified 2026-08-16, TASK-735).
 * Historically pinned to `'guardrail.'`; guardrail left the global-admin-only
 * set in TASK-735 Phase 0, so that value would now be actively wrong. Aliased
 * to the first remaining locked prefix instead of a stale literal.
 */
export const GLOBAL_ADMIN_ONLY_TASK_PREFIX = GLOBAL_ADMIN_ONLY_TASK_PREFIXES[0];

/** True when `taskKey` is under a SUPER_ADMIN-only prefix. */
export function isGlobalAdminOnlyTaskKey(taskKey: string): boolean {
  return GLOBAL_ADMIN_ONLY_TASK_PREFIXES.some((p) => taskKey.startsWith(p));
}

/**
 * Task-key prefix for the guardrail safety-engine keys
 * (`guardrail.validate` / `guardrail.safety` / `guardrail.groundedness`).
 * `guardrail.` is tenant-configurable (see {@link GLOBAL_ADMIN_ONLY_TASK_PREFIXES}
 * doc), but `AiTaskDefaultService.upsertRow` still layers the D2 tighten-only
 * platform floor on it via {@link isGuardrailTaskKey}.
 */
export const GUARDRAIL_TASK_PREFIX = 'guardrail.';

/** True when `taskKey` is a `guardrail.*` key (the D2 platform-floor gate applies). */
export function isGuardrailTaskKey(taskKey: string): boolean {
  return taskKey.startsWith(GUARDRAIL_TASK_PREFIX);
}
