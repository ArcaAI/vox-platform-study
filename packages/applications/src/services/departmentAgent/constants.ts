/**
 * DepartmentAgent — shared constants.
 */

/**
 * The tenant-tier HarnessPolicy keys a DepartmentAgent's `harnessOverrides`
 * JSONB may carry. Everything else on HarnessPolicy is
 * `SUPER_ADMIN_ONLY_POLICY_KEYS` (see
 * `harness-policy/harness-policy.service.ts`) and MUST NOT appear in an agent's
 * overrides — a tenant admin editing an agent may only nudge the tenant-tier
 * knobs (the 5 assurance-sensor thresholds + the 4 pipeline-shape knobs).
 *
 * Exported so (harness-override CONSUMPTION) reuses the exact same
 * allow-list rather than re-deriving it.
 */
export const TENANT_TIER_HARNESS_OVERRIDE_KEYS = [
  // 5 assurance-sensor thresholds
  'entityFaithfulnessThreshold',
  'coverageThreshold',
  'citationPresenceThreshold',
  'numericDoseThreshold',
  'groundednessThreshold',
  // tenant-tier pipeline-shape knobs
  'maxRegen',
  'gateSlaSeconds',
  'gateEscalationSeconds',
  'toolAllowlist',
] as const;

export type TenantTierHarnessOverrideKey = (typeof TENANT_TIER_HARNESS_OVERRIDE_KEYS)[number];

const ALLOWED_KEY_SET: ReadonlySet<string> = new Set(TENANT_TIER_HARNESS_OVERRIDE_KEYS);

/**
 * Keys present in `overrides` that are NOT tenant-tier-allowed (i.e. would be
 * super-admin-only HarnessPolicy knobs). Empty ⇒ the override set is valid.
 */
export function disallowedHarnessOverrideKeys(overrides: Record<string, unknown>): string[] {
  return Object.keys(overrides).filter((key) => !ALLOWED_KEY_SET.has(key));
}

// =============================================================================
// Live-loop tool plan + per-task LLM override
// =============================================================================

/**
 * The tool keys a DepartmentAgent's `toolConfig.tools` object may name.
 *
 * SINGLE ALLOW-LIST, two consumers: `DepartmentAgentService` validates writes
 * against it (400 on an unknown key), and the `LiveToolRegistry`
 * dispatches reads from it (warn + ignore on an unknown key — the
 * defense-in-depth mirror of `applyAgentOverrides` in the harness policy
 * service). C4 owns the executors; it MUST key them to exactly these names
 * rather than introducing a parallel list.
 *
 *   ner          → the NLP token-classification call that extracts entities
 *   vitals       → the vitals block of that SAME NLP response (filtered off
 *                  when disabled — it is not a second HTTP call)
 *   groundedness → the optional guardrail groundedness check
 */
export const LIVE_TOOL_KEYS = ['ner', 'vitals', 'groundedness'] as const;

export type LiveToolKey = (typeof LIVE_TOOL_KEYS)[number];

const LIVE_TOOL_KEY_SET: ReadonlySet<string> = new Set(LIVE_TOOL_KEYS);

/**
 * The `TextRoutingTask` subset an agent may override. Deliberately NOT one
 * global field: a low-latency live model must never silently drive
 * finalize, so the override is keyed per task and each key falls back
 * independently to the tenant's `AiTaskDefault` (`smr.live` / `smr.finalize`).
 */
export const AGENT_LLM_OVERRIDE_TASKS = ['live', 'finalize'] as const;

export type AgentLlmOverrideTask = (typeof AGENT_LLM_OVERRIDE_TASKS)[number];

const LLM_OVERRIDE_TASK_SET: ReadonlySet<string> = new Set(AGENT_LLM_OVERRIDE_TASKS);

/**
 * Structural validation of a `toolConfig` JSONB payload. Returns the list of
 * problems; empty ⇒ valid. Shape:
 *
 *   { version: 1, tools: { ner: { enabled: true }, groundedness: { enabled: null } } }
 *
 * `version` is the schema-evolution anchor so a later model-initiated mode can
 * arrive without a migration. `enabled: null` means "follow the platform/env
 * default" and is distinct from `false`.
 */
