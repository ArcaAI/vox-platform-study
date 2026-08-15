/**
 * pure field catalogues + validators for the Loop config tab
 * (the seven `DepartmentAgent` fields, plus the pre-existing
 * `toolConfig` "Tool allowlist" and a "Budgets" subset of `harnessOverrides`).
 *
 * Every catalogue here MIRRORS an allow-list the server already enforces
 * (`packages/applications/src/services/departmentAgent/constants.ts`) rather
 * than importing it — the console never imports a server package, so this is
 * a client-side reflection kept in sync by hand. The server remains the sole
 * authority; these lists only stop the picker from OFFERING a value the
 * server would reject (D8: constrained fields, not free text).
 */

import type { DepartmentAgentRole, GuardrailProfile } from '../api/types';

/** Mirrors `AGENT_ACTION_KEYS` — the seven action-registry names the loop dispatches. */
export const AGENT_ACTION_KEYS = [
  'livedoc.start',
  'livedoc.stop',
  'vision.extract_text',
  'document.extract_text',
  'nlp.extract_entities',
  'harness.finalize',
  'client.emit',
] as const;

export const AGENT_ACTION_LABELS: Record<(typeof AGENT_ACTION_KEYS)[number], string> = {
  'livedoc.start': 'Start live documentation',
  'livedoc.stop': 'Stop live documentation',
  'vision.extract_text': 'Extract text from an image',
  'document.extract_text': 'Extract text from a document',
  'nlp.extract_entities': 'Extract clinical entities',
  'harness.finalize': 'Finalize the clinical note',
  'client.emit': 'Emit a client event',
};

/**
 * The two action-registry entries that are clinical-safety-relevant for C25
 * purposes: forbidding either via `neverActions` disables a
 * clinical check on this agent's note. `client.emit`/`livedoc.*` are plumbing,
 * not a check.
 */
export const CLINICAL_CHECK_ACTIONS: readonly (typeof AGENT_ACTION_KEYS)[number][] = ['nlp.extract_entities', 'harness.finalize'];

/** Mirrors `GUARDRAIL_PROFILE_KEYS` — the closed catalogue `guardrailProfile` selects from. */
export const GUARDRAIL_PROFILE_KEYS = ['STANDARD', 'STRICT', 'RELAXED'] as const;

export const GUARDRAIL_PROFILE_LABELS: Record<GuardrailProfile, string> = {
  STANDARD: 'Standard',
  STRICT: 'Strict',
  RELAXED: 'Relaxed',
};

/** The weakest profile in the catalogue — transitioning INTO it is the C25 trigger. */
export const WEAKEST_GUARDRAIL_PROFILE: GuardrailProfile = 'RELAXED';

/** Mirrors `LIVE_TOOL_KEYS` — the "Tool allowlist" catalogue (`toolConfig.tools`). */
export const LIVE_TOOL_KEYS = ['ner', 'vitals', 'groundedness'] as const;

export const LIVE_TOOL_LABELS: Record<(typeof LIVE_TOOL_KEYS)[number], string> = {
  ner: 'Named-entity recognition',
  vitals: 'Vitals extraction',
  groundedness: 'Groundedness check',
};

export const AGENT_ROLE_OPTIONS: { value: DepartmentAgentRole; label: string }[] = [
  { value: 'SPECIALIST', label: 'Specialist' },
  { value: 'PRIMARY', label: 'Primary (owns the note)' },
];

/**
 * "Budgets" — the `maxRegen`/`gateSlaSeconds`/`gateEscalationSeconds` subset
 * of `harnessOverrides` (mirrors the "Generation"/"Clinician gate" groups of
 * `harness-policy/components/policy-fields.ts`). Tenant-writable, not
 * global-admin-tier: these are 3 of the "4 pipeline-shape knobs"
 * `TENANT_TIER_HARNESS_OVERRIDE_KEYS` grants a tenant admin on an agent's
 * `harnessOverrides` (`packages/applications/src/services/departmentAgent/
 * constants.ts`), and the SAME keys are tenant-writable on the `HarnessPolicy`
 * resource itself — they are NOT in `SUPER_ADMIN_ONLY_POLICY_KEYS`. An
 * earlier revision of this tab rendered them disabled for a non-elevated
 * caller on the `TENANT_LOCKED_POLICY_KEYS` precedent, which locks a
 * DIFFERENT key set; that was a console guarantee the server never enforced.
 * See the Decisions section.
 */
export const AGENT_BUDGET_FIELDS: { key: 'maxRegen' | 'gateSlaSeconds' | 'gateEscalationSeconds'; label: string }[] = [
  { key: 'maxRegen', label: 'Max regen budget' },
  { key: 'gateSlaSeconds', label: 'Gate SLA (seconds)' },
  { key: 'gateEscalationSeconds', label: 'Gate escalation (seconds)' },
];

