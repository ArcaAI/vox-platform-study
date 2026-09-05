// AI task-model default descriptors.
//
// One `models.<taskKey>` descriptor per `AiTaskDefault` task key that a request
// path actually resolves — see `UNCATALOGUED_TASK_KEYS` below for the five that
// TASK-872 excluded and why. The value is a registry model slug (dataType
// `string`) living in the dedicated `AiTaskDefault` table (tier `db-config`,
// tenant → SYSTEM cascade resolved by `AiTaskDefaultService.getEffective`).
//
// Governance: `nlp.*`, `harness.*` and — since owner decision #3 of
// 2026-09-05 (TASK-872) — `guardrail.*` keys are SUPER_ADMIN-ONLY.
// `editableBy` points at the super-admin resource (`'all'`, the CASL
// manage-everything subject) and the descriptor is flagged `globalOnly`.
//
// That reverses the 2026-08-16 decision this file used to record. The reason
// is stated positively rather than as a swing: guardrail is BUILT-IN and
// PLATFORM-ONLY. It gates every text-generation request before send and every
// response after receive, for built-in and BYO providers alike, so no tenant
// admin manages any guardrail setting — including which model does the
// gating. Only `text.*` and `vlm.*` remain tenant-admin configurable: their
// descriptors resolve to the tenant-editable `AiTaskDefault` resource and are
// NOT flagged `globalOnly`.
//
// One predicate decides all of it — `isSuperAdminOnlyTaskKey`
// (`ai-task-default/constants.ts`) — so the catalog, the write gate and the
// runtime read resolution can never disagree about who owns a key. The D2
// platform-approved-list floor in `AiTaskDefaultService.upsertRow` is
// unchanged and still layered on top: it bounds WHICH slug may be bound, not
// WHO may bind it.

import { AI_TASK_KEYS, AiTaskKey, isSuperAdminOnlyTaskKey } from '../../ai-task-default/constants';
import { SettingDescriptor } from '../registry.types';

/**
 * Task keys that get NO `models.<taskKey>` descriptor (TASK-872).
 *
 * A `models.*` descriptor offers an admin a SELECTION control on the settings
 * surface. For these five there is nothing on the other end of it: no request
 * path resolves the key, so a value written here would be stored, listed, and
 * never consulted — the failure mode this registry's own fail-closed posture
 * exists to prevent, arriving quietly instead of as a 503.
 *
 * The evidence, per key:
 *   - `guardrail.pii.spans` — guardrail resolves `guardrail.pii` and only that
 *     (`core/dependencies.py` → `TASK_KEY_GUARDRAIL_PII`). The `.spans` variant
 *     has no reader in any service.
 *   - `nlp.classification` — the seed calls its own SYSTEM election "an
 *     explicitly DISABLED placeholder until a real doc-type model is seeded
 *     (fails closed)".
 *   - `nlp.sentiment`, `nlp.toxicity` — `SYSTEM_TASK_DEFAULT_EXEMPTIONS` in the
 *     seed records both as OPEN OWNER DECISIONS: "no checkpoint has been
 *     selected and no gateway route reaches the key".
 *   - `vlm.extract` — same exemption list: "no deployable vision model is
 *     loaded on the LM Studio instance".
 *
 * The TASK KEYS themselves stay in `AI_TASK_KEYS`, deliberately. They are
 * `AiRoutingPolicy` domain vocabulary with their own admin routes, their own
 * OpenAPI enum, their own console catalog and their own seed exemptions
 * recording decisions the owner has not yet made. What is removed is only this
 * registry's claim to be a control surface for them. When a reader appears for
 * one, delete its line here and the descriptor comes back.
 */
const UNCATALOGUED_TASK_KEYS = ['guardrail.pii.spans', 'nlp.classification', 'nlp.sentiment', 'nlp.toxicity', 'vlm.extract'] as const;

type UncataloguedTaskKey = (typeof UNCATALOGUED_TASK_KEYS)[number];
type CataloguedTaskKey = Exclude<AiTaskKey, UncataloguedTaskKey>;

const UNCATALOGUED = new Set<string>(UNCATALOGUED_TASK_KEYS);