export function toolConfigProblems(toolConfig: Record<string, unknown>): string[] {
  const problems: string[] = [];

  const version = toolConfig.version;
  if (version !== undefined && version !== 1) {
    problems.push(`toolConfig.version must be 1 (got ${JSON.stringify(version)})`);
  }

  // Checked BEFORE the `tools`-absent early return: a payload that carries only
  // an unknown top-level key (e.g. a future `mode` a client sent too early) must
  // still be rejected rather than silently accepted and ignored.
  const unknownTop = Object.keys(toolConfig).filter((key) => key !== 'version' && key !== 'tools');
  if (unknownTop.length > 0) {
    problems.push(`toolConfig contains unknown key(s): ${unknownTop.join(', ')}`);
  }

  const tools = toolConfig.tools;
  if (tools === undefined || tools === null) return problems;
  if (typeof tools !== 'object' || Array.isArray(tools)) {
    problems.push('toolConfig.tools must be an object keyed by tool name');
    return problems;
  }

  for (const [key, value] of Object.entries(tools as Record<string, unknown>)) {
    if (!LIVE_TOOL_KEY_SET.has(key)) {
      problems.push(`toolConfig.tools contains an unknown tool '${key}' (allowed: ${LIVE_TOOL_KEYS.join(', ')})`);
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      problems.push(`toolConfig.tools.${key} must be an object`);
      continue;
    }
    const enabled = (value as Record<string, unknown>).enabled;
    if (enabled !== undefined && enabled !== null && typeof enabled !== 'boolean') {
      problems.push(`toolConfig.tools.${key}.enabled must be a boolean or null`);
    }
  }

  return problems;
}

/**
 * Structural validation of an `llmOverrides` JSONB payload, plus the model
 * slugs it names (so the caller can verify them against ENABLED
 * TEXT_GENERATION `AiModel` rows). Shape:
 *
 *   { live?: { aiModelSlug }, finalize?: { aiModelSlug } }
 */
export function llmOverridesProblems(llmOverrides: Record<string, unknown>): { problems: string[]; slugs: string[] } {
  const problems: string[] = [];
  const slugs: string[] = [];

  for (const [task, value] of Object.entries(llmOverrides)) {
    if (!LLM_OVERRIDE_TASK_SET.has(task)) {
      problems.push(`llmOverrides contains an unknown task '${task}' (allowed: ${AGENT_LLM_OVERRIDE_TASKS.join(', ')})`);
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      problems.push(`llmOverrides.${task} must be an object`);
      continue;
    }
    const slug = (value as Record<string, unknown>).aiModelSlug;
    if (typeof slug !== 'string' || slug.trim().length === 0) {
      problems.push(`llmOverrides.${task}.aiModelSlug is required and must be a non-empty string`);
      continue;
    }
    const unknownKeys = Object.keys(value as Record<string, unknown>).filter((key) => key !== 'aiModelSlug');
    if (unknownKeys.length > 0) {
      problems.push(`llmOverrides.${task} contains unknown key(s): ${unknownKeys.join(', ')}`);
    }
    slugs.push(slug);
  }

  return { problems, slugs };
}

// =============================================================================
// Loop configuration + promotion surface
// =============================================================================

/**
 * Grammar for a kind/output key referenced by `subscribedKinds`/`writeScope`.
 * Mirrors `CONTEXT_KIND_KEY_PATTERN` in
 * `consultation-context-schema/context-schema-definition.ts` — kept as an
 * independent constant (not imported) so this module's structural validators
 * stay self-contained pure functions with no cross-service dependency; the
 * grammar itself is a platform-wide convention, not 's alone.
 */
export const AGENT_KIND_KEY_PATTERN = /^[a-z0-9_]{2,48}$/;

