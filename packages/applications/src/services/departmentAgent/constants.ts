/**
 * DepartmentAgent — shared constants (TASK-546).
 */

/**
 * The tenant-tier HarnessPolicy keys a DepartmentAgent's `harnessOverrides`
 * JSONB may carry. Everything else on HarnessPolicy is
 * `GLOBAL_ADMIN_ONLY_POLICY_KEYS` (see
 * `harness-policy/harness-policy.service.ts`) and MUST NOT appear in an agent's
 * overrides — a tenant admin editing an agent may only nudge the tenant-tier
 * knobs (the 5 assurance-sensor thresholds + the 4 pipeline-shape knobs).
 *
 * Exported so TASK-550 (harness-override CONSUMPTION) reuses the exact same
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
 * global-admin-only HarnessPolicy knobs). Empty ⇒ the override set is valid.
 */
export function disallowedHarnessOverrideKeys(overrides: Record<string, unknown>): string[] {
  return Object.keys(overrides).filter((key) => !ALLOWED_KEY_SET.has(key));
}

// =============================================================================
// TASK-635 RF-4 — live-loop tool plan + per-task LLM override
// =============================================================================

/**
 * The tool keys a DepartmentAgent's `toolConfig.tools` object may name.
 *
 * SINGLE ALLOW-LIST, two consumers: `DepartmentAgentService` validates writes
 * against it (400 on an unknown key), and the `LiveToolRegistry` (TASK-635 C4)
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
 * The `SmrRoutingTask` subset an agent may override. Deliberately NOT one
 * global field (RF-4): a low-latency live model must never silently drive
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