const META: Record<CataloguedTaskKey, { label: string; description: string }> = {
  // Tenant-admin configurable since, subject to the
  // platform-approved-list floor (a SYSTEM-tenant AiModel row is required).
  'guardrail.validate': {
    label: 'Guardrail validation model',
    description:
      'Default guardian LLM used by the safety engine for medical validation. Selection is limited to the platform-approved model catalog.',
  },
  'guardrail.safety': {
    label: 'Guardrail safety detector',
    description:
      'Default GLiNER token-classification detector used by the safety engine for content-safety / PII labelling. Selection is limited to the platform-approved model catalog.',
  },
  'guardrail.groundedness': {
    label: 'Guardrail groundedness model',
    description:
      'Default MiniCheck NLI/entailment fact-checker used by the safety engine for groundedness verification. Selection is limited to the platform-approved model catalog.',
  },
  // PII redaction selection. SUPER_ADMIN-only — since owner decision #3 of
  // 2026-09-05 that follows from the locked `guardrail.` prefix, so
  // `superAdminOnly` below resolves true and the descriptor is flagged
  // `globalOnly`, exactly like `nlp.*`. Its `guardrail.pii.spans` sibling is in
  // `UNCATALOGUED_TASK_KEYS`: guardrail resolves this key and never that one.
  'guardrail.pii': {
    label: 'PII redaction model',
    description:
      'Default GLiNER2 span extractor used to detect and redact PII. Platform-wide: one vetted model serves every tenant (super admins only).',
  },
  'nlp.ner': {
    label: 'Medical NER model',
    description: 'Default token-classification model used for medical entity extraction.',
  },
  // diagnosis suggester, split out of the doc-type classifier key.
  'nlp.diagnosis': {
    label: 'Diagnosis suggestion model',
    description: 'Default text-classification model used for symptom→disease diagnosis suggestions (super admins only).',
  },
  // TEXT generation routing (tenant-admin configurable).
  'text.live': {
    label: 'TEXT live-summary model',
    description: 'Default text-generation model for the live-documentation delta summariser.',
  },
  'text.finalize': {
    label: 'TEXT final-summary model',
    description: 'Default text-generation model for the final/comprehensive summary generator.',
  },
  // per-tenant TEXT fallback selections (opt-in). No SYSTEM default;
  // when unset, no fallback runs (`resolveTextFallbackSelection` returns null).
  'text.live.fallback': {
    label: 'TEXT live-summary fallback model',
    description: 'Fallback text-generation model for the live-documentation delta summariser when the primary provider fails.',
  },
  'text.finalize.fallback': {
    label: 'TEXT final-summary fallback model',
    description: 'Fallback text-generation model for the final/comprehensive summary generator when the primary provider fails.',
  },
  // prompt-template test-bench routing (tenant-admin
  // configurable, same governance class as text.live/text.finalize). Consulted
  // only when the caller does not supply an explicit provider/model pair on
  // `POST admin/prompt-templates/:id/test`.: fail-CLOSED when unset
  // for the tenant — there is no `text.finalize` fallback hop (removed
  // deliberately; this comment described behaviour that no longer existed).
  'text.test': {
    label: 'TEXT prompt-test-bench model',
    description: 'Default text-generation model for the tenant-admin prompt-template test bench, when the caller does not select a provider/model.',
  },
  // harness LLM-as-judge model (super admins only).
  'harness.judge': {
    label: 'Harness judge model',
    description: 'Default text-generation model used as the LLM-as-judge by the clinical documentation harness (super admins only).',
  },
};

export const MODEL_DEFAULT_SETTINGS: SettingDescriptor[] = AI_TASK_KEYS.filter(
  (taskKey): taskKey is CataloguedTaskKey => !UNCATALOGUED.has(taskKey),
).map<SettingDescriptor>((taskKey) => {
  // Call the shared predicate rather than re-deriving it from the prefix list:
  // a second copy of the rule is how `SUPER_ADMIN_ONLY_TASK_KEYS` (the
  // key-level exceptions a prefix cannot express) would have been silently
  // dropped here, leaving the descriptor tenant-editable while the service
  // refused the write.
  const superAdminOnly = isSuperAdminOnlyTaskKey(taskKey);
  return {
    key: `models.${taskKey}`,
    tier: 'db-config',
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'tenant',
    editableBy: superAdminOnly ? 'all' : 'AiTaskDefault',
    ...(superAdminOnly ? { globalOnly: true } : {}),
    // Provider/model SELECTION — the canonical fail-closed class.
    // An unselected task must surface as unresolved, never as a null the caller
    // cannot tell apart from a deliberate value, and never as a neighbouring
    // tenant's or a global model. This mirrors guardrail's own posture
    // (`tenant_config.py`: "Selection is DB-only … fail-closed").
    failMode: 'closed',
    category: 'Models',
    label: META[taskKey].label,
    description: META[taskKey].description,
  };
});