/**
 * Structural validation of a `subscribedKinds` JSONB payload. Returns the
 * structural problems plus the referenced kind keys, so the caller can
 * cross-check them against the department's resolved context schema (the
 * repository-backed half lives in the service, not here — this function never
 * throws and never does I/O). Shape:
 *
 *   { version: 1, kinds: [{ key: "referral_letter", filter?: {...} }] }
 */
export function subscribedKindsProblems(value: Record<string, unknown>): { problems: string[]; kindKeys: string[] } {
  const problems: string[] = [];
  const kindKeys: string[] = [];

  const version = value.version;
  if (version !== undefined && version !== 1) {
    problems.push(`subscribedKinds.version must be 1 (got ${JSON.stringify(version)})`);
  }

  const unknownTop = Object.keys(value).filter((key) => key !== 'version' && key !== 'kinds');
  if (unknownTop.length > 0) {
    problems.push(`subscribedKinds contains unknown key(s): ${unknownTop.join(', ')}`);
  }

  const kinds = value.kinds;
  if (kinds === undefined) return { problems, kindKeys };
  if (!Array.isArray(kinds)) {
    problems.push('subscribedKinds.kinds must be an array');
    return { problems, kindKeys };
  }

  const seen = new Set<string>();
  kinds.forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`subscribedKinds.kinds[${index}] must be an object`);
      return;
    }
    const record = entry as Record<string, unknown>;
    const unknownEntryKeys = Object.keys(record).filter((key) => key !== 'key' && key !== 'filter');
    if (unknownEntryKeys.length > 0) {
      problems.push(`subscribedKinds.kinds[${index}] contains unknown key(s): ${unknownEntryKeys.join(', ')}`);
    }
    const key = record.key;
    if (typeof key !== 'string' || !AGENT_KIND_KEY_PATTERN.test(key)) {
      problems.push(`subscribedKinds.kinds[${index}].key must match ${AGENT_KIND_KEY_PATTERN.source}`);
    } else if (seen.has(key)) {
      problems.push(`subscribedKinds.kinds[${index}].key: duplicate kind '${key}'`);
    } else {
      seen.add(key);
      kindKeys.push(key);
    }
    if (record.filter !== undefined && (record.filter === null || typeof record.filter !== 'object' || Array.isArray(record.filter))) {
      problems.push(`subscribedKinds.kinds[${index}].filter must be an object when present`);
    }
  });

  return { problems, kindKeys };
}

/**
 * Structural validation of a `writeScope` JSONB payload. Shape:
 *
 *   { version: 1, outputs: ["soap_note"] }
 */
export function writeScopeProblems(value: Record<string, unknown>): { problems: string[]; outputKeys: string[] } {
  const problems: string[] = [];
  const outputKeys: string[] = [];

  const version = value.version;
  if (version !== undefined && version !== 1) {
    problems.push(`writeScope.version must be 1 (got ${JSON.stringify(version)})`);
  }

  const unknownTop = Object.keys(value).filter((key) => key !== 'version' && key !== 'outputs');
  if (unknownTop.length > 0) {
    problems.push(`writeScope contains unknown key(s): ${unknownTop.join(', ')}`);
  }

  const outputs = value.outputs;
  if (outputs === undefined) return { problems, outputKeys };
  if (!Array.isArray(outputs)) {
    problems.push('writeScope.outputs must be an array');
    return { problems, outputKeys };
  }

  const seen = new Set<string>();
  outputs.forEach((entry, index) => {
    if (typeof entry !== 'string' || !AGENT_KIND_KEY_PATTERN.test(entry)) {
      problems.push(`writeScope.outputs[${index}] must match ${AGENT_KIND_KEY_PATTERN.source}`);
      return;
    }
    if (seen.has(entry)) {
      problems.push(`writeScope.outputs[${index}]: duplicate output '${entry}'`);
      return;
    }
    seen.add(entry);
    outputKeys.push(entry);
  });

  return { problems, outputKeys };
}

/**
 * Closed catalogue of named guardrail profiles a DepartmentAgent may select
 * placement, not permission — the actual clinical-safety
 * enforcement runs at a boundary the agent cannot route around; this field
 * only SELECTS which profile that boundary applies.
 */