/** C25 — the exact phrase a caller must type to arm the weakening-acknowledgement confirm button. */
export const C25_CONFIRM_PHRASE = 'WEAKEN';

const GOAL_OBJECTIVE_MAX_LENGTH = 280;
const GOAL_SUCCESS_CRITERION_MAX_LENGTH = 200;
export const GOAL_MAX_SUCCESS_CRITERIA = 10;

/** Mirrors `goalProblems`'s objective check. Returns a single message, or null when valid. */
export function goalObjectiveProblem(objective: string): string | null {
  const trimmed = objective.trim();
  if (trimmed.length === 0) return 'An objective is required.';
  if (objective.length > GOAL_OBJECTIVE_MAX_LENGTH) return `Objective must be at most ${GOAL_OBJECTIVE_MAX_LENGTH} characters.`;
  return null;
}

/** Mirrors `goalProblems`'s per-criterion check. */
export function goalSuccessCriterionProblem(criterion: string): string | null {
  const trimmed = criterion.trim();
  if (trimmed.length === 0) return 'A success criterion cannot be empty.';
  if (criterion.length > GOAL_SUCCESS_CRITERION_MAX_LENGTH) return `Success criteria must be at most ${GOAL_SUCCESS_CRITERION_MAX_LENGTH} characters.`;
  return null;
}

/** Mirrors `actionOverlapProblems` — every action present in both lists. */
export function actionOverlap(always: string[], never: string[]): string[] {
  const alwaysSet = new Set(always);
  return never.filter((action) => alwaysSet.has(action));
}

/**
 * C25 — does this pending edit disable a clinical check?
 * Returns human-readable reasons; empty ⇒ no acknowledgement needed. Two
 * triggers, both grounded in what this ticket's seven fields can actually
 * express:
 *   1. `guardrailProfile` transitions INTO the weakest catalogue entry
 *      (RELAXED) — D9's enforcement boundary is placed elsewhere, but
 *      SELECTING the weaker profile is still the tenant admin's act.
 *   2. A clinical-safety action (`nlp.extract_entities`, `harness.finalize`)
 *      is newly added to `neverActions` — forbidding it disables that check
 *      outright. Already-forbidden actions are not re-flagged.
 */
export function weakensClinicalCheck(params: {
  currentGuardrailProfile: string | null | undefined;
  nextGuardrailProfile: string | null | undefined;
  currentNeverActions: string[] | null | undefined;
  nextNeverActions: string[] | null | undefined;
}): string[] {
  const reasons: string[] = [];

  if (params.nextGuardrailProfile === WEAKEST_GUARDRAIL_PROFILE && params.currentGuardrailProfile !== WEAKEST_GUARDRAIL_PROFILE) {
    reasons.push(`Guardrail profile is changing to ${WEAKEST_GUARDRAIL_PROFILE}, the weakest profile in the catalogue.`);
  }

  const current = new Set(params.currentNeverActions ?? []);
  const next = new Set(params.nextNeverActions ?? []);
  for (const action of CLINICAL_CHECK_ACTIONS) {
    if (next.has(action) && !current.has(action)) {
      reasons.push(`"${AGENT_ACTION_LABELS[action]}" (${action}) is being added to Never actions, disabling that clinical check.`);
    }
  }

  return reasons;
}

/** Builds the `subscribedKinds` JSONB payload from picker state; null when nothing is selected. */
export function buildSubscribedKindsPayload(kinds: { key: string; filter?: Record<string, string> }[]): { version: 1; kinds: { key: string; filter?: Record<string, string> }[] } | null {
  if (kinds.length === 0) return null;
  return {
    version: 1,
    kinds: kinds.map((kind) => (kind.filter && Object.keys(kind.filter).length > 0 ? { key: kind.key, filter: kind.filter } : { key: kind.key })),
  };
}

/** Builds the `writeScope` JSONB payload from picker state; null when nothing is selected. */
export function buildWriteScopePayload(outputs: string[]): { version: 1; outputs: string[] } | null {
  if (outputs.length === 0) return null;
  return { version: 1, outputs };
}

/** Builds the `goal` JSONB payload; null when the objective is empty (goal not configured). */
export function buildGoalPayload(objective: string, successCriteria: string[]): { version: 1; objective: string; successCriteria?: string[] } | null {
  const trimmed = objective.trim();
  if (trimmed.length === 0) return null;
  const cleanCriteria = successCriteria.map((c) => c.trim()).filter((c) => c.length > 0);
  return cleanCriteria.length > 0 ? { version: 1, objective: trimmed, successCriteria: cleanCriteria } : { version: 1, objective: trimmed };
}

/**
 * Tri-state editor value for one tool's `toolConfig.tools[key].enabled` pin
 *  — mirrors the `TriState` pattern of
 * `pipeline-policy/components/cascade.ts` (inherit/on/off over a nullable
 * boolean), reimplemented here rather than imported because features never
 * import each other (`13-nextjs-apps.md`). `'inherit'` round-trips to
 * `enabled: null` — "follow the platform/env default" — instead of being
 * coerced to `true`/`false`.
 */
