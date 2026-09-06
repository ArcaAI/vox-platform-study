/**
 * TASK-890 §3.3 — the ONE render scope every TypeScript prompt renderer builds.
 *
 * The grammar lives in `@arcaai/workflow-contract` (`renderTemplate`); this is the VOCABULARY
 * that grammar resolves against, so the same agent instruction means the same thing on the
 * realtime `core.agent` lane, on `POST /agents/:slug/invocations`, and — through the
 * hand-written mirror `_prompt_scope` in
 * `apps/harness/src/harness/temporal/interpreter/nodes/core.py` — on the durable lane.
 *
 * | Root | Workflow run | Standalone invocation |
 * |---|---|---|
 * | `trigger.*` | the `core.trigger`-validated run payload | — |
 * | `context.*` | ALIAS of `trigger.*` | the request's validated `context` |
 * | `input.*` | — | the body validated against `inputSchema` |
 * | `vars.*` | merged `core.variable` outputs | — |
 * | `nodes.<id>.*` | prior node outputs | — |
 * | bare `name` | `instruction.variables`, overlaid by the node's `overrides.promptVariables` | same, overlaid by the request's `variables` |
 *
 * Two ordering decisions that are load-bearing:
 *
 *  - the `context` alias is bound BEFORE the bare names, so an agent that genuinely declares a
 *    variable called `context` still wins its own name;
 *  - a root is bound only when the caller actually HAS it. Binding an absent `trigger` to `{}`
 *    would turn "this call shape has no trigger" into "that field does not exist", and the two
 *    are different findings for whoever has to fix the prompt.
 */

export interface AgentPromptScopeInput {
  /** Bare names: `instruction.variables` already overlaid by the node's / caller's overrides. */
  readonly variables?: Readonly<Record<string, unknown>>;
  /** The run payload (workflow) or the request `context` (invocation). Also published as `context`. */
  readonly trigger?: Readonly<Record<string, unknown>> | null;
  /** The invocation body validated against the agent's `inputSchema`. */
  readonly input?: Readonly<Record<string, unknown>> | null;
  /** Merged `core.variable` outputs. */
  readonly vars?: Readonly<Record<string, unknown>> | null;
  /** Prior node outputs, keyed by node id. */
  readonly nodes?: Readonly<Record<string, unknown>> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Build the render scope. Pure; no defaults are invented for a root the caller does not have. */
export function buildAgentPromptScope(input: AgentPromptScopeInput): Record<string, unknown> {
  const scope: Record<string, unknown> = {};
  if (isRecord(input.trigger)) {
    scope.trigger = input.trigger;
    scope.context = input.trigger;
  }
  if (isRecord(input.input)) scope.input = input.input;
  if (isRecord(input.vars)) scope.vars = input.vars;
  if (isRecord(input.nodes)) scope.nodes = input.nodes;

  const variables = isRecord(input.variables) ? input.variables : {};
  Object.assign(scope, variables);
  // The pre-890 durable scope also exposed the bound map under its own key; a seeded instruction
  // may reference `{{variables.x}}`, so both renderers keep it.
  scope.variables = variables;
  return scope;
}