export const GUARDRAIL_PROFILE_KEYS = ['STANDARD', 'STRICT', 'RELAXED'] as const;

export type GuardrailProfileKey = (typeof GUARDRAIL_PROFILE_KEYS)[number];

const GUARDRAIL_PROFILE_KEY_SET: ReadonlySet<string> = new Set(GUARDRAIL_PROFILE_KEYS);

export function guardrailProfileProblems(value: string): string[] {
  if (!GUARDRAIL_PROFILE_KEY_SET.has(value)) {
    return [`guardrailProfile must be one of ${GUARDRAIL_PROFILE_KEYS.join(', ')} (got '${value}')`];
  }
  return [];
}

/**
 * The action registry names 's `ConsultationLoopWorkflow` will
 * dispatch — `alwaysActions`/`neverActions` (D11's compliance
 * envelope) may name only these.
 */
export const AGENT_ACTION_KEYS = [
  'livedoc.start',
  'livedoc.stop',
  'vision.extract_text',
  'document.extract_text',
  'nlp.extract_entities',
  'harness.finalize',
  'client.emit',
] as const;

export type AgentActionKey = (typeof AGENT_ACTION_KEYS)[number];

const AGENT_ACTION_KEY_SET: ReadonlySet<string> = new Set(AGENT_ACTION_KEYS);

/**
 * Structural validation of an `alwaysActions`/`neverActions` array: every
 * entry must be a known action key, a string, and non-duplicate.
 */
export function actionListProblems(value: unknown[], field: 'alwaysActions' | 'neverActions'): string[] {
  const problems: string[] = [];
  const seen = new Set<unknown>();
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || !AGENT_ACTION_KEY_SET.has(entry)) {
      problems.push(`${field}[${index}] must be one of ${AGENT_ACTION_KEYS.join(', ')} (got ${JSON.stringify(entry)})`);
      return;
    }
    if (seen.has(entry)) {
      problems.push(`${field}[${index}]: duplicate action '${entry}'`);
      return;
    }
    seen.add(entry);
  });
  return problems;
}

/**
 * The compliance envelope's one cross-field rule: an action cannot be both
 * mandatory and forbidden at once.
 */
export function actionOverlapProblems(always: unknown[] | undefined | null, never: unknown[] | undefined | null): string[] {
  if (!always || !never) return [];
  const alwaysSet = new Set(always.filter((v): v is string => typeof v === 'string'));
  const overlap = never.filter((v): v is string => typeof v === 'string' && alwaysSet.has(v));
  if (overlap.length === 0) return [];
  return [`the following action(s) appear in both alwaysActions and neverActions: ${overlap.join(', ')}`];
}

/**
 * Structural validation of a `goal` JSONB payload — a CONSTRAINED goal
 * statement, deliberately NOT a free-text system prompt: a
 * short, length-capped objective plus optional bounded success criteria. Free-
 * text prompt authoring stays where it already is — the approval-gated
 * PromptTemplate bound via `promptTemplateId`. Shape:
 *
 *   { version: 1, objective: "...", successCriteria?: ["..."] }
 */
const GOAL_OBJECTIVE_MAX_LENGTH = 280;
const GOAL_SUCCESS_CRITERION_MAX_LENGTH = 200;
const GOAL_MAX_SUCCESS_CRITERIA = 10;