export type ToolTriState = 'inherit' | 'on' | 'off';

export function toolEnabledToTri(enabled: boolean | null | undefined): ToolTriState {
  if (enabled === true) return 'on';
  if (enabled === false) return 'off';
  return 'inherit';
}

export function triToToolEnabled(tri: ToolTriState): boolean | null {
  if (tri === 'inherit') return null;
  return tri === 'on';
}

/**
 * Builds the `toolConfig` JSONB payload ("Tool allowlist") — every one of the
 * three tools is set EXPLICITLY, `enabled: true | false | null`, never
 * omitted. `null` ("inherit") is preserved rather than coerced to a boolean —
 * it means "follow the platform/env default", the same tri-state the server
 * already validates (`toolConfigProblems` in
 * `packages/applications/src/services/departmentAgent/constants.ts`).
 */
export function buildToolConfigPayload(
  toolStates: Record<(typeof LIVE_TOOL_KEYS)[number], ToolTriState>,
): { version: 1; tools: Record<(typeof LIVE_TOOL_KEYS)[number], { enabled: boolean | null }> } {
  const tools = {} as Record<(typeof LIVE_TOOL_KEYS)[number], { enabled: boolean | null }>;
  for (const key of LIVE_TOOL_KEYS) tools[key] = { enabled: triToToolEnabled(toolStates[key] ?? 'inherit') };
  return { version: 1, tools };
}

/**
 * Merges Budgets edits into the agent's EXISTING `harnessOverrides`, so
 * saving the three locked/elevated-only budget fields never clobbers other
 * keys this form does not render (the 5 sensor thresholds, `toolAllowlist`).
 */
export function buildBudgetsHarnessOverridesPayload(
  existing: Record<string, unknown> | undefined,
  budgets: { maxRegen?: number; gateSlaSeconds?: number; gateEscalationSeconds?: number },
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(existing ?? {}) };
  if (budgets.maxRegen !== undefined) merged.maxRegen = budgets.maxRegen;
  if (budgets.gateSlaSeconds !== undefined) merged.gateSlaSeconds = budgets.gateSlaSeconds;
  if (budgets.gateEscalationSeconds !== undefined) merged.gateEscalationSeconds = budgets.gateEscalationSeconds;
  return merged;
}

// ---------------------------------------------------------------------------
// Hydration — defensive parsing of the raw JSONB fields a `DepartmentAgent`
// wire row carries, into the shapes the form's state uses. Malformed/legacy
// shapes degrade to an empty selection rather than throwing.
// ---------------------------------------------------------------------------

export interface SelectedKind {
  key: string;
  filter?: Record<string, string>;
}

/** Parses `agent.subscribedKinds` into the picker's selection list. */
export function parseSubscribedKinds(value: Record<string, unknown> | null | undefined): SelectedKind[] {
  const kinds = value?.kinds;
  if (!Array.isArray(kinds)) return [];
  return kinds
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    .map((entry) => {
      const key = entry.key;
      if (typeof key !== 'string') return null;
      const filter = entry.filter;
      return filter && typeof filter === 'object' && !Array.isArray(filter) ? { key, filter: filter as Record<string, string> } : { key };
    })
    .filter((entry): entry is SelectedKind => entry !== null);
}

/** Parses `agent.writeScope` into the picker's selected output keys. */
export function parseWriteScope(value: Record<string, unknown> | null | undefined): string[] {
  const outputs = value?.outputs;
  return Array.isArray(outputs) ? outputs.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** Parses `agent.goal` into `{ objective, successCriteria }` form fields. */
export function parseGoal(value: Record<string, unknown> | null | undefined): { objective: string; successCriteria: string[] } {
  const objective = typeof value?.objective === 'string' ? value.objective : '';
  const successCriteria = Array.isArray(value?.successCriteria) ? value.successCriteria.filter((entry): entry is string => typeof entry === 'string') : [];
  return { objective, successCriteria };
}

/** Parses `agent.toolConfig` into each tool's tri-state pin (`'inherit'` when unset/null). */
export function parseToolConfig(value: Record<string, unknown> | null | undefined): Record<(typeof LIVE_TOOL_KEYS)[number], ToolTriState> {
  const tools = value?.tools;
  const result = {} as Record<(typeof LIVE_TOOL_KEYS)[number], ToolTriState>;
  for (const key of LIVE_TOOL_KEYS) {
    const entry = tools && typeof tools === 'object' ? (tools as Record<string, unknown>)[key] : undefined;
    const enabled = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).enabled : undefined;
    result[key] = toolEnabledToTri(typeof enabled === 'boolean' ? enabled : null);
  }
  return result;
}
