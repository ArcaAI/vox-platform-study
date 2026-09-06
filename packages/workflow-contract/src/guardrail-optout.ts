/**
 * TASK-890 §3.14 (OD-R clause 3) — the guardrail opt-out's ONE precedence function.
 *
 * ## What this does NOT change
 *
 * Guardrail POLICY stays platform-managed: the eight `policy-catalogue` checks, the per-tenant
 * `TenantGuardrailPolicy` row and the `guardrail.*` routing selection are all super-admin
 * instruments, resolved tenant-row-or-SYSTEM inside `apps/guardrail`. This module does not touch
 * any of that. It answers ONE question — for THIS call, does the platform's guardrail run — and
 * the tenant's only move is to opt OUT.
 *
 * ## The precedence, and why it is this way round
 *
 * `node > workflow > agent > true`. The most specific opinion wins because it is the most
 * deliberate: a tenant that disabled screening on one node of one graph said something narrower,
 * and therefore more informed, than the agent's blanket default. ABSENT is INHERIT at every
 * level (tri-state by absence, the `mcpToolsEnabled` precedent) — there is no "unset false".
 *
 * The floor is `true`. Guardrail is what a tenant opts OUT of; nothing here can turn screening ON
 * that the platform turned off, and `apps/text` keeps `platform.enabled` as the hard floor for
 * exactly that reason (a pushed `true` cannot revive a platform kill switch).
 *
 * ## Why it returns a SOURCE
 *
 * "This consultation ran without its guard" must be answerable from a record, not reconstructed
 * from three JSON columns after the fact. The source rides into the publish WARNING
 * (`GUARDRAIL_OPTED_OUT`), the per-call usage attribute (`guardrail: 'opted_out'`) and the step
 * result, so the omission is attributable at authoring time, at publish time and per run.
 *
 * Pure, total and dependency-free; mirrored by
 * `apps/harness/src/harness/temporal/interpreter/guardrail_optout.py` and held to
 * `tests/contracts/guardrail-optout.fixture.json` by two loaders — the durable lane must not
 * screen a call the realtime lane skipped.
 */

export const GUARDRAIL_DECISION_SOURCES = Object.freeze(['node', 'workflow', 'agent', 'default'] as const);
export type GuardrailDecisionSource = (typeof GUARDRAIL_DECISION_SOURCES)[number];

export interface GuardrailDecision {
  readonly enabled: boolean;
  /** WHICH level decided. `default` = nobody expressed an opinion, so screening is on. */
  readonly source: GuardrailDecisionSource;
}

/**
 * One opinion per level. `undefined`/`null` — and, defensively, any non-boolean — mean NO
 * OPINION, never `false`: a malformed value must not read as an opt-out. Publish refuses one
 * (the node/agent schemas), and a runtime that saw one anyway screens the call.
 */
export interface GuardrailOptOutInputs {
  /** `core.agent` node `config.guardrail.enabled`. */
  readonly node?: boolean | null;
  /** The workflow's `core.trigger` `config.guardrail.enabled` (compiled to `policyBindings.guardrail`). */
  readonly workflow?: boolean | null;
  /** The agent's `parameters.guards.enabled` (compiled to `compiledConfig.guardrail.enabled`). */
  readonly agent?: boolean | null;
}

export function resolveGuardrailDecision(inputs: GuardrailOptOutInputs): GuardrailDecision {
  if (typeof inputs.node === 'boolean') return { enabled: inputs.node, source: 'node' };
  if (typeof inputs.workflow === 'boolean') return { enabled: inputs.workflow, source: 'workflow' };
  if (typeof inputs.agent === 'boolean') return { enabled: inputs.agent, source: 'agent' };
  return { enabled: true, source: 'default' };
}

/** Reads `config.guardrail.enabled` off an authored node config; `null` when it says nothing. */
export function guardrailOptOutOf(config: unknown): boolean | null {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return null;
  const guardrail = (config as Record<string, unknown>).guardrail;
  if (typeof guardrail !== 'object' || guardrail === null || Array.isArray(guardrail)) return null;
  const enabled = (guardrail as Record<string, unknown>).enabled;
  return typeof enabled === 'boolean' ? enabled : null;
}