export function goalProblems(value: Record<string, unknown>): string[] {
  const problems: string[] = [];

  const version = value.version;
  if (version !== undefined && version !== 1) {
    problems.push(`goal.version must be 1 (got ${JSON.stringify(version)})`);
  }

  const unknownTop = Object.keys(value).filter((key) => key !== 'version' && key !== 'objective' && key !== 'successCriteria');
  if (unknownTop.length > 0) {
    problems.push(`goal contains unknown key(s): ${unknownTop.join(', ')}`);
  }

  const objective = value.objective;
  if (typeof objective !== 'string' || objective.trim().length === 0 || objective.length > GOAL_OBJECTIVE_MAX_LENGTH) {
    problems.push(`goal.objective is required and must be a non-empty string of at most ${GOAL_OBJECTIVE_MAX_LENGTH} characters`);
  }

  const successCriteria = value.successCriteria;
  if (successCriteria !== undefined) {
    if (!Array.isArray(successCriteria)) {
      problems.push('goal.successCriteria must be an array when present');
    } else {
      if (successCriteria.length > GOAL_MAX_SUCCESS_CRITERIA) {
        problems.push(`goal.successCriteria must not exceed ${GOAL_MAX_SUCCESS_CRITERIA} entries`);
      }
      successCriteria.forEach((entry, index) => {
        if (typeof entry !== 'string' || entry.trim().length === 0 || entry.length > GOAL_SUCCESS_CRITERION_MAX_LENGTH) {
          problems.push(`goal.successCriteria[${index}] must be a non-empty string of at most ${GOAL_SUCCESS_CRITERION_MAX_LENGTH} characters`);
        }
      });
    }
  }

  return problems;
}

// ===========================================================================
// Loop-config snapshot + checksum (shared with )
// ===========================================================================

/**
 * The seven loop-config fields, as a STRUCTURAL type rather than the entity.
 * `DepartmentAgentEntity` satisfies it, and so does a `configSnapshot` read
 * back off a `DepartmentAgentVersion` — which is the whole point: promotion
 *  checksums a snapshot it read from the version table, never a live
 * entity. Keeping the shape structural also keeps this module dependency-free,
 * as every other validator in it is.
 */
export interface AgentLoopConfig {
  role: string;
  subscribedKinds?: Record<string, unknown> | null;
  writeScope?: Record<string, unknown> | null;
  goal?: Record<string, unknown> | null;
  guardrailProfile?: string | null;
  alwaysActions?: string[] | null;
  neverActions?: string[] | null;
}

/**
 * Deterministic (key-sorted, array-order-preserved) serialization for the
 * loop-config checksum — the same shape as `context-schema-definition.ts`'s
 * `canonicalJson`.
 *
 * This USED to be a module-private copy inside `departmentAgent.service.ts`,
 * consistent with this codebase's habit of keeping such canonicalisers
 * deliberately separate per file. moved it here because promotion
 * introduces a requirement the earlier copies did not have: the checksum
 * `DepartmentAgentService` writes onto a `DepartmentAgentVersion` and the
 * checksum `AgentPromotionService` writes onto an `AgentPromotion` MUST agree,
 * or drift detection compares the output of two different functions and is
 * wrong by construction. That is a correctness coupling, not a stylistic one,
 * so the two share one implementation.
 */
export function canonicalAgentConfigJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalAgentConfigJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalAgentConfigJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The seven loop-config fields, snapshotted verbatim and normalised to null. */
export function buildLoopConfigSnapshot(config: AgentLoopConfig): Record<string, unknown> {
  return {
    role: config.role,
    subscribedKinds: config.subscribedKinds ?? null,
    writeScope: config.writeScope ?? null,
    goal: config.goal ?? null,
    guardrailProfile: config.guardrailProfile ?? null,
    alwaysActions: config.alwaysActions ?? null,
    neverActions: config.neverActions ?? null,
  };
}

/**
 * True when the config actually configures the loop surface — `SPECIALIST` +
 * all-null is "nothing configured", which is every agent in the catalogue that
 * has never touched this surface.
 */
export function hasLoopConfig(snapshot: Record<string, unknown>): boolean {
  return (
    snapshot.role !== 'SPECIALIST' ||
    snapshot.subscribedKinds !== null ||
    snapshot.writeScope !== null ||
    snapshot.goal !== null ||
    snapshot.guardrailProfile !== null ||
    (Array.isArray(snapshot.alwaysActions) && snapshot.alwaysActions.length > 0) ||
    (Array.isArray(snapshot.neverActions) && snapshot.neverActions.length > 0)
  );
}
