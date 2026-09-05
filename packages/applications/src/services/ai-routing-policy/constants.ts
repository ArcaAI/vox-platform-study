import { AiTaskKind } from '@arcaai/domains';

/**
 * The AI tasks whose provider + model are selected through `AiRoutingPolicy`
 * rows — the ELECTED default (`isDefault`) of the winning tier, resolved
 * request tenant → SYSTEM by `AiRoutingPolicyService.resolveDefault`.
 *
 * TASK-881 re-homed this vocabulary from the retired `AiTaskDefault` facade
 * and REMOVED the five `text.*` keys (`text.live`, `text.finalize`,
 * `text.test` and the two `.fallback` variants): text generation selects
 * through the tenant's assigned `TEXT_GENERATION` agent (TASK-876), so a
 * routing key for it had nothing left to select. The `text.live` /
 * `text.finalize` / `text.test` strings survive elsewhere ONLY as a workflow
 * node's `taskKey` config — a prompt-binding and telemetry role, never a
 * selector.
 *
 * Extensible: a new key is added here AND classified in
 * {@link AI_TASK_KIND_BY_TASK_KEY} (the `Record<AiTaskKey, …>` makes forgetting
 * a compile error), then seeded as a SYSTEM election in
 * `seed/16-ai-routing-policy.ts` or recorded in its exemption list.
 *
 * Per key:
 *   - `guardrail.validate` — the guardian LLM (medical validation screen).
 *   - `guardrail.safety` — the GLiGuard content-safety detector.
 *   - `guardrail.groundedness` — the MiniCheck NLI fact-checker.
 *   - `guardrail.pii` / `guardrail.pii.spans` — the PII redaction selections
 *     guardrail's own SQL resolves (`core/tenant_config.py`).
 *   - `nlp.ner` — clinical NER (`/classify/tokens`).
 *   - `nlp.classification` / `nlp.diagnosis` / `nlp.sentiment` /
 *     `nlp.toxicity` — the FIXED-taxonomy classifiers served by the same
 *     generic `/classify/text` path.
 *   - `harness.judge` — the LLM-as-judge.
 *   - `vlm.extract` — TEXT's vision capability (image → text). No deployable
 *     vision model is loaded; it stays vocabulary because the seed exemption
 *     records that open owner decision.
 */
export const AI_TASK_KEYS = [
  'guardrail.validate',
  'guardrail.safety',
  'guardrail.groundedness',
  'guardrail.pii',
  'guardrail.pii.spans',
  'nlp.ner',
  'nlp.classification',
  'nlp.diagnosis',
  'nlp.sentiment',
  'nlp.toxicity',
  'harness.judge',
  'vlm.extract',
] as const;

export type AiTaskKey = (typeof AI_TASK_KEYS)[number];

/**
 * taskKey → the CANONICAL TASK TAXONOMY the key belongs to.
 *
 * This is the mapping `AiRoutingPolicy.taskKind` is derived from — DERIVED at
 * write time, never taken from a request, so the two axes cannot drift. The
 * SQL `CASE` in the `task_843_ai_task_taxonomy` migration was its twin at the
 * time; `ai-task-kind.test.ts` reads that migration and fails if the surviving
 * keys disagree.
 *
 * The taxonomy is COARSER than the key vocabulary by design (four `nlp.*`
 * classifiers share one kind), so a "one default per task" constraint keys on
 * `taskKey`, never on `taskKind` alone.
 */
export const AI_TASK_KIND_BY_TASK_KEY: Record<AiTaskKey, AiTaskKind> = {
  // Safety moderation — `guardrail.validate` is the granite-guardian screen,
  // `guardrail.safety` the GLiGuard moderation head. Same task, two models.
  'guardrail.validate': AiTaskKind.CONTENT_SAFETY,
  'guardrail.safety': AiTaskKind.CONTENT_SAFETY,
  // NLI/entailment fact-checking is its own task, not a generic classification:
  // it scores a claim AGAINST a source, and no other key does that.
  'guardrail.groundedness': AiTaskKind.GROUNDEDNESS,
  // PII span extraction. Distinct from NER despite sharing
  // `ModelTaskType.TOKEN_CLASSIFICATION` — different models, and PII redaction
  // is a PHI control with platform-shared (never BYO) selection.
  'guardrail.pii': AiTaskKind.PII_DETECTION,
  'guardrail.pii.spans': AiTaskKind.PII_DETECTION,
  'nlp.ner': AiTaskKind.NAMED_ENTITY_RECOGNITION,
  // The four keys served by the same generic `/classify/text` path.
  'nlp.classification': AiTaskKind.TEXT_CLASSIFICATION,
  'nlp.diagnosis': AiTaskKind.TEXT_CLASSIFICATION,
  'nlp.sentiment': AiTaskKind.TEXT_CLASSIFICATION,
  'nlp.toxicity': AiTaskKind.TEXT_CLASSIFICATION,
  // The generation plane's only routing key: a text-generation model doing
  // LLM-as-judge.
  'harness.judge': AiTaskKind.TEXT_GENERATION,
  // Image + text in, text out. Not TEXT_GENERATION: the binding needs a vision
  // model, and a text-only provider cannot serve it.
  'vlm.extract': AiTaskKind.VISION_EXTRACTION,
};

/**
 * Task keys that carry a kind but live OUTSIDE `AI_TASK_KEYS`.
 *
 * `nlp.topic` / `nlp.intent` are declared in
 * `tenant-nlp-task-instructions/constants.ts` as instruction-CONTENT keys;
 * their MODEL selection is a pre-existing governance gap `assertKnownTaskKey`
 * still rejects. Classifying them here keeps the taxonomy honest without
 * widening `AI_TASK_KEYS`, which is an owner-facing decision about who may
 * configure them.
 */
const AI_TASK_KIND_BY_UNREGISTERED_TASK_KEY: Readonly<Record<string, AiTaskKind>> = {
  'nlp.topic': AiTaskKind.TEXT_CLASSIFICATION,
  'nlp.intent': AiTaskKind.TEXT_CLASSIFICATION,
};

/**
 * The canonical task kind for `taskKey`, or `null` when the key is unknown.
 *
 * Returns `null` rather than guessing: provider/model selection is
 * `failMode: 'closed'` platform-wide, so "nobody classified this" must stay
 * distinguishable from "classified as X".
 */
export function resolveAiTaskKind(taskKey: string): AiTaskKind | null {
  return (AI_TASK_KIND_BY_TASK_KEY as Record<string, AiTaskKind>)[taskKey] ?? AI_TASK_KIND_BY_UNREGISTERED_TASK_KEY[taskKey] ?? null;
}

/**
 * Task-key prefixes whose selection is PLATFORM-ONLY: writes are super-admin
 * only (every `AiRoutingPolicy` write already is), and the runtime READ pins
 * to the SYSTEM tier — a tenant row for one of these never wins and never
 * vetoes (`ResolveDefaultOptions.systemOnly`). Tenants only USE the platform
 * default for these surfaces.
 *
 * - `nlp.` and `harness.` — the platform's own inference and judgement.
 * - `guardrail.` — owner decision #3 of 2026-09-05 (TASK-872): guardrail is
 *   built-in and platform-only. It gates every text-generation request before
 *   send and every response after receive, for built-in and BYO providers
 *   alike, so which model does the gating is a property of the PLATFORM's
 *   safety plane and not a tenant's choice of vendor.
 *
 * `vlm.extract` is deliberately NOT here — it lives in TEXT's own adapter
 * framework, the same governance class the tenant-configurable `text.*` keys
 * had before TASK-876 moved text selection onto the agent.
 */
export const SUPER_ADMIN_ONLY_TASK_PREFIXES = ['nlp.', 'harness.', 'guardrail.'] as const;

/**
 * SUPER_ADMIN-only task keys that do NOT follow a locked PREFIX.
 *
 * EMPTY since TASK-872 and deliberately RETAINED: the shape it expresses (a
 * key-level lock inside an otherwise open prefix) recurs, and adding one here
 * is a one-line change where re-deriving the mechanism is not.
 */
export const SUPER_ADMIN_ONLY_TASK_KEYS: readonly string[] = [];

/**
 * True when `taskKey` is platform-only — by locked PREFIX, or by explicit KEY
 * for the exceptions a prefix cannot express.
 *
 * The single predicate every SYSTEM-only reader pins with
 * (`resolveDefault(…, { systemOnly: isSuperAdminOnlyTaskKey(key) })`), so one
 * edit here reaches all of them.
 */
export function isSuperAdminOnlyTaskKey(taskKey: string): boolean {
  return SUPER_ADMIN_ONLY_TASK_PREFIXES.some((p) => taskKey.startsWith(p)) || SUPER_ADMIN_ONLY_TASK_KEYS.includes(taskKey);
}
